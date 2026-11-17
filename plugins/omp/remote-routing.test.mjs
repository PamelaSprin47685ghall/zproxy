import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createRemoteGateway } from "./remote.mjs";
import { acquireProviderOptIn } from "./remote-opt-in.mjs";
import { excludeBlockedAccounts, unpackRoutingResponse, packRoutingResponse, prioritizeDirectAccounts,
  antigravitySchedulable, planWithDirectRoutes, dropPrivateHeaders,
  planProvidersOfRoutes, createAccountCooldowns } from "./remote-routing.mjs";

test("filtering drops only the benched account of a candidate list", () => {
  let now = 1_000;
  const cooldowns = createAccountCooldowns({ now: () => now });
  const candidates = [
    { provider: "ag", account: 1, model: "m" },
    { provider: "ag", account: 2, model: "m" },
    { provider: "other", account: 1, model: "m" },
  ];
  cooldowns.block("ag", 1);
  // The cooldown names one account inside one provider, so the same id under
  // another provider keeps serving.
  expect(excludeBlockedAccounts(candidates, cooldowns).map((c) => `${c.provider}/${c.account}`))
    .toEqual(["ag/2", "other/1"]);
  now += 30 * 60_000;
  expect(excludeBlockedAccounts(candidates, cooldowns)).toHaveLength(3);
});

test("an account-level refusal benches the whole account until its interval ends", () => {
  let now = 1_000;
  const cooldowns = createAccountCooldowns({ now: () => now });
  cooldowns.block("provider", 7);
  expect(cooldowns.blocked("provider", 7)).toBe(true);
  // Another account of the same provider stays usable.
  expect(cooldowns.blocked("provider", 8)).toBe(false);
  // The interval is the routing layer's usual one.
  now += 30 * 60_000 - 1;
  expect(cooldowns.blocked("provider", 7)).toBe(true);
  now += 1;
  expect(cooldowns.blocked("provider", 7)).toBe(false);
});

test("a second refusal extends the bench and a shorter one cannot cut it", () => {
  let now = 1_000;
  const cooldowns = createAccountCooldowns({ now: () => now });
  cooldowns.block("provider", 7);
  now += 10 * 60_000;
  cooldowns.block("provider", 7);
  now += 30 * 60_000 - 1;
  expect(cooldowns.blocked("provider", 7)).toBe(true);
  cooldowns.block("provider", 7, 1_000);
  expect(cooldowns.blocked("provider", 7)).toBe(true);
  now += 1_000;
  expect(cooldowns.blocked("provider", 7)).toBe(false);
});


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

