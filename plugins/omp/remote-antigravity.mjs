// OMP owns accounts and HTTP. Antigravity2API only prepares and decodes the protocol.
import { createHash, randomUUID } from "node:crypto";
import { seedApiKeyResolver, withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { oauthAccountKey } from "@oh-my-pi/pi-ai/auth/types";
import { recordGatewayUsage } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { parseGeminiCliCredentials } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { clampThinkingLevelForModel, defaultSupportedEffort, mapEffortToGoogleThinkingLevel, resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import { getAntigravityModelWireProfile } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { mapRequestToolIds, serializeRecipe } from "./contract.mjs";
import { admit, framed, rejectedResponse, usageTap } from "./remote-handoff.mjs";
import { continueGoogle } from "./remote-google.mjs";

const PROVIDER = "google-antigravity";
const FAMILIES = Object.freeze({ anthropic: "anthropic", gemini: "google", openai: "openai", "gpt-oss": "openai" });
const PROVIDERS = Object.freeze({ google: "MODEL_PROVIDER_GOOGLE", anthropic: "MODEL_PROVIDER_ANTHROPIC", openai: "MODEL_PROVIDER_OPENAI" });
const LEVELS = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, xhigh: 100 });
const SAFE_HEADERS = ["content-type", "cache-control", "retry-after"];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function reject(status, message) { return Object.assign(new Error(message), { status, publicMessage: message }); }
function name(value, limit, label) {
  if (typeof value !== "string" || !value.length || CONTROL.test(value) || Buffer.byteLength(value) > limit) throw reject(400, `Invalid Antigravity ${label}.`);
  return value;
}
function positive(value, label) {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) throw reject(400, `Invalid Antigravity ${label}.`);
  return value;
}

/** Convert only the selected account's public catalog fields. No discovery or credentials leave here. */
export function antigravityModel(model, request, identity) {
  const family = FAMILIES[model.identity?.class];
  if (!family) throw reject(400, "The Antigravity model family is not supported by this codec.");
  const canDisable = (!model.thinking?.requiresEffort || model.thinking.suppressWhenOff)
    && (model.thinking?.effortRouting?.off !== undefined || model.thinking?.suppressWhenOff || model.reasoning === false);
  const disabled = request.reasoning_effort === "none" && canDisable;
  let effort = request.reasoning_effort === "none" ? undefined : clampThinkingLevelForModel(model, request.reasoning_effort);
  if (effort === undefined && model.reasoning && model.thinking?.requiresEffort && !model.thinking.suppressWhenOff) {
    effort = defaultSupportedEffort(model);
  }
  const id = name(resolveWireModelId(model, effort), 256, "model id");
  const accountKey = oauthAccountKey(identity);
  const access = accountKey === undefined ? undefined : model.accountAccess?.[accountKey];
  if (model.accountAccess && !access) throw reject(403, "The selected account does not have this Antigravity model.");
  const accountProfiles = access?.antigravityWireProfiles;
  if (accountProfiles && !Object.hasOwn(accountProfiles, id)) throw reject(403, "The selected account does not have this Antigravity model tier.");
  const profile = getAntigravityModelWireProfile(id, accountProfiles, model.antigravityWireProfiles);
  const catalog = {
    id, modelProvider: PROVIDERS[family], maxOutputTokens: positive(profile?.maxOutputTokens ?? model.maxTokens, "output limit"),
    maxTokens: positive(model.contextWindow, "context limit"), supportsThinking: model.reasoning === true,
    supportsImages: model.input?.includes("image") === true,
  };
  if (profile?.modelEnum) catalog.model = name(profile.modelEnum, 256, "model enum");
  let level = profile?.thinkingLevel;
  let budget = profile?.thinkingBudget;
  if (level === undefined && effort !== undefined && model.thinking?.mode === "google-level") level = mapEffortToGoogleThinkingLevel(effort, model);
  if (budget === undefined && effort !== undefined) budget = model.thinking?.effortBudgets?.[effort];
  if (disabled) {
    catalog.thinkingDisabled = true;
    catalog.thinkingBudget = 0;
  } else if (level !== undefined) {
    if (!Object.hasOwn(LEVELS, level)) throw reject(400, "Invalid Antigravity thinking level.");
    catalog.thinkingLevel = LEVELS[level];
  } else if (budget !== undefined) {
    if (!Number.isInteger(budget) || budget < -1 || budget > 2147483647) throw reject(400, "Invalid Antigravity thinking budget.");
    catalog.thinkingBudget = budget;
  }
  return { catalog, family };
}

