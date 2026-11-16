import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { antigravityModel, antigravityUserAgent, createAntigravity } from "./remote-antigravity.mjs";
import { createRemoteAccounts } from "./remote-accounts.mjs";
import { acquireProviderOptIn } from "./remote-opt-in.mjs";
import { createRemoteGateway } from "./remote.mjs";
import { readJsonBody } from "./ag-worker.mjs";
import { buildToolIdMap, normalizeOpenAIRequest } from "./contract.mjs";

const PROVIDER = "google-antigravity";
const config = { headerTimeoutMs: 1000, idleTimeoutMs: 1000 };
const model = {
  provider: PROVIDER, api: "google-gemini-cli", id: "gemini-fixture", name: "Fixture", baseUrl: "https://upstream.invalid",
  identity: { class: "gemini" }, reasoning: true, input: ["text", "image"], contextWindow: 8192, maxTokens: 2048,
  thinking: { mode: "google-level", efforts: ["low", "high"], requiresEffort: true,
    effortRouting: { low: "gemini-fixture-low", high: "gemini-fixture-high" } }, requestModelId: "gemini-fixture-low",
  antigravityWireProfiles: { "gemini-fixture-low": { maxOutputTokens: 2048, thinkingLevel: "LOW" } },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const credential = (token = "fixture-access", projectId = "fixture-project", email = "first@fixture.invalid", id = 1) => ({
  apiKey: JSON.stringify({ token, projectId, email, expiresAt: Date.now() + 3600000 }), oauthAccess: token, credentialId: id,
});
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const result = sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "fixture answer" }] } }] } });
const done = sse({ response: { candidates: [{ finishReason: "STOP" }], usageMetadata: {
  promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 10, cachedContentTokenCount: 1,
} } });
const stream = bytes => new Response(bytes, { headers: { "content-type": "text/event-stream", "x-account-secret": "server-only" } });
const unpack = async response => {
  const bytes = Buffer.from(await response.arrayBuffer());
  const count = bytes.readUInt32BE(0);
  return { metadata: JSON.parse(bytes.subarray(4, count + 4)), raw: bytes.subarray(count + 4).toString() };
};

function fixture(options = {}) {
  const seen = { prepared: [], sent: [], resolved: [], usage: [], contact: 0, holds: 0, released: 0 };
  const selected = options.model ?? model;
  const first = options.credential ?? credential();
  const registry = {
    async getApiKeyWithCredentialForProvider(provider, session, input) {
      expect(provider).toBe(PROVIDER);
      seen.initial = { session, model: input.modelId };
      return first;
    },
    resolver() { return async context => { seen.resolved.push(context); return options.refresh?.(context); }; },
    async resolveModelHeaders() { return { "x-server-config": String(seen.prepared.length), "user-agent": "must-be-overridden" }; },
  };
  const adapter = createAntigravity({ config, storage: { usage: { observe(value) { seen.usage.push(value); } } }, registry,
    resolveModel: () => selected,
    async prepare(payload, control) {
      seen.prepared.push(structuredClone(payload));
      expect(control.signal).toBeInstanceOf(AbortSignal);
      if (options.prepare) return options.prepare(payload, control);
      return { body: { project: payload.project, model: payload.model.id, request: { contents: [], marker: "prepared" } } };
    },
    async fetch(input, init) {
      const sent = { url: String(input), headers: new Headers(init.headers), body: JSON.parse(init.body), signal: init.signal };
      seen.sent.push(sent);
      return options.fetch ? options.fetch(sent, seen.sent.length) : stream(result + done);
    },
    observeTurn: () => ({ onContact() { seen.contact++; }, classifyError: text => text.includes("QUOTA_EXHAUSTED") ? "quota" : undefined }),
  });
  const scope = {
    name: "a".repeat(32), allows: () => true,
    credentialSessionId: (_, key) => `fixture-session-${key}`,
    retain() { seen.holds++; return () => { seen.holds--; seen.released++; }; },
    ...options.scope,
  };
  return {
    seen, scope,
    invoke(body = {}, signal) {
      return adapter(new Request("http://private/v1/chat/completions", { method: "POST", signal,
        body: JSON.stringify({ model: "public-alias", stream: true, messages: [{ role: "user", content: "hello" }], ...body }) }), scope);
    },
  };
}

