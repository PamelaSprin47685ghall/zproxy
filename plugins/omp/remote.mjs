#!/usr/bin/env bun
// Keep credentials, model routing, and shared OMP account state on the server.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway/server";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { indexModelsByRequestId, resolveGatewayModel } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import { buildToolIdMap, descriptorFor, normalizeOpenAIRequest, serializeRecipe } from "./contract.mjs";
import { createRawHandoff } from "./remote-handoff.mjs";
import { continueGoogle } from "./remote-google.mjs";
import { legacyResponse, legacyStream } from "./local-codec.mjs";
import { createRemoteFeatures, getWireInfo } from "./remote-features.mjs";
import { createPassthrough } from "./remote-passthrough.mjs";
import { createAgWorker } from "./ag-worker.mjs";
import { acquireProviderOptIn } from "./remote-opt-in.mjs";
import { ipcResponse } from "./ipc-response.mjs";
import { sanitizeDirectResponse } from "./router/direct-guard.mjs";
import { buildPublicSummary, encodePublicSummary } from "./router/status-page/public-summary.mjs";

const PATHS = new Set(["/v1/chat/completions", "/v1/completions"]);
const HEADER_NAMES = ["content-type", "cache-control", "retry-after", "x-zproxy-decode"];
const CONFIG_KEYS = new Set(["version", "authDatabase", "modelsFile", "modelCache", "aliases", "providerOrder",
  "disabledProviders", "discovery", "refreshMs", "headerTimeoutMs", "idleTimeoutMs", "maxRequestBytes",
  "accountPolicies", "defaultReservePct", "shimsConfig", "passthroughProviders", "antigravity2api"]);
const utf8 = new TextEncoder();

function applyMistralRequestOptions({ model, options, parsed }) {
  if (model.provider !== "mistral" || model.api !== "openai-completions") return;
  if (model.baseUrl.replace(/\/+$/, "") !== "https://api.mistral.ai/v1") return;
  // Mistral supplies final SSE usage without the OpenAI stream_options extension.
  const previous = options.onPayload;
  options.onPayload = async (payload, selected) => {
    const outgoing = await previous?.(payload, selected) ?? payload;
    delete outgoing.stream_options;
    // The OpenAI serializer omits metadata; Mistral uses it for request attribution.
    outgoing.metadata = parsed.options.metadata ?? { call_source: "vibe_code", call_type: "main_call" };
    if (outgoing.tools?.length && outgoing.parallel_tool_calls === undefined) outgoing.parallel_tool_calls = true;
    return outgoing;
  };
  const headers = new Headers(options.headers);
  // Vibe v3.1.3 sets this header explicitly instead of using the SDK default.
  if (!headers.has("user-agent") && !new Headers(model.headers).has("user-agent")) {
    headers.set("user-agent", "mistral-client-python/Mistral-Vibe/3.1.3");
  }
  options.headers = Object.fromEntries(headers);
}

function plain(value, max, label) {
  if (typeof value !== "string" || value.length === 0 || utf8.encode(value).length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function validateConfig(value, base = process.cwd()) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) throw new Error("Invalid OMP server configuration version.");
  for (const key of Object.keys(value)) if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown OMP configuration field: ${key}`);
  const config = { ...value };
  config.antigravity2api ??= false;
  if (typeof config.antigravity2api !== "boolean") throw new Error("Invalid antigravity2api option.");
  for (const key of ["authDatabase", "modelsFile", "modelCache", "shimsConfig"]) {
    if (config[key] !== undefined) config[key] = resolve(base, plain(config[key], 4096, key));
  }
  if (!config.authDatabase) throw new Error("authDatabase is required on the server.");
  config.modelsFile ??= resolve(dirname(config.authDatabase), "models.yml");
  config.modelCache ??= resolve(dirname(config.authDatabase), "models.db");
  config.aliases ??= {};
  if (!config.aliases || typeof config.aliases !== "object" || Array.isArray(config.aliases) || Object.keys(config.aliases).length > 4096) throw new Error("Invalid model aliases.");
  for (const [alias, model] of Object.entries(config.aliases)) { plain(alias, 128, "model alias"); plain(model, 512, "model target"); }
  for (const key of ["providerOrder", "disabledProviders", "passthroughProviders"]) {
    config[key] ??= [];
    if (!Array.isArray(config[key]) || config[key].length > 512) throw new Error(`Invalid ${key}.`);
    for (const provider of config[key]) plain(provider, 128, key);
  }
  config.discovery ??= "online-if-uncached";
  if (!["offline", "online", "online-if-uncached"].includes(config.discovery)) throw new Error("Invalid discovery mode.");
  for (const [key, fallback, min, max] of [
    ["refreshMs", 300000, 1000, 3600000], ["headerTimeoutMs", 120000, 100, 1800000],
    ["idleTimeoutMs", 120000, 100, 1800000], ["maxRequestBytes", 16777216, 1024, 67108864],
  ]) {
    config[key] ??= fallback;
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}.`);
  }
  if (config.defaultReservePct !== undefined && (!Number.isFinite(config.defaultReservePct) || config.defaultReservePct < 0 || config.defaultReservePct > 100)) throw new Error("Invalid defaultReservePct.");
  return config;
}

