// Compose the original route policy with the official remote account owner.
import { oauthAccountKey } from "@oh-my-pi/pi-ai/auth/types";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRemoteAccounts } from "./remote-accounts.mjs";
import { loadConfig } from "./shim/config.mjs";
import { clearProviderBlocks } from "./shim/credentials.mjs";
import { activePin } from "./shim/contracts.mjs";
import { readJson } from "./shim/inbound.mjs";
import { AdmissionControl } from "./router/admission.mjs";
import { PrefixAffinity } from "./router/affinity.mjs";
import { currentAttempt, quotaWording } from "./router/attempt.mjs";
import { InFlightTracker } from "./router/capacity.mjs";
import { ModelCatalog } from "./router/catalog.mjs";
import { disallowedClientModelRequest, forbiddenModelResponse } from "./router/client-model-policy.mjs";
import { CyclicSpeed } from "./router/cyclic-speed.mjs";
import { sanitizeDirectResponse } from "./router/direct-guard.mjs";
import { GatewayDispatcher } from "./router/dispatcher.mjs";
import { createEventLog } from "./router/events.mjs";
import { FaultInjector } from "./router/faults.mjs";
import { formatForPath } from "./router/formats.mjs";
import { HealthRegistry } from "./router/health.mjs";
import { ModelPerf } from "./router/perf.mjs";
import { ComposedPolicy, loadPlanData } from "./router/plan.mjs";
import { ProviderConcurrencyProof } from "./router/provider-concurrency-proof.mjs";
import { LazyRouter } from "./router/router.mjs";
import { StateStore } from "./router/state-store.mjs";
import { AccountDirectory } from "./router/tiers.mjs";

const PRIVATE_METADATA = "x-zproxy-private-metadata";
const PRIVATE_PROBE = "x-zproxy-private-probe";
const utf8 = new TextEncoder();

export const AG_PROVIDER = "google-antigravity";

/**
 * How long one account-level upstream refusal benches the whole account.
 *
 * Every cooldown in this routing layer uses the same interval, so an account
 * withdrawn by the upstream returns on the same schedule as one that merely
 * answered an account-status failure. The refusal is a state, never a
 * permanent exclusion: the upstream can let the account back in.
 */
const ACCOUNT_COOLDOWN_MS = 30 * 60_000;

/**
 * Accounts the upstream refused as a whole, keyed `${provider}/${account}`.
 *
 * A refusal can be confined to one model (a quota) or cover the account (a
 * terms-of-service or verification answer). Only the second kind belongs here:
 * it says the account may not be used at all, so selecting it for any model
 * would spend another request on the same refusal.
 */
export function createAccountCooldowns({ now = Date.now } = {}) {
  const until = new Map();
  const live = (key, at) => {
    const deadline = until.get(key);
    if (deadline === undefined) return false;
    if (deadline > at) return true;
    until.delete(key);
    return false;
  };
  return {
    /** Bench one account for the standard interval. */
    block(provider, account, durationMs = ACCOUNT_COOLDOWN_MS) {
      if (account === undefined || account === null) return;
      const key = `${provider}/${account}`;
      const at = now();
      // Extend, never shorten: a later refusal of the same account restarts
      // the interval, and a shorter one cannot cut it.
      const deadline = at + Math.max(1, durationMs);
      if (!(until.get(key) >= deadline)) until.set(key, deadline);
    },
    /** True while one account is still benched. */
    blocked(provider, account) {
      if (account === undefined || account === null) return false;
      return live(`${provider}/${account}`, now());
    },
    /** Drop every expired entry, so the map cannot grow without bound. */
    sweep() {
      const at = now();
      for (const key of [...until.keys()]) live(key, at);
    },
  };
}

/**
 * Drop every candidate whose account the upstream withdrew as a whole.
 *
 * This runs before ranking, so an account-level refusal costs no further
 * request on any of its models. The cooldown expires by itself, so the account
 * rejoins the pool without any explicit recovery step.
 */
export function excludeBlockedAccounts(candidates, cooldowns) {
  return candidates.filter((candidate) => !cooldowns.blocked(candidate.provider, candidate.account));
}

/** True when one catalog model can be scheduled as its own Antigravity route. */
export function antigravitySchedulable(model) {
  return model?.provider === AG_PROVIDER
    && Number.isInteger(model.contextWindow) && model.contextWindow > 0
    && Number.isInteger(model.maxTokens) && model.maxTokens > 0;
}