function endpoint(model) {
  const url = new URL(model.baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw reject(500, "Invalid server Antigravity endpoint.");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1internal:streamGenerateContent`;
  url.search = "?alt=sse";
  return url;
}

function retryAfter(response, text) {
  const header = response.headers.get("retry-after");
  if (header && header.length <= 128) return header;
  let details;
  try { details = JSON.parse(text).error?.details; } catch { return undefined; }
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    const delay = detail?.retryDelay ?? detail?.metadata?.quotaResetDelay;
    if (typeof delay === "string" && /^\d+(?:\.\d+)?s$/.test(delay)) {
      const seconds = Math.ceil(Number(delay.slice(0, -1)));
      if (Number.isSafeInteger(seconds) && seconds >= 0) return String(seconds);
    }
    const at = Date.parse(detail?.metadata?.quotaResetTimeStamp);
    if (Number.isFinite(at)) return String(Math.max(0, Math.ceil((at - Date.now()) / 1000)));
  }
  return undefined;
}

function sameAccount(first, next) {
  if (!next) return false;
  if (typeof first === "object" && first.credentialId !== undefined
      && typeof next === "object" && next.credentialId !== first.credentialId) return false;
  const key = value => typeof value === "string" ? value : value.apiKey;
  return oauthAccountKey(parseGeminiCliCredentials(key(first))) === oauthAccountKey(parseGeminiCliCredentials(key(next)));
}

export function createAntigravity({ config, storage, registry, resolveModel, prepare, fetch: baseFetch = fetch, observeTurn = () => ({}) }) {
  if (typeof prepare !== "function") throw new Error("The Antigravity protocol codec is not configured.");
  return async (request, scope) => {
    const body = await request.clone().json();
    const model = resolveModel(body.model);
    if (model?.provider !== PROVIDER) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    const release = scope.retain();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      controller.abort();
      request.signal.removeEventListener("abort", abort);
      release();
    };
    const observer = observeTurn(model);
    let failure;
    let attempts = 0;
    let rawResponse;
    try {
      if (!scope.allows(model)) throw reject(403, "This Antigravity model is not available to this request.");
      const url = endpoint(model);
      const seed = createHash("sha256").update(JSON.stringify([model.id, body.prompt_cache_key ?? body.messages?.[0]])).digest("hex");
      const session = scope.credentialSessionId(PROVIDER, seed);
      const initial = await registry.getApiKeyWithCredentialForProvider(PROVIDER, session, {
        modelId: model.id, baseUrl: model.baseUrl, signal: controller.signal,
      });
      if (!initial) throw reject(401, "No Antigravity credential is available for this request.");
      const resolveKey = registry.resolver(model, session);
      const resolver = seedApiKeyResolver(initial, async context => {
        // The outer route owns account changes. This adapter can refresh only its selected account.
        if (context.lastChance) return undefined;
        const next = await resolveKey(context);
        return sameAccount(initial, next) ? next : undefined;
      });
      const outgoing = structuredClone(body);
      for (const key of ["omp", "headers", "apiKey", "baseUrl", "transport", "billing", "_zproxy_ag"]) delete outgoing[key];
      if (scope.toolIds) mapRequestToolIds(outgoing, id => scope.toolIds.get(id) ?? id);
      if (scope.antigravityContext !== undefined) outgoing._zproxy_ag = scope.antigravityContext;
      const fetch = transportFetch(model, baseFetch, () => observer.onContact?.(url));
      const result = await withAuth(resolver, async apiKey => {
        failure = undefined;
        const identity = parseGeminiCliCredentials(apiKey);
        if (identity.expiresAt !== undefined && identity.expiresAt <= Date.now()) throw reject(401, "The Antigravity access token expired.");
        const { catalog, family } = antigravityModel(model, outgoing, identity);
        const prepared = await prepare({ version: 1, request: outgoing, model: catalog, project: identity.projectId, session }, { signal: controller.signal });
        if (!prepared?.body || prepared.body.project !== identity.projectId || prepared.body.model !== catalog.id
            || !prepared.body.request || typeof prepared.body.request !== "object") throw reject(502, "The Antigravity codec returned an invalid request.");
        const headers = new Headers(await registry.resolveModelHeaders(model, controller.signal));
        for (const key of ["host", "connection", "content-length", "content-encoding", "transfer-encoding", "cookie"]) headers.delete(key);
        headers.set("authorization", `Bearer ${identity.accessToken}`);
        headers.set("content-type", "application/json");
        headers.set("accept", "text/event-stream");
        headers.set("accept-encoding", "identity");
        headers.set("user-agent", "zproxy/AG2API");
        const init = { method: "POST", body: JSON.stringify(prepared.body), headers, signal: controller.signal, timeout: false };
        const timer = setTimeout(() => controller.abort(new Error("The Antigravity response timed out.")), config.headerTimeoutMs);
        try {
          attempts++;
          let response = await fetch(url, init);
          if (response.ok) {
            if (!response.body || !/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
              await response.body?.cancel();
              throw reject(502, "The Antigravity upstream did not return a response stream.");
            }
            const checked = await admit(response, controller.signal, config.headerTimeoutMs,
              event => typeof (event?.response ?? event)?.promptFeedback?.blockReason === "string");
            response = checked.response ?? checked.error;
          }
          if (!response.ok) {
            const rejected = await rejectedResponse(response, controller.signal, config.headerTimeoutMs);
            failure = { status: response.status, retryAfter: retryAfter(response, rejected.text),
              type: observer.classifyError?.(rejected.text) === "quota" ? "insufficient_quota" : "upstream_error" };
            throw Object.assign(new Error("The Antigravity upstream rejected this attempt."), { status: response.status });
          }
          rawResponse = response;
          rawResponse = continueGoogle(response, { model: { ...model, api: "google-gemini-cli" }, input: url, init, fetch,
            signal: controller.signal, headerTimeoutMs: config.headerTimeoutMs, idleTimeoutMs: config.idleTimeoutMs });
          return { response: rawResponse, catalog, family };
        } finally { clearTimeout(timer); }
      }, { signal: controller.signal, isAuthError: error => error?.status === 401 });
      const recipe = serializeRecipe({ api: "antigravity2api", provider: PROVIDER, id: result.catalog.id,
        reasoning: model.reasoning === true, input: model.input ?? ["text"], contextWindow: result.catalog.maxTokens,
        maxTokens: result.catalog.maxOutputTokens, compat: { agProvider: result.family } });
      const alias = typeof body.model === "string" && Buffer.byteLength(body.model) <= 128 && !CONTROL.test(body.model) ? body.model : "";
      const metadata = { decoder: "omp-response", version: 1, modelAlias: alias, requestId: randomUUID().replaceAll("-", ""),
        attempt: Math.min(attempts, 65535), isStreaming: body.stream === true, recipe };
      const headers = new Headers({ "x-zproxy-decode": "1" });
      for (const key of SAFE_HEADERS) if (result.response.headers.has(key)) headers.set(key, result.response.headers.get(key));
      const tap = usageTap(usage => {
        usage.cost = calculateCost(model, usage);
        recordGatewayUsage(storage, model, { installId: scope.name, app: "zproxy" }, usage);
        observer.onUsage?.(usage);
      }, "google-gemini-cli");
      return new Response(framed(metadata, result.response.body, finish, controller.signal, config.idleTimeoutMs, tap),
        { status: result.response.status, headers });
    } catch (error) {
      finish();
      try { await rawResponse?.body?.cancel(); } catch {}
      const status = failure?.status ?? (error?.status >= 400 && error.status <= 599 ? error.status : 502);
      const headers = new Headers({ "content-type": "application/json" });
      if (failure?.retryAfter) headers.set("retry-after", failure.retryAfter);
      return Response.json({ error: { type: failure?.type ?? (status < 500 ? "invalid_request_error" : "upstream_error"),
        message: error?.publicMessage ?? "The Antigravity request failed before a response was transferred." } }, { status, headers });
    }
  };
}
