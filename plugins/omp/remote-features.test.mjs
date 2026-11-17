import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createRemoteFeatures, getWireInfo, syncKiro } from "./remote-features.mjs";

const temporary = [];
const hosts = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function configFor(features = {}, extra = {}) {
  const directory = await mkdtemp(join(import.meta.dir, "features-test-"));
  temporary.push(directory);
  const path = join(directory, "shims.json");
  await writeFile(path, JSON.stringify({ version: 2, features: {
    "copilot-auto": { enabled: false }, "cline-pin-upstream": { enabled: false },
    "plugin-bridge": { enabled: false }, "kiro-credential-sync": { enabled: false }, ...features,
  }, ...extra }));
  return { shimsConfig: path, authDatabase: join(directory, "auth.db"), directory };
}

function registryFixture() {
  const registrations = new Map();
  return {
    registrations,
    getAll: () => [], getProviderModels: () => [],
    registerProvider: (id, value) => registrations.set(id, value),
    unregisterProvider: id => registrations.delete(id),
  };
}

/**
 * A storage stand-in that keeps rows in place.
 *
 * `replaceById` mirrors the official CredentialPool method: it writes the given
 * row and returns its index, or -1 when the row is gone. `upsert` records calls
 * so a test can prove the inserting path stayed unused.
 */
function storageFixture(rows = []) {
  const upserts = [];
  return {
    rows,
    upserts,
    credentials: {
      list: () => rows,
      upsert: async (provider, credential) => { upserts.push({ provider, credential }); },
      replaceById: (provider, id, credential) => {
        const index = rows.findIndex(row => row.id === id);
        if (index === -1) return -1;
        rows[index] = { ...rows[index], credential };
        return index;
      },
    },
    keys: { setConfig() {} },
  };
}

test("optional features leave the default gateway transport untouched", async () => {
  let calls = 0;
  const host = await createRemoteFeatures({ config: {}, storage: {}, registry: {}, fetch: async () => { calls++; return new Response("plain"); } });
  hosts.push(host);
  expect(await (await host.fetch("https://fixture.invalid")).text()).toBe("plain");
  expect(calls).toBe(1);
  expect(host.usesCustomTransport({ api: "openai-completions" })).toBe(false);
});

test("Cline pins both supported channel fields and retains official credentials", async () => {
  const config = await configFor({ "cline-pin-upstream": { enabled: true, baseURL: "http://127.0.0.1:19001/v1", upstream: "fixture-channel", modelChannels: {} } });
  const host = await createRemoteFeatures({ config, storage: storageFixture(), registry: registryFixture() });
  hosts.push(host);
  let sent;
  await host.fetch("http://127.0.0.1:19001/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer server-only-fixture", "content-type": "application/json", "content-length": "1" }, body: JSON.stringify({ model: "fixture", messages: [] }) }, async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response("ok");
  });
  expect(sent.body.provider.only).toEqual(["fixture-channel"]);
  expect(sent.body.providerOptions.gateway.only).toEqual(["fixture-channel"]);
  expect(new Headers(sent.init.headers).get("authorization")).toBe("Bearer server-only-fixture");
  expect(new Headers(sent.init.headers).has("content-length")).toBe(false);
});

