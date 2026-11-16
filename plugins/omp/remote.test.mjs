import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteGateway, userScope, validateConfig } from "./remote.mjs";
import { patchUpstream } from "./patch-upstream.mjs";

const id = "c".repeat(32);
const headers = { "content-type": "application/json", "x-zproxy-user-id": id,
  "x-zproxy-user-nickname": Buffer.from("Fixture user").toString("base64url") };
const text = 'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"owned loopback"},"finish_reason":null}]}\n\n'
  + 'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'
  + "data: [DONE]\n\n";

let dir;
let server;
let gateway;
let seen;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "zproxy-omp-remote-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen = { url: request.url, auth: request.headers.get("authorization"), body: await request.json(), headers: request.headers };
    return new Response(text, { headers: { "content-type": "text/event-stream", "x-account-secret": "must-stay-remote" } });
  } });
  const modelsFile = join(dir, "models.yml");
  await writeFile(modelsFile, JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-credential-only-on-server",
    models: [{ id: "demo", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  gateway = await createRemoteGateway({ version: 1, authDatabase: join(dir, "auth.db"), modelsFile,
    discovery: "offline", aliases: { friendly: "fixture/demo" } }, { fetch });
}, 30000);

afterAll(async () => { await gateway?.close(); server?.stop(true); if (dir) await rm(dir, { recursive: true, force: true }); });

describe("official remote OMP gateway", () => {
  test("uses server models and credentials, then hands off the original upstream body", async () => {
    const response = await gateway.handle(new Request("http://private/v1/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model: "friendly", messages: [{ role: "user", content: "hello" }], stream: true }) }));
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
    expect(seen.headers.has("x-zproxy-user-id")).toBe(false);
    expect(response.headers.has("x-account-secret")).toBe(false);
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
  for (const file of ["dispatch.ts", "server.ts"]) {
    await writeFile(join(copy, "packages/ai/src/auth-gateway", file), await readFile(join(source, "packages/ai/src/auth-gateway", file)));
  }
  await writeFile(join(copy, "packages/ai/src/auth-gateway/dispatch.ts"), "unexpected upstream source");
  await expect(patchUpstream(copy)).rejects.toThrow("The pinned OMP source changed");
  await rm(copy, { recursive: true, force: true });
});
