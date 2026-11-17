import { describe, expect, test } from "bun:test";
import { createRawHandoff, usageTap } from "./remote-handoff.mjs";
import { descriptorFor, serializeRecipe } from "./contract.mjs";
import { continueGoogle } from "./remote-google.mjs";

const model = { api: "openai-completions", provider: "fixture", id: "fixture-model", input: ["text"],
  reasoning: false, contextWindow: 8192, maxTokens: 1024, baseUrl: "http://secret-authority.invalid/v1", headers: { Authorization: "server-account-secret" } };
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const result = event({ choices: [{ delta: { content: "hello" } }] });
const done = event({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } }) + "data: [DONE]\n\n";

function turnFor(fetcher, selected = model, maxAttempts = 1) {
  let settled = 0;
  let parsed = false;
  let usage;
  const controller = new AbortController();
  const options = { signal: controller.signal, fetch: fetcher };
  const turn = {
    model: selected, controller, options, parsed: { modelId: "public-alias", stream: true },
    settle() { settled++; }, observeUsage(value) { usage = value; },
    stream() {
      const promise = (async () => {
        try {
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const response = await options.fetch("http://127.0.0.1/v1/chat/completions", {
              method: "POST", headers: { Authorization: "Bearer server-account-secret" }, body: "{}", signal: controller.signal,
            });
            if (!response.ok) { await response.body?.cancel(); continue; }
            parsed = true;
            await response.text();
          }
          return { stopReason: "error" };
        } catch { return { stopReason: controller.signal.aborted ? "aborted" : "error" }; }
      })();
      return { result: () => promise };
    },
  };
  return { turn, state: () => ({ settled, parsed, usage }) };
}

function unpack(bytes) {
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return { metadata: JSON.parse(new TextDecoder().decode(bytes.subarray(4, size + 4))), raw: new TextDecoder().decode(bytes.subarray(size + 4)) };
}

const handoff = options => createRawHandoff({ descriptorFor, serializeRecipe, headerTimeoutMs: 1000, idleTimeoutMs: 1000, ...options });

describe("remote raw response ownership", () => {
  test("sends raw bytes before OMP parses, then releases the official lease", async () => {
    let upstream;
    const stream = new ReadableStream({ start(controller) { upstream = controller; controller.enqueue(Buffer.from(result)); } });
    const fixture = turnFor(async () => new Response(stream, { headers: { "content-type": "text/event-stream", "x-account-secret": "never-transfer" } }));
    const response = await handoff()(fixture.turn);
    expect(response.headers.get("x-zproxy-decode")).toBe("1");
    expect(response.headers.has("x-account-secret")).toBe(false);
    expect(fixture.state().parsed).toBe(false);
    const reader = response.body.getReader();
    const prefix = await reader.read();
    expect(unpack(prefix.value).metadata.modelAlias).toBe("public-alias");
    expect(JSON.stringify(unpack(prefix.value).metadata)).not.toMatch(/secret-authority|Authorization|server-account-secret/);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(result);
    expect(fixture.state().settled).toBe(0);
    upstream.enqueue(Buffer.from(done));
    upstream.close();
    let tail = "";
    for (;;) { const item = await reader.read(); if (item.done) break; tail += new TextDecoder().decode(item.value); }
    expect(tail).toBe(done);
    expect(fixture.state()).toMatchObject({ parsed: false, settled: 1, usage: { input: 8, cacheRead: 3, output: 7, totalTokens: 18 } });
  });

  test("keeps rejected responses on the official retry path", async () => {
    let calls = 0;
    const fixture = turnFor(async () => ++calls === 1 ? new Response("retry", { status: 429 })
      : new Response(result + done, { headers: { "content-type": "text/event-stream" } }), model, 2);
    const response = await handoff()(fixture.turn);
    const decoded = unpack(new Uint8Array(await response.arrayBuffer()));
    expect(calls).toBe(2);
    expect(decoded.metadata.attempt).toBe(2);
    expect(decoded.raw).toBe(result + done);
    expect(fixture.state().parsed).toBe(false);
  });

  test("rejects a 200 SSE error before committing raw bytes", async () => {
    let calls = 0;
    const fixture = turnFor(async () => new Response(++calls === 1
      ? event({ error: { type: "rate_limit_error", message: "private upstream details" } }) : result + done,
    { headers: { "content-type": "text/event-stream" } }), model, 2);
    const response = await handoff()(fixture.turn);
    const decoded = unpack(new Uint8Array(await response.arrayBuffer()));
    expect(decoded.metadata.attempt).toBe(2);
    expect(decoded.raw).toBe(result + done);
    expect(decoded.raw).not.toContain("private upstream details");
  });

  test("terminal failures retain status and a safe quota category within the error byte limit", async () => {
    let cancelled = false;
    let inspected = 0;
    const fixture = turnFor(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('insufficient_quota private-token ' + "x".repeat(100000))); },
      cancel() { cancelled = true; },
    }), { status: 400, headers: { "retry-after": "30" } }));
    const response = await handoff({ observeTurn: () => ({ classifyError(text) {
      inspected = Buffer.byteLength(text);
      return text.includes("insufficient_quota") ? "quota" : undefined;
    } }) })(fixture.turn);
    expect(response.status).toBe(400);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toMatchObject({ error: { type: "insufficient_quota" } });
    expect(inspected).toBe(65536);
    expect(cancelled).toBe(true);
    expect(fixture.state().settled).toBe(1);
  });

  test("cancel stops the raw source and releases one lease", async () => {
    let cancelled = false;
    const fixture = turnFor(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(result)); }, cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await handoff()(fixture.turn);
    await response.body.cancel();
    expect(cancelled).toBe(true);
    expect(fixture.state().settled).toBe(1);
    expect(fixture.turn.controller.signal.aborted).toBe(true);
  });

  test("an unsupported transport takes the original semantic path", async () => {
    const fixture = turnFor(() => { throw new Error("must not run"); }, { ...model, api: "bedrock-converse-stream" });
    expect(await handoff()(fixture.turn)).toBeUndefined();
    expect(fixture.state().settled).toBe(0);
  });

  test("a first event deadline closes the official turn", async () => {
    const fixture = turnFor((_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })));
    await expect(handoff({ headerTimeoutMs: 20 })(fixture.turn)).rejects.toThrow("timed out");
    expect(fixture.state().settled).toBe(1);
  });
});

