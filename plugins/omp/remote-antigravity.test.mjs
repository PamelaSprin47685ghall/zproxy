import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { antigravityModel, createAntigravity } from "./remote-antigravity.mjs";
import { createRemoteAccounts } from "./remote-accounts.mjs";
import { acquireProviderOptIn } from "./remote-opt-in.mjs";
import { createRemoteGateway } from "./remote.mjs";
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

const device = Object.freeze({ os: "linux", arch: "x64", user_name: "first", app_data_dir: "/home/first/.gemini/antigravity",
  time_zone: "UTC", installation_id: "fixture-installation" });

/** A gateway-owned codec: the private child builds the envelope and owns the hop. */
function fixture(options = {}) {
  const seen = { prepared: [], sent: [], resolved: [], usage: [], devices: [], contact: 0, holds: 0, released: 0 };
  const selected = options.model ?? model;
  const first = options.credential ?? credential();
  const registry = {
    async getApiKeyWithCredentialForProvider(provider, session, input) {
      expect(provider).toBe(PROVIDER);
      seen.initial = { session, model: input.modelId };
      return first;
    },
    resolver() { return async context => { seen.resolved.push(context); return options.refresh?.(context); }; },
  };
  const adapter = createAntigravity({ config, storage: { usage: { observe(value) { seen.usage.push(value); } } }, registry,
    resolveModel: () => selected,
    observeTurn: () => ({ onContact() { seen.contact++; } }),
    devices: {
      async get(identity) {
        seen.devices.push(identity);
        return device;
      },
    },
    async prepare(payload, control) {
      seen.prepared.push(structuredClone(payload));
      expect(control.signal).toBeInstanceOf(AbortSignal);
      if (options.prepare) return options.prepare(payload, control);
      return { body: { project: payload.project, model: payload.model.id, requestType: "agent",
        request: { contents: [], marker: "prepared" } } };
    },
    async send(payload, control) {
      const sent = { ...structuredClone(payload), signal: control.signal };
      seen.sent.push(sent);
      return options.send ? options.send(sent, seen.sent.length) : stream(result + done);
    },
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

test("prepares with the selected account catalog and transfers the official stream untouched", async () => {
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
  // The projection names the bare wire id and the provider enum, never the family.
  expect(source.seen.prepared[0].model).toEqual({ id: "gemini-fixture-high", model: "FIRST_ENUM", modelProvider: "MODEL_PROVIDER_GOOGLE",
    maxOutputTokens: 1024, maxTokens: 8192, supportsThinking: true, supportsImages: true, thinkingLevel: 3 });
  expect(source.seen.prepared[0]).toMatchObject({ version: 1, project: "fixture-project", scope: "a".repeat(32),
    accessToken: "fixture-access", expiresAt: expect.any(Number) });
  expect(source.seen.prepared[0].handle).toMatch(/^[0-9a-f]{64}$/u);
  expect(source.seen.prepared[0].device).toEqual(device);
  expect(source.seen.prepared[0].request).toMatchObject({ model: "public-alias", stream: true });
  // The account token reaches only the private codec, never the public side.
  expect(JSON.stringify(decoded.metadata)).not.toMatch(/fixture-project|fixture-access|fixture.invalid|FIRST_ENUM|upstream\.invalid/);
  expect(source.seen.sent).toHaveLength(1);
  expect(source.seen.sent[0]).toMatchObject({ version: 1, handle: source.seen.prepared[0].handle, device,
    accessToken: "fixture-access" });
  expect(source.seen.sent[0]).not.toHaveProperty("project");
  expect(source.seen.sent[0].body).toEqual({ project: "fixture-project", model: "gemini-fixture-high",
    requestType: "agent", request: { contents: [], marker: "prepared" } });
  expect(source.seen.sent[0].continuationToken).toBeUndefined();
  expect(source.seen.usage[0].usage).toEqual({ input: 4, output: 5, cacheRead: 1, cacheWrite: 0 });
  expect(source.seen.contact).toBe(1);
  expect(source.seen.devices).toEqual([{ credentialId: 1, email: "first@fixture.invalid" }]);
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

test("refuses unknown accounts, missing account tiers, and non-chat model families before the codec", async () => {
  for (const selected of [
    { ...model, accountAccess: { "second@fixture.invalid": {} } },
    { ...model, accountAccess: { "first@fixture.invalid": { antigravityWireProfiles: { other: {} } } } },
    { ...model, identity: { class: "unknown" } },
  ]) {
    const source = fixture({ model: selected });
    const response = await source.invoke();
    expect([400, 403]).toContain(response.status);
    expect(source.seen.prepared).toHaveLength(0);
    expect(source.seen.sent).toHaveLength(0);
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

test("refreshes only the selected credential on 401 and re-prepares for that retry", async () => {
  const source = fixture({ refresh: () => credential("renewed-access"),
    send: (_sent, index) => index === 1
      ? Response.json({ error: { message: "the official upstream rejected the request" } }, { status: 401 })
      : stream(result + done) });
  const decoded = await unpack(await source.invoke());
  expect(decoded.metadata.attempt).toBe(2);
  expect(source.seen.sent.map(item => item.accessToken)).toEqual(["fixture-access", "renewed-access"]);
  // One account keeps one handle and one device across the refresh.
  expect(source.seen.sent[0].handle).toBe(source.seen.sent[1].handle);
  expect(source.seen.devices).toHaveLength(2);
  expect(source.seen.resolved).toHaveLength(1);
  expect(source.seen.resolved[0].lastChance).toBe(false);
  const other = fixture({ refresh: () => credential("other-access", "other-project", "second@fixture.invalid", 2),
    send: () => Response.json({ error: { message: "denied" } }, { status: 401 }) });
  expect((await other.invoke()).status).toBe(401);
  expect(other.seen.sent).toHaveLength(1);
});

test("preserves refusal status without extra account attempts or secret error bodies", async () => {
  for (const status of [403, 429]) {
    const source = fixture({ send: () => Response.json({ error: { message: "private account secret" } }, { status }) });
    const response = await source.invoke();
    expect(response.status).toBe(status);
    expect(response.headers.has("x-zproxy-decode")).toBe(false);
    const body = await response.text();
    expect(body).not.toContain("private account secret");
    expect(body).not.toContain("fixture-access");
    expect(source.seen.sent).toHaveLength(1);
    expect(source.seen.resolved).toHaveLength(0);
    expect(source.seen.holds).toBe(0);
  }
  const inBand = fixture({ send: () => stream(sse({ error: { code: 429, message: "private stream rejection" } })) });
  expect((await inBand.invoke()).status).toBe(429);
  expect(inBand.seen.sent).toHaveLength(1);
});

test("forwards the worker's private refusal classification without letting it reach the caller", async () => {
  // The worker reports one request-content refusal privately. The adapter keeps
  // the public 429 and its own fixed sentence, and it repeats the classification
  // only on the private hop, where the router reads it and skips account
  // accounting. A genuine quota 429 carries no classification.
  const refused = fixture({ send: () => Response.json({ error: { type: "rate_limit_error", message: "private refusal" } },
    { status: 429, headers: { "x-zproxy-refusal": "request" } }) });
  const refusal = await refused.invoke();
  expect(refusal.status).toBe(429);
  expect(refusal.headers.get("x-zproxy-refusal")).toBe("request");
  expect(refusal.headers.has("x-zproxy-decode")).toBe(false);
  const refusalBody = await refusal.text();
  expect(refusalBody).not.toContain("private refusal");
  expect(refusalBody).toContain("The Antigravity account limit is reached.");
  expect(refused.seen.sent).toHaveLength(1);
  expect(refused.seen.resolved).toHaveLength(0);

  const quota = fixture({ send: () => Response.json({ error: { type: "rate_limit_error", message: "private quota" } },
    { status: 429 }) });
  const exhausted = await quota.invoke();
  expect(exhausted.status).toBe(429);
  expect(exhausted.headers.has("x-zproxy-refusal")).toBe(false);
  expect(await exhausted.text()).toContain("The Antigravity account limit is reached.");
  // The classification belongs to the private 429 refusal of the selected
  // account, not to another status the worker may also refuse.
  const denied = fixture({ send: () => Response.json({ error: { type: "permission_error", message: "private denial" } },
    { status: 403, headers: { "x-zproxy-refusal": "request" } }) });
  const forbidden = await denied.invoke();
  expect(forbidden.status).toBe(403);
  expect(forbidden.headers.has("x-zproxy-refusal")).toBe(false);
});

test("one header deadline covers the first prepare and the first send", async () => {
  // A cold start can hold prepare for its own 45-second budget. The request must
  // still end on the header deadline it shares with the first send, and its own
  // abort signal must reach the codec.
  const started = Date.now();
  const seen = [];
  const source = fixture({ prepare: (_payload, control) => new Promise(resolve => {
    seen.push(control.signal);
    const abort = () => resolve({ body: { project: "fixture-project", model: "gemini-fixture-low",
      requestType: "agent", request: { contents: [] } } });
    control.signal.addEventListener("abort", abort, { once: true });
  }) });
  const response = await source.invoke();
  expect(response.status).toBe(504);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(seen).toHaveLength(1);
  expect(seen[0].aborted).toBe(true);
  expect(await response.text()).not.toContain("fixture-access");
  expect(source.seen.sent).toHaveLength(0);
  // The hold is released even though no send happened.
  expect(source.seen.holds).toBe(0);
  expect(source.seen.released).toBe(1);
});

test("a first send past the shared deadline is a timeout, not an upstream answer", async () => {
  const source = fixture({ send: (_payload, _index) => new Promise((_resolve, reject) => {
    // The private child answers a cancel with an abort error.
    setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 5000);
  }) });
  const response = await source.invoke();
  expect(response.status).toBe(504);
  expect(await response.text()).toContain("The Antigravity request timed out.");
  expect(source.seen.sent).toHaveLength(1);
  expect(source.seen.holds).toBe(0);
});

test("keeps prompt-feedback refusal frames for the real local AG decoder", async () => {
  const refusal = sse({ response: { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Fixture content rejected" } } });
  const source = fixture({ send: () => stream(refusal) });
  const response = await source.invoke();
  expect(response.status).toBe(200);
  expect((await unpack(response)).raw).toBe(refusal);
});

test("keeps cache hits in the final usage sent to the local decoder", async () => {
  const first = sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] } }],
    usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 8 } } });
  const last = sse({ response: { candidates: [{ finishReason: "STOP" }],
    usageMetadata: { candidatesTokenCount: 3, totalTokenCount: 15 } } });
  const source = fixture({ send: () => stream(first + last) });
  const { raw } = await unpack(await source.invoke());
  const final = JSON.parse(raw.trimEnd().split("\n\n").at(-1).slice("data: ".length));
  expect(final.response.usageMetadata).toEqual({
    promptTokenCount: 12, cachedContentTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 15,
  });
  expect(source.seen.usage[0].usage).toEqual({ input: 4, output: 3, cacheRead: 8, cacheWrite: 0 });
});

test("carries one prepared envelope through every continuation segment under the same account", async () => {
  const first = sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "first" }] } }] } })
    + sse({ response: { usageMetadata: { promptTokenCount: 2, cachedContentTokenCount: 1 } } })
    + sse({ response: { candidates: [{ finishReason: "CONTINUATION", continuationToken: "private-next-token" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } } });
  const last = sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "second" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12, cachedContentTokenCount: 0 } } });
  const source = fixture({ send: (_sent, index) => stream(index === 1 ? first : last) });
  const decoded = await unpack(await source.invoke());
  expect(decoded.raw).toContain("first");
  expect(decoded.raw).toContain("second");
  expect(decoded.raw).not.toMatch(/CONTINUATION|private-next-token/);
  expect(source.seen.prepared).toHaveLength(1);
  expect(source.seen.sent).toHaveLength(2);
  // The same envelope leaves again; only the continuation token is added.
  expect(source.seen.sent[1].body).toEqual(source.seen.sent[0].body);
  expect(source.seen.sent[1].continuationToken).toBe("private-next-token");
  expect(source.seen.sent[1].handle).toBe(source.seen.sent[0].handle);
  expect(source.seen.sent[1].accessToken).toBe(source.seen.sent[0].accessToken);
  expect(source.seen.usage[0].usage).toEqual({ input: 6, output: 10, cacheRead: 1, cacheWrite: 0 });
});

