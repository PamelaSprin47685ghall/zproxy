// Retain OMP request shaping and auth. Transfer the successful body before its parser can read it.
import { randomUUID } from "node:crypto";

const SAFE_HEADERS = ["content-type", "cache-control", "retry-after"];
const RAW_PATHS = /(?:\/chat\/completions|\/responses|\/messages|:streamGenerateContent|:rawPredict)$/;
const MAX_EVENT_BYTES = 65536;

function stopError() {
  return new DOMException("The raw response is closed.", "AbortError");
}

function abortable(signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? stopError());
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason ?? stopError()), { once: true });
  });
}

export function timeoutRead(reader, timeoutMs, signal) {
  let timer;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? stopError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => reject(new Error("The upstream body stalled.")), timeoutMs);
  });
  return Promise.race([reader.read(), interrupted]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  });
}

function eventObject(block) {
  const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (data === "[DONE]") return { type: "done" };
  if (!data) return undefined;
  try { return JSON.parse(data); } catch { return undefined; }
}

function streamError(value) {
  const payload = value?.response ?? value;
  if (!payload?.error && payload?.type !== "error") return undefined;
  const error = payload.error ?? payload;
  const type = String(error.type ?? error.status ?? error.code ?? "").toLowerCase();
  const code = Number(error.code);
  const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code
    : /rate|quota|resource_exhausted|429/.test(type) ? 429
    : /permission|forbidden|403/.test(type) ? 403 : /auth|401/.test(type) ? 401 : 502;
  return new Response(JSON.stringify({ error: { type: "upstream_error", message: "The upstream stream returned an error." } }),
    { status, headers: { "Content-Type": "application/json" } });
}

function publicFailure(response) {
  const headers = new Headers({ "content-type": "application/json" });
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && retryAfter.length <= 128) headers.set("retry-after", retryAfter);
  return { status: response.status >= 400 && response.status <= 599 ? response.status : 502, headers };
}