test("Copilot auto uses official protocol shaping and keeps negotiated state remote", async () => {
  const config = await configFor({ "copilot-auto": { enabled: true, autoBootstrapModel: "github-copilot/bootstrap" } });
  const requests = [];
  const baseFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const body = JSON.parse(init.body);
    requests.push({ url, body, headers: new Headers(init.headers) });
    if (new URL(url).pathname === "/auto") return Response.json({ session_token: "fixture-private-session", selected_model: { id: "gpt-5.6-luna", supported_endpoints: ["/responses"] } });
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const host = await createRemoteFeatures({ config, storage: storageFixture(), registry: registryFixture(), fetch: baseFetch });
  hosts.push(host);
  const original = { model: "github-copilot/auto", stream: true, messages: [
    { role: "user", content: "Find a city" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"city":"Paris"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "France" },
  ], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }] };
  const response = await host.dispatch(new Request("http://private/v1/chat/completions", { method: "POST", body: JSON.stringify(original) }), "peer", {}, async forwarded => {
    const body = await forwarded.json();
    expect(body.model).toBe("github-copilot/bootstrap");
    return host.fetch("https://api.githubcopilot.com/chat/completions", { method: "POST", headers: { authorization: "Bearer fixture-server-token", "content-type": "application/json" }, body: JSON.stringify({ ...body, model: "bootstrap" }) });
  });
  expect(requests).toHaveLength(2);
  expect(new URL(requests[1].url).pathname).toBe("/responses");
  expect(requests[1].body.model).toBe("gpt-5.6-luna");
  expect(requests[1].body.tools[0].name).toBe("lookup");
  expect(requests[1].body.tools[0].function).toBeUndefined();
  expect(requests[1].body.input.some(item => item.type === "function_call_output")).toBe(true);
  expect(requests[1].headers.get("authorization")).toBe("Bearer fixture-server-token");
  expect(requests[1].headers.get("copilot-session-token")).toBe("fixture-private-session");
  expect(getWireInfo(response)).toMatchObject({ api: "openai-responses", id: "gpt-5.6-luna" });
  expect(JSON.stringify(getWireInfo(response))).not.toContain("fixture-private-session");
  expect(JSON.stringify(getWireInfo(response))).not.toContain("fixture-server-token");
});

test("a fixed Copilot model negotiates only after model_not_supported", async () => {
  const config = await configFor({ "copilot-auto": { enabled: true } });
  let calls = 0;
  const host = await createRemoteFeatures({ config, storage: storageFixture(), registry: registryFixture(), fetch: async (input) => {
    calls++;
    const url = typeof input === "string" ? input : input.url;
    if (new URL(url).pathname === "/auto") return Response.json({ session_token: "fixture-session", selected_model: { id: "selected", supported_endpoints: ["/chat/completions"] } });
    if (calls === 1) return Response.json({ error: { code: "model_not_supported" } }, { status: 400 });
    return new Response("fixture");
  } });
  hosts.push(host);
  const response = await host.fetch("https://api.githubcopilot.com/chat/completions", { method: "POST", headers: { authorization: "Bearer fixture" }, body: JSON.stringify({ model: "fixed", messages: [{ role: "user", content: "hello" }] }) });
  expect(calls).toBe(3);
  expect(getWireInfo(response).api).toBe("openai-completions");
  expect(await response.text()).toBe("fixture");
});

let kiroDatabaseCount = 0;

/** Write a kiro-cli database that holds one social token, and return its path. */
async function kiroDatabase(directory, token) {
  const path = join(directory, `kiro-${++kiroDatabaseCount}.db`);
  const database = new Database(path);
  database.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  database.query("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:social:token", JSON.stringify({
    access_token: "fixture-access", refresh_token: "fixture-refresh",
    expires_at: "2030-01-01T00:00:00Z", region: "fixture-region", ...token,
  }));
  database.close();
  return path;
}

/** One stored kiro account. A credential field set to undefined is absent, as OMP stores it. */
function kiroRow(id, credential = {}) {
  return { id, disabledCause: null, credential: { type: "oauth", access: `old-${id}`, refresh: `old-${id}`, expires: 0, ...credential } };
}

test("Kiro sync writes the matched row and never inserts a second account", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);

  // This row carries no account, email, project, or org field, so the official
  // matcher resolves no identity key for it and refuses the replacement; its
  // upsert would therefore insert a clone beside the real account. The sync
  // must write this row and leave the inserting path unused.
  expect(Object.hasOwn(rows[0].credential, "accountId")).toBe(false);
  expect(Object.hasOwn(rows[0].credential, "email")).toBe(false);
  expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  expect(storage.upserts).toHaveLength(0);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(7);
  expect(rows[0].credential.access).toBe("fixture-access");
  expect(rows[0].credential.refresh).toBe("fixture-refresh|desktop");
  expect(rows[0].credential.region).toBe("fixture-region");
  expect(rows[0].credential.expires).toBe(Date.parse("2030-01-01T00:00:00Z"));
});

