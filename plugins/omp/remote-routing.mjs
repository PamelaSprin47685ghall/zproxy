// Compose the original route policy with the official remote account owner.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRemoteAccounts } from "./remote-accounts.mjs";
import { loadConfig } from "./vendor/shims/lib/config.mjs";
import { activePin } from "./vendor/shims/lib/contracts.mjs";
import { readJson } from "./vendor/shims/lib/inbound.mjs";
import { AdmissionControl } from "./vendor/shims/lib/router/admission.mjs";
import { PrefixAffinity } from "./vendor/shims/lib/router/affinity.mjs";
import { currentAttempt, quotaWording } from "./vendor/shims/lib/router/attempt.mjs";
import { InFlightTracker } from "./vendor/shims/lib/router/capacity.mjs";
import { ModelCatalog } from "./vendor/shims/lib/router/catalog.mjs";
import { disallowedClientModelRequest, forbiddenModelResponse } from "./vendor/shims/lib/router/client-model-policy.mjs";
import { CyclicSpeed } from "./vendor/shims/lib/router/cyclic-speed.mjs";
import { GatewayDispatcher } from "./vendor/shims/lib/router/dispatcher.mjs";
import { createEventLog } from "./vendor/shims/lib/router/events.mjs";
import { FaultInjector } from "./vendor/shims/lib/router/faults.mjs";
import { formatForPath } from "./vendor/shims/lib/router/formats.mjs";
import { HealthRegistry } from "./vendor/shims/lib/router/health.mjs";
import { ModelPerf } from "./vendor/shims/lib/router/perf.mjs";
import { ComposedPolicy, loadPlanData } from "./vendor/shims/lib/router/plan.mjs";
import { ProviderConcurrencyProof } from "./vendor/shims/lib/router/provider-concurrency-proof.mjs";
import { LazyRouter } from "./vendor/shims/lib/router/router.mjs";
import { StateStore } from "./vendor/shims/lib/router/state-store.mjs";
import { AccountDirectory } from "./vendor/shims/lib/router/tiers.mjs";

const PRIVATE_METADATA = "x-zproxy-private-metadata";
const PRIVATE_PROBE = "x-zproxy-private-probe";
const utf8 = new TextEncoder();

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
  if (!settings.enabled) return { dispatch };
  const base = dirname(config.shimsConfig);
  const loaded = loadPlanData(settings.routesFile ? resolve(base, settings.routesFile) : undefined);
  const planData = { ...loaded, maxInFlight: { ...loaded.maxInFlight, ...settings.maxInFlight } };
  const policy = new ComposedPolicy(planData);
  if (config.antigravity2api) {
    const limit = policy.maxInFlight.bind(policy);
    policy.maxInFlight = unit => {
      const key = typeof unit === "string" ? unit : unit?.key ?? unit?.provider;
      return typeof key === "string" && /^google-antigravity(?:$|[/#])/.test(key) ? 0 : limit(unit);
    };
  }
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
  let router;
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
      return { onContact() { if (attempt?.provider === model.provider) attempt.contacted = true; },
        classifyError: text => quotaWording(text) ? "quota" : undefined };
    },
    dispatch(request, peer, scope) {
      return scopeStore.run({ peer, scope }, async () => {
        const body = await readJson(request);
        const format = formatForPath(new URL(request.url).pathname);
        let response;
        if (router.handles(body.model)) response = await router.serve(format, body, request);
        else if (disallowedClientModelRequest({ method: request.method, body, router,
          clientOnlyPrefix: settings.clientOnlyPrefix, supportedFormat: Boolean(format) })) return forbiddenModelResponse();
        else {
          const started = Date.now();
          const epoch = store.captureTokenEpoch();
          response = await dispatcher.forward(request);
          const model = resolveModel(body.model);
          if (model) response = router.measureDirect(`${model.provider}/${model.id}`, response, started, request.signal, epoch);
        }
        return packRoutingResponse(response, body.model);
      });
    },
    close,
  };
}
