import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { descriptorFor, normalizeOpenAIRequest, parseRecipe, serializeRecipe, shortToolId, supportsRawApi } from "./contract.mjs";
import { decodeUpstream } from "./local-codec.mjs";
import { readDecodeRequest, startLocal } from "./local.mjs";

const encoder = new TextEncoder();
const chatRequest = { model: "requested-alias", messages: [{ role: "user", content: "Hello" }] };
const sse = events => events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const recipe = (api, compat = {}) => serializeRecipe({ api, provider: "fixture", id: "fixture-model", reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 4096, compat });
const raw = (api, wire, request = chatRequest, extra = {}) => decodeUpstream({
  path: "/v1/chat/completions", request, recipe: recipe(api, api === "openai-completions" ? { streamMarkupHealingPattern: null } : {}),
  body: new Response(wire).body, headers: [["content-type", "text/event-stream"]], ...extra,
});

const chatEvents = [
  { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
  "[DONE]",
];
const messageItem = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] };
const responseEvents = [
  { type: "response.created", response: { id: "resp_fixture" } },
  { type: "response.output_item.added", output_index: 0, item: { ...messageItem, status: "in_progress", content: [] } },
  { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0, item: messageItem },
  { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [messageItem], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
];
const anthropicEvents = [
  { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model", content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];
const googleChunk = { candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } };

describe("the credential-free local OMP adapter", () => {
  for (const [api, wire] of [
    ["openai-completions", sse(chatEvents)],
    ["openai-responses", sse(responseEvents)],
    ["anthropic-messages", anthropicEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")],
    ["google-generative-ai", sse([googleChunk])],
    ["google-gemini-cli", sse([{ response: googleChunk }])],
  ]) {
    test(`uses the official ${api} parser for nonstream output`, async () => {
      const response = await raw(api, wire);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.model).toBe("requested-alias");
      expect(body.choices[0].message.content).toBe("Hello");
      expect(body.usage.prompt_tokens).toBe(5);
      expect(body.usage.completion_tokens).toBe(3);
      expect(response.headers.has("content-length")).toBe(false);
    });
  }

  test("preserves late reasoning, tool arguments, restored IDs, usage, and terminal SSE", async () => {
    const originalId = "call_with_a_long_shared_prefix_".repeat(4);
    const request = { ...chatRequest, stream: true, stream_options: { include_usage: true }, tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], messages: [
      ...chatRequest.messages,
      { role: "assistant", content: null, tool_calls: [{ id: originalId, type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: originalId, content: "ok" },
    ] };
    const wire = sse([
      { choices: [{ index: 0, delta: { content: "Visible" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "Late thought" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: shortToolId(originalId), type: "function", function: { name: "lookup", arguments: '{"city":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }, "[DONE]",
    ]);
    const response = await raw("openai-completions", wire, request, { reasoningOrder: true });
    const text = await response.text();
    expect(text.indexOf("Late thought")).toBeLessThan(text.indexOf("Visible"));
    expect(text).toContain(originalId);
    expect(text).not.toContain(shortToolId(originalId));
    const frames = text.split("\n\n").filter(frame => frame.startsWith("data: {")).map(frame => JSON.parse(frame.slice(6)));
    const argumentsText = frames.flatMap(frame => frame.choices ?? []).flatMap(choice => choice.delta?.tool_calls ?? []).map(call => call.function?.arguments ?? "").join("");
    expect(JSON.parse(argumentsText)).toEqual({ city: "Paris" });
    expect(frames.find(frame => frame.usage?.total_tokens === 8)).toBeDefined();
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("retains Google thought signatures on tool calls", async () => {
    const chunk = { candidates: [{ content: { role: "model", parts: [{ text: "Think", thought: true }, { functionCall: { id: "call_1", name: "lookup", args: { city: "Paris" } }, thoughtSignature: "signature-fixture" }] }, finishReason: "STOP" }], usageMetadata: googleChunk.usageMetadata };
    const response = await raw("google-generative-ai", sse([chunk]));
    const body = await response.json();
    expect(body.choices[0].message.reasoning_content).toBe("Think");
    expect(body.choices[0].message.tool_calls[0].extra_content.google.thought_signature).toBe("signature-fixture");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });

  test("uses explicit local stream order when reasoning buffering is disabled", async () => {
    const response = await raw("openai-completions", sse([
      { choices: [{ index: 0, delta: { content: "Visible first" } }] },
      { choices: [{ index: 0, delta: { reasoning_content: "Thought second" }, finish_reason: "stop" }] }, "[DONE]",
    ]), { ...chatRequest, stream: true }, { reasoningOrder: false });
    const text = await response.text();
    expect(text.indexOf("Visible first")).toBeLessThan(text.indexOf("Thought second"));
  });

  test("maps legacy completions for both response modes", async () => {
    for (const stream of [false, true]) {
      const response = await raw("openai-completions", sse(chatEvents), { model: "legacy-alias", prompt: "Hello", stream }, { path: "/v1/completions" });
      if (stream) {
        const text = await response.text();
        expect(text).toContain('"object":"text_completion"');
        expect(text).toContain('"text":"Hello"');
        expect(text).not.toContain('"delta"');
      } else {
        const body = await response.json();
        expect(body.object).toBe("text_completion");
        expect(body.choices[0].text).toBe("Hello");
      }
    }
  });

  test("propagates upstream errors and rejects truncated streams", async () => {
    for (const wire of [sse([{ error: { message: "Fixture rejected", type: "invalid_request_error" } }]), sse([{ choices: [{ index: 0, delta: { content: "Truncated" } }] }])]) {
      const response = await raw("openai-completions", wire);
      expect(response.status).toBe(502);
      expect((await response.json()).error.type).toBe("upstream_error");
    }
  });

  test("enforces the source byte limit", async () => {
    const response = await raw("openai-completions", sse(chatEvents), chatRequest, { maxResponseBytes: 16 });
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain("byte limit");
  });

  test("enforces the reasoning buffer limit as a stream error", async () => {
    const response = await raw("openai-completions", sse(chatEvents), { ...chatRequest, stream: true }, { reasoningOrder: true, maxVisibleBytes: 4 });
    expect(await response.text()).toContain("reasoning-order buffer exceeds");
  });

  test("cancels the raw source when the response reader leaves", async () => {
    const cancelled = Promise.withResolvers();
    const source = new ReadableStream({ cancel() { cancelled.resolve(true); } });
    const response = await raw("openai-completions", "", { ...chatRequest, stream: true }, { body: source });
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"role":"assistant"');
    await reader.cancel("fixture left");
    expect(await cancelled.promise).toBe(true);
  });

  test("an input abort cancels the source and closes the output with an error", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const source = new ReadableStream({ cancel() { cancelled = true; } });
    const response = await raw("openai-completions", "", { ...chatRequest, stream: true }, { body: source, signal: controller.signal });
    const reader = response.body.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"role":"assistant"');
      controller.abort(new Error("Fixture input cancelled."));
      let text = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += new TextDecoder().decode(next.value);
      }
      expect(text).toContain('"error"');
      expect(cancelled).toBe(true);
    } finally { await reader.cancel(); }
  }, 1000);

  test("a signal aborted before decoding still cancels the raw source", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Fixture input already cancelled."));
    let cancelled = false;
    const source = new ReadableStream({ cancel() { cancelled = true; } });
    const response = await raw("openai-completions", "", { ...chatRequest, stream: true }, { body: source, signal: controller.signal });
    expect(await response.text()).toContain('"error"');
    expect(cancelled).toBe(true);
  }, 1000);

  test("a provider terminal before source EOF completes rather than aborting the response", async () => {
    let input;
    let cancelled = false;
    const source = new ReadableStream({ start(controller) { input = controller; }, cancel() { cancelled = true; } });
    const response = await raw("openai-completions", "", { ...chatRequest, stream: true }, { body: source });
    const pending = response.text();
    input.enqueue(encoder.encode(sse(chatEvents)));
    const text = await pending;
    expect(text).toContain("Hello");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain('"error"');
    expect(cancelled).toBe(true);
  });

  test("an internal parser limit sends an error and closes a live stream", async () => {
    const response = await raw("openai-completions", sse(chatEvents), { ...chatRequest, stream: true }, { maxResponseBytes: 16 });
    const text = await response.text();
    expect(text).toContain('"error"');
    expect(text).toContain("byte limit");
  });

  test("never uses global fetch, including attempted continuation", async () => {
    const before = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Unexpected network fetch."); };
    try {
      const response = await raw("google-gemini-cli", sse([{ response: { candidates: [{ content: { role: "model", parts: [{ text: "First segment" }] }, finishReason: "CONTINUATION", continuationToken: "fixture-token" }] } }]));
      expect(response.status).toBe(502);
      expect(calls).toBe(0);
    } finally { globalThis.fetch = before; }
  });
});

describe("the narrow parser contract", () => {
  test("drops account data rather than transporting a model object", () => {
    const descriptor = descriptorFor({ api: "openai-codex-responses", provider: "fixture", id: "fixture", reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 1024, apiKey: "secret", baseUrl: "https://private.invalid", headers: { authorization: "secret" }, compat: { extraBody: { token: "secret" }, toolNamePrefix: "safe_" } });
    expect(descriptor.api).toBe("openai-responses");
    expect(JSON.stringify(descriptor)).not.toContain("secret");
    expect(JSON.stringify(descriptor)).not.toContain("private.invalid");
    expect(descriptor.compat.toolNamePrefix).toBe("safe_");
    expect(supportsRawApi("cursor-agent")).toBe(false);
    expect(supportsRawApi("bedrock-converse-stream")).toBe(false);
  });

  test("rejects unknown fields, URLs, controls, and invalid parser settings", () => {
    const good = JSON.parse(recipe("openai-completions"));
    for (const changed of [{ ...good, baseUrl: "https://private.invalid" }, { ...good, provider: "bad\nprovider" }, { ...good, compat: { headers: {} } }, { ...good, compat: { toolNamePrefix: "x".repeat(65) } }, { ...good, input: ["text", "text"] }, { ...good, maxTokens: -1 }]) {
      expect(() => parseRecipe(JSON.stringify(changed))).toThrow();
    }
    expect(() => parseRecipe(JSON.stringify({ ...good, id: "bad\u0085model" }))).toThrow();
    expect(() => parseRecipe(recipe("openai-completions").replace('"compat":{}', '"compat":{"escapeBuiltinToolNames":true,"escapeBuiltinToolNames":false}'))).toThrow("Duplicate");
  });

  test("admits only the AG provider and a known public codec family", () => {
    const base = JSON.parse(recipe("openai-completions"));
    const ag = { ...base, api: "antigravity2api", provider: "google-antigravity", compat: { agProvider: "google" } };
    for (const family of ["google", "anthropic", "openai"]) {
      expect(parseRecipe(serializeRecipe({ ...ag, compat: { agProvider: family } })).compat.agProvider).toBe(family);
    }
    for (const invalid of [
      { ...ag, compat: {} }, { ...ag, compat: { agProvider: "unknown" } },
      { ...ag, provider: "other" }, { ...ag, api: "google-gemini-cli" },
      { ...ag, compat: { agProvider: "google", projectId: "server-only" } },
    ]) expect(() => parseRecipe(JSON.stringify(invalid))).toThrow();
  });

  test("normalizes only optional nulls and tool identifier slots", () => {
    const body = { ...chatRequest, tools: null, metadata: null, _zproxy_ag: { version: 1, messages: [] }, messages: [{ role: "assistant", content: null, tool_calls: [{ id: "long-id", type: "function", function: { name: "f", arguments: '{"tool_call_id":"opaque"}' } }] }, { role: "tool", tool_call_id: "long-id", content: "ok" }] };
    const normalized = normalizeOpenAIRequest("/v1/chat/completions", body);
    expect(normalized.tools).toBeUndefined();
    expect(normalized.metadata).toBeUndefined();
    expect(normalized._zproxy_ag).toBeUndefined();
    expect(body._zproxy_ag).toEqual({ version: 1, messages: [] });
    expect(normalized.messages[0].content).toBeNull();
    expect(normalized.messages[0].tool_calls[0].function.arguments).toBe('{"tool_call_id":"opaque"}');
    expect(normalized.messages[0].tool_calls[0].id).toBe(normalized.messages[1].tool_call_id);
    expect(body.messages[0].tool_calls[0].id).toBe("long-id");
    expect(() => normalizeOpenAIRequest("/v1/completions", { model: "a", prompt: ["a", "b"] })).toThrow();
    expect(() => normalizeOpenAIRequest("/v1/completions", { model: "a", prompt: "a", echo: true })).toThrow();
  });

  test("rejects an oversized IPC envelope before allocating its body", async () => {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, 65537);
    await expect(readDecodeRequest(new Request("http://localhost/decode", { method: "POST", body: size }))).rejects.toThrow("envelope size");
  });
});

test("private HTTP IPC sends response bytes before request EOF", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "local-test-"));
  const socketPath = join(directory, "local.sock");
  let server;
  try { server = await startLocal(socketPath); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const original = encoder.encode(JSON.stringify({ ...chatRequest, stream: true }));
  const envelope = encoder.encode(JSON.stringify({ version: 1, path: "/v1/chat/completions", requestBytes: original.length, metadata: { decoder: "omp-response", version: 1, recipe: recipe("openai-completions", { streamMarkupHealingPattern: null }) }, status: 200, headers: [["content-type", "text/event-stream"]] }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(envelope.length);
  const socket = createConnection({ path: socketPath });
  const arrived = Promise.withResolvers();
  const completed = Promise.withResolvers();
  let response = "";
  let sentTail = false;
  const writeChunk = bytes => { socket.write(bytes.length.toString(16) + "\r\n"); socket.write(bytes); socket.write("\r\n"); };
  const timer = setTimeout(() => { arrived.reject(new Error("No early IPC response.")); completed.reject(new Error("No complete IPC response.")); }, 5000);
  completed.promise.catch(() => {});
  socket.on("error", error => { arrived.reject(error); completed.reject(error); });
  socket.on("data", chunk => {
    response += chunk.toString();
    if (response.includes('"content":"Hello"')) arrived.resolve(true);
    if (sentTail && response.includes("data: [DONE]") && /\r\n0\r\n\r\n$/.test(response)) completed.resolve(true);
  });
  try {
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("POST /decode HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n");
    writeChunk(Buffer.concat([length, envelope, original, Buffer.from(sse(chatEvents.slice(0, 1)))]));
    expect(await arrived.promise).toBe(true);
    expect(response).toContain("Transfer-Encoding: chunked");
    sentTail = true;
    writeChunk(Buffer.from(sse(chatEvents.slice(1))));
    socket.write("0\r\n\r\n");
    expect(await completed.promise).toBe(true);
    expect(response).toContain("Hello");
  } finally {
    clearTimeout(timer);
    socket.destroy();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
