import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteGateway } from "./remote.mjs";
import { unpackRoutingResponse, packRoutingResponse } from "./remote-routing.mjs";
import { patchShims } from "./patch-shims.mjs";

const encoder = new TextEncoder();
const payload = 'data: {"choices":[{"index":0,"delta":{"content":"raw answer"},"finish_reason":null}]}\n\n'
  + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n'
  + "data: [DONE]\n\n";

function framed(metadata, raw) {
  const json = encoder.encode(JSON.stringify(metadata));
  const prefix = new Uint8Array(4 + json.length);
  new DataView(prefix.buffer).setUint32(0, json.length);
  prefix.set(json, 4);
  return new Response(new ReadableStream({ start(target) {
    // Deliberately split both the length and JSON, then combine the last JSON byte with raw data.
    target.enqueue(prefix.subarray(0, 2));
    target.enqueue(prefix.subarray(2, prefix.length - 1));
    target.enqueue(new Uint8Array([prefix.at(-1), ...encoder.encode(raw)]));
    target.close();
  } }), { headers: { "x-zproxy-decode": "1", "content-type": "text/event-stream" } });
}

test("routing metrics see only raw bytes and public alias rewriting never changes provider bytes", async () => {
  const meta = { decoder: "omp-response", version: 1, modelAlias: "模型/model", recipe: "{}" };
  const unpacked = await unpackRoutingResponse(framed(meta, payload));
  expect(unpacked.headers.get("x-zproxy-private-metadata")).toBeTruthy();
  const packed = await packRoutingResponse(unpacked, "lazy/公共");
  expect(packed.headers.has("x-zproxy-private-metadata")).toBe(false);
  const bytes = new Uint8Array(await packed.arrayBuffer());
  const length = new DataView(bytes.buffer).getUint32(0);
  expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4))).modelAlias).toBe("lazy/公共");
  expect(new TextDecoder().decode(bytes.subarray(length + 4))).toBe(payload);
});

test("routing metadata bounds cancel the raw body", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({ start(target) { target.enqueue(new Uint8Array([0, 1, 0, 0])); },
    cancel() { canceled = true; } }), { headers: { "x-zproxy-decode": "1" } });
  await expect(unpackRoutingResponse(response)).rejects.toThrow("exceeds its limit");
  expect(canceled).toBe(true);
});

test("a routing prefix failure releases the response and long aliases remain local", async () => {
  let canceled = false;
  const broken = new Response(new ReadableStream({ cancel() { canceled = true; } }),
    { headers: { "x-zproxy-private-metadata": Buffer.from("invalid json").toString("base64url") } });
  await expect(packRoutingResponse(broken, "public")).rejects.toThrow();
  expect(canceled).toBe(true);
  const unpacked = await unpackRoutingResponse(framed({ decoder: "omp-response", version: 1 }, payload));
  const packed = await packRoutingResponse(unpacked, "界".repeat(43));
  const bytes = new Uint8Array(await packed.arrayBuffer());
  const length = new DataView(bytes.buffer).getUint32(0);
  expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4))).modelAlias).toBe("");
});

test("original lazy policy fails over using shared server state and preserves raw SSE", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zproxy-routing-"));
  let gateway;
  const calls = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json();
    calls.push({ model: body.model, auth: request.headers.get("authorization") });
    if (body.model === "unavailable") return Response.json({ error: { message: "insufficient_quota" } }, { status: 429 });
    return new Response(payload, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const model = id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const modelsFile = join(folder, "models.yml");
    await writeFile(modelsFile, JSON.stringify({ providers: { fixture: { api: "openai-completions",
      baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "server-route-secret", models: [model("unavailable"), model("good")] } } }));
    await writeFile(join(folder, "routes.json"), JSON.stringify({ contextWindow: 8192, maxOutputTokens: 1024,
      peakWindows: [{ from: "00:00", to: "24:00" }],
      routes: { "lazy/public": { graph: { type: "fallback", children: [
        { type: "model", model: "fixture/unavailable" }, { type: "model", model: "fixture/good" },
      ] } } } }));
    const shimsConfig = join(folder, "shims.json");
    await writeFile(shimsConfig, JSON.stringify({ version: 2, stateDbPath: join(folder, "routing.sqlite"),
      features: { "lazy-router": { enabled: true, routesFile: "routes.json", store: "sqlite", headerTimeoutMs: 3000 },
        "plugin-bridge": { enabled: false }, "kiro-credential-sync": { enabled: false } } }));
    gateway = await createRemoteGateway({ version: 1, authDatabase: join(folder, "auth.db"), modelsFile, shimsConfig,
      discovery: "offline", headerTimeoutMs: 3000 }, { fetch });
    const invoke = async id => {
      const response = await gateway.handle(new Request("http://private/v1/chat/completions", { method: "POST", headers: {
        "content-type": "application/json", "x-zproxy-user-id": id.repeat(32),
        "x-zproxy-user-nickname": Buffer.from("Route user").toString("base64url"),
      }, body: JSON.stringify({ model: "lazy/public", messages: [{ role: "user", content: "hello" }], stream: true }) }));
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(response.headers.has("x-zproxy-private-metadata")).toBe(false);
      const length = new DataView(bytes.buffer).getUint32(0);
      const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4)));
      expect(metadata.modelAlias).toBe("lazy/public");
      expect(JSON.parse(metadata.recipe).id).toBe("good");
      expect(new TextDecoder().decode(bytes.subarray(length + 4))).toBe(payload);
      expect(JSON.stringify(metadata)).not.toContain("server-route-secret");
    };
    await invoke("a");
    const failedCalls = calls.filter(call => call.model === "unavailable").length;
    expect(failedCalls).toBeGreaterThan(0);
    await invoke("b");
    expect(calls.filter(call => call.model === "unavailable").length).toBe(failedCalls);
    expect(calls.every(call => call.auth === "Bearer server-route-secret")).toBe(true);
  } finally { await gateway?.close(); server.stop(true); await rm(folder, { recursive: true, force: true }); }
}, 20000);

test("the two raw routing patches reject upstream drift", async () => {
  const root = join(import.meta.dir, "vendor/shims");
  expect(await patchShims(root)).toBe(0);
  const folder = await mkdtemp(join(tmpdir(), "zproxy-routing-patch-"));
  try {
    await cp(join(root, "lib/router"), join(folder, "lib/router"), { recursive: true });
    await writeFile(join(folder, "lib/router/dispatcher.mjs"), "changed upstream");
    await expect(patchShims(folder)).rejects.toThrow("The pinned shim source changed");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