test("uses the selected account's catalog and transfers raw bytes without sending credentials to Go", async () => {
  const selected = { ...model, accountAccess: {
    "first@fixture.invalid": { antigravityWireProfiles: {
      "gemini-fixture-high": { modelEnum: "FIRST_ENUM", maxOutputTokens: 1024, thinkingLevel: "HIGH" },
    } },
    "second@fixture.invalid": { antigravityWireProfiles: {
      "gemini-fixture-high": { modelEnum: "SECOND_ENUM", maxOutputTokens: 4096, thinkingLevel: "LOW" },
    } },
  } };
  const source = fixture({ model: selected });
  const response = await source.invoke({ reasoning_effort: "high", headers: { authorization: "caller-key" } });
  expect(response.headers.get("x-zproxy-decode")).toBe("1");
  expect(response.headers.has("x-account-secret")).toBe(false);
  const decoded = await unpack(response);
  expect(decoded.raw).toBe(result + done);
  expect(decoded.metadata).toMatchObject({ decoder: "omp-response", version: 1, modelAlias: "public-alias", attempt: 1, isStreaming: true });
  expect(JSON.parse(decoded.metadata.recipe)).toMatchObject({ api: "antigravity2api", provider: PROVIDER,
    id: "gemini-fixture-high", maxTokens: 1024, compat: { agProvider: "google" } });
  expect(source.seen.prepared[0].model).toMatchObject({ id: "gemini-fixture-high", model: "FIRST_ENUM", maxOutputTokens: 1024,
    thinkingLevel: 3, modelProvider: "MODEL_PROVIDER_GOOGLE" });
  expect(source.seen.prepared[0].project).toBe("fixture-project");
  expect(JSON.stringify(source.seen.prepared)).not.toMatch(/fixture-access|refreshToken|first@fixture|caller-key/);
  expect(JSON.stringify(decoded.metadata)).not.toMatch(/fixture-project|fixture-access|fixture.invalid|upstream.invalid|FIRST_ENUM/);
  expect(source.seen.sent).toHaveLength(1);
  expect(source.seen.sent[0].url).toBe("https://upstream.invalid/v1internal:streamGenerateContent?alt=sse");
  expect(source.seen.sent[0].headers.get("authorization")).toBe("Bearer fixture-access");
  // The backend gates the product on the official client identity; any other UA is 403.
  expect(source.seen.sent[0].headers.get("user-agent")).toBe(antigravityUserAgent());
  expect(source.seen.usage[0].usage).toEqual({ input: 4, output: 5, cacheRead: 1, cacheWrite: 0 });
  expect(source.seen.contact).toBe(1);
  expect(source.seen.holds).toBe(0);
  expect(source.seen.released).toBe(1);
});

test("restores caller tool IDs and gives only the retained AG context to the codec", async () => {
  const id = "original-long-tool-call-identifier";
  const original = { model: "public-alias", stream: false, messages: [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "find", arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: "found" },
  ] };
  const context = { version: 1, messages: [] };
  const source = fixture({ scope: { toolIds: buildToolIdMap(original), antigravityContext: context } });
  const decoded = await unpack(await source.invoke({ ...normalizeOpenAIRequest("/v1/chat/completions", original), _zproxy_ag: "untrusted body value" }));
  expect(decoded.metadata.isStreaming).toBe(false);
  expect(source.seen.prepared[0].request.messages[0].tool_calls[0].id).toBe(id);
  expect(source.seen.prepared[0].request.messages[1].tool_call_id).toBe(id);
  expect(source.seen.prepared[0].request._zproxy_ag).toEqual(context);
});

test("refuses unknown accounts, missing account tiers, and non-chat model families before sending", async () => {
  for (const selected of [
    { ...model, accountAccess: { "second@fixture.invalid": {} } },
    { ...model, accountAccess: { "first@fixture.invalid": { antigravityWireProfiles: { other: {} } } } },
    { ...model, identity: { class: "unknown" } },
  ]) {
    const source = fixture({ model: selected });
    const response = await source.invoke();
    expect([400, 403]).toContain(response.status);
    expect(source.seen.sent).toHaveLength(0);
    expect(source.seen.prepared).toHaveLength(0);
    expect(source.seen.holds).toBe(0);
  }
  expect(antigravityModel({ ...model, identity: { class: "gpt-oss" } }, {}, { projectId: "fixture" }).family).toBe("openai");
});

