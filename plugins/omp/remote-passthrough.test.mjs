import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkedResponse, createRemoteGateway } from "./remote.mjs";
import { createPassthrough } from "./remote-passthrough.mjs";

let folder;
let server;
let gateway;
let seen;
let refreshKey;
let refreshHeader;
const refreshed = [];
const headers = { "content-type": "application/json", "x-zproxy-user-id": "a".repeat(32),
  "x-zproxy-user-nickname": Buffer.from("Fast path user").toString("base64url") };
const event = 'data: {"id":"chatcmpl-fast","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"fast"},"finish_reason":null}]}\n\n'
  + 'data: {"id":"chatcmpl-fast","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n'
  + "data: [DONE]\n\n";
const answer = { id: "chatcmpl-fast", object: "chat.completion", created: 1, model: "demo",
  choices: [{ index: 0, message: { role: "assistant", content: "fast" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "zproxy-pass-"));
  refreshKey = join(folder, "refresh-key");
  refreshHeader = join(folder, "refresh-header");
  await writeFile(refreshKey, "old-key");
  await writeFile(refreshHeader, "old-header");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen = { body: await request.json(), auth: request.headers.get("authorization"),
      serverToken: request.headers.get("x-server-token"), url: request.url };
    if (seen.body.model === "refresh") {
      refreshed.push(seen);
      if (refreshed.length === 1) {
        await writeFile(refreshKey, "new-key");
        await writeFile(refreshHeader, "new-header");
        return Response.json({ error: { message: "expired fixture credentials" } }, { status: 401 });
      }
    }
    return seen.body.stream ? new Response(event, { headers: { "content-type": "text/event-stream" } }) : Response.json(answer);
  } });
  const modelsFile = join(folder, "models.yml");
  const model = { id: "demo", name: "Demo",
      reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const provider = { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [model] };
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(modelsFile, JSON.stringify({ providers: {
    fixture: { ...provider, apiKey: "server-fast-key" },
    "fixture-keyless": { ...provider, auth: "none" },
    "fixture-refresh": { ...provider, apiKey: `!cat ${quote(refreshKey)}`,
      headers: { "x-server-token": `!cat ${quote(refreshHeader)}` }, models: [{ ...model, id: "refresh" }] },
  } }));
  gateway = await createRemoteGateway({ version: 1, authDatabase: join(folder, "auth.db"), modelsFile, discovery: "offline",
    aliases: { friendly: "fixture/demo" }, passthroughProviders: ["fixture", "fixture-keyless", "fixture-refresh"] }, { fetch });
}, 30000);
afterAll(async () => { await gateway?.close(); server?.stop(true); if (folder) await rm(folder, { recursive: true, force: true }); });

const invoke = (body, path = "/v1/chat/completions") => gateway.handle(new Request(`http://private${path}`, { method: "POST", headers, body: JSON.stringify(body) }));

test("explicit same-wire providers bypass both semantic parsers and keep tool IDs", async () => {
  const id = "a-tool-call-id-that-the-original-upstream-already-accepts";
  const response = await invoke({ model: "friendly", stream: true, messages: [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: "result" },
  ] });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-zproxy-passthrough")).toBe("1");
  expect(response.headers.has("x-zproxy-decode")).toBe(false);
  expect(await response.text()).toBe(event);
  expect(seen.auth).toBe("Bearer server-fast-key");
  expect(seen.body.model).toBe("demo");
  expect(seen.body.messages[0].tool_calls[0].id).toBe(id);
  expect(seen.body.messages[1].tool_call_id).toBe(id);
});

test("JSON responses remain byte-for-byte OpenAI responses with the upstream model name", async () => {
  const response = await invoke({ model: "friendly", stream: false, messages: [{ role: "user", content: "hello" }] });
  expect(response.headers.get("x-zproxy-passthrough")).toBe("1");
  expect(await response.json()).toEqual(answer);
  expect(seen.body.stream).toBe(false);
});

test("an explicitly keyless model uses the official no-auth sentinel without sending a bearer", async () => {
  expect(await gateway.registry.getApiKeyWithCredentialForProvider("fixture-keyless", "keyless-test"))
    .toEqual({ apiKey: "N/A" });
  const response = await invoke({ model: "fixture-keyless/demo", messages: [{ role: "user", content: "hello" }] });
  expect(response.headers.get("x-zproxy-passthrough")).toBe("1");
  expect(await response.json()).toEqual(answer);
  expect(seen.auth).toBeNull();
});