// SDK error readers receive a bounded body; the route policy gets only a category.
export async function rejectedResponse(response, signal, timeoutMs) {
  if (!response.body) return { response, text: "" };
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (size < MAX_EVENT_BYTES) {
      const item = await timeoutRead(reader, timeoutMs, signal);
      if (item.done) break;
      const part = item.value.subarray(0, MAX_EVENT_BYTES - size);
      parts.push(part);
      size += part.byteLength;
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
  const bytes = Buffer.concat(parts, size);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return { response: new Response(bytes, { status: response.status, statusText: response.statusText, headers }),
    text: bytes.toString("utf8") };
}

function useful(value) {
  const data = value?.response ?? value;
  if (!data || typeof data !== "object") return false;
  if (value.type === "done" || /(?:completed|message_stop)$/.test(value.type ?? "")) return true;
  if (typeof value.delta === "string" && value.delta.length) return true;
  if (value.delta?.text || value.delta?.thinking || value.delta?.partial_json) return true;
  if (value.type === "content_block_start" && value.content_block?.type === "tool_use") return true;
  if (value.type === "response.output_item.added" && value.item?.type === "function_call") return true;
  if (data.choices?.some(choice => choice.finish_reason || choice.delta?.content || choice.delta?.reasoning_content
      || choice.delta?.reasoning || choice.delta?.tool_calls?.length)) return true;
  return data.candidates?.some(candidate => candidate.finishReason || candidate.content?.parts?.some(part =>
    part.text || part.functionCall || part.inlineData)) === true;
}

// Inspect only the beginning. A provider's 200 error must remain eligible for OMP's retry policy.
export async function admit(response, signal, timeoutMs, acceptEvent = () => false) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const held = [];
  let bytes = 0;
  let pending = "";
  try {
    while (true) {
      const next = await timeoutRead(reader, timeoutMs, signal);
      if (next.done) break;
      held.push(next.value);
      pending += decoder.decode(next.value.subarray(0, MAX_EVENT_BYTES - bytes), { stream: true });
      bytes += next.value.byteLength;
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop();
      for (const block of blocks) {
        const value = eventObject(block);
        const error = streamError(value);
        if (error) {
          await reader.cancel();
          reader.releaseLock();
          for (const name of ["retry-after", "x-ratelimit-reset", "x-ratelimit-reset-after"]) {
            if (response.headers.has(name)) error.headers.set(name, response.headers.get(name));
          }
          return { error };
        }
        if (useful(value) || acceptEvent(value)) {
          return { response: new Response(new ReadableStream({
            async pull(controller) {
              if (held.length) controller.enqueue(held.shift());
              else {
                const item = await reader.read();
                if (item.done) { reader.releaseLock(); controller.close(); }
                else controller.enqueue(item.value);
              }
            },
            async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
          }), { status: response.status, headers: response.headers }) };
        }
      }
      if (bytes >= MAX_EVENT_BYTES) throw new Error("The upstream sent no usable event within the admission limit.");
    }
    reader.releaseLock();
    return { error: new Response(JSON.stringify({ error: { message: "The upstream stream ended before a result." } }),
      { status: 502, headers: { "Content-Type": "application/json" } }) };
  } catch (error) {
    try { await reader.cancel(error); } finally { reader.releaseLock(); }
    throw error;
  }
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function natural(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// Parse only bounded usage records. Text deltas remain bytes and never become OMP messages here.
export function usageTap(onUsage, api) {
  const decoder = new TextDecoder();
  const usage = emptyUsage();
  let pending = "";
  let overflow = false;
  const inspect = block => {
    if (!/"(?:usage|usageMetadata)"\s*:/.test(block)) return;
    const value = eventObject(block);
    const row = value?.usage ?? value?.response?.usage ?? value?.message?.usage
      ?? value?.usageMetadata ?? value?.response?.usageMetadata;
    if (!row || typeof row !== "object") return;
    let read = natural(row.cache_read_input_tokens ?? row.prompt_tokens_details?.cached_tokens
      ?? row.input_tokens_details?.cached_tokens ?? row.cachedContentTokenCount);
    const write = natural(row.cache_creation_input_tokens);
    const prompt = natural(row.prompt_tokens ?? row.promptTokenCount ?? row.input_tokens
      ?? (row.totalTokenCount !== undefined ? row.totalTokenCount - natural(row.candidatesTokenCount) - natural(row.thoughtsTokenCount) : 0));
    if (api !== "anthropic-messages") read = Math.min(read, prompt);
    const input = api === "anthropic-messages" ? natural(row.input_tokens) : Math.max(0, prompt - read);
    usage.input = Math.max(usage.input, input);
    usage.output = Math.max(usage.output, natural(row.output_tokens ?? row.completion_tokens ?? row.candidatesTokenCount)
      + natural(row.thoughtsTokenCount));
    usage.cacheRead = Math.max(usage.cacheRead, read);
    usage.cacheWrite = Math.max(usage.cacheWrite, write);
  };
  return {
    push(bytes) {
      const text = decoder.decode(bytes, { stream: true });
      for (const line of text.split(/(?<=\n)/)) {
        if (overflow) {
          if (/^\r?\n$/.test(line)) overflow = false;
          continue;
        }
        pending += line;
        if (pending.length > MAX_EVENT_BYTES) { pending = ""; overflow = true; continue; }
        if (/\r?\n\r?\n$/.test(pending)) { inspect(pending); pending = ""; }
      }
    },
    finish() {
      usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      if (usage.totalTokens) onUsage(usage);
    },
  };
}

export function framed(metadata, raw, finish, signal, timeoutMs, tap) {
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  if (encoded.byteLength > 16384) throw new Error("The decode metadata exceeds its limit.");
  const prefix = new Uint8Array(4 + encoded.byteLength);
  new DataView(prefix.buffer).setUint32(0, encoded.byteLength);
  prefix.set(encoded, 4);
  const reader = raw.getReader();
  let initial = true;
  let ended = false;
  const close = async () => {
    if (ended) return;
    ended = true;
    try { tap.finish(); } finally { await finish(); }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        if (initial) { initial = false; controller.enqueue(prefix); return; }
        const item = await timeoutRead(reader, timeoutMs, signal);
        if (item.done) {
          reader.releaseLock();
          await close();
          controller.close();
        } else { tap.push(item.value); controller.enqueue(item.value); }
      } catch (error) {
        const closing = close();
        try { await reader.cancel(error); } catch {}
        try { reader.releaseLock(); } catch {}
        await closing;
        controller.error(new Error("The upstream response ended unexpectedly."));
      }
    },
    async cancel(reason) {
      const closing = close();
      try { await reader.cancel(reason); }
      finally { try { reader.releaseLock(); } catch {} await closing; }
    },
  });
}