test("reasoning none disables only a catalog route that can turn thinking off", () => {
  const mandatory = antigravityModel(model, { reasoning_effort: "none" }, { projectId: "fixture" }).catalog;
  expect(mandatory.id).toBe("gemini-fixture-low");
  expect(mandatory.thinkingLevel).toBe(1);
  expect(mandatory.thinkingDisabled).toBeUndefined();
  const optional = { ...model, thinking: { ...model.thinking, requiresEffort: false,
    effortRouting: { ...model.thinking.effortRouting, off: "gemini-fixture-off" } } };
  const off = antigravityModel(optional, { reasoning_effort: "none" }, { projectId: "fixture" }).catalog;
  expect(off.id).toBe("gemini-fixture-off");
  expect(off.thinkingDisabled).toBe(true);
  expect(off.thinkingBudget).toBe(0);
  expect(off.thinkingLevel).toBeUndefined();
});

test("refreshes only the selected credential on 401 and prepares headers for that retry", async () => {
  const source = fixture({ refresh: () => credential("renewed-access"), fetch: (_sent, index) => index === 1
    ? Response.json({ error: { message: "private error" } }, { status: 401 }) : stream(result + done) });
  const decoded = await unpack(await source.invoke());
  expect(decoded.metadata.attempt).toBe(2);
  expect(source.seen.sent.map(item => item.headers.get("authorization"))).toEqual(["Bearer fixture-access", "Bearer renewed-access"]);
  expect(source.seen.sent.map(item => item.headers.get("x-server-config"))).toEqual(["1", "2"]);
  expect(source.seen.resolved).toHaveLength(1);
  expect(source.seen.resolved[0].lastChance).toBe(false);
  const other = fixture({ refresh: () => credential("other-access", "other-project", "second@fixture.invalid", 2),
    fetch: () => Response.json({ error: { message: "denied" } }, { status: 401 }) });
  expect((await other.invoke()).status).toBe(401);
  expect(other.seen.sent).toHaveLength(1);
});

test("preserves refusal status and Retry-After without extra account attempts or secret error bodies", async () => {
  for (const status of [403, 429]) {
    const source = fixture({ fetch: () => Response.json({ error: { message: "private account secret", details: [
      { reason: "QUOTA_EXHAUSTED", retryDelay: "2.25s" },
    ] } }, { status }) });
    const response = await source.invoke();
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.has("x-zproxy-decode")).toBe(false);
    expect(await response.text()).not.toContain("private account secret");
    expect(source.seen.sent).toHaveLength(1);
    expect(source.seen.resolved).toHaveLength(0);
    expect(source.seen.holds).toBe(0);
  }
  const inBand = fixture({ fetch: () => stream(sse({ error: { code: 429, message: "private stream rejection" } })) });
  expect((await inBand.invoke()).status).toBe(429);
  expect(inBand.seen.sent).toHaveLength(1);
});

test("keeps prompt-feedback refusal frames for the real local AG decoder", async () => {
  const refusal = sse({ response: { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Fixture content rejected" } } });
  const source = fixture({ fetch: () => stream(refusal) });
  const response = await source.invoke();
  expect(response.status).toBe(200);
  expect((await unpack(response)).raw).toBe(refusal);
});

test("stitches explicit continuations under the same selected account and reports cumulative usage", async () => {
  const first = sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "first" }] } }] } })
    + sse({ response: { candidates: [{ finishReason: "CONTINUATION", continuationToken: "private-next-token" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } } });
  const last = sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "second" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 } } });
  const source = fixture({ fetch: (_sent, index) => stream(index === 1 ? first : last) });
  const decoded = await unpack(await source.invoke());
  expect(decoded.raw).toContain("first");
  expect(decoded.raw).toContain("second");
  expect(decoded.raw).not.toMatch(/CONTINUATION|private-next-token/);
  expect(source.seen.sent).toHaveLength(2);
  expect(source.seen.sent.map(item => item.headers.get("authorization"))).toEqual(["Bearer fixture-access", "Bearer fixture-access"]);
  expect(source.seen.sent[1].body).toEqual({ ...source.seen.sent[0].body,
    request: { ...source.seen.sent[0].body.request, continuationToken: "private-next-token" } });
  expect(source.seen.prepared).toHaveLength(1);
  expect(source.seen.usage[0].usage).toEqual({ input: 7, output: 10, cacheRead: 0, cacheWrite: 0 });
});