test("Kiro sync keeps the account identity fields of the row it updates", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { accountId: "fixture-account", email: "fixture@example.invalid", profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  expect(rows[0].credential.accountId).toBe("fixture-account");
  expect(rows[0].credential.email).toBe("fixture@example.invalid");
  expect(rows[0].credential.profileArn).toBe("fixture-profile");
  expect(rows[0].credential.access).toBe("fixture-access");
});

test("Kiro sync picks the row whose profile ARN the token names", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "second-profile" });
  const rows = [kiroRow(7, { profileArn: "first-profile" }), kiroRow(8, { profileArn: "second-profile" })];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  expect(rows[0].credential.access).toBe("old-7");
  expect(rows[1].credential.access).toBe("fixture-access");
});

test("Kiro sync refuses an ambiguous account set instead of guessing", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { profileArn: "fixture-profile" }), kiroRow(8, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  let writes = 0;
  const replaceById = storage.credentials.replaceById;
  storage.credentials.replaceById = (provider, id, credential) => { writes++; return replaceById(provider, id, credential); };
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
  expect(writes).toBe(0);
  expect(rows[0].credential.access).toBe("old-7");
  expect(rows[1].credential.access).toBe("old-8");
});

test("Kiro sync refuses several rows when the token names no profile", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, {});
  const rows = [kiroRow(7), kiroRow(8)];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
  expect(rows[0].credential.access).toBe("old-7");
  expect(rows[1].credential.access).toBe("old-8");
});

test("Kiro sync writes the only row when neither side names a profile", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, {});
  const rows = [kiroRow(7)];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  expect(rows[0].credential.access).toBe("fixture-access");
  // A profile the token does not name is never invented onto the row.
  expect(rows[0].credential.profileArn).toBeUndefined();
});

test("Kiro sync writes the only row when the token names a profile the row omits", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7)];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  expect(rows[0].credential.access).toBe("fixture-access");
  // The CLI profile fills the row's missing identity, so later polls match it.
  expect(rows[0].credential.profileArn).toBe("fixture-profile");
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
});

test("Kiro sync refuses a row whose stored profile contradicts the token", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { profileArn: "different-profile" })];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
  expect(rows[0].credential.access).toBe("old-7");
});

test("Kiro sync retries a write that did not land and keeps no secret in its result", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  const replaceById = storage.credentials.replaceById;
  storage.credentials.replaceById = () => { throw new Error("fixture-transient-write-failure"); };

  const failed = await syncKiro(storage, path);
  expect(failed).toEqual({ synced: false, retry: true });
  expect(rows[0].credential.access).toBe("old-7");
  expect(JSON.stringify(failed)).not.toContain("fixture-access");
  expect(JSON.stringify(failed)).not.toContain("fixture-refresh");

  // The source is unchanged, so only a retry can move the token across.
  storage.credentials.replaceById = replaceById;
  expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  expect(rows[0].credential.access).toBe("fixture-access");
});

test("Kiro sync retries when a concurrent write wins the comparison", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  storage.credentials.replaceById = () => 0;
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: true });
});

test("Kiro sync reports a vanished row as a retry so the next poll looks again", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  storage.credentials.replaceById = () => -1;
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: true });
});

test("Kiro sync stays idle when the credential is already current", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  let writes = 0;
  storage.credentials.replaceById = () => { writes++; return 0; };
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
  expect(writes).toBe(0);
});

test("Kiro sync never inserts when the host offers no by-id write", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [kiroRow(7, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  delete storage.credentials.replaceById;
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
  // The inserting upsert stays untouched: it would add a clone of this account.
  expect(storage.upserts).toHaveLength(0);
  expect(rows).toHaveLength(1);
  expect(rows[0].credential.access).toBe("old-7");
});

test("Kiro sync skips a disabled account and a missing or corrupt source", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const rows = [{ ...kiroRow(7, { profileArn: "fixture-profile" }), disabledCause: "fixture-disabled" }];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
  expect(rows[0].credential.access).toBe("old-7");

  expect(await syncKiro(storageFixture([kiroRow(7)]), join(config.directory, "absent.db")))
    .toEqual({ synced: false, retry: false });

  const corrupt = join(config.directory, "corrupt.db");
  await writeFile(corrupt, "not a database");
  expect(await syncKiro(storageFixture([kiroRow(7)]), corrupt)).toEqual({ synced: false, retry: false });
});