test("the private IPC hop carries the refusal classification and nothing else", async () => {
  // The Go child sets the classification on an official rejection, and this is
  // the only hop between it and the adapter. The allowlist must pass that one
  // header and drop every other child header, so no upstream header can reach
  // the adapter and no worker text can reach a caller.
  const { createAgWorker } = await import("./ag-worker.mjs");
  const { spyOn } = await import("bun:test");
  const encoder = new TextEncoder();
  let server;
  let exiting;
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = import.meta.dir;
  const spawn = spyOn(Bun, "spawn").mockImplementation(args => {
    server = Bun.serve({
      unix: args[2],
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path !== "/official-send") return new Response(null, { status: 404 });
        return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream",
          "x-zproxy-refusal": "request", "retry-after": "9", "x-account-secret": "server-only" } });
      },
    });
    return {
      exitCode: null,
      stdout: new ReadableStream({ start(target) { target.enqueue(encoder.encode("READY\n")); target.close(); } }),
      stderr: new ReadableStream({ start(target) { target.close(); } }),
      exited: new Promise(resolve => { exiting = resolve; }),
      kill() { exiting(0); },
    };
  });
  const worker = createAgWorker({ binary: "/fixture/codec" });
  try {
    const response = await worker.officialSend({ version: 1, handle: "h",
      body: { project: "", model: "m", requestType: "agent", request: {} } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-zproxy-refusal")).toBe("request");
    expect(response.headers.get("retry-after")).toBe("9");
    expect(response.headers.get("x-account-secret")).toBeNull();
    await response.body.cancel();
  } finally {
    await worker.close();
    server?.stop(true);
    spawn.mockRestore();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}, 10000);

test("direct AG scheduling prefers eligible fresh accounts and skips inaccessible accounts", () => {
  const candidates = [1, 2, 3, 4].map(account => ({ account }));
  const credentials = [
    { id: 1, credential: { type: "oauth", email: "not-in-catalog", expires: 2000 } },
    { id: 2, credential: { type: "oauth", email: "allowed-expired", expires: 999 } },
    { id: 3, credential: { type: "oauth", email: "allowed-fresh", expires: 2000 } },
    { id: 4, credential: { type: "oauth", email: "allowed-fresh-too", expires: 2000 } },
  ];
  const model = { accountAccess: { "allowed-expired": {}, "allowed-fresh": {}, "allowed-fresh-too": {} } };
  expect(prioritizeDirectAccounts(candidates, model, credentials, 1000).map(c => c.account)).toEqual([3, 4, 2]);
});

test("direct route injection keeps a configured route and ignores an unschedulable model", () => {
  const configuredRoutes = { "google-antigravity/kept": { graph: { type: "fallback", children: [
    { type: "model", model: "fixture/one" }, { type: "model", model: "fixture/two" },
  ] } } };
  const models = [
    { provider: "google-antigravity", id: "kept", contextWindow: 1000, maxTokens: 100 },
    { provider: "google-antigravity", id: "added", contextWindow: 2000, maxTokens: 200 },
    { provider: "google-antigravity", id: "no-window", maxTokens: 200 },
    { provider: "google-antigravity", id: "zero-tokens", contextWindow: 2000, maxTokens: 0 },
    { provider: "other", id: "ignored", contextWindow: 2000, maxTokens: 200 },
  ];
  expect(antigravitySchedulable(models[2])).toBe(false);
  expect(antigravitySchedulable(models[3])).toBe(false);
  const injected = planWithDirectRoutes(configuredRoutes, models);
  // A configured route keeps its graph: the plan, not the catalog, decides it.
  expect(injected.routes["google-antigravity/kept"].graph.type).toBe("fallback");
  expect(injected.direct.has("google-antigravity/kept")).toBe(false);
  expect(injected.routes["google-antigravity/added"]).toEqual({
    contextWindow: 2000, maxOutputTokens: 200,
    graph: { type: "model", model: "google-antigravity/added" },
  });
  expect([...injected.direct]).toEqual(["google-antigravity/added"]);
  // A model the catalog gains later joins its own route on the next compile.
  const later = planWithDirectRoutes(configuredRoutes, [...models,
    { provider: "google-antigravity", id: "late", contextWindow: 4000, maxTokens: 400 }]);
  expect([...later.direct].sort()).toEqual(["google-antigravity/added", "google-antigravity/late"]);
  expect([...planProvidersOfRoutes(later)].sort()).toEqual(["fixture", "google-antigravity"]);
});

test("a direct Antigravity model without a schedulable account is never taken over by the router", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zproxy-ag-no-account-"));
  let gateway;
  try {
    const modelsFile = join(folder, "models.yml");
    // The catalog publishes the model, but auth.db holds no Antigravity credential.
    await writeFile(modelsFile, JSON.stringify({ providers: { "google-antigravity": {
      api: "google-gemini-cli", auth: "oauth", baseUrl: "http://ag-fixture.invalid",
      models: [{ id: "gemini-fixture", name: "Fixture", reasoning: false, input: ["text"],
        contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(join(folder, "routes.json"), JSON.stringify({ contextWindow: 8192,
      maxOutputTokens: 1024, peakWindows: [{ from: "00:00", to: "24:00" }], routes: {} }));
    const shimsConfig = join(folder, "shims.json");
    await writeFile(shimsConfig, JSON.stringify({ version: 2,
      stateDbPath: join(folder, "routing.db"),
      features: { "lazy-router": { enabled: true, routesFile: "routes.json", store: "memory",
        headerTimeoutMs: 3000 }, "plugin-bridge": { enabled: false },
      "kiro-credential-sync": { enabled: false } } }));
    let upstreamCalls = 0;
    gateway = await createRemoteGateway({ version: 1, antigravity2api: true, discovery: "offline",
      authDatabase: join(folder, "auth.db"), modelsFile, shimsConfig,
      headerTimeoutMs: 1000, idleTimeoutMs: 1000 }, {
      agWorker: { async prepare() { throw new Error("no account may reach the codec"); },
        close() {} },
      async fetch() { upstreamCalls++; return new Response("unexpected"); },
    });
    const response = await gateway.handle(new Request("http://private/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-zproxy-user-id": "b".repeat(32),
        "x-zproxy-user-nickname": Buffer.from("Fixture").toString("base64url") },
      body: JSON.stringify({ model: "google-antigravity/gemini-fixture", stream: true,
        messages: [{ role: "user", content: "hello" }] }),
    }));
    const text = await response.text();
    // The gateway answers for the missing credential; no lazy route may claim it.
    expect(response.status).toBe(401);
    expect(text).not.toContain("lazy_router_unavailable");
    expect(text).not.toContain("no healthy candidate");
    expect(upstreamCalls).toBe(0);
  } finally { await gateway?.close(); await rm(folder, { recursive: true, force: true }); }
}, 20000);


test("configured rating weights select the upstream model through the gateway", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zproxy-rating-gateway-"));
  const calls = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls.push((await request.json()).model);
    return new Response(payload, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const model = id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const modelsFile = join(folder, "models.yml");
    await writeFile(modelsFile, JSON.stringify({ providers: { fixture: { api: "openai-completions",
      baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-key", models: [model("cheap"), model("rich")] } } }));
    await writeFile(join(folder, "routes.json"), JSON.stringify({ contextWindow: 8192, maxOutputTokens: 1024,
      peakWindows: [{ from: "00:00", to: "24:00" }], routes: { "lazy/public": { graph: { type: "rating", children: [
        { type: "model", model: "fixture/cheap", intelligence: 50, cost: 1 },
        { type: "model", model: "fixture/rich", intelligence: 60, cost: 2 },
      ] } } } }));
    for (const [costWeight, expected] of [[0, "rich"], [40, "cheap"]]) {
      const shimsConfig = join(folder, `shims-${costWeight}.json`);
      await writeFile(shimsConfig, JSON.stringify({ version: 2, stateDbPath: join(folder, `state-${costWeight}.db`),
        features: { "lazy-router": { enabled: true, routesFile: "routes.json", store: "memory",
          headerTimeoutMs: 3000, routing: { temperature: 0, costWeight } },
        "plugin-bridge": { enabled: false }, "kiro-credential-sync": { enabled: false } } }));
      const gateway = await createRemoteGateway({ version: 1, authDatabase: join(folder, `auth-${costWeight}.db`),
        modelsFile, shimsConfig, discovery: "offline", headerTimeoutMs: 3000 }, { fetch });
      try {
        const response = await gateway.handle(new Request("http://private/v1/chat/completions", { method: "POST",
          headers: { "content-type": "application/json", "x-zproxy-user-id": "a".repeat(32),
            "x-zproxy-user-nickname": Buffer.from("Rating user").toString("base64url") },
          body: JSON.stringify({ model: "lazy/public", messages: [{ role: "user", content: "hello" }], stream: true }) }));
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        expect(calls.at(-1)).toBe(expected);
      } finally { await gateway.close(); }
    }
  } finally { server.stop(true); await rm(folder, { recursive: true, force: true }); }
}, 20000);

/**
 * Build one direct Antigravity gateway over two stored accounts.
 *
 * A fixed private codec stands in for the Go child: it derives no device and
 * reaches no upstream, and each test decides what its send answers.
 */
async function agGateway(folder, send) {
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const authDatabase = join(folder, "auth.db");
  const storage = await AuthStorage.create(authDatabase);
  await storage.credentials.set("google-antigravity", [
    { type: "oauth", access: "first-test-access", refresh: "first-test-refresh",
      expires: Date.now() + 3600000, projectId: "first-project", email: "first@fixture.invalid" },
    { type: "oauth", access: "second-test-access", refresh: "second-test-refresh",
      expires: Date.now() + 3600000, projectId: "second-project", email: "second@fixture.invalid" },
  ]);
  storage.close();
  const id = "gemini-3.8-flash";
  const modelsFile = join(folder, "models.yml");
  await writeFile(modelsFile, JSON.stringify({ providers: { "google-antigravity": {
    api: "google-gemini-cli", auth: "oauth", baseUrl: "http://ag-fixture.invalid",
    models: [{ id, reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(folder, "routes.json"), JSON.stringify({ contextWindow: 8192, maxOutputTokens: 2048,
    peakWindows: [{ from: "00:00", to: "24:00" }], routes: {} }));
  const shimsConfig = join(folder, "shims.json");
  await writeFile(shimsConfig, JSON.stringify({ version: 2, stateDbPath: join(folder, "routing.db"),
    features: { "lazy-router": { enabled: true, routesFile: "routes.json", store: "memory",
      headerTimeoutMs: 3000 }, "plugin-bridge": { enabled: false },
    "kiro-credential-sync": { enabled: false } } }));
  const device = { os: "linux", arch: "x64", user_name: "first", app_data_dir: "/home/first/.gemini/antigravity",
    time_zone: "UTC", installation_id: "fixture-installation" };
  const encoder = new TextEncoder();
  const body = 'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"fixture answer"}]}}]}}\n\n'
    + 'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n';
  return createRemoteGateway({ version: 1, antigravity2api: true, discovery: "offline", authDatabase,
    modelsFile, shimsConfig, headerTimeoutMs: 1000, idleTimeoutMs: 1000 }, {
    agWorker: {
      started: false,
      async device(email) { return { ...device, user_name: email.split("@")[0] }; },
      async officialPrepare(value) {
        return { body: { project: value.project, model: value.model.id, requestType: "agent",
          request: { contents: [] } } };
      },
      async officialSend(value, options) {
        return send({ ...value, signal: options?.signal });
      },
      async close() {},
    },
  });
}

/** The one direct Antigravity request every classification test sends. */
function agRequest(id) {
  return new Request("http://private/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", "x-zproxy-user-id": "c".repeat(32),
      "x-zproxy-user-nickname": Buffer.from("Fixture").toString("base64url") },
    body: JSON.stringify({ model: `google-antigravity/${id}`, stream: true, reasoning_effort: "low",
      messages: [{ role: "user", content: "hello" }] }) });
}

const agStream = () => new Response('data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"fixture answer"}]}}]}}\n\n',
  { headers: { "content-type": "text/event-stream" } });

test("a request-content refusal keeps one account and answers the caller 429", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zproxy-ag-refusal-"));
  const release = acquireProviderOptIn("google-antigravity");
  let gateway;
  const sent = [];
  try {
    gateway = await agGateway(folder, value => {
      sent.push(value.accessToken);
      // The Go child's private classification of a request-content refusal.
      return Response.json({ error: { type: "rate_limit_error", message: "the official upstream rejected the request" } },
        { status: 429, headers: { "x-zproxy-refusal": "request" } });
    });
    const response = await gateway.handle(agRequest("gemini-3.8-flash"));
    expect(response.status).toBe(429);
    // One account, one attempt: a refusal is about the request, not the account.
    expect(sent).toEqual(["first-test-access"]);
    // The private classification never reaches the caller.
    expect(response.headers.has("x-zproxy-refusal")).toBe(false);
    const text = await response.text();
    expect(text).not.toContain("official upstream");
    expect(text).not.toContain("first-project");
    expect(text).not.toContain("fixture.invalid");
  } finally { await gateway?.close(); release(); await rm(folder, { recursive: true, force: true }); }
}, 20000);

test("a genuine quota 429 still fails over to the next account", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zproxy-ag-quota-"));
  const release = acquireProviderOptIn("google-antigravity");
  let gateway;
  const sent = [];
  try {
    gateway = await agGateway(folder, value => {
      sent.push(value.accessToken);
      // A quota rejection names no refusal: the account is spent, so the router
      // must keep its account-status path and try the next account.
      if (sent.length === 1) {
        return Response.json({ error: { type: "insufficient_quota",
          message: "the official upstream rejected the request" } }, { status: 429 });
      }
      return agStream();
    });
    const response = await gateway.handle(agRequest("gemini-3.8-flash"));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(sent).toEqual(["first-test-access", "second-test-access"]);
  } finally { await gateway?.close(); release(); await rm(folder, { recursive: true, force: true }); }
}, 20000);

// An account the upstream withdrew is benched for the whole account, not just
// for the model of that one attempt: the first request fails over to the other
// account, and every later request of any model skips the benched one.
test("an account-level refusal benches the whole account for later requests", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zproxy-ag-blocked-"));
  const release = acquireProviderOptIn("google-antigravity");
  let gateway;
  const sent = [];
  try {
    gateway = await agGateway(folder, value => {
      sent.push(value.accessToken);
      if (value.accessToken === "first-test-access") {
        return Response.json({ error: { type: "upstream_error",
          message: "the official upstream rejected the request" } },
        { status: 403, headers: { "x-zproxy-refusal": "blocked" } });
      }
      return agStream();
    });
    const first = await gateway.handle(agRequest("gemini-3.8-flash"));
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    expect(sent).toEqual(["first-test-access", "second-test-access"]);
    // A later request never selects the benched account again, and its refusal
    // never reaches the caller.
    const second = await gateway.handle(agRequest("gemini-3.8-flash"));
    expect(second.status).toBe(200);
    await second.arrayBuffer();
    expect(sent).toEqual(["first-test-access", "second-test-access", "second-test-access"]);
    expect(second.headers.has("x-zproxy-refusal")).toBe(false);
  } finally { await gateway?.close(); release(); await rm(folder, { recursive: true, force: true }); }
}, 20000);

test("a refusal classification on an ordinary answer changes nothing", async () => {
  // The header is authoritative only for the 429 refusal it describes. A
  // successful answer that carried it (a broken peer, not a real one) must be
  // passed through untouched.
  const response = dropPrivateHeaders(new Response("data: {}\n\n", { status: 200,
    headers: { "content-type": "text/event-stream", "x-zproxy-refusal": "request" } }));
  expect(response.status).toBe(200);
  expect(response.headers.has("x-zproxy-refusal")).toBe(false);
  expect(await response.text()).toBe("data: {}\n\n");
  const untouched = new Response("plain", { status: 200, headers: { "content-type": "text/plain" } });
  expect(dropPrivateHeaders(untouched)).toBe(untouched);
});

test("only 429 answers are classified, and their text never leaves the process", async () => {
  // A 403 with a reasonless body and a RetryInfo-less 400 are not the refusal
  // the worker reports, so neither is treated as one.
  for (const [status, headers] of [[403, { "x-zproxy-refusal": "request" }], [400, {}]]) {
    const response = dropPrivateHeaders(new Response(JSON.stringify({ error: { message: "private body" } }),
      { status, headers: { "content-type": "application/json", ...headers } }));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("x-zproxy-refusal");
  }
});
