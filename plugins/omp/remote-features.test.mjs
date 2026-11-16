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

function storageFixture(rows = []) {
  return { credentials: { list: () => rows, upsert: async () => {} }, keys: { setConfig() {} } };
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

test("Kiro sync writes through official credentials and preserves account identity", async () => {
  const config = await configFor();
  const path = join(config.directory, "kiro.db");
  const database = new Database(path);
  database.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  database.query("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:social:token", JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: "2030-01-01T00:00:00Z", region: "us-east-1", profile_arn: "fixture-profile" }));
  database.close();
  let saved;
  const rows = [{ id: 7, disabledCause: null, credential: { type: "oauth", accountId: "fixture-account", email: "fixture@example.invalid", access: "old", refresh: "old", expires: 0, profileArn: "fixture-profile" } }];
  const storage = storageFixture(rows);
  storage.credentials.upsert = async (provider, credential) => { saved = { provider, credential }; };
  expect(await syncKiro(storage, path)).toBe(true);
  expect(saved.provider).toBe("kiro");
  expect(saved.credential.accountId).toBe("fixture-account");
  expect(saved.credential.access).toBe("fixture-access");
  expect(saved.credential.refresh).toBe("fixture-refresh|desktop");
  rows.push({ id: 8, disabledCause: null, credential: { type: "oauth", accountId: "second", profileArn: "another-profile" } });
  expect(await syncKiro(storage, path)).toBe(true);
  expect(saved.credential.accountId).toBe("fixture-account");
  rows[0].credential.profileArn = "different-profile";
  expect(await syncKiro(storage, path)).toBe(false);
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
});

test("a timed-out plugin cannot register later and its late disposer runs", async () => {
  const config = await configFor();
  const plugins = join(config.directory, "plugins");
  const packageDir = join(plugins, "node_modules", "fixture-slow-provider");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(plugins, "package.json"), JSON.stringify({ dependencies: { "fixture-slow-provider": "1.0.0" } }));
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "fixture-slow-provider", version: "1.0.0", type: "module", omp: { extensions: ["index.mjs"] } }));
  const ended = Promise.withResolvers();
  const key = Symbol.for("zproxy.local.test.late-plugin");
  globalThis[key] = ended.resolve;
  await writeFile(join(packageDir, "index.mjs"), 'export default async host => { await new Promise(resolve => setTimeout(resolve, 30)); host.registerProvider("late-plugin", {api:"fixture-native",models:[{id:"late"}]}); return () => globalThis[Symbol.for("zproxy.local.test.late-plugin")](); };');
  await writeFile(config.shimsConfig, JSON.stringify({ version: 2, features: {
    "plugin-bridge": { enabled: true, pluginsDir: plugins, eagerTimeoutMs: 5 }, "copilot-auto": { enabled: false },
    "cline-pin-upstream": { enabled: false }, "kiro-credential-sync": { enabled: false },
  } }));
  const registry = registryFixture();
  try {
    await expect(createRemoteFeatures({ config, storage: storageFixture(), registry })).rejects.toThrow("timed out");
    await ended.promise;
    expect(registry.registrations.size).toBe(0);
  } finally { delete globalThis[key]; }
});
