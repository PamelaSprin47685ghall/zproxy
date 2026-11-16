// Google can split one generation into authenticated segments. Keep that control loop remote.
import { fetchWithRetry } from "@oh-my-pi/pi-utils";

const MAX_EVENT = 1048576;
const MAX_SEGMENTS = 128;
const COUNTS = ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount", "cachedContentTokenCount"];

async function* events(body, signal) {
  const reader = body.getReader();
  const stop = () => { void reader.cancel(signal.reason).catch(() => {}); };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  let parts = [];
  let length = 0;
  let lineHasData = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      let start = 0;
      for (let i = 0; i < item.value.byteLength; i++) {
        const byte = item.value[i];
        if (byte !== 10 && byte !== 13) lineHasData = true;
        if (byte !== 10) continue;
        const end = i + 1;
        parts.push(item.value.subarray(start, end));
        length += end - start;
        start = end;
        if (length > MAX_EVENT) throw new Error("A Google control event exceeds its limit.");
        if (!lineHasData) {
          yield Buffer.concat(parts, length);
          parts = [];
          length = 0;
        }
        lineHasData = false;
      }
      if (start < item.value.byteLength) {
        parts.push(item.value.subarray(start));
        length += item.value.byteLength - start;
        if (length > MAX_EVENT) throw new Error("A Google control event exceeds its limit.");
      }
    }
    if (length) yield Buffer.concat(parts, length);
  } finally {
    signal.removeEventListener("abort", stop);
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

function eventValue(bytes) {
  const data = bytes.toString("utf8").split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  try { return JSON.parse(data); } catch { return undefined; }
}

function sumUsage(earlier, segment) {
  const sum = { ...segment };
  for (const key of COUNTS) {
    if (earlier[key] !== undefined || segment[key] !== undefined) sum[key] = (earlier[key] ?? 0) + (segment[key] ?? 0);
  }
  const context = segment.totalTokenCount || (segment.promptTokenCount ?? 0) + (segment.candidatesTokenCount ?? 0) + (segment.thoughtsTokenCount ?? 0);
  if (context > 0) sum.contextTokenCount = context;
  return sum;
}

/** Ordinary events pass unchanged. Only segment control and cumulative usage records need decoding. */
export function continueGoogle(response, turn) {
  if (!["google-generative-ai", "google-gemini-cli", "google-vertex"].includes(turn.model.api)) return response;
  if (typeof turn.init.body !== "string") throw new Error("The Google request body cannot be resumed.");
  let original;
  const controller = new AbortController();
  const signal = AbortSignal.any([turn.signal, controller.signal]);
  const cli = turn.model.api === "google-gemini-cli";
  const url = turn.input instanceof Request ? turn.input.url : String(turn.input);
  const resume = async token => {
    original ??= JSON.parse(turn.init.body);
    const body = cli ? { ...original, request: { ...original.request, continuationToken: token } } : { ...original, continuationToken: token };
    const next = await fetchWithRetry(url, {
      ...turn.init, method: "POST", body: JSON.stringify(body), signal,
      maxAttempts: 4, maxDelayMs: 60000, defaultDelayMs: attempt => 1000 * 2 ** attempt, timeout: false,
      fetch: async (input, init) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("A continuation request timed out.")), turn.headerTimeoutMs);
        try { return await turn.fetch(input, { ...init, signal: AbortSignal.any([signal, controller.signal]) }); }
        finally { clearTimeout(timer); }
      },
    });
    if (!next.ok || !next.body || !/text\/event-stream/i.test(next.headers.get("content-type") ?? "")) {
      await next.body?.cancel();
      throw new Error("The Google continuation request failed.");
    }
    return next;
  };
  async function* segments() {
    let segment = response;
    let earlierUsage;
    for (let count = 0; count < MAX_SEGMENTS; count++) {
      let token;
      let segmentUsage;
      for await (const bytes of events(segment.body, signal)) {
        if (!bytes.includes('"continuationToken"') && !bytes.includes('"usageMetadata"')) { yield bytes; continue; }
        const value = eventValue(bytes);
        const data = cli ? value?.response : value;
        if (!data || typeof data !== "object") { yield bytes; continue; }
        let changed = false;
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason === "CONTINUATION" && typeof candidate.continuationToken === "string") {
          if (candidate.continuationToken.length > 65536) throw new Error("The Google continuation token exceeds its limit.");
          token = candidate.continuationToken;
          delete candidate.finishReason;
          delete candidate.continuationToken;
          changed = true;
        }
        if (data.usageMetadata) {
          segmentUsage = data.usageMetadata;
          if (earlierUsage) { data.usageMetadata = sumUsage(earlierUsage, segmentUsage); changed = true; }
        }
        yield changed ? Buffer.from(`data: ${JSON.stringify(value)}\n\n`) : bytes;
      }
      if (signal.aborted) throw signal.reason;
      if (!token) return;
      earlierUsage = sumUsage(earlierUsage ?? {}, segmentUsage ?? {});
      if (count + 1 >= MAX_SEGMENTS) throw new Error("The Google generation exceeds its segment limit.");
      segment = await resume(token);
    }
    await segment.body?.cancel();
    throw new Error("The Google generation exceeds its segment limit.");
  }
  const iterator = segments();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (item.done) controller.close();
        else controller.enqueue(item.value);
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { controller.abort(reason); await iterator.return(); },
  }), { status: response.status, headers: response.headers });
}