async function readBody(request, limit) {
  if (!request.body) throw new Error("A JSON request body is required.");
  const reader = request.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error("The request body exceeds its limit.");
      parts.push(next.value);
    }
  } catch (error) { await reader.cancel(error); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

// Only the private F# bridge can supply this identity. No caller UUID or account token is accepted here.
export function userScope(headers) {
  const id = headers.get("x-zproxy-user-id");
  if (!id || !/^[a-f0-9]{32,64}$/.test(id)) throw new Error("An authenticated user identity is required.");
  const encoded = headers.get("x-zproxy-user-nickname") ?? "";
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) throw new Error("Invalid authenticated user nickname.");
  const nickname = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url"));
  plain(nickname, 256, "authenticated user nickname");
  return {
    name: id, nickname, limitsModels: false,
    allows: () => true,
    credentialSessionId(provider, sessionId) {
      return createHash("sha256").update(JSON.stringify(["zproxy-omp-session-v1", id, provider, sessionId])).digest("hex");
    },
    retain: () => () => {},
  };
}

// Keep the private response header allowlist while forcing chunked IPC output.
export function chunkedResponse(response) {
  return ipcResponse(response, HEADER_NAMES);
}

export async function createRemoteGateway(input, { fetch: testFetch, routingFactory, agWorker: suppliedAgWorker, onWorkerExit } = {}) {
  const config = validateConfig(input);
  const releaseOptIn = config.antigravity2api ? acquireProviderOptIn("google-antigravity") : () => {};
  let storage;
  let timer;
  let gateway;
  let routing;
  let features;
  let agWorker;
  let closing;
  const active = new Set();
  try {
    await mkdir(dirname(config.authDatabase), { recursive: true, mode: 0o700 });
    storage = await AuthStorage.create(config.authDatabase, {
      accountPolicies: config.accountPolicies, defaultReservePct: config.defaultReservePct,
    });
    await chmod(config.authDatabase, 0o600);
    await storage.credentials.reload();
    const registry = new ModelRegistry(storage, config.modelsFile, { cacheDbPath: config.modelCache, fetch: testFetch });
    if (registry.getError()) throw new Error("The server models file is invalid.");
    features = await createRemoteFeatures({ config, storage, registry, fetch: testFetch });
    let index;
    const disabled = new Set(config.disabledProviders);
    let refreshing;
    const refresh = () => refreshing ??= (async () => {
      await storage.credentials.poll();
      await features.refresh();
      await registry.refresh(config.discovery);
      if (registry.getError()) throw new Error("The server models file is invalid.");
      const models = registry.getAll("chat").filter(model => !disabled.has(model.provider));
      index = indexModelsByRequestId(models, new Set(models.map(model => model.provider)), config.providerOrder);
    })().finally(() => { refreshing = undefined; });
    await refresh();
    const resolveModel = (id, options) => resolveGatewayModel(Object.hasOwn(config.aliases, id) ? config.aliases[id] : id, index, options);
    const chooseFetch = model => model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : fetch;
    const handoff = createRawHandoff({
      descriptorFor, serializeRecipe, chooseFetch,
      isOAuth: (model, headers) => model.api === "anthropic-messages"
        && isAnthropicOAuthToken((headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")),
      wrapRaw: continueGoogle, wireInfo: getWireInfo,
      observeTurn: model => routing?.observeTurn?.(model) ?? {},
      priceUsage: (model, usage) => { usage.cost = calculateCost(model, usage); },
      headerTimeoutMs: config.headerTimeoutMs, idleTimeoutMs: config.idleTimeoutMs,
    });
    gateway = createAuthGatewayRouter({
      storage, resolveModel, listModels: () => index.models, excludeProviders: disabled,
      fetch: testFetch,
      rawResponseHandoff(turn) {
        applyMistralRequestOptions(turn);
        const base = turn.options.fetch ?? chooseFetch(turn.model);
        turn.options.fetch = (input, init) => features.fetch(input, init, base);
        if (features.usesCustomTransport(turn.model)) return undefined;
        return handoff(turn);
      },
    });
    const passthrough = createPassthrough({ config, storage, registry, resolveModel, fetch: testFetch,
      observeTurn: model => routing?.observeTurn?.(model) ?? {}, usesCustomTransport: model => features.usesCustomTransport(model) });
    let antigravity;
    if (config.antigravity2api) {
      const [{ createAntigravity }, { createAgDeviceProfiles }] = await Promise.all([
        import("./remote-antigravity.mjs"), import("./remote-ag-devices.mjs"),
      ]);
      // Only the remote worker owns official accounts, so only it receives a
      // state directory; the local worker starts without one and cannot reach
      // the official routes at all.
      const stateDir = resolve(dirname(config.authDatabase), "antigravity");
      agWorker = suppliedAgWorker ?? createAgWorker({ onExit: onWorkerExit, stateDir });
      // One device profile per credential identity, derived once by the pinned
      // official factory in the private child and kept in a private file.
      const devices = createAgDeviceProfiles({
        path: resolve(dirname(config.authDatabase), "ag-devices.json"),
        // A worker that cannot derive a device fails that lookup; the store
        // then reports it and no profile is invented in its place.
        generate: email => {
          if (typeof agWorker.device !== "function") throw new Error("The Antigravity device factory is unavailable.");
          return agWorker.device(email);
        },
      });
      antigravity = createAntigravity({ config, storage, registry, resolveModel, devices,
        prepare: (value, options) => agWorker.officialPrepare(value, options),
        send: (value, options) => agWorker.officialSend(value, options),
        observeTurn: model => routing?.observeTurn?.(model) ?? {} });
    }
    const dispatch = (request, peer, scope) => features.dispatch(request, peer, scope,
      async (request, peer, scope) => await antigravity?.(request, scope)
        ?? await passthrough(request, scope) ?? gateway.route(request, peer, scope));
    if (routingFactory) routing = await routingFactory({ config, storage, registry, dispatch, resolveModel });
    else if (config.shimsConfig) {
      const { createRemoteRouting } = await import("./remote-routing.mjs");
      routing = await createRemoteRouting({ config, storage, registry, dispatch, resolveModel });
    }
    timer = setInterval(() => { refresh().catch(() => process.stderr.write("OMP catalog refresh failed; the prior catalog remains active.\n")); }, config.refreshMs);
    timer.unref();
    return {
      registry, storage,
      /// The public routing summary: one bounded, whitelisted document. It
      /// never contains an account id, unitRef, provider, model name, or the
      /// worker host. A disabled router or a read failure is reported as such,
      /// never as zeros.
      statusSummary(limit = 65536) {
        try {
          return encodePublicSummary(buildPublicSummary(routing?.router?.statusView?.() ?? null), limit)
        } catch {
          return encodePublicSummary(buildPublicSummary(null, { reason: "路由统计读取失败" }), limit)
        }
      },
      async handle(request) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.search || !PATHS.has(url.pathname)) return Response.json({ error: "Unknown completion route." }, { status: 404 });
        let scope;
        let body;
        try { scope = userScope(request.headers); }
        catch { return Response.json({ error: "Authenticated IPC identity required." }, { status: 401 }); }
        try {
          const original = await readBody(request, config.maxRequestBytes);
          scope.antigravityContext = original?._zproxy_ag;
          scope.completionPath = url.pathname;
          scope.toolIds = buildToolIdMap(original);
          body = normalizeOpenAIRequest(url.pathname, original);
        }
        catch (error) { return Response.json({ error: { message: error.message } }, { status: 400 }); }
        const controller = new AbortController();
        active.add(controller);
        const onAbort = () => controller.abort(request.signal.reason);
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
        const headers = new Headers({ "content-type": "application/json", "x-omp-install-id": scope.name, "x-omp-app": "zproxy" });
        for (const name of ["x-prompt-cache-key", "x-session-id", "session_id", "conversation_id"]) {
          if (request.headers.has(name)) headers.set(name, request.headers.get(name));
        }
        const normalized = new Request("http://zproxy-omp/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
        let result;
        try {
          result = await (routing?.dispatch ?? dispatch)(normalized, "private-unix", scope);
          // Without the routing layer this is the first boundary a provider
          // answer crosses. Never let an account-status reply reach the caller.
          if (!routing) result = await sanitizeDirectResponse(result);
        }
        catch { result = Response.json({ error: "OMP request failed." }, { status: 502 }); }
        const release = () => { active.delete(controller); request.signal.removeEventListener("abort", onAbort); };
        if (url.pathname === "/v1/completions" && result.ok && result.headers.get("x-zproxy-decode") !== "1") {
          try {
            const converted = /text\/event-stream/i.test(result.headers.get("content-type") ?? "")
              ? legacyStream(result.body)
              : JSON.stringify(legacyResponse(await readBody(result, 134217728)));
            result = new Response(converted, { status: result.status, headers: result.headers });
          } catch {
            release();
            return Response.json({ error: "The remote fallback could not encode this completion." }, { status: 502 });
          }
        }
        if (!result.body) { release(); return result; }
        const reader = result.body.getReader();
        return new Response(new ReadableStream({
          async pull(target) {
            try {
              const item = await reader.read();
              if (item.done) { reader.releaseLock(); release(); target.close(); }
              else target.enqueue(item.value);
            } catch (error) { try { reader.releaseLock(); } catch {} release(); target.error(error); }
          },
          async cancel(reason) {
            controller.abort(reason);
            try { await reader.cancel(reason); } finally { reader.releaseLock(); release(); }
          },
        }), { status: result.status, headers: result.headers });
      },
      close() {
        return closing ??= (async () => {
          try {
            clearInterval(timer);
            for (const controller of active) controller.abort(new DOMException("The gateway stopped.", "AbortError"));
            active.clear();
            await routing?.close?.();
            gateway.close();
            await features.close();
            await agWorker?.close();
            storage.close();
          } finally { releaseOptIn(); }
        })();
      },
    };
  } catch (error) {
    try {
      clearInterval(timer);
      await routing?.close?.();
      gateway?.close();
      await features?.close();
      await agWorker?.close();
      storage?.close();
    } finally { releaseOptIn(); }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--socket" || args[2] !== "--config" || !isAbsolute(args[1])) throw new Error("Usage: bun remote.mjs --socket ABSOLUTE_PATH --config CONFIG_PATH");
  const socket = args[1];
  const configPath = resolve(args[3]);
  const text = await readFile(configPath, "utf8");
  if (utf8.encode(text).length > 1048576) throw new Error("The OMP server configuration exceeds its limit.");
  const config = validateConfig(JSON.parse(text), dirname(configPath));
  const app = await createRemoteGateway(config, { onWorkerExit: () => process.exit(1) });
  let stopping = false;
  let server;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await app.close();
    try { await unlink(socket); } catch {}
    process.exit(0);
  };
  try {
    server = Bun.serve({
      unix: socket, idleTimeout: 0, maxRequestBodySize: config.maxRequestBytes,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health" && request.method === "GET") return chunkedResponse(Response.json({ ready: !stopping }));
        // Read-only aggregate routing statistics for the private F# bridge.
        // A completion caller cannot reach it: the head method must be a
        // bodyless read, the exact path is required, and any query is refused.
        // Both GET and POST are accepted because the bridge owns the framing
        // and the reply is identical: a bodyless read has no method-dependent
        // behaviour, so a method change on either side cannot strand the panel.
        if (url.pathname === "/status" && (request.method === "GET" || request.method === "POST")) {
          if (url.search) return chunkedResponse(Response.json({ error: "Unknown status route." }, { status: 404 }));
          if (Number(request.headers.get("content-length") ?? "0") > 0) {
            return chunkedResponse(Response.json({ error: "Unknown status route." }, { status: 404 }));
          }
          return chunkedResponse(new Response(app.statusSummary(), {
            status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          }));
        }
        if (url.pathname === "/shutdown" && request.method === "POST") {
          setTimeout(() => { void stop(); }, 25);
          return chunkedResponse(Response.json({ stopping: true }));
        }
        return chunkedResponse(await app.handle(request));
      },
      error() { return chunkedResponse(Response.json({ error: "OMP request failed." }, { status: 502 })); },
    });
    await chmod(socket, 0o600);
    process.on("SIGTERM", () => { void stop(); });
    process.on("SIGINT", () => { void stop(); });
    process.stdout.write("READY\n");
  } catch (error) { await app.close(); throw error; }
}

if (import.meta.main) main().catch(() => { process.stderr.write("The OMP server could not start. Check its private configuration and pinned bundle.\n"); process.exit(1); });
