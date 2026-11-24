import { afterEach, beforeEach, expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createRemoteAccounts } from "./remote-accounts.mjs";

let storage;
let accounts;
const user = { name: "user-fixture", limitsModels: false, allows: () => true, credentialSessionId: (_, id) => id, retain: () => () => {} };
const request = () => new Request("http://private/v1/chat/completions", { method: "POST", body: "{}" });

beforeEach(async () => {
  storage = await AuthStorage.create(":memory:");
  await storage.credentials.set("fixture", [{ type: "api_key", key: "first-server-key" }, { type: "api_key", key: "second-server-key" }]);
  accounts = createRemoteAccounts(storage);
});
afterEach(() => { accounts?.close(); storage?.close(); });

test("the policy sees safe rows and resolves secrets only within the server", async () => {
  const rows = await accounts.credentials.listAccounts("fixture");
  expect(rows.length).toBe(2);
  expect(JSON.stringify(rows)).not.toMatch(/server-key|secret|refresh/);
  expect(await accounts.credentials.listProviders()).toContain("fixture");
  expect((await accounts.credentials.resolve("fixture", { id: rows[1].id })).secret).toBe("second-server-key");
});

test("concurrent selected static accounts never change the global provider key", async () => {
  const rows = storage.credentials.list("fixture");
  storage.keys.setRuntime("fixture", "global-runtime-key");
  const original = await storage.keys.getWithCredential("fixture");
  const run = (row, pause) => accounts.dispatch(request(), "private", user, { provider: "fixture", credentialId: row.id }, async (_req, _peer, scope) => {
    await new Promise(resolve => setTimeout(resolve, pause));
    const resolved = await storage.keys.getWithCredential("fixture", scope.credentialSessionId("fixture", "same"));
    expect(resolved.apiKey).toBe(row.credential.key);
    expect(resolved.credentialId).toBe(row.id);
    return new Response("ok");
  }).then(response => response.text());
  expect(await Promise.all([run(rows[0], 15), run(rows[1], 1)])).toEqual(["ok", "ok"]);
  expect((await storage.keys.getWithCredential("fixture")).apiKey).toBe(original.apiKey);
});

test("a selected static key never rotates into another stored key", async () => {
  const row = storage.credentials.list("fixture")[1];
  const response = await accounts.dispatch(request(), "private", user, { provider: "fixture", credentialId: row.id }, async (_req, _peer, scope) => {
    const session = scope.credentialSessionId("fixture", "same");
    expect((await storage.keys.getWithCredential("fixture", session)).credentialId).toBe(row.id);
    expect(await storage.keys.getWithCredential("fixture", session, { forceRefresh: true })).toBeUndefined();
    expect(await storage.keys.getWithCredential("fixture", session)).toBeUndefined();
    return new Response("ok");
  });
  await response.text();
});

test("OAuth restrictions outlive headers and remain until the last official lease closes", async () => {
  await storage.credentials.set("openai-codex", [
    { type: "oauth", access: "first-oauth", refresh: "first-refresh", expires: Date.now() + 3600000, accountId: "first-account", email: "first@example.invalid" },
    { type: "oauth", access: "second-oauth", refresh: "second-refresh", expires: Date.now() + 3600000, accountId: "second-account", email: "second@example.invalid" },
  ]);
  const rows = storage.credentials.list("openai-codex");
  let session;
  let releaseOfficial;
  const response = await accounts.dispatch(request(), "private", user, { provider: "openai-codex", credentialId: rows[1].id }, async (_req, _peer, scope) => {
    session = scope.credentialSessionId("openai-codex", "same");
    releaseOfficial = scope.retain();
    expect(storage.sessions.permits("openai-codex", session, rows[0].id)).toBe(false);
    expect(storage.sessions.permits("openai-codex", session, rows[1].id)).toBe(true);
    expect(() => scope.credentialSessionId("fixture", "same")).toThrow();
    return new Response("ok");
  });
  await response.text();
  expect(storage.sessions.permits("openai-codex", session, rows[0].id)).toBe(false);
  releaseOfficial();
  expect(storage.sessions.permits("openai-codex", session, rows[0].id)).toBe(true);
});

test("cancel closes an account scope and missing accounts fail closed", async () => {
  const row = storage.credentials.list("fixture")[0];
  let saved;
  const response = await accounts.dispatch(request(), "private", user, { provider: "fixture", credentialId: row.id }, async (_req, _peer, scope) => {
    saved = scope;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("first")); } }));
  });
  await response.body.cancel();
  expect(() => saved.credentialSessionId("fixture", "same")).toThrow();
  await expect(accounts.dispatch(request(), "private", user, { provider: "fixture", credentialId: 999999 }, () => { throw new Error("must not run"); })).rejects.toThrow("not available");
});

test("a caller deadline does not abort the official OAuth refresh", async () => {
  await storage.credentials.set("openai-codex", [
    { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000, accountId: "acct", email: "acct@example.invalid" },
  ]);
  const row = storage.credentials.list("openai-codex")[0];
  let passed = "unset";
  let finish;
  const hung = new Promise(resolve => { finish = resolve; });
  storage.oauth.refresh = (id, signal) => {
    expect(id).toBe(row.id);
    passed = signal;
    return hung;
  };
  expect(await accounts.credentials.refresh(row.id, { timeoutMs: 20 })).toBeUndefined();
  expect(passed).toBeUndefined();
  let settled = false;
  const pending = hung.then(() => { settled = true; });
  expect(settled).toBe(false);
  finish();
  await pending;
  expect(settled).toBe(true);
  storage.oauth.refresh = async id => {
    expect(id).toBe(row.id);
    return { id };
  };
  expect((await accounts.credentials.refresh(row.id, { timeoutMs: 1000 })).secret).toBe("old-access");
});