export function createRawHandoff({ descriptorFor, serializeRecipe, chooseFetch = () => fetch,
  isOAuth = () => false, wrapRaw = response => response,
  wireInfo = () => undefined,
  observeTurn = () => ({}),
  priceUsage = () => {}, headerTimeoutMs = 120000, idleTimeoutMs = 120000 }) {
  return async turn => {
    try { if (!descriptorFor(turn.model, turn.options)) return undefined; }
    catch { return undefined; }
    const { promise: captured, resolve: capture } = Promise.withResolvers();
    const controller = turn.controller;
    const observer = observeTurn(turn.model);
    const base = turn.options.fetch ?? chooseFetch(turn.model);
    let transferred = false;
    let attempts = 0;
    let lastFailure;
    let events;
    let finalized = false;
    const finish = async () => {
      if (finalized) return;
      finalized = true;
      if (!controller.signal.aborted) controller.abort(stopError());
      try { await events?.result(); } catch {}
      finally { turn.settle(); }
    };
    let deadline = setTimeout(() => controller.abort(new Error("The upstream response headers timed out.")), headerTimeoutMs);
    turn.options.preferWebsockets = false;
    // The ordinary watchdog cannot see progress while fetch deliberately awaits raw body ownership.
    turn.options.streamFirstEventTimeoutMs = 0;
    turn.options.streamIdleTimeoutMs = 0;
    turn.options.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const inference = method === "POST" && RAW_PATHS.test(url.pathname);
      if (inference) { attempts++; observer.onContact?.(url); }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("Accept-Encoding", "identity");
      const response = await base(input, { ...init, headers });
      if (!inference) return response;
      if (!response.ok) {
        const rejected = await rejectedResponse(response, controller.signal, headerTimeoutMs);
        lastFailure = { ...publicFailure(response), type: observer.classifyError?.(rejected.text) === "quota" ? "insufficient_quota" : "upstream_error" };
        return rejected.response;
      }
      if (!response.body || !/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) return response;
      const hint = wireInfo(response);
      const admitted = await admit(response, controller.signal, headerTimeoutMs);
      if (admitted.error) { lastFailure = publicFailure(admitted.error); return admitted.error; }
      if (transferred) { await admitted.response.body.cancel(); throw new Error("A raw turn cannot transfer a second response."); }
      const wireApi = hint?.api ?? (/\/responses$/.test(url.pathname) ? "openai-responses"
        : /\/chat\/completions$/.test(url.pathname) ? "openai-completions" : undefined);
      const recipe = hint?.recipe ?? descriptorFor(hint?.id ? { ...turn.model, id: hint.id } : turn.model,
        { ...turn.options, isOAuth: isOAuth(turn.model, headers) }, wireApi);
      if (!recipe) { await admitted.response.body.cancel(); throw new Error("The upstream wire has no local decoder."); }
      transferred = true;
      clearTimeout(deadline);
      deadline = undefined;
      capture({ response: await wrapRaw(admitted.response, {
        model: turn.model, input, init: { ...init, headers }, fetch: base,
        signal: controller.signal, headerTimeoutMs, idleTimeoutMs,
      }), recipe });
      // Success never resolves to the server-side provider parser.
      return await abortable(controller.signal);
    };
    try {
      events = turn.stream();
      const outcome = await Promise.race([
        captured.then(value => ({ raw: value })),
        events.result().then(value => ({ terminal: value })),
        abortable(controller.signal),
      ]);
      if (!outcome.raw) {
        await finish();
        const { type = "upstream_error", ...init } = lastFailure ?? { status: 502 };
        return Response.json({ error: { type, message: "The upstream request failed before a response was transferred." } }, init);
      }
      const { response, recipe } = outcome.raw;
      const publicAlias = new TextEncoder().encode(turn.parsed.modelId).byteLength <= 128 ? turn.parsed.modelId : "";
      const metadata = {
        decoder: "omp-response", version: 1, modelAlias: publicAlias,
        requestId: randomUUID().replaceAll("-", ""), attempt: Math.min(attempts, 65535),
        isStreaming: turn.parsed.stream, recipe: serializeRecipe(recipe),
      };
      const headers = new Headers();
      for (const name of SAFE_HEADERS) if (response.headers.has(name)) headers.set(name, response.headers.get(name));
      headers.set("X-Zproxy-Decode", "1");
      const tap = usageTap(usage => {
        priceUsage(turn.model, usage);
        turn.observeUsage(usage);
        observer.onUsage?.(usage);
      }, recipe.api);
      return new Response(framed(metadata, response.body, finish, controller.signal, idleTimeoutMs, tap),
        { status: response.status, headers });
    } catch (error) {
      await finish();
      throw error;
    } finally { clearTimeout(deadline); }
  };
}
