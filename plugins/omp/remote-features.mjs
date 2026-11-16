// Retain server-only compatibility policy through explicit functions.
import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseRequest as parseChat } from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import { parseRequest as parseResponses } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { loadConfig } from "./vendor/shims/lib/config.mjs";
import { CredentialRepository } from "./vendor/shims/lib/credentials.mjs";
import { installVendorPlugin, loadVendorShim, registerExtensionProviderMeta } from "./vendor/shims/lib/host-bridge.mjs";
import { discoverPlugins, createPluginHost } from "./vendor/shims/features/plugin-bridge.mjs";
import { extractPrompt, isAutoModel, isCopilotEndpoint } from "./vendor/shims/features/copilot-auto.mjs";
import { rewriteClineBody, isClineChatUrl } from "./vendor/shims/features/cline-pin-upstream.mjs";
import { readOutboundBodyText, requestUrl, withRequestBody } from "./vendor/shims/lib/outbound.mjs";
import { descriptorFor } from "./contract.mjs";

const infoByResponse = new WeakMap();
const MAX_NEGOTIATION_BYTES = 65536;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();

export function getWireInfo(response) { return infoByResponse.get(response); }

async function boundedJson(response, limit) {
  if (!response.body) throw new Error("The provider response has no body.");
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new Error("The provider control response exceeds its byte limit.");
      parts.push(item.value);
    }
  } catch (error) { await reader.cancel(error); throw error; }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts, size).toString("utf8"));
}

function validToken(value) {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "undefined";
}

/** Read the external CLI store, then write through the current OMP public API. */
export async function syncKiro(storage, path) {
  let database;
  let token;
  try {
    database = new Database(path, { readonly: true, create: false });
    const row = database.query("SELECT value FROM auth_kv WHERE key = 'kirocli:social:token'").get();
    if (!row || typeof row.value !== "string" || Buffer.byteLength(row.value) > MAX_NEGOTIATION_BYTES) return false;
    token = JSON.parse(row.value);
  } finally { database?.close(); }
  if (!token || !validToken(token.access_token) || !validToken(token.refresh_token)) return false;
  const rows = storage.credentials.list("kiro").filter(row => !row.disabledCause && row.credential.type === "oauth");
  const row = rows.length === 1 ? rows[0] : rows.find(item =>
    typeof token.profile_arn === "string" && token.profile_arn === item.credential.profileArn);
  if (!row) return false;
  const current = row.credential;
  if (token.profile_arn && current.profileArn && token.profile_arn !== current.profileArn) return false;
  const expiry = typeof token.expires_at === "string" ? Date.parse(token.expires_at) : NaN;
  const next = { ...current, access: token.access_token, refresh: `${token.refresh_token}|desktop`,
    expires: Number.isFinite(expiry) ? expiry : Date.now() + 3600000,
    region: typeof token.region === "string" && token.region ? token.region : current.region ?? "us-east-1",
    profileArn: typeof token.profile_arn === "string" && token.profile_arn ? token.profile_arn : current.profileArn };
  if (["access", "refresh", "expires", "region", "profileArn"].every(key => current[key] === next[key])) return false;
  await storage.credentials.upsert("kiro", next);
  return true;
}

/** Ask the official request builder for the selected protocol without sending it. */
async function buildWireRequest(model, parsed, signal) {
  const controller = new AbortController();
  const capture = Promise.withResolvers();
  const abort = () => controller.abort(signal?.reason ?? new Error("The request stopped."));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const options = { ...parsed.options, maxTokens: parsed.options.maxOutputTokens,
    apiKey: "zproxy-request-shape", signal: controller.signal,
    maxHttpAttempts: 1, acceptEmptyResponse: true, transport: "sse", stateful: false,
    streamFirstEventTimeoutMs: 0, streamIdleTimeoutMs: 0,
    fetch: async (input, init) => {
      capture.resolve({ input, init });
      const stop = new DOMException("The request shape is complete.", "AbortError");
      controller.abort(stop);
      throw stop;
    },
    providerRetryWait: async () => { throw new Error("Request shaping cannot retry."); },
  };
  if (options.toolChoice && typeof options.toolChoice === "object" && !("type" in options.toolChoice)) {
    options.toolChoice = { type: "tool", name: options.toolChoice.name };
  }
  const stream = (model.api === "openai-responses" ? streamOpenAIResponses : streamOpenAICompletions)(model, parsed.context, options);
  const ended = stream.result().then(message => { throw new Error(message.errorMessage ?? "The provider request could not be shaped."); });
  try { return await Promise.race([capture.promise, ended]); }
  finally { signal?.removeEventListener("abort", abort); controller.abort(); }
}