test("Kiro sync ignores an unusable CLI token", async () => {
  const config = await configFor();
  const rows = [kiroRow(7, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  // Each field must be rejected on its own: a rejected refresh token has to
  // block a write even though the access token is fine, and the reverse holds.
  for (const token of [
    { access_token: "undefined" }, { access_token: "" }, { access_token: "   " },
    { refresh_token: "undefined" }, { refresh_token: " " },
  ]) {
    const path = await kiroDatabase(config.directory, token);
    expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
  }
  expect(rows[0].credential.access).toBe("old-7");
});

test("Kiro sync reuses a stored deadline when the token carries no expiration", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile", expires_at: undefined });
  const rows = [kiroRow(7, { profileArn: "fixture-profile" })];
  const storage = storageFixture(rows);
  expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  const stored = rows[0].credential.expires;
  expect(stored).toBeGreaterThan(Date.now());
  // A fresh deadline on every poll would rewrite the row forever.
  expect(await syncKiro(storage, path)).toEqual({ synced: false, retry: false });
  expect(rows[0].credential.expires).toBe(stored);
});

test("the plugin host registers actual models, OAuth, and custom transports", async () => {
  const config = await configFor();
  const plugins = join(config.directory, "plugins");
  const packageDir = join(plugins, "node_modules", "fixture-provider");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(plugins, "package.json"), JSON.stringify({ dependencies: { "fixture-provider": "1.0.0" } }));
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "fixture-provider", version: "1.0.0", type: "module", omp: { extensions: ["index.mjs"] } }));
  await writeFile(join(packageDir, "index.mjs"), 'import { AssistantMessageEventStream } from "@earendil-works/pi-ai"; export default host => { host.registerProvider("fixture-plugin", {api:"fixture-native", models:[{id:"fixture"}], oauth:{login:async()=>({access:"fixture"})}, streamSimple:()=>new AssistantMessageEventStream()}); };');
  await writeFile(config.shimsConfig, JSON.stringify({ version: 2, features: {
    "plugin-bridge": { enabled: true, pluginsDir: plugins }, "copilot-auto": { enabled: false },
    "cline-pin-upstream": { enabled: false }, "kiro-credential-sync": { enabled: false },
  }, pluginBridge: { tokens: { "fixture-plugin": { value: "fixture-configured-token" } } } }));
  const registry = registryFixture();
  const storage = storageFixture();
  let configuredToken;
  storage.keys.setConfig = (provider, token) => { configuredToken = { provider, token }; };
  const host = await createRemoteFeatures({ config, storage, registry });
  hosts.push(host);
  const provider = registry.registrations.get("fixture-plugin");
  expect(provider.models[0].id).toBe("fixture");
  expect(typeof provider.oauth.login).toBe("function");
  expect(typeof provider.streamSimple).toBe("function");
  expect(configuredToken).toEqual({ provider: "fixture-plugin", token: "fixture-configured-token" });
  expect(host.usesCustomTransport({ api: "fixture-native" })).toBe(true);
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
  expect(registry.registrations.size).toBe(0);
  // A second close must stay a no-op: no disposer runs twice, nothing throws.
  await host.close();
  expect(registry.registrations.size).toBe(0);
});

/** The gate and the two signals a slow fixture plugin reports through. */
const SLOW_PLUGIN = Symbol.for("zproxy.local.test.slow-plugin");

/**
 * Install a plugin that registers one provider at once and one more after
 * `gate` opens, then returns a disposer that records its own run.
 *
 * The first provider is there before any deadline, so it must survive one;
 * the second one can only arrive late.
 */
