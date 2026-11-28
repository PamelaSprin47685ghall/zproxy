import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteGateway, userScope, validateConfig } from "./remote.mjs";
import { patchUpstream } from "./patch-upstream.mjs";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway/server";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const id = "c".repeat(32);
const headers = { "content-type": "application/json", "x-zproxy-user-id": id,
  "x-zproxy-user-nickname": Buffer.from("Fixture user").toString("base64url") };
const text = 'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"owned loopback"},"finish_reason":null}]}\n\n'
  + 'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'
  + "data: [DONE]\n\n";

let dir;
let server;
let gateway;
let gatewayConfig;
let gatewayInit;
let seen;
let mistralRequest;

beforeAll(async () => {
  registerCustomApi("fixture-native", selected => {
    const stream = new AssistantMessageEventStream();
    const message = { role: "assistant", api: "fixture-native", provider: selected.provider, model: selected.id,
      content: [{ type: "text", text: "native fixture" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "native fixture", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: "native fixture", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  }, "zproxy-remote-test");
  dir = await mkdtemp(join(tmpdir(), "zproxy-omp-remote-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen = { url: request.url, auth: request.headers.get("authorization"), body: await request.json(), headers: request.headers };
    return new Response(text, { headers: { "content-type": "text/event-stream", "x-account-secret": "must-stay-remote" } });
  } });
  const modelsFile = join(dir, "models.yml");
  const model = { id: "deepseek-v4-1-flash-1017", name: "Mistral DeepSeek fixture", reasoning: true,
    input: ["text"], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  await writeFile(modelsFile, JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-credential-only-on-server",
    models: [{ id: "demo", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  }, mistral: { api: "openai-completions", baseUrl: "https://api.mistral.ai/v1",
    apiKey: "fixture-mistral-key", models: [model] } } }));
  gatewayConfig = { version: 1, authDatabase: join(dir, "auth.db"), modelsFile,
    discovery: "offline", aliases: { friendly: "fixture/demo" } };
  gatewayInit = {
    async fetch(input, init) {
      if (String(input) !== "https://api.mistral.ai/v1/chat/completions") return fetch(input, init);
      const request = new Request(input, init);
      mistralRequest = { headers: request.headers, body: await request.json() };
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    },
    routingFactory({ storage, dispatch }) {
      storage.keys.setRuntime("fallback", "fixture-native-key");
      const model = buildModel({ api: "fixture-native", provider: "fallback", id: "native", name: "Native fixture",
        baseUrl: "http://127.0.0.1/never-used", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      const fallback = createAuthGatewayRouter({ storage, resolveModel: id => id === "fallback/native" ? model : undefined });
      return { async dispatch(request, peer, scope) {
        const body = await request.clone().json();
        return body.model === "fallback/native" ? fallback.route(request, peer, scope) : dispatch(request, peer, scope);
      }, router: {
        statusView: () => ({
          routes: [{ id: "fixture-route", title: "Fixture route", strategy: "fixture-strategy" }],
          metrics: { M01: { id: "M01", label: "Fixture metric" } },
        }),
      }, close: () => fallback.close() };
    } };
  gateway = await createRemoteGateway(gatewayConfig, gatewayInit);
}, 30000);

afterAll(async () => { await gateway?.close(); unregisterCustomApis("zproxy-remote-test"); server?.stop(true); if (dir) await rm(dir, { recursive: true, force: true }); });

describe("official remote OMP gateway", () => {
  test("uses server models and credentials, then hands off the original upstream body", async () => {
    const response = await gateway.handle(new Request("http://private/v1/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model: "friendly", messages: [{ role: "user", content: "hello" }], stream: true,
        metadata: { call_source: "vibe_code", call_type: "main_call" } }) }));
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-zproxy-decode")).toBe("1");
    const length = new DataView(bytes.buffer).getUint32(0);
    const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4)));
    expect(metadata).toMatchObject({ decoder: "omp-response", version: 1, modelAlias: "friendly", isStreaming: true });
    expect(JSON.parse(metadata.recipe)).toMatchObject({ api: "openai-completions", provider: "fixture", id: "demo" });
    expect(new TextDecoder().decode(bytes.subarray(length + 4))).toBe(text);
    expect(JSON.stringify(metadata)).not.toMatch(/credential|127\.0\.0\.1|Authorization|baseUrl/);
    expect(seen.auth).toBe("Bearer fixture-credential-only-on-server");
    expect(seen.body.model).toBe("demo");
    expect(seen.body.stream).toBe(true);
    expect(seen.body.stream_options).toEqual({ include_usage: true });
    expect(seen.body).not.toHaveProperty("metadata");
    expect(seen.headers.has("x-zproxy-user-id")).toBe(false);
    expect(response.headers.has("x-account-secret")).toBe(false);
  });

  test("sends DeepSeek through Mistral's streaming format with server credentials", async () => {
    const response = await gateway.handle(new Request("http://private/v1/chat/completions", { method: "POST",
      headers: { ...headers, "user-agent": "caller-ua", authorization: "Bearer caller-key" },
      body: JSON.stringify({ model: "mistral/deepseek-v4-1-flash-1017", stream: true,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] }) }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(text);
    expect(mistralRequest.headers.get("authorization")).toBe("Bearer fixture-mistral-key");
    expect(mistralRequest.headers.get("user-agent")).toBe("mistral-client-python/Mistral-Vibe/3.1.3");
    expect(mistralRequest.body).toMatchObject({ model: "deepseek-v4-1-flash-1017", stream: true,
      messages: [{ role: "user", content: "hello" }], parallel_tool_calls: true,
      tools: [{ type: "function", function: { name: "lookup" } }] });
    expect(mistralRequest.body).not.toHaveProperty("stream_options");
    expect(mistralRequest.body.metadata).toEqual({ call_source: "vibe_code", call_type: "main_call" });
  });

  test("preserves caller-supplied Vibe attribution on the official Mistral endpoint", async () => {
    const metadata = { call_source: "vibe_code", call_type: "secondary_call", client_version: "3.1.3", session_id: "fixture-session" };
    const response = await gateway.handle(new Request("http://private/v1/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model: "mistral/deepseek-v4-1-flash-1017", stream: true,
        messages: [{ role: "user", content: "hello" }], metadata }) }));
    expect(await response.text()).toContain(text);
    expect(mistralRequest.body.metadata).toEqual(metadata);
  });

  test("normalizes legacy completions before the official parser", async () => {
    const response = await gateway.handle(new Request("http://private/v1/completions", { method: "POST", headers,
      body: JSON.stringify({ model: "friendly", prompt: "legacy question", stream: false, tools: null }) }));
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    const length = new DataView(bytes.buffer).getUint32(0);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4))).isStreaming).toBe(false);
    expect(seen.body.messages.some(message => message.content === "legacy question")).toBe(true);
  });

  test("requires a trusted identity and never serves gateway administration", async () => {
    const response = await gateway.handle(new Request("http://private/v1/chat/completions", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect((await gateway.handle(new Request("http://private/v1/credentials/check", { headers }))).status).toBe(404);
  });

  test("the actual semantic fallback returns legacy text JSON and SSE", async () => {
    for (const streaming of [false, true]) {
      const response = await gateway.handle(new Request("http://private/v1/completions", { method: "POST", headers,
        body: JSON.stringify({ model: "fallback/native", prompt: "hello", stream: streaming }) }));
      expect(response.status).toBe(200);
      expect(response.headers.has("x-zproxy-decode")).toBe(false);
      const text = await response.text();
      expect(text).toContain('"object":"text_completion"');
      expect(text).toContain('"text":"native fixture"');
      expect(text).not.toContain('"object":"chat.completion');
      if (streaming) expect(text).toContain("data: [DONE]");
    }
  });
});