export async function createRemoteFeatures({ config, storage, registry, fetch: baseFetch = fetch }) {
  const empty = {
    fetch: (input, init, next = baseFetch) => next(input, init),
    dispatch: (request, peer, scope, next) => next(request, peer, scope),
    refresh: async () => {}, close: async () => {}, usesCustomTransport: () => false,
  };
  if (!config.shimsConfig) return empty;
  const settings = loadConfig(config.shimsConfig);
  const features = settings.features;
  const scope = new AsyncLocalStorage();
  const providers = new Map();
  const disposers = [];
  const repository = new CredentialRepository({ agentDbPath: config.authDatabase });
  let stopped = false;
  let closed = false;
  let kiroBusy;
  let lastKiroStamp;
  let kiroTimer;
  const kiro = features["kiro-credential-sync"];
  const kiroPath = resolve(kiro.dbPath ?? join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3"));

  const refreshKiro = () => kiroBusy ??= (async () => {
    if (stopped || !kiro.enabled) return;
    let source;
    try { source = await stat(kiroPath); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const wal = await stat(kiroPath + "-wal").catch(() => undefined);
    const accounts = storage.credentials.list("kiro").map(row => [row.id, row.disabledCause, row.credential.expires, row.credential.profileArn]);
    const stamp = [source.mtimeMs, source.size, wal?.mtimeMs, wal?.size, JSON.stringify(accounts)].join(":");
    if (stamp === lastKiroStamp) return;
    await syncKiro(storage, kiroPath);
    lastKiroStamp = stamp;
  })().finally(() => { kiroBusy = undefined; });

  const register = (id, supplied, packageName, shim) => {
    if (stopped) return;
    const value = { ...supplied };
    if (value.oauth === true) delete value.oauth;
    if (value.models?.length === 1 && (registry.getProviderModels?.(id)?.length ?? 0) > 1) delete value.models;
    if (Object.hasOwn(settings.pluginBridge.tokens, id)) {
      const token = repository.resolveTokenSpec(settings.pluginBridge.tokens[id]);
      if (typeof token === "string" && token) storage.keys.setConfig(id, token);
      else if (token !== undefined) throw new Error("The configured provider token is not a string.");
    }
    if (value.streamSimple && value.api) shim.registerTransport?.(value.api, value.streamSimple);
    const sourceId = `zproxy-plugin:${packageName}`;
    registry.registerProvider(id, value, sourceId);
    providers.get(id)?.dispose();
    const dispose = registerExtensionProviderMeta(id, {
      api: value.api, baseUrl: value.baseUrl, headers: value.headers, models: value.models,
      streamSimple: value.streamSimple ?? shim.streamSimple, fetchDynamicModels: value.fetchDynamicModels,
      resolveApiKey: () => repository.resolveTokenSpec(settings.pluginBridge.tokens[id]),
    });
    providers.set(id, { api: value.api, custom: typeof value.streamSimple === "function", dispose });
  };

  try {
    const plugins = features["plugin-bridge"];
    if (plugins.enabled) {
      const directory = resolve(plugins.pluginsDir ?? join(homedir(), ".omp", "plugins"));
      const selected = Array.isArray(plugins.plugins) ? new Set(plugins.plugins) : undefined;
      const advertised = discoverPlugins(directory).filter(plugin => !selected || selected.has(plugin.name));
      if (advertised.length) {
        const vendor = await installVendorPlugin({ pluginsDir: directory });
        disposers.push(vendor.dispose);
        const shim = await loadVendorShim("@earendil-works/pi-ai");
        shim.setHostStream?.(streamSimple);
        const load = (async () => {
          for (const plugin of advertised) {
            for (const entry of plugin.entries) {
              if (stopped) return;
              const module = await import(entry);
              const initialize = module.default ?? module;
              if (typeof initialize !== "function") throw new Error("The provider plugin has no initializer.");
              const host = createPluginHost((id, value) => register(id, value, plugin.name, shim), {
                onUnregister(id) { if (!stopped) { providers.get(id)?.dispose(); providers.delete(id); registry.unregisterProvider(id); } },
              });
              const dispose = await initialize(host);
              if (typeof dispose === "function") {
                if (stopped) await dispose();
                else disposers.push(dispose);
              }
            }
          }
        })();
        let timeout;
        try {
          await Promise.race([load, new Promise((_, reject) => {
            timeout = setTimeout(() => { stopped = true; reject(new Error("Provider plugin initialization timed out.")); }, plugins.eagerTimeoutMs);
          })]);
        } finally { clearTimeout(timeout); }
      }
    }
    await refreshKiro().catch(() => process.stderr.write("The external Kiro credential could not be synchronized.\n"));
    if (kiro.enabled) {
      kiroTimer = setInterval(() => { refreshKiro().catch(() => process.stderr.write("The external Kiro credential could not be synchronized.\n")); }, kiro.pollMs);
      kiroTimer.unref();
    }
  } catch (error) {
    stopped = true;
    clearInterval(kiroTimer);
    for (const dispose of disposers.reverse()) await dispose();
    for (const [id, entry] of providers) { entry.dispose(); registry.unregisterProvider(id); }
    repository.close();
    throw error;
  }

  const copilot = features["copilot-auto"];
  const cline = features["cline-pin-upstream"];
  const clineUrl = new URL(cline.baseURL || `https://${cline.host}`);
  const clineTarget = { hosts: [clineUrl.hostname], allowHttp: clineUrl.protocol === "http:", expectedPath: `${clineUrl.pathname.replace(/\/$/, "")}/chat/completions` };
  const clineFilter = String(cline.models ?? "").split(",").map(value => value.trim()).filter(Boolean);

  const shapedFetch = async (input, init, next = baseFetch) => {
    const url = requestUrl(input);
    const copilotTarget = copilot.enabled && isCopilotEndpoint(url) && /\/(?:chat\/completions|responses)$/.test(new URL(url).pathname);
    const clineTargeted = cline.enabled && isClineChatUrl(url, clineTarget);
    if (!copilotTarget && !clineTargeted) return next(input, init);
    const text = await readOutboundBodyText(input, init);
    if (text === undefined || Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("The provider request body cannot be rewritten within its limit.");
    let outgoing = text;
    if (clineTargeted) outgoing = rewriteClineBody(text, { modelChannels: cline.modelChannels, defaultUpstream: cline.upstream, modelFilter: clineFilter }) ?? text;
    const replay = withRequestBody(input, init, outgoing);
    if (!copilotTarget) return next(replay.target, replay.init);
    const headers = new Headers(replay.init.headers);
    const parsedBody = JSON.parse(outgoing);
    const auto = scope.getStore()?.auto === true || isAutoModel(parsedBody.model);
    if (!auto && headers.has("Copilot-Session-Token")) return next(replay.target, replay.init);
    let rejected;
    if (!auto) {
      const response = await next(replay.target, replay.init);
      if (response.status !== 400) return response;
      const error = await boundedJson(response, MAX_NEGOTIATION_BYTES);
      rejected = new Response(JSON.stringify(error), { status: response.status, headers: response.headers });
      if (!JSON.stringify(error).includes("model_not_supported")) return rejected;
    }
    const negotiationHeaders = new Headers(headers);
    negotiationHeaders.delete("content-length");
    negotiationHeaders.delete("content-encoding");
    negotiationHeaders.set("content-type", "application/json");
    if (!negotiationHeaders.has("Copilot-Integration-Id")) negotiationHeaders.set("Copilot-Integration-Id", "vscode-chat");
    if (!negotiationHeaders.has("X-GitHub-Api-Version")) negotiationHeaders.set("X-GitHub-Api-Version", copilot.apiVersion);
    const signal = replay.init.signal;
    const negotiated = await next(`${new URL(url).origin}/auto?apiVersion=${encodeURIComponent(copilot.apiVersion)}`, {
      method: "POST", headers: negotiationHeaders, body: JSON.stringify({ prompt: extractPrompt(parsedBody) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!negotiated.ok) { await negotiated.body?.cancel(); return rejected ?? next(replay.target, replay.init); }
    const selected = await boundedJson(negotiated, MAX_NEGOTIATION_BYTES);
    const id = selected?.selected_model?.id;
    if (typeof id !== "string" || id.length === 0 || encoder.encode(id).length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(id) || !validToken(selected.session_token) || selected.session_token.length > 16384) {
      throw new Error("The Copilot negotiation returned invalid public model data or session state.");
    }
    const endpoints = selected.selected_model.supported_endpoints ?? [];
    const api = endpoints.includes("/responses") && !endpoints.includes("/chat/completions") ? "openai-responses"
      : endpoints.includes("/chat/completions") && !endpoints.includes("/responses") ? "openai-completions"
        : new URL(url).pathname.endsWith("/responses") ? "openai-responses" : "openai-completions";
    const reference = registry.getAll("chat").find(model => model.provider === "github-copilot" && model.id === id);
    const baseUrl = url.replace(/\/(?:chat\/completions|responses)$/, "");
    const model = buildModel({ id, name: id, api, provider: "zproxy-copilot-request", baseUrl,
      reasoning: reference?.reasoning ?? false, input: reference?.input ?? ["text"], contextWindow: reference?.contextWindow ?? 128000,
      maxTokens: reference?.maxTokens ?? 16384, cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: reference?.compatConfig });
    const original = scope.getStore()?.body;
    const parsed = original ? parseChat(original) : new URL(url).pathname.endsWith("/responses") ? parseResponses(parsedBody) : parseChat(parsedBody);
    const captured = await buildWireRequest(model, parsed, signal);
    const targetHeaders = new Headers(captured.init.headers);
    for (const [name, value] of headers) if (name !== "content-length" && name !== "content-encoding") targetHeaders.set(name, value);
    targetHeaders.set("Copilot-Session-Token", selected.session_token);
    const result = await next(captured.input, { ...captured.init, headers: targetHeaders, signal });
    infoByResponse.set(result, { api, id, recipe: descriptorFor({ ...model, provider: "github-copilot" }) });
    return result;
  };

  return {
    fetch: shapedFetch,
    async dispatch(request, peer, client, next) {
      if (!copilot.enabled) return next(request, peer, client);
      const body = await request.clone().json();
      const auto = isAutoModel(body.model);
      let forwarded = request;
      if (auto) {
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        forwarded = new Request(request.url, { method: request.method, headers, body: JSON.stringify({ ...body, model: copilot.autoBootstrapModel }), signal: request.signal });
      }
      return scope.run({ auto, body }, () => next(forwarded, peer, client));
    },
    refresh: refreshKiro,
    usesCustomTransport: model => [...providers.values()].some(entry => entry.custom && entry.api === model.api),
    async close() {
      if (closed) return;
      closed = true;
      stopped = true;
      clearInterval(kiroTimer);
      await kiroBusy;
      for (const dispose of disposers.reverse()) await dispose();
      for (const [id, entry] of providers) { entry.dispose(); registry.unregisterProvider(id); }
      providers.clear();
      repository.close();
    },
  };
}