test("an auth retry resolves command-backed headers again after the official cache invalidation", async () => {
  const response = await invoke({ model: "fixture-refresh/refresh", messages: [{ role: "user", content: "hello" }] });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(answer);
  expect(refreshed.map(item => [item.auth, item.serverToken]))
    .toEqual([["Bearer old-key", "old-header"], ["Bearer new-key", "new-header"]]);
});

test("built-in providers, OAuth pools, custom transports, and unlisted providers keep the official path", async () => {
  for (const guard of [
    { provider: "openai" },
    { provider: "fixture", oauth: true },
    { provider: "fixture", transport: true },
    { provider: "unlisted" },
  ]) {
    let touched = false;
    const forbidden = () => { touched = true; throw new Error("A refused shortcut must not resolve credentials or fetch."); };
    const shortcut = createPassthrough({
      config: { passthroughProviders: ["fixture", "openai"] },
      storage: { credentials: { hasOAuth: () => guard.oauth === true } },
      registry: { getApiKeyWithCredentialForProvider: forbidden },
      resolveModel: () => ({ provider: guard.provider, api: "openai-completions" }),
      usesCustomTransport: () => guard.transport === true,
      fetch: forbidden,
    });
    const response = await shortcut(new Request("http://private/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "fixture/demo", messages: [] }),
    }), { completionPath: "/v1/chat/completions", allows: () => true });
    expect(response).toBeUndefined();
    expect(touched).toBe(false);
  }
});

test("a pending shortcut body releases its account hold on cancellation, error, and clean end", async () => {
  const first = new TextEncoder().encode(event.slice(0, event.indexOf("\n\n") + 2));
  for (const end of ["cancel", "error", "eof"]) {
    let upstream;
    let canceled = false;
    let holds = 0;
    let transportSignal;
    const source = new ReadableStream({
      start(controller) { upstream = controller; controller.enqueue(first); },
      cancel() { canceled = true; },
    });
    const shortcut = createPassthrough({
      config: { passthroughProviders: ["fixture"], headerTimeoutMs: 1000, idleTimeoutMs: 1000 },
      storage: gateway.storage, registry: gateway.registry,
      resolveModel: () => gateway.registry.find("fixture", "demo"),
      fetch: async (_input, init) => {
        transportSignal = init.signal;
        return new Response(source, { headers: { "content-type": "text/event-stream", "authorization": "private-server-key" } });
      },
    });
    const response = await shortcut(new Request("http://private/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "fixture/demo", stream: true, messages: [] }),
    }), {
      name: "fixture-user", completionPath: "/v1/chat/completions", allows: () => true,
      credentialSessionId: () => `lifetime-${end}`,
      retain() { holds++; return () => { holds--; }; },
    });
    expect(holds).toBe(1);
    expect(response.headers.has("authorization")).toBe(false);
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(first);
    const pending = reader.read();
    if (end === "cancel") {
      await reader.cancel();
      expect(await pending).toEqual({ value: undefined, done: true });
      expect(canceled).toBe(true);
    } else if (end === "error") {
      upstream.error(new Error("private fixture error"));
      await expect(pending).rejects.toThrow("The OpenAI shortcut response stopped.");
    } else {
      upstream.close();
      expect(await pending).toEqual({ value: undefined, done: true });
    }
    reader.releaseLock();
    expect(holds).toBe(0);
    expect(transportSignal.aborted).toBe(true);
  }
});

test("legacy prompts retain the official gateway and local decoder path", async () => {
  const response = await invoke({ model: "friendly", prompt: "hello", stream: false }, "/v1/completions");
  expect(response.headers.get("x-zproxy-decode")).toBe("1");
  expect(response.headers.has("x-zproxy-passthrough")).toBe(false);
  await response.arrayBuffer();
  expect(seen.body.stream).toBe(true);
});

test("the private passthrough marker never enters the core HTTP bridge", async () => {
  const response = await invoke({ model: "friendly", stream: true, messages: [{ role: "user", content: "hello" }] });
  const publicResponse = chunkedResponse(response);
  expect(publicResponse.headers.has("x-zproxy-passthrough")).toBe(false);
  expect(await publicResponse.text()).toBe(event);
});
