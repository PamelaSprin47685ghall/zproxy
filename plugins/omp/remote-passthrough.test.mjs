import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkedResponse, createRemoteGateway } from "./remote.mjs";

let folder;
let server;
let gateway;
let seen;
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
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen = { body: await request.json(), auth: request.headers.get("authorization"), url: request.url };
    return seen.body.stream ? new Response(event, { headers: { "content-type": "text/event-stream" } }) : Response.json(answer);
  } });
  const modelsFile = join(folder, "models.yml");
  await writeFile(modelsFile, JSON.stringify({ providers: { fixture: { api: "openai-completions",
    baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "server-fast-key", models: [{ id: "demo", name: "Demo",
      reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  gateway = await createRemoteGateway({ version: 1, authDatabase: join(folder, "auth.db"), modelsFile, discovery: "offline",
    aliases: { friendly: "fixture/demo" }, passthroughProviders: ["fixture"] }, { fetch });
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