test("canceling the response stops a pending raw read and releases the account hold", async () => {
  let cancelled = false;
  const source = fixture({ fetch: () => stream(new ReadableStream({
    start(output) { output.enqueue(Buffer.from(result)); }, cancel() { cancelled = true; },
  })) });
  const response = await source.invoke();
  const reader = response.body.getReader();
  await reader.read(); // Decode prefix.
  await reader.read(); // The first raw event.
  const pending = reader.read();
  await reader.cancel();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancelled).toBe(true);
  expect(source.seen.sent[0].signal.aborted).toBe(true);
  expect(source.seen.holds).toBe(0);
  expect(source.seen.released).toBe(1);
}, 2000);

test("does not add an AG concurrency queue", async () => {
  const ready = Promise.withResolvers();
  let entered = 0;
  const source = fixture({ fetch: async () => { if (++entered === 6) ready.resolve(); await ready.promise; return stream(result + done); } });
  const responses = await Promise.all(Array.from({ length: 6 }, () => source.invoke()));
  await Promise.all(responses.map(unpack));
  expect(entered).toBe(6);
  expect(source.seen.holds).toBe(0);
}, 2000);

test("leaves other providers alone", async () => {
  const other = fixture({ model: { ...model, provider: "other" } });
  expect(await other.invoke()).toBeUndefined();
  expect(other.seen.prepared).toHaveLength(0);
});

test("a prepare 400 stays 400 and cannot contact the upstream or refresh credentials", async () => {
  const invalid = fixture({ prepare: () => readJsonBody(Response.json({ error: "private codec diagnostics" }, { status: 400 })) });
  const response = await invalid.invoke();
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { type: "invalid_request_error", message: "The Antigravity codec rejected the request." } });
  expect(invalid.seen.prepared).toHaveLength(1);
  expect(invalid.seen.sent).toHaveLength(0);
  expect(invalid.seen.resolved).toHaveLength(0);
  expect(invalid.seen.holds).toBe(0);
  expect(invalid.seen.released).toBe(1);
});