describe("admin routing snapshot", () => {
  test("reports the full router snapshot through statusSnapshot", () => {
    const snapshot = JSON.parse(gateway.statusSnapshot());
    expect(snapshot.available).toBe(true);
    expect(snapshot.routes).toEqual([{
      id: "fixture-route",
      title: "Fixture route",
      strategy: "fixture-strategy",
    }]);
    expect(snapshot.metrics.M01.id).toBe("M01");
  });

  test("fails closed when no router is configured", async () => {
    const config = { ...gatewayConfig, authDatabase: join(dir, "auth-no-router.db") };
    const init = { ...gatewayInit, routingFactory: ({ dispatch }) => ({ dispatch, close: () => {} }) };
    const withoutRouter = await createRemoteGateway(config, init);
    try {
      const snapshot = JSON.parse(withoutRouter.statusSnapshot());
      expect(snapshot.available).toBe(false);
      expect(snapshot.reason).toBe("路由统计未启用");
    } finally {
      await withoutRouter.close();
    }
  });
});

test("user session pins cannot cross authenticated users", () => {
  const first = userScope(new Headers(headers));
  const second = userScope(new Headers({ ...headers, "x-zproxy-user-id": "d".repeat(32) }));
  expect(first.credentialSessionId("fixture", "same-session")).not.toBe(second.credentialSessionId("fixture", "same-session"));
  expect(first.credentialSessionId("fixture", "same-session")).toBe(first.credentialSessionId("fixture", "same-session"));
});

test("configuration mistakes fail closed", () => {
  expect(() => validateConfig({ version: 1, authDatabase: "/fixture/auth.db", clientAccountSnapshot: {} })).toThrow("Unknown OMP configuration");
});

test("the checked OMP patch is idempotent and rejects drift", async () => {
  const source = join(import.meta.dir, "vendor/omp");
  expect(await patchUpstream(source)).toBe(0);
  const copy = await mkdtemp(join(tmpdir(), "zproxy-patch-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(copy, "packages/ai/src/auth-gateway"), { recursive: true });
  await mkdir(join(copy, "packages/ai/src/registry/oauth"), { recursive: true });
  const files = ["packages/ai/src/auth-gateway/dispatch.ts", "packages/ai/src/auth-gateway/server.ts",
    "packages/ai/src/registry/oauth/index.ts"];
  for (const file of files) {
    await writeFile(join(copy, file), await readFile(join(source, file)));
  }
  expect(await patchUpstream(copy)).toBe(0);
  for (const file of files) {
    await writeFile(join(copy, file), "unexpected upstream source");
    await expect(patchUpstream(copy)).rejects.toThrow("expected exactly one");
    await writeFile(join(copy, file), await readFile(join(source, file)));
  }
  await rm(copy, { recursive: true, force: true });
});
