// Run the official OMP response adapters against one supplied response.
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { parseRequest, encodeResponse, encodeStream } from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import { buildToolIdMap, normalizeOpenAIRequest, parseRecipe } from "./contract.mjs";

const utf8 = new TextEncoder();
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_VISIBLE_BYTES = 16 * 1024 * 1024;
const PARSER_VALUE = "zproxy-local-response-parser";
const PROVIDERS = Object.freeze({
  "openai-completions": () => import("@oh-my-pi/pi-ai/providers/openai-completions").then(module => module.streamOpenAICompletions),
  "openai-responses": () => import("@oh-my-pi/pi-ai/providers/openai-responses").then(module => module.streamOpenAIResponses),
  "anthropic-messages": () => import("@oh-my-pi/pi-ai/providers/anthropic").then(module => module.streamAnthropic),
  "google-generative-ai": () => import("@oh-my-pi/pi-ai/providers/google").then(module => module.streamGoogle),
  "google-gemini-cli": () => import("@oh-my-pi/pi-ai/providers/google-gemini-cli").then(module => module.streamGoogleGeminiCli),
});

export function streamBytes(bytes) {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

export function jsonResponse(value, status = 200) {
  return new Response(streamBytes(utf8.encode(JSON.stringify(value))), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function errorResponse(message, status = 502) {
  return jsonResponse({ error: { message, type: status < 500 ? "invalid_request_error" : "upstream_error" } }, status);
}

function localModel(recipe) {
  const spec = {
    ...recipe, provider: "zproxy-local", name: recipe.id,
    baseUrl: "http://zproxy.invalid/v1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const policy = resolveModelPolicy(spec);
  return { ...spec, identity: policy.identity, thinking: policy.thinking, compat: { ...policy.compat, ...recipe.compat } };
}

/** Bound total source bytes and cancel the source when the client leaves. */
function responseBody(source, controller, limit) {
  if (!source) throw new Error("The upstream response has no body.");
  const reader = source.getReader();
  let total = 0;
  let closed = false;
  const stop = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
  controller.signal.addEventListener("abort", stop, { once: true });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    controller.signal.removeEventListener("abort", stop);
    reader.releaseLock();
  };
  return new ReadableStream({
    async pull(output) {
      try {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled.");
        const next = await reader.read();
        if (next.done) { cleanup(); output.close(); return; }
        total += next.value.byteLength;
        if (total > limit) throw new Error("The upstream response exceeds the local parser byte limit.");
        output.enqueue(next.value);
      } catch (error) {
        controller.abort(error);
        cleanup();
        output.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      await reader.cancel(reason).catch(() => {});
      cleanup();
    },
  });
}

function restoreIds(message, mapping) {
  if (!message?.content) return;
  for (const block of message.content) {
    if (block.type === "toolCall" && mapping.has(block.id)) block.id = mapping.get(block.id);
  }
}

function restoredEvent(event, mapping) {
  if (mapping.size === 0) return event;
  const copy = { ...event };
  for (const key of ["partial", "message", "error"]) {
    if (!event[key]?.content) continue;
    copy[key] = { ...event[key], content: event[key].content.map(block =>
      block.type === "toolCall" && mapping.has(block.id) ? { ...block, id: mapping.get(block.id) } : block) };
  }
  return copy;
}

/** The only retained output shim: keep late reasoning before visible output. */
async function* orderedEvents(events, mapping, enabled, limit) {
  const pending = [];
  let bytes = 0;
  for await (const event of events) {
    const bodyEvent = event.type === "text_delta" || event.type.startsWith("toolcall_");
    if (enabled && bodyEvent) {
      bytes += utf8.encode(event.delta ?? "").byteLength + 512;
      if (bytes > limit) throw new Error("The reasoning-order buffer exceeds its byte limit.");
      pending.push(event);
      continue;
    }
    if (event.type === "done" || event.type === "error") {
      for (const held of pending) yield restoredEvent(held, mapping);
      pending.length = 0;
      bytes = 0;
    }
    yield restoredEvent(event, mapping);
  }
  for (const held of pending) yield restoredEvent(held, mapping);
}

export function legacyResponse(chat) {
  return {
    id: chat.id.replace(/^chatcmpl-/, "cmpl-"), object: "text_completion", created: chat.created, model: chat.model,
    choices: chat.choices.map(choice => ({ index: choice.index, text: choice.message.content ?? "", finish_reason: choice.finish_reason, logprobs: null,
      ...(choice.message.reasoning_content ? { reasoning_content: choice.message.reasoning_content } : {}) })),
    usage: chat.usage,
  };
}

/** Convert only the official encoder's bounded SSE frames for the legacy route. */
export function legacyStream(source) {
  let pending = "";
  const decoder = new TextDecoder();
  const convert = frame => frame.split("\n").map(line => {
    if (!line.startsWith("data: ") || line === "data: [DONE]") return line;
    const value = JSON.parse(line.slice(6));
    if (!Array.isArray(value.choices)) return line;
    return `data: ${JSON.stringify({ ...value, id: value.id.replace(/^chatcmpl-/, "cmpl-"), object: "text_completion",
      choices: value.choices.map(choice => ({ index: choice.index, text: choice.delta?.content ?? "", finish_reason: choice.finish_reason, logprobs: null,
        ...(choice.delta?.reasoning_content ? { reasoning_content: choice.delta.reasoning_content } : {}) })) })}`;
  }).join("\n");
  return source.pipeThrough(new TransformStream({
    transform(chunk, output) {
      pending += decoder.decode(chunk, { stream: true });
      if (utf8.encode(pending).byteLength > MAX_VISIBLE_BYTES) throw new Error("The completion frame exceeds its byte limit.");
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        output.enqueue(utf8.encode(`${convert(pending.slice(0, end))}\n\n`));
        pending = pending.slice(end + 2);
      }
    },
    flush(output) {
      pending += decoder.decode();
      if (pending) output.enqueue(utf8.encode(convert(pending)));
    },
  }));
}

/** Attach completion to the actual body lifetime, including early cancellation. */
export function finishBody(source, finish) {
  const reader = source.getReader();
  let finished = false;
  const done = () => { if (!finished) { finished = true; finish(); } };
  return new ReadableStream({
    async pull(output) {
      try {
        const next = await reader.read();
        if (next.done) { done(); output.close(); }
        else output.enqueue(next.value);
      } catch (error) { done(); output.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { done(); } },
  });
}

export async function decodeUpstream({ path, request, recipe: recipeText, body, status = 200, headers = [], signal, reasoningOrder = false, maxResponseBytes = MAX_RESPONSE_BYTES, maxVisibleBytes = MAX_VISIBLE_BYTES }) {
  let recipe;
  let parsed;
  let mapping;
  try {
    recipe = parseRecipe(recipeText);
    parsed = parseRequest(normalizeOpenAIRequest(path, request));
    mapping = buildToolIdMap(request);
  } catch (error) {
    await body?.cancel(error).catch(() => {});
    throw error;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error("The client disconnected."));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const finish = () => {
    signal?.removeEventListener("abort", abort);
    controller.abort(new Error("The local response is complete."));
  };

  try {
    if (status < 200 || status >= 300) throw new Error("A raw OMP response must be successful.");
    const streamProvider = await PROVIDERS[recipe.api]();
    const source = new Response(responseBody(body, controller, maxResponseBytes), { status, headers });
    let used = false;
    const fetchOnce = async () => {
      if (used || controller.signal.aborted) {
        const error = new Error("The local OMP parser cannot retry or contact an upstream.");
        controller.abort(error);
        throw error;
      }
      used = true;
      return source;
    };
    // The request builder receives public tool definitions and fixed local data.
    // Its fetch hook consumes the supplied body; no request leaves this process.
    const context = { messages: [{ role: "user", content: "Decode the supplied response.", timestamp: 0 }], tools: parsed.context.tools };
    const events = streamProvider(localModel(recipe), context, {
      apiKey: recipe.api === "google-gemini-cli" ? JSON.stringify({ token: PARSER_VALUE, projectId: PARSER_VALUE }) : PARSER_VALUE,
      fetch: fetchOnce, signal: controller.signal, maxHttpAttempts: 1, codexSseMaxAttempts: 1,
      acceptEmptyResponse: true, transport: "sse", stateful: false, cacheRetention: "none",
      streamFirstEventTimeoutMs: 0, streamIdleTimeoutMs: 0,
      providerRetryWait: async () => { throw new Error("The local OMP parser cannot retry an upstream."); },
    });
    if (!parsed.stream) {
      let message;
      for await (const event of events) {
        if (event.type === "done") message = event.message;
        if (event.type === "error") message = event.error;
      }
      if (!message) throw new Error("The OMP parser did not produce a final result.");
      restoreIds(message, mapping);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        finish();
        return errorResponse(message.errorMessage ?? "The upstream response could not be decoded.");
      }
      const encoded = encodeResponse(message, parsed.modelId);
      finish();
      return jsonResponse(path === "/v1/completions" ? legacyResponse(encoded) : encoded);
    }
    let encoded = encodeStream(orderedEvents(events, mapping, reasoningOrder, maxVisibleBytes), parsed.modelId, parsed.options, {
      signal: controller.signal, onCancel: reason => controller.abort(reason),
    });
    if (path === "/v1/completions") encoded = legacyStream(encoded);
    return new Response(finishBody(encoded, finish), { headers: {
      "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no",
    } });
  } catch (error) {
    finish();
    throw error;
  }
}