async function slowPlugin(config, gate) {
  const plugins = join(config.directory, "plugins");
  const packageDir = join(plugins, "node_modules", "fixture-slow-provider");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(plugins, "package.json"), JSON.stringify({ dependencies: { "fixture-slow-provider": "1.0.0" } }));
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "fixture-slow-provider", version: "1.0.0", type: "module", omp: { extensions: ["index.mjs"] } }));
  const settled = Promise.withResolvers();
  const disposed = Promise.withResolvers();
  globalThis[SLOW_PLUGIN] = { gate, settled: settled.resolve, disposed: disposed.resolve };
  await writeFile(join(packageDir, "index.mjs"), 'import { AssistantMessageEventStream } from "@earendil-works/pi-ai";' +
    ' const key = Symbol.for("zproxy.local.test.slow-plugin");' +
    ' export default async host => {' +
    ' const late = globalThis[key];' +
    ' host.registerProvider("ready-plugin", { api: "fixture-native", models: [{ id: "ready" }], streamSimple: () => new AssistantMessageEventStream() });' +
    ' await late.gate;' +
    ' host.registerProvider("late-plugin", { api: "fixture-native", models: [{ id: "late" }], streamSimple: () => new AssistantMessageEventStream() });' +
    ' late.settled();' +
    ' return () => { late.disposed(); };' +
    ' };');
  await writeFile(config.shimsConfig, JSON.stringify({ version: 2, features: {
    "plugin-bridge": { enabled: true, pluginsDir: plugins, eagerTimeoutMs: 1000 },
    "copilot-auto": { enabled: false }, "cline-pin-upstream": { enabled: false },
    "kiro-credential-sync": { enabled: false },
  } }));
  return { settled, disposed };
}

test("a plugin that outlives the initialization deadline keeps its ready provider", async () => {
  const config = await configFor();
  const gate = Promise.withResolvers();
  const { settled, disposed } = await slowPlugin(config, gate.promise);
  const registry = registryFixture();
  try {
    // The deadline must not turn a slow plugin into a startup failure.
    const host = await createRemoteFeatures({ config, storage: storageFixture(), registry });
    hosts.push(host);
    // The provider registered before the deadline stays advertised.
    expect(registry.registrations.get("ready-plugin")?.models[0].id).toBe("ready");
    gate.resolve();
    await settled.promise;
    // The provider registered after the deadline is discarded, not added late.
    expect(registry.registrations.has("late-plugin")).toBe(false);
    // Its disposer still runs, so the plugin can release what it built.
    await disposed.promise;
    expect(registry.registrations.has("late-plugin")).toBe(false);
  } finally { delete globalThis[SLOW_PLUGIN]; }
});

test("a plugin that finishes after close leaves no registration behind", async () => {
  const config = await configFor();
  const gate = Promise.withResolvers();
  const { settled, disposed } = await slowPlugin(config, gate.promise);
  const registry = registryFixture();
  try {
    const host = await createRemoteFeatures({ config, storage: storageFixture(), registry });
    hosts.push(host);
    expect(registry.registrations.get("ready-plugin")?.models[0].id).toBe("ready");
    await host.close();
    expect(registry.registrations.size).toBe(0);
    await host.close();
    gate.resolve();
    await settled.promise;
    await disposed.promise;
    // Close happened first, so neither the registration nor the disposer can
    // bring a provider back into a closed host.
    expect(registry.registrations.size).toBe(0);
    await host.close();
    expect(registry.registrations.size).toBe(0);
  } finally { delete globalThis[SLOW_PLUGIN]; }
});



test("Kiro sync persists through the real local OMP credential store", async () => {
  const config = await configFor();
  const path = await kiroDatabase(config.directory, { profile_arn: "fixture-profile" });
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const storage = await AuthStorage.create(config.authDatabase);
  try {
    await storage.credentials.reload();
    await storage.credentials.upsert("kiro", { type: "oauth", access: "old-access", refresh: "old-refresh",
      expires: 0, profileArn: "fixture-profile" });
    expect(await syncKiro(storage, path)).toEqual({ synced: true, retry: false });
  } finally { storage.close(); }
  const reopened = await AuthStorage.create(config.authDatabase);
  try {
    await reopened.credentials.reload();
    const rows = reopened.credentials.list("kiro");
    expect(rows).toHaveLength(1);
    expect(rows[0].credential.access).toBe("fixture-access");
    expect(rows[0].credential.refresh).toBe("fixture-refresh|desktop");
  } finally { reopened.close(); }
});