test("usage tap is bounded across fragmented and large events", () => {
  let usage;
  const tap = usageTap(value => { usage = value; }, "openai-responses");
  const text = event({ huge: "x".repeat(100000) }) + event({ response: { usage: { input_tokens: 19, output_tokens: 4, input_tokens_details: { cached_tokens: 7 } } } });
  for (const character of text) tap.push(Buffer.from(character));
  tap.finish();
  expect(usage).toMatchObject({ input: 12, output: 4, cacheRead: 7, totalTokens: 23 });
});

test("Google continuation uses remote credentials and produces one raw stream", async () => {
  const token = "remote-only-continuation-token";
  const first = event({ candidates: [{ content: { parts: [{ text: "first" }] } }] })
    + event({ candidates: [{ finishReason: "CONTINUATION", continuationToken: token }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
  const second = event({ candidates: [{ content: { parts: [{ text: "second" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 } });
  let calls = 0;
  const response = continueGoogle(new Response(first, { headers: { "content-type": "text/event-stream" } }), {
    model: { api: "google-generative-ai" }, input: "http://127.0.0.1/v1/models/demo:streamGenerateContent?alt=sse",
    init: { body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "question" }] }] }), headers: { Authorization: "Bearer private-google-key" } },
    signal: new AbortController().signal, headerTimeoutMs: 1000,
    fetch: async (url, init) => {
      calls++;
      expect(url).toContain("127.0.0.1");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer private-google-key");
      expect(JSON.parse(init.body).continuationToken).toBe(token);
      return new Response(second, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const text = await response.text();
  expect(calls).toBe(1);
  expect(text).toContain("first");
  expect(text).toContain("second");
  expect(text).not.toContain("CONTINUATION");
  expect(text).not.toContain(token);
  expect(text).toContain('"promptTokenCount":22');
  expect(text).toContain('"contextTokenCount":15');
});

function terminalTurn(fetcher, terminal, stream) {
  const controller = new AbortController();
  const options = { signal: controller.signal, fetch: fetcher };
  return {
    model, controller, options, parsed: { modelId: "public-alias", stream },
    settle() {}, observeUsage() {},
    stream() {
      const promise = (async () => {
        const response = await options.fetch("http://private.invalid/v1/responses", {
          method: "POST", headers: { Authorization: "Bearer secret" }, body: "{}", signal: controller.signal });
        await response.text();
        return terminal;
      })();
      return { result: () => promise };
    },
  };
}

const jsonOnly = () => Response.json({ id: "resp_1" }, { headers: { "content-type": "application/json" } });
const success = { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop",
  usage: { input: 8, output: 5, totalTokens: 13 } };

describe("upstream that never yields a raw stream", () => {
  test("encodes the parsed terminal as SSE for a streaming caller", async () => {
    const response = await handoff()(terminalTurn(jsonOnly, success, true));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.has("x-zproxy-decode")).toBe(false);
    const text = await response.text();
    expect(text).toContain('"content":"OK"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("encodes the parsed terminal as one completion for a buffered caller", async () => {
    const response = await handoff()(terminalTurn(jsonOnly, success, false));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("OK");
    expect(body.usage.total_tokens).toBe(13);
  });

  test("still fails when the terminal carries an error", async () => {
    const failed = { role: "assistant", content: [], stopReason: "error" };
    const response = await handoff()(terminalTurn(jsonOnly, failed, true));
    expect(response.status).toBe(502);
    expect((await response.json()).error.type).toBe("upstream_error");
  });
});

test("terminal fallback preserves reasoning and tool calls for both response modes", async () => {
  const terminal = { ...success, content: [
    { type: "thinking", thinking: "considered" },
    { type: "toolCall", id: "call-fixture", name: "lookup", arguments: { city: "Paris" } },
  ], stopReason: "toolUse", usage: { input: 8, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 15 } };
  const buffered = await handoff()(terminalTurn(jsonOnly, terminal, false));
  const json = await buffered.json();
  expect(json.model).toBe("public-alias");
  expect(json.choices[0].message.reasoning_content).toBe("considered");
  expect(json.choices[0].message.tool_calls[0]).toMatchObject({ id: "call-fixture", type: "function", function: { name: "lookup", arguments: '{\"city\":\"Paris\"}' } });
  expect(json.choices[0].finish_reason).toBe("tool_calls");
  expect(json.usage.prompt_tokens).toBe(10);
  const streamed = await handoff()(terminalTurn(jsonOnly, terminal, true));
  const frames = (await streamed.text()).split('\n\n').filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]').map(frame => JSON.parse(frame.slice(6)));
  expect(frames.some(frame => frame.choices?.[0]?.delta?.reasoning_content === "considered")).toBe(true);
  expect(frames.some(frame => frame.choices?.[0]?.delta?.tool_calls?.[0]?.id === "call-fixture")).toBe(true);
  expect(frames.some(frame => frame.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments === '{\"city\":\"Paris\"}')).toBe(true);
  expect(frames.some(frame => frame.choices?.[0]?.finish_reason === "tool_calls")).toBe(true);
});