test("the real OMP store and registry keep concurrent routed accounts pinned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zproxy-ag-accounts-"));
  const releaseOptIn = acquireProviderOptIn(PROVIDER);
  const storage = await AuthStorage.create(":memory:");
  let accounts;
  try {
    const modelsFile = join(directory, "models.yml");
    await writeFile(modelsFile, JSON.stringify({ providers: { [PROVIDER]: {
      api: "google-gemini-cli", baseUrl: model.baseUrl,
      models: [{ id: model.id, name: "Fixture", reasoning: true, input: model.input,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost }],
    } } }));
    await storage.credentials.set(PROVIDER, [
      { type: "oauth", access: "first-stored-access", refresh: "first-unused-refresh", expires: Date.now() + 3600000,
        projectId: "first-project", email: "first@fixture.invalid" },
      { type: "oauth", access: "second-stored-access", refresh: "second-unused-refresh", expires: Date.now() + 3600000,
        projectId: "second-project", email: "second@fixture.invalid" },
    ]);
    expect(storage.credentials.list(PROVIDER)).toHaveLength(2);
    const registry = new ModelRegistry(storage, modelsFile, { cacheDbPath: join(directory, "models.db"),
      fetch: () => { throw new Error("The fixture must not discover or contact an upstream."); } });
    await registry.refresh("offline");
    accounts = createRemoteAccounts(storage);
    const sent = [];
    const prepared = [];
    const ready = Promise.withResolvers();
    const adapter = createAntigravity({ config, storage, registry, resolveModel: () => model,
      async prepare(value) {
        prepared.push(value);
        await Promise.resolve();
        return { body: { project: value.project, model: value.model.id, request: { contents: [] } } };
      },
      async fetch(_input, init) {
        sent.push([new Headers(init.headers).get("authorization"), JSON.parse(init.body).project]);
        if (sent.length === 6) ready.resolve();
        await ready.promise;
        return stream(result + done);
      },
    });
    const rows = storage.credentials.list(PROVIDER);
    expect(rows).toHaveLength(2);
    const scope = { name: "real-store-user", allows: () => true, credentialSessionId: (_, id) => id, retain: () => () => {} };
    const requests = Array.from({ length: 6 }, (_, index) => rows[index % rows.length]);
    const replies = await Promise.all(requests.map(row => accounts.dispatch(new Request("http://private/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "fixture", stream: true, messages: [{ role: "user", content: "hello" }] }),
    }), "private", scope, { provider: PROVIDER, credentialId: row.id }, (request, _peer, selected) => adapter(request, selected))));
    await Promise.all(replies.map(unpack));
    expect(sent).toHaveLength(6);
    expect(sent.filter(([token, project]) => token === "Bearer first-stored-access" && project === "first-project")).toHaveLength(3);
    expect(sent.filter(([token, project]) => token === "Bearer second-stored-access" && project === "second-project")).toHaveLength(3);
    expect(JSON.stringify(prepared)).not.toMatch(/stored-access|unused-refresh|fixture.invalid/);
  } finally {
    accounts?.close();
    storage.close();
    releaseOptIn();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("the original lazy routing policy keeps AG unlimited even with old provider and model limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zproxy-ag-routing-"));
  let gateway;
  let entered = 0;
  const ready = Promise.withResolvers();
  const selectedId = "gemini-3.8-flash";
  try {
    const modelsFile = join(directory, "models.yml");
    await writeFile(modelsFile, JSON.stringify({ providers: { [PROVIDER]: {
      api: "google-gemini-cli", baseUrl: "http://ag-fixture.invalid", apiKey: JSON.stringify({ token: "fixture-only", projectId: "fixture-project" }),
      models: [{ id: selectedId, reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 2048, cost: model.cost }],
    } } }));
    await writeFile(join(directory, "routes.json"), JSON.stringify({ contextWindow: 8192, maxOutputTokens: 2048,
      maxInFlight: { [PROVIDER]: 1, [`${PROVIDER}/${selectedId}`]: 1 },
      peakWindows: [{ from: "00:00", to: "24:00" }],
      routes: { "lazy/ag-fixture": { graph: { type: "model", model: `${PROVIDER}/${selectedId}` } } } }));
    const shimsConfig = join(directory, "shims.json");
    await writeFile(shimsConfig, JSON.stringify({ version: 2, stateDbPath: join(directory, "routing.db"),
      features: { "lazy-router": { enabled: true, routesFile: "routes.json", store: "memory", headerTimeoutMs: 3000 },
        "plugin-bridge": { enabled: false }, "kiro-credential-sync": { enabled: false } } }));
    gateway = await createRemoteGateway({ version: 1, antigravity2api: true, discovery: "offline",
      authDatabase: join(directory, "auth.db"), modelsFile, shimsConfig, headerTimeoutMs: 1000, idleTimeoutMs: 1000 }, {
      agWorker: { async prepare(value) { return { body: { model: value.model.id, project: value.project, request: { contents: [] } } }; }, close() {} },
      async fetch(input, init) {
        expect(new URL(input).hostname).toBe("ag-fixture.invalid");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-only");
        if (++entered === 6) ready.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => reject(init.signal.reason);
          init.signal.addEventListener("abort", abort, { once: true });
          ready.promise.then(() => { init.signal.removeEventListener("abort", abort); resolve(); });
        });
        return stream(result + done);
      },
    });
    const requests = Array.from({ length: 6 }, (_, index) => gateway.handle(new Request("http://private/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-zproxy-user-id": String(index + 1).repeat(32),
        "x-zproxy-user-nickname": Buffer.from(`Fixture ${index}`).toString("base64url") },
      body: JSON.stringify({ model: "lazy/ag-fixture", stream: true, messages: [{ role: "user", content: "fixture" }] }),
    })));
    const replies = await Promise.all(requests);
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(entered).toBe(6);
    for (const reply of replies) {
      const decoded = await unpack(reply);
      expect(decoded.metadata.modelAlias).toBe("lazy/ag-fixture");
      expect(decoded.raw).toBe(result + done);
    }
  } finally {
    ready.resolve();
    await gateway?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