test("canceling the response stops a pending raw read and releases the account hold", async () => {
  let cancelled = false;
  const source = fixture({ send: () => stream(new ReadableStream({
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
  const source = fixture({ send: async () => { if (++entered === 6) ready.resolve(); await ready.promise; return stream(result + done); } });
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

test("refuses an envelope that names another project or model without sending it", async () => {
  for (const body of [
    { project: "other-project", model: "gemini-fixture-low", requestType: "agent", request: {} },
    { project: "fixture-project", model: "other-model", requestType: "agent", request: {} },
    { project: "fixture-project", model: "gemini-fixture-low", requestType: "tab", request: {} },
    { project: "fixture-project", model: "gemini-fixture-low", requestType: "agent" },
  ]) {
    const source = fixture({ prepare: () => ({ body }) });
    const response = await source.invoke();
    expect(response.status).toBe(502);
    expect(source.seen.sent).toHaveLength(0);
    expect(source.seen.holds).toBe(0);
  }
});

test("a prepare 400 stays 400 and cannot reach the upstream or refresh credentials", async () => {
  const invalid = fixture({ prepare: () => { throw Object.assign(new Error("The Antigravity codec rejected the request."),
    { status: 400, publicMessage: "The Antigravity codec rejected the request." }); } });
  const response = await invalid.invoke();
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { type: "invalid_request_error", message: "The Antigravity codec rejected the request." } });
  expect(invalid.seen.prepared).toHaveLength(1);
  expect(invalid.seen.sent).toHaveLength(0);
  expect(invalid.seen.resolved).toHaveLength(0);
  expect(invalid.seen.holds).toBe(0);
  expect(invalid.seen.released).toBe(1);
});

test("an unavailable device profile fails before the codec sees an account", async () => {
  const source = fixture();
  const adapter = createAntigravity({ config, storage: {}, devices: { async get() { throw new Error("fixture store failure"); } },
    registry: {
      async getApiKeyWithCredentialForProvider() { return credential(); },
      resolver() { return async () => undefined; },
    },
    resolveModel: () => model,
    async prepare() { throw new Error("The codec must not be reached."); },
    async send() { throw new Error("The codec must not be reached."); },
  });
  const response = await adapter(new Request("http://private/v1/chat/completions", { method: "POST",
    body: JSON.stringify({ model: "public-alias", stream: true, messages: [{ role: "user", content: "hello" }] }) }), source.scope);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("fixture store failure");
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
      devices: { get: async identity => ({ ...device, user_name: identity.email.split("@")[0] }) },
      async prepare(value) {
        prepared.push(value);
        await Promise.resolve();
        return { body: { project: value.project, model: value.model.id, requestType: "agent", request: { contents: [] } } };
      },
      async send(value) {
        sent.push([value.accessToken, value.body.project]);
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
    expect(sent.filter(([token, project]) => token === "first-stored-access" && project === "first-project")).toHaveLength(3);
    expect(sent.filter(([token, project]) => token === "second-stored-access" && project === "second-project")).toHaveLength(3);
    expect(JSON.stringify(prepared)).not.toMatch(/unused-refresh|fixture\.invalid/);
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
      // The official hop presents one device per account, so the credential
      // carries the mailbox that device profile is derived from.
      api: "google-gemini-cli", baseUrl: "http://ag-fixture.invalid",
      apiKey: JSON.stringify({ token: "fixture-only", projectId: "fixture-project", email: "fixture@fixture.invalid" }),
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
      agWorker: officialWorker({ async send(value) {
        expect(value.accessToken).toBe("fixture-only");
        expect(value.body.project).toBe("fixture-project");
        if (++entered === 6) ready.resolve();
        await new Promise(resolve => {
          const abort = () => resolve();
          value.signal?.addEventListener("abort", abort, { once: true });
          ready.promise.then(() => { value.signal?.removeEventListener("abort", abort); resolve(); });
        });
        return stream(result + done);
      } }),
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

test("a direct AG model changes accounts after a pre-output rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zproxy-ag-direct-"));
  const release = acquireProviderOptIn(PROVIDER);
  let gateway;
  try {
    const authDatabase = join(directory, "auth.db");
    const storage = await AuthStorage.create(authDatabase);
    await storage.credentials.set(PROVIDER, [
      { type: "oauth", access: "first-test-access", refresh: "first-test-refresh", expires: Date.now() + 3600000, projectId: "first-project", email: "first@fixture.invalid" },
      { type: "oauth", access: "second-test-access", refresh: "second-test-refresh", expires: Date.now() + 3600000, projectId: "second-project", email: "second@fixture.invalid" },
    ]);
    storage.close();
    const id = "gemini-3.8-flash";
    const modelsFile = join(directory, "models.yml");
    await writeFile(modelsFile, JSON.stringify({ providers: { [PROVIDER]: { api: "google-gemini-cli", auth: "oauth", baseUrl: "http://ag-fixture.invalid", models: [{ id, reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 2048, cost: model.cost }] } } }));
    await writeFile(join(directory, "routes.json"), JSON.stringify({ contextWindow: 8192, maxOutputTokens: 2048, peakWindows: [{ from: "00:00", to: "24:00" }], routes: {} }));
    const shimsConfig = join(directory, "shims.json");
    await writeFile(shimsConfig, JSON.stringify({ version: 2, stateDbPath: join(directory, "routing.db"), features: { "lazy-router": { enabled: true, routesFile: "routes.json", store: "memory", headerTimeoutMs: 3000 }, "plugin-bridge": { enabled: false }, "kiro-credential-sync": { enabled: false } } }));
    const sent = [];
    gateway = await createRemoteGateway({ version: 1, antigravity2api: true, discovery: "offline", authDatabase, modelsFile, shimsConfig, headerTimeoutMs: 1000, idleTimeoutMs: 1000 }, {
      agWorker: officialWorker({ async send(value) {
        sent.push(value.accessToken);
        return value.accessToken === "first-test-access"
          ? Response.json({ error: { message: "the official upstream rejected the request" } }, { status: 403 })
          : stream(result + done);
      } }),
    });
    const request = () => new Request("http://private/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-zproxy-user-id": "a".repeat(32), "x-zproxy-user-nickname": Buffer.from("Fixture").toString("base64url") }, body: JSON.stringify({ model: `${PROVIDER}/${id}`, stream: true, reasoning_effort: "low", max_completion_tokens: 100, messages: [{ role: "user", content: "hello" }] }) });
    const response = await gateway.handle(request());
    expect(response.status).toBe(200);
    const decoded = await unpack(response);
    expect(decoded.raw).toBe(result + done);
    expect(decoded.metadata.modelAlias).toBe(`${PROVIDER}/${id}`);
    expect(sent).toEqual(["first-test-access", "second-test-access"]);
    const next = await gateway.handle(request());
    expect(next.status).toBe(200);
    await unpack(next);
    expect(sent).toEqual(["first-test-access", "second-test-access", "second-test-access"]);
  } finally { await gateway?.close(); release(); await rm(directory, { recursive: true, force: true }); }
}, 20000);

/**
 * The injected private codec of a gateway test.
 *
 * Production starts the Go child; a test replaces it with the same three calls
 * the gateway makes, so no test derives a device or reaches an upstream.
 */
function officialWorker({ prepare, send }) {
  return {
    started: false,
    async device(email) { return { ...device, user_name: email.split("@")[0] }; },
    async officialPrepare(value) {
      const body = await prepare?.(value);
      return body ?? { body: { project: value.project, model: value.model.id, requestType: "agent", request: { contents: [] } } };
    },
    async officialSend(value, options) { return send({ ...value, signal: options?.signal }); },
    async close() {},
  };
}
