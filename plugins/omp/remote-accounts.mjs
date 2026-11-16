// Adapt the old routing policy to the one official, server-owned credential store.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";

const owners = new WeakSet();
const enabled = row => row && !row.disabledCause;
const same = (left, right) => String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();

function publicRow(row) {
  const value = row.credential;
  return { id: row.id, provider: row.provider, email: value.email, tier: value.tier,
    disabled: !enabled(row), expiresAt: Number(value.expires ?? value.expiresAt) || 0 };
}

function secretRow(row) {
  const value = row.credential;
  const secret = value.type === "api_key" ? value.key : value.access;
  if (typeof secret !== "string" || !secret.trim() || secret === "N/A") return undefined;
  return { ...publicRow(row), accountId: value.accountId, secret };
}

/** No secret-bearing result from this adapter may leave the remote process. */
export function createRemoteAccounts(storage, { activePin = () => undefined } = {}) {
  if (owners.has(storage)) throw new Error("The credential store already has a routing adapter.");
  owners.add(storage);
  const context = new AsyncLocalStorage();
  const keys = storage.keys;
  const originalResolve = keys.getWithCredential;
  let closed = false;
  const leases = new Set();
  const rows = provider => storage.credentials.list(provider);
  const find = (provider, id) => rows(provider).find(row => String(row.id) === String(id));

  // Native OMP restricts OAuth accounts. This scoped decorator covers stored static keys.
  const scopedResolve = async function(provider, sessionId, options) {
    const current = context.getStore();
    if (!current || current.provider !== provider || !["api_key", "oauth-exact"].includes(current.kind)) {
      return originalResolve.call(keys, provider, sessionId, options);
    }
    if (options?.signal?.aborted) throw options.signal.reason;
    if (current.kind === "oauth-exact") {
      if (current.ended) return undefined;
      const access = await storage.oauth.accessById(provider, current.credentialId, options);
      if (!access?.ok) return undefined;
      const { accountId, orgId, region, inferenceRegion } = access;
      return { apiKey: access.apiKey, credentialId: current.credentialId, oauthAccess: access.accessToken,
        oauthIdentity: { accountId, orgId, region, inferenceRegion } };
    }
    if (options?.forceRefresh) current.failed = true;
    if (current.failed || current.ended) return undefined;
    const row = find(provider, current.credentialId);
    if (!enabled(row) || row.credential.type !== "api_key") return undefined;
    return { apiKey: row.credential.key, credentialId: row.id };
  };
  keys.getWithCredential = scopedResolve;

  const credentials = {
    async listProviders() {
      await storage.credentials.poll();
      return [...new Set(rows().map(row => row.provider))].sort();
    },
    async listAccounts(provider) {
      await storage.credentials.poll();
      return rows(provider).map(publicRow);
    },
    async resolve(provider, filter = {}) {
      await storage.credentials.poll();
      const current = context.getStore();
      const pin = activePin(provider) ?? (current?.provider === provider ? current : undefined);
      const pinId = pin?.credentialId ?? pin?.id;
      if (filter.id !== undefined && pinId !== undefined && String(filter.id) !== String(pinId)) return undefined;
      const id = pinId ?? filter.id;
      for (const row of rows(provider)) {
        if (!enabled(row) || (id !== undefined && String(row.id) !== String(id))) continue;
        const value = secretRow(row);
        if (!value) continue;
        if (filter.accountId !== undefined && String(value.accountId) !== String(filter.accountId)) continue;
        if (filter.email !== undefined && !same(value.email, filter.email)) continue;
        if (filter.tier !== undefined && !same(value.tier, filter.tier)) continue;
        return value;
      }
      return undefined;
    },
    async refresh(id, { signal, timeoutMs = 10000 } = {}) {
      const row = rows().find(item => String(item.id) === String(id));
      if (!enabled(row) || row.credential.type !== "oauth") return undefined;
      const deadline = AbortSignal.timeout(timeoutMs);
      try {
        await storage.oauth.refresh(row.id, signal ? AbortSignal.any([signal, deadline]) : deadline);
        const fresh = find(row.provider, row.id);
        return enabled(fresh) ? secretRow(fresh) : undefined;
      } catch { return undefined; }
    },
    invalidate() { void storage.credentials.poll().catch(() => {}); },
    close() {},
  };

  const dispatch = async (request, peer, userScope, selection, next) => {
    if (closed) throw new Error("The routing account adapter is closed.");
    if (selection?.credentialId === undefined || selection?.credentialId === null) return next(request, peer, userScope);
    const provider = selection.provider;
    const row = find(provider, selection.credentialId);
    if (!enabled(row)) throw new Error("The selected routing account is not available.");
    const session = randomUUID();
    const state = { provider, credentialId: row.id, kind: row.credential.type, failed: false, ended: false };
    let restriction;
    if (state.kind === "oauth") {
      const identity = resolveCredentialIdentityKey(provider, row.credential);
      if (identity) restriction = storage.sessions.restrict(provider, session, [identity]);
      else state.kind = "oauth-exact";
      storage.sessions.pin(provider, session, row.id);
    }
    let holds = 1;
    let retired = false;
    const cleanup = () => {
      if (state.ended || !retired || holds !== 0) return;
      state.ended = true;
      if (restriction) storage.sessions.unrestrict(provider, session, restriction);
      storage.sessions.release(provider, session);
      leases.delete(forceClose);
    };
    const release = () => { if (holds > 0) holds--; cleanup(); };
    const forceClose = () => { retired = true; holds = 0; cleanup(); };
    leases.add(forceClose);
    const scope = {
      ...userScope,
      limitsModels: true,
      allows: model => model.provider === provider && userScope.allows(model),
      credentialSessionId(wanted) {
        if (wanted !== provider || state.ended) throw new Error("The routing account scope is not available.");
        return session;
      },
      retain() {
        if (state.ended) throw new Error("The routing account scope is closed.");
        holds++;
        let held = true;
        return () => { if (held) { held = false; release(); } };
      },
    };
    const retire = () => { retired = true; release(); };
    let response;
    try { response = await context.run(state, () => next(request, peer, scope)); }
    catch (error) { retire(); throw error; }
    if (!response.body) { retire(); return response; }
    const reader = response.body.getReader();
    let ended = false;
    const finish = () => { if (!ended) { ended = true; retire(); } };
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) { reader.releaseLock(); finish(); controller.close(); }
          else controller.enqueue(item.value);
        } catch (error) { try { reader.releaseLock(); } catch {} finish(); controller.error(error); }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); }
        finally { try { reader.releaseLock(); } catch {} finish(); }
      },
    }), { status: response.status, headers: response.headers });
  };

  return {
    credentials, dispatch,
    close() {
      if (closed) return;
      closed = true;
      for (const release of [...leases]) release();
      if (keys.getWithCredential === scopedResolve) keys.getWithCredential = originalResolve;
      owners.delete(storage);
      context.disable();
    },
  };
}