/**
 * Add one model-only route per schedulable Antigravity model. A model the
 * plan already routes keeps its configured graph, so a plan or alias wins.
 * The graph names exactly one model: only the account may change.
 *
 * These routes stay reachable by name but stay out of the advertised model
 * list, the status topology, and the routing page. The caller replaced the
 * provider's own model names with the four lazy aliases, so a direct name is
 * an internal fallback, not a published one.
 */
export function planWithDirectRoutes(baseRoutes, models) {
  const routes = { ...(baseRoutes ?? {}) };
  const direct = new Set();
  const hidden = new Set();
  for (const model of models ?? []) {
    if (!antigravitySchedulable(model)) continue;
    const ref = `${model.provider}/${model.id}`;
    if (Object.hasOwn(routes, ref)) continue;
    routes[ref] = {
      contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
      graph: { type: "model", model: ref },
    };
    direct.add(ref);
    hidden.add(ref);
  }
  return { routes, direct, hidden };
}

/** Every provider a compiled plan names. */
export function planProvidersOfRoutes(data) {
  const providers = new Set();
  const visit = (node) => {
    if (!node) return;
    if (node.type === "model" && typeof node.model === "string") {
      const slash = node.model.indexOf("/");
      if (slash > 0) providers.add(node.model.slice(0, slash));
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const route of Object.values(data?.routes ?? {})) visit(route.graph);
  return providers;
}

export function prioritizeDirectAccounts(candidates, model, credentials, now = Date.now()) {
  const rows = new Map(credentials.map(row => [row.id, row.credential]));
  const priority = candidate => {
    const credential = rows.get(candidate.account);
    if (!credential) return 2;
    const identity = oauthAccountKey(credential);
    const unavailable = model?.accountAccess && (!identity || !Object.hasOwn(model.accountAccess, identity));
    const expired = credential.type === "oauth" && Number(credential.expires) <= now;
    return (unavailable ? 2 : 0) + (expired ? 1 : 0);
  };
  return candidates.filter(candidate => {
    const credential = rows.get(candidate.account);
    if (!model?.accountAccess || credential?.type !== "oauth") return true;
    const identity = oauthAccountKey(credential);
    return identity !== undefined && Object.hasOwn(model.accountAccess, identity);
  }).map((candidate, index) => ({ candidate, index, priority: priority(candidate) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index).map(row => row.candidate);
}

// The policy sees raw bytes for bounded usage and timing. It never sees the
// binary metadata prefix, which would corrupt SSE scans and first-byte timing.
export async function unpackRoutingResponse(response) {
  if (response.headers.get("x-zproxy-decode") !== "1") return response;
  const reader = response.body.getReader();
  let pending = new Uint8Array();
  async function take(length) {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (!pending.byteLength) {
        const item = await reader.read();
        if (item.done) throw new Error("The raw metadata prefix is incomplete.");
        pending = item.value;
      }
      const count = Math.min(length - offset, pending.byteLength);
      bytes.set(pending.subarray(0, count), offset);
      pending = pending.subarray(count);
      offset += count;
    }
    return bytes;
  }
  try {
    const prefix = await take(4);
    const length = new DataView(prefix.buffer).getUint32(0);
    if (!length || length > 16384) throw new Error("The raw metadata prefix exceeds its limit.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await take(length));
    const metadata = JSON.parse(text);
    if (metadata.decoder !== "omp-response" || metadata.version !== 1) throw new Error("Unknown raw decoder.");
    const headers = new Headers(response.headers);
    headers.set(PRIVATE_METADATA, Buffer.from(text, "utf8").toString("base64url"));
    return new Response(new ReadableStream({
      async pull(target) {
        if (pending.byteLength) { const next = pending; pending = new Uint8Array(); target.enqueue(next); return; }
        try {
          const item = await reader.read();
          if (item.done) { reader.releaseLock(); target.close(); }
          else target.enqueue(item.value);
        } catch (error) { reader.releaseLock(); target.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
    }, { highWaterMark: 0 }), { status: response.status, headers });
  } catch (error) {
    try { await reader.cancel(error); } finally { reader.releaseLock(); }
    throw error;
  }
}

/** The private response headers this process may set and never forwards. */
const PRIVATE_RESPONSE_HEADERS = Object.freeze(["x-zproxy-refusal"]);

/**
 * Copy one response without the private response headers.
 *
 * The refusal classification is read inside the routing layer only. Every
 * answer that leaves that layer passes here first, so no public response can
 * carry it, whichever path produced the response.
 */
export function dropPrivateHeaders(response) {
  if (!response?.headers) return response;
  if (!PRIVATE_RESPONSE_HEADERS.some(name => response.headers.has(name))) return response;
  const headers = new Headers(response.headers);
  for (const name of PRIVATE_RESPONSE_HEADERS) headers.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function packRoutingResponse(response, publicModel) {
  const text = response.headers.get(PRIVATE_METADATA);
  if (!text) return response;
  let bytes;
  try {
    const metadata = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    metadata.modelAlias = typeof publicModel === "string" && utf8.encode(publicModel).byteLength <= 128
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(publicModel) ? publicModel : "";
    bytes = utf8.encode(JSON.stringify(metadata));
    if (bytes.byteLength > 16384) throw new Error("The raw metadata prefix exceeds its limit.");
  } catch (error) {
    await response.body?.cancel(error);
    throw error;
  }
  const prefix = new Uint8Array(4 + bytes.byteLength);
  new DataView(prefix.buffer).setUint32(0, bytes.byteLength);
  prefix.set(bytes, 4);
  const headers = new Headers(response.headers);
  headers.delete(PRIVATE_METADATA);
  headers.delete("content-length");
  const reader = response.body.getReader();
  let initial = true;
  return new Response(new ReadableStream({
    async pull(target) {
      if (initial) { initial = false; target.enqueue(prefix); return; }
      try {
        const item = await reader.read();
        if (item.done) { reader.releaseLock(); target.close(); }
        else target.enqueue(item.value);
      } catch (error) { reader.releaseLock(); target.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 }), { status: response.status, headers });
}

export async function createRemoteRouting({ config, storage, registry, dispatch, resolveModel }) {
  const shims = loadConfig(config.shimsConfig);
  const settings = shims.features["lazy-router"];
  // Even without the router, the private classification must not reach a
  // caller: this layer owns that boundary whether or not it schedules.
  if (!settings.enabled) {
    return {
      dispatch: async (request, peer, scope) =>
        dropPrivateHeaders(await sanitizeDirectResponse(await dispatch(request, peer, scope))),
    };
  }
  const base = dirname(config.shimsConfig);
  const loaded = loadPlanData(settings.routesFile ? resolve(base, settings.routesFile) : undefined);
  const directModels = new Set();
  let planData;
  let policy;
  let router;
  // One cooldown table for every account the upstream withdrew as a whole.
  const accountCooldowns = createAccountCooldowns();
  const antigravityAccounts = () => storage.credentials.list(AG_PROVIDER)
    .some((row) => Boolean(row?.credential) && !row.disabledCause);
  // Recompile the plan so a model gained after startup joins its own route.
  const installPolicy = () => {
    // Only inject while a schedulable account exists, so an account-less provider
    // keeps answering through the gateway (401) instead of the router (503).
    const injected = planWithDirectRoutes(loaded.routes,
      config.antigravity2api && antigravityAccounts() ? registry.getAll("chat") : []);
    planData = { ...loaded, routes: injected.routes,
      maxInFlight: { ...loaded.maxInFlight, ...settings.maxInFlight } };
    const fresh = new ComposedPolicy(planData);
    const candidatesFor = fresh.candidatesFor.bind(fresh);
    fresh.candidatesFor = (route, options) => {
      // An account the upstream withdrew for good-for-now is excluded before
      // any ranking, so no selection can spend a request on the same refusal.
      // The cooldown expires on its own, so the account returns by itself.
      const candidates = excludeBlockedAccounts(candidatesFor(route, options), accountCooldowns);
      if (!injected.direct.has(route)) return candidates;
      return prioritizeDirectAccounts(candidates, resolveModel(route),
        storage.credentials.list(AG_PROVIDER));
    };
    if (config.antigravity2api) {
      const limit = fresh.maxInFlight.bind(fresh);
      fresh.maxInFlight = (unit) => {
        const key = typeof unit === "string" ? unit : unit?.key ?? unit?.provider;
        return typeof key === "string" && /^google-antigravity(?:$|[/#])/.test(key)
          ? 0 : limit(unit);
      };
    }
    directModels.clear();
    for (const ref of injected.direct) directModels.add(ref);
    policy = fresh;
    if (!router) return;
    // A rebuild only appends newly scheduled models, so a request that
    // already resolved its route keeps one consistent graph until it ends.
    router.policy = fresh;
    router.planData = planData;
    router.routeSet = new Set(fresh.routeNames);
    router.hiddenRoutes = new Set(injected.hidden);
    // Replace, never accumulate: planData is rebuilt in full, so a provider that
    // lost its last scheduled model must leave the account placeholder set too.
    router.planProviders = planProvidersOfRoutes(planData);
  };
  installPolicy();

  let emit = () => {};
  if (settings.out) {
    const path = resolve(base, settings.out);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "a", 0o600);
    await file.close();
    await chmod(path, 0o600);
    emit = createEventLog({ out: path, report: () => {} });
  }
  const statePath = settings.store === "memory" ? null : shims.stateDbPath;
  if (statePath) await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const store = new StateStore({ path: statePath, ...(statePath ? {} : { mode: "memory" }),
    admissionWindowMs: settings.admissionWindowMs });
  if (statePath) await chmod(statePath, 0o600);
  const accounts = createRemoteAccounts(storage, { activePin });
  const scopeStore = new AsyncLocalStorage();
  const probeScope = { name: "zproxy-routing-probes", limitsModels: false, allows: () => true,
    credentialSessionId: (provider, session) => createHash("sha256").update(JSON.stringify(["zproxy-probe", provider, session])).digest("hex"),
    retain: () => () => {} };
  const dispatcher = new GatewayDispatcher({ headerTimeoutMs: settings.headerTimeoutMs, readToken: () => "" });
  const makeProbe = dispatcher.internalRequest.bind(dispatcher);
  dispatcher.internalRequest = (path, body) => {
    const request = makeProbe(path, body);
    request.headers.set(PRIVATE_PROBE, "1");
    return request;
  };
  dispatcher.bind(async request => {
    const context = scopeStore.getStore();
    const scope = request.headers.has(PRIVATE_PROBE) ? probeScope : context?.scope;
    if (!scope) throw new Error("The routing request has no authenticated scope.");
    const attempt = currentAttempt();
    const selected = attempt?.credentialId === undefined ? undefined
      : { provider: attempt.provider, credentialId: attempt.credentialId };
    const response = await accounts.dispatch(request, context?.peer ?? "private-probe", scope, selected, dispatch);
    return unpackRoutingResponse(response);
  }, "private-unix");
  const disabled = new Set(config.disabledProviders ?? []);
  const hostSnapshot = () => registry.getAll("chat").filter(model => !disabled.has(model.provider));
  const catalog = new ModelCatalog({ overrides: planData.modelTraits, hostSnapshot,
    agentDbPath: config.authDatabase, isRouteModel: id => policy.routeNames.includes(id) });
  const providers = new Set(hostSnapshot().map(model => model.provider));
  const accountDirectory = new AccountDirectory({ credentials: accounts.credentials, providers,
    recheckMs: settings.tierRecheckMs, tierRefreshMs: settings.tierRefreshMs });
  const health = new HealthRegistry({ store, probeIntervalMs: settings.probeIntervalMs, onEvent: emit });
  const capacity = new InFlightTracker({ store, limitOf: key => router?.capacityLimits.get(key) ?? 0 });
  const admission = new AdmissionControl({ store, windowMs: settings.admissionWindowMs });
  const affinity = new PrefixAffinity({ store, ttlMs: settings.affinityTtlMs,
    maxEntries: settings.affinityMaxEntries, minPrefixBytes: settings.affinityMinPrefixBytes });
  const perf = new ModelPerf({ store });
  const speed = new CyclicSpeed({ store });
  const concurrencyProof = new ProviderConcurrencyProof({ store });
  router = new LazyRouter({ policy, catalog, health, dispatcher, affinity, capacity, admission, perf, speed,
    store, concurrencyProof, credentials: accounts.credentials, accountDirectory, planData, emit,
    faults: new FaultInjector(settings.testFaults), settings, pinnedProviders: new Set() });
  // The first compile ran before this router existed, so its plan and hidden set
  // never reached it. Compile once more now; later compiles update it in place.
  installPolicy();
  const close = async () => {
    router.dispose();
    accountDirectory.stop();
    speed.stop?.();
    await accounts.close();
    store.close();
    emit.close?.();
  };
  try {
    store.start();
    catalog.refresh();
    await accountDirectory.start();
    speed.start?.();
  } catch (error) { await close(); throw error; }
  return {
    router, store,
    observeTurn(model) {
      const attempt = currentAttempt();
      return {
        onContact() { if (attempt?.provider === model.provider) attempt.contacted = true; },
        classifyError: text => quotaWording(text) ? "quota" : undefined,
        // The adapter reports the worker's private classification of one
        // upstream answer. An account-level refusal covers every model of that
        // account, so it benches the account here, where the attempt still
        // names which account served it. The interval is the routing layer's
        // usual one, and it ends by itself, so a lifted block needs no action.
        onAccountRefused() {
          if (attempt?.credentialId !== undefined) {
            accountCooldowns.block(attempt.provider ?? model.provider, attempt.credentialId);
          }
        },
      };
    },
    dispatch(request, peer, scope) {
      return scopeStore.run({ peer, scope }, async () => {
          const body = await readJson(request);
          const format = formatForPath(new URL(request.url).pathname);
          const requested = typeof body?.model === "string" ? body.model : undefined;
          const resolved = requested === undefined ? undefined : resolveModel(requested);
          let response;
          const candidate = antigravitySchedulable(resolved)
            ? `${resolved.provider}/${resolved.id}` : undefined;
          // The catalog and the credential list both move. Recompile whenever the
          // injected set disagrees with whether an account can serve right now.
          const hasAccounts = config.antigravity2api && antigravityAccounts();
          if (candidate !== undefined && (directModels.has(candidate)
            ? !hasAccounts : hasAccounts && !router.handles(candidate))) {
            installPolicy();
          }
          const directRef = candidate !== undefined && directModels.has(candidate) ? candidate : undefined;
          if (format && directRef !== undefined) {
            // Preserve the requested effort and limit; only the account may change.
            const directFormat = {
              ...format, writeEffort() {}, writeMaxTokens() {}, requestUsage() {} };
            response = await router.serve(directFormat, { ...body, model: directRef }, request);
          } else if (requested !== undefined && router.handles(requested)) {
            // Injection never shadows a configured route, so these two sets are disjoint.
            response = await router.serve(format, body, request);
          } else if (disallowedClientModelRequest({ method: request.method, body, router,
            clientOnlyPrefix: settings.clientOnlyPrefix, supportedFormat: Boolean(format) })) {
            return forbiddenModelResponse();
          } else {
            const started = Date.now();
            const epoch = store.captureTokenEpoch();
            // This is the only boundary where a direct provider answer reaches
            // the caller without the router's classification. Replace an
            // account-status reply before it can carry a provider status, URL,
            // or billing text.
            response = await dispatcher.forward(request);
            if (response.status === 402 && format !== undefined) {
              // A provider may answer 402 when concurrent budget reservations
              // collide, while the account still has credit. Clear the block
              // written for that one answer and ask once more.
              const provider = resolved?.provider ?? "mistral";
              await clearProviderBlocks(config.authDatabase, provider);
              const headers = new Headers(request.headers);
              headers.delete("content-length");
              headers.delete("content-encoding");
              response = await dispatcher.forward(new Request(request.url, {
                method: request.method,
                headers,
                body: JSON.stringify(body),
                signal: request.signal,
              }));
              // The retry may answer 402 too and write a fresh block. Clear it
              // before returning: one upstream answer must not bench the
              // account for the provider's whole cooldown.
              if (response.status === 402) await clearProviderBlocks(config.authDatabase, provider);
            }
            response = await sanitizeDirectResponse(response);
            if (resolved && response.ok) {
              const ref = `${resolved.provider}/${resolved.id}`;
              response = router.measureDirect(ref, response, started, request.signal, epoch);
            }
          }
        // The private classification travels only inside this process. A
        // refusal written by the adapter would otherwise ride back to the
        // caller as a response header; the pack step strips it unconditionally.
        return packRoutingResponse(dropPrivateHeaders(response), body.model);

      });
    },
    close,
  };
}