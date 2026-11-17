// OMP owns accounts and refresh. The private Go child owns the official hop.
import { createHash, randomUUID } from "node:crypto";
import { seedApiKeyResolver, withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { oauthAccountKey } from "@oh-my-pi/pi-ai/auth/types";
import { recordGatewayUsage } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { parseGeminiCliCredentials } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { clampThinkingLevelForModel, defaultSupportedEffort, mapEffortToGoogleThinkingLevel, resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import { getAntigravityModelWireProfile } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { mapRequestToolIds, serializeRecipe } from "./contract.mjs";
import { admit, framed, usageTap } from "./remote-handoff.mjs";
import { continueGoogle } from "./remote-google.mjs";

const PROVIDER = "google-antigravity";
const FAMILIES = Object.freeze({ anthropic: "anthropic", gemini: "google", openai: "openai", "gpt-oss": "openai" });
const PROVIDERS = Object.freeze({ google: "MODEL_PROVIDER_GOOGLE", anthropic: "MODEL_PROVIDER_ANTHROPIC", openai: "MODEL_PROVIDER_OPENAI" });
const LEVELS = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, xhigh: 100 });
const SAFE_HEADERS = ["content-type", "cache-control", "retry-after"];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const HANDLE_DOMAIN = "zproxy-ag-official-handle-v1";
/** The worker's private classification of one official rejection. */
const REFUSAL_HEADER = "x-zproxy-refusal";
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
    // The account catalog keys an entry as "models/<id>" and carries the bare
    // id in the entry itself, and the official envelope sends the entry. The
    // projection therefore names the bare id too, so the envelope the worker
    // returns is checked against the model the caller selected.
    id: id.startsWith("models/") ? id.slice("models/".length) : id,
    modelProvider: PROVIDERS[family], maxOutputTokens: positive(profile?.maxOutputTokens ?? model.maxTokens, "output limit"),
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

/**
 * Name one account to the private Go worker.
 *
 * The handle is the only identity the worker stores, and it is opaque: a
 * digest of the durable credential row, so one account keeps one handle across
 * requests and restarts without the row id, the mailbox, or the token ever
 * reaching the worker's text.
 */
export function antigravityHandle(identity, credentialId) {
  const durable = credentialId === undefined || credentialId === null ? oauthAccountKey(identity) ?? identity?.projectId : String(credentialId);
  if (typeof durable !== "string" || durable === "") throw reject(502, "The selected Antigravity account has no durable identity.");
  return createHash("sha256").update(JSON.stringify([HANDLE_DOMAIN, durable, identity?.email ?? ""])).digest("hex");
}

function retryAfter(response) {
  const header = response.headers.get("retry-after");
  return header && header.length <= 128 ? header : undefined;
}

/**
 * Name one rejection for the caller and the outer route.
 *
 * The worker answers a refusal with a status and one fixed sentence that
 * describes the private exchange, and it never relays an upstream body here.
 * This adapter therefore classifies by status alone and answers with its own
 * sentence, so no worker or provider text can reach the caller. An exhausted
 * account and a rate limit both answer 429, and credit answers 402, which is
 * what the public error type reports.
 */
function callerMessage(status) {
  switch (status) {
    case 400: return "The Antigravity codec rejected the request.";
    case 401: return "The Antigravity account credential was refused.";
    case 403: return "The Antigravity account does not have access to this model.";
    case 409: return "The Antigravity device profile conflicts with the stored one.";
    case 429: return "The Antigravity account limit is reached.";
    case 499: return "The Antigravity request was cancelled.";
    case 504: return "The Antigravity request timed out.";
    default: return "The Antigravity upstream is unavailable.";
  }
}

/**
 * Name one rejected send for the outer route.
 *
 * `refusal` is the worker's own classification of a request-content refusal,
 * and it is the only header of the private hop this adapter reads. It is not a
 * public field: the caller keeps the 429 and the fixed sentence, and the outer
 * router uses the classification alone to skip account accounting. An
 * exhausted account stays a quota rejection.
 */
function rejection(status, retryAfter, refusal) {
  const quota = status === 429 || status === 402;
  // Only the official 429 refusal is classified: every other status keeps the
  // account-status path, whatever header a broken peer may have attached.
  const refused = status === 429 && refusal === "request";
  // The upstream withdrew the account itself, so this refusal covers every
  // model of that account. The router cools the account for its usual interval
  // instead of excluding it, because an upstream block can be lifted again.
  const blocked = status === 403 && refusal === "blocked";
  return { status, retryAfter, type: quota ? "insufficient_quota" : "upstream_error",
    ...(refused ? { refusal: "request" } : {}),
    ...(blocked ? { refusal: "blocked" } : {}) };
}

/**
 * Accept only an envelope the worker built for this account, project, and model.
 *
 * The envelope is the whole upstream body, so a reply that named another
 * project, another model, or no agent request would send the caller's request
 * somewhere it does not belong. The worker itself builds exactly these fields,
 * so this check is about the private reply, not about the caller's input.
 */
function validEnvelope(body, project, id) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.project !== project || body.model !== id || body.requestType !== "agent") return false;
  return Boolean(body.request) && typeof body.request === "object" && !Array.isArray(body.request);
}

function sameAccount(first, next) {
  if (!next) return false;
  if (typeof first === "object" && first.credentialId !== undefined
      && typeof next === "object" && next.credentialId !== first.credentialId) return false;
  const key = value => typeof value === "string" ? value : value.apiKey;
  return oauthAccountKey(parseGeminiCliCredentials(key(first))) === oauthAccountKey(parseGeminiCliCredentials(key(next)));
}

/**
 * Await one private call until the shared header deadline ends it.
 *
 * The child aborts the exchange when its caller cancels, but a cold start can
 * still be inside its own work at that moment. This race therefore ends the
 * caller's wait on the abort rather than on the child, so one slow start
 * cannot outlive the deadline it shares with the first send.
 */
function withinDeadline(promise, signal) {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const settle = (fn) => (value) => {
      signal.removeEventListener("abort", abort);
      fn(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(settle(resolve), settle(reject));
  });
}

export function createAntigravity({ config, storage, registry, resolveModel, prepare, send, devices, observeTurn = () => ({}) }) {
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
    let timedOut = false;
    let attempts = 0;
    let rawResponse;
    try {
      if (!scope.allows(model)) throw reject(403, "This Antigravity model is not available to this request.");
      const seed = createHash("sha256").update(JSON.stringify([model.id, body.prompt_cache_key ?? body.messages?.[0]])).digest("hex");
      const session = scope.credentialSessionId(PROVIDER, seed);
      const initial = await registry.getApiKeyWithCredentialForProvider(PROVIDER, session, {
        modelId: model.id, baseUrl: model.baseUrl, signal: controller.signal,
      });
      if (!initial) throw reject(401, "No Antigravity credential is available for this request.");
      // An account exists, so the rest of the private codec must too. Refusing
      // here keeps a partially wired gateway from claiming it can send.
      if (typeof send !== "function" || typeof devices?.get !== "function") {
        throw reject(502, "The Antigravity protocol codec is not configured.");
      }
      // The outer route owns account changes. This adapter can refresh only its
      // selected account, so every attempt stays on the same credential row.
      let selected = typeof initial === "string" ? { apiKey: initial } : initial;
      const resolveKey = registry.resolver(model, session);
      const resolver = seedApiKeyResolver(initial, async context => {
        if (context.lastChance) return undefined;
        const next = await resolveKey(context);
        if (!sameAccount(initial, next)) return undefined;
        selected = typeof next === "string" ? { apiKey: next } : next;
        return next;
      });
      const outgoing = structuredClone(body);
      for (const key of ["omp", "headers", "apiKey", "baseUrl", "transport", "billing", "_zproxy_ag"]) delete outgoing[key];
      // Go keys each capsule signature by the ID the upstream actually saw, and
      // /decode rejects a capsule whose ID is absent from this request. Restoring
      // the caller's IDs here keeps one ID space from client to upstream.
      if (scope.toolIds) mapRequestToolIds(outgoing, id => scope.toolIds.get(id) ?? id);
      if (scope.antigravityContext !== undefined) outgoing._zproxy_ag = scope.antigravityContext;
      const result = await withAuth(resolver, async apiKey => {
        failure = undefined;
        const identity = parseGeminiCliCredentials(apiKey);
        if (identity.expiresAt !== undefined && identity.expiresAt <= Date.now()) throw reject(401, "The Antigravity access token expired.");
        const { catalog, family } = antigravityModel(model, outgoing, identity);
        const project = typeof identity.projectId === "string" ? identity.projectId : "";
        const handle = antigravityHandle(identity, selected.credentialId);
        // The device profile is derived once per credential identity and kept
        // privately, so every request of one account presents one device. The
        // handle stands in for a credential row that carries no durable id; it
        // is a digest, so it names the same account without naming the row.
        const deviceId = selected.credentialId ?? handle;
        if (typeof identity.email !== "string") throw reject(502, "The Antigravity device profile is unavailable.");
        let device;
        try { device = await devices.get({ credentialId: deviceId, email: identity.email }); }
        catch { throw reject(502, "The Antigravity device profile is unavailable."); }
        const exchange = { version: 1, handle, device, accessToken: identity.accessToken, expiresAt: identity.expiresAt ?? 0 };
        // The first prepare may wait for a cold start, and the first send waits
        // for the upstream's headers. Both share one header deadline and this
        // request's own abort signal, so a slow start cannot spend the caller's
        // budget twice. Later segments keep their own per-hop deadlines.
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("The Antigravity response timed out."));
        }, config.headerTimeoutMs);
        try {
          // Both hops share this one deadline, so each is raced against it:
          // the child answers a cancel, but the caller's wait must end on the
          // deadline even while a cold start is still unwinding.
          const prepared = await withinDeadline(
            prepare({ version: 1, request: outgoing, model: catalog, scope: scope.name, ...exchange, project },
              { signal: controller.signal }),
            controller.signal);
          if (!validEnvelope(prepared?.body, project, catalog.id)) {
            throw reject(502, "The Antigravity codec returned an invalid request.");
          }
          attempts++;
          let response = await withinDeadline(
            send({ ...exchange, body: prepared.body }, { signal: controller.signal }),
            controller.signal);
          observer.onContact?.(model.baseUrl);
          if (!response.ok) {
            // The refused body is discarded unread: the worker already reduced
            // it to a fixed sentence, and this adapter answers with its own.
            await response.body?.cancel().catch(() => {});
            failure = rejection(response.status, retryAfter(response), response.headers.get(REFUSAL_HEADER));
            if (failure.refusal === "blocked") observer.onAccountRefused?.();
            throw reject(response.status, callerMessage(response.status));
          }
          if (!response.body || !/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
            await response.body?.cancel();
            throw reject(502, "The Antigravity upstream did not return a response stream.");
          }
          // The worker hands back the upstream bytes as they arrived: it sets no
          // content-encoding, so this adapter must neither decode nor re-label
          // them. Only the first event is inspected, to keep a 200 error frame
          // eligible for the outer retry policy.
          const checked = await admit(response, controller.signal, config.headerTimeoutMs,
            event => typeof (event?.response ?? event)?.promptFeedback?.blockReason === "string");
          response = checked.response ?? checked.error;
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            failure = rejection(response.status, retryAfter(response));
            throw reject(response.status, callerMessage(response.status));
          }
          // A Google generation may be split into authenticated segments. Every
          // later segment re-sends the same envelope through the same account,
          // and only the continuation token changes. The token travels
          // separately so the envelope itself stays the one prepare produced.
          const envelope = prepared.body;
          rawResponse = continueGoogle(response, { model: { ...model, api: "google-gemini-cli" }, input: "official-send",
            init: { method: "POST", body: JSON.stringify(envelope) },
            fetch: async (_input, init) => {
              let resumed;
              try { resumed = JSON.parse(init.body); } catch { throw new Error("The Google continuation body is invalid."); }
              const token = resumed?.request?.continuationToken;
              if (typeof token !== "string" || !token.length) throw new Error("The Google continuation token is invalid.");
              // continueGoogle owns the segment rules: it accepts a stream,
              // cancels a rejected body, and applies its own header timeout and
              // cancel signal to every hop. This adapter only re-sends the same
              // envelope with the token the caller's continuation named.
              return send({ ...exchange, body: envelope, continuationToken: token }, { signal: init.signal });
            },
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
      // The shared prepare/send deadline is a timeout, not an upstream answer:
      // it reports what the worker reports when a cold start spends its own
      // budget, so one slow start cannot turn into an unavailable-upstream
      // error here.
      const status = timedOut ? 504
        : failure?.status ?? (error?.status >= 400 && error.status <= 599 ? error.status : 502);
      const headers = new Headers({ "content-type": "application/json" });
      if (failure?.retryAfter) headers.set("retry-after", failure.retryAfter);
      // The private classification stays on the private hop: the router reads
      // it to skip account accounting, and no public layer forwards it.
      if (failure?.refusal === "request") headers.set(REFUSAL_HEADER, "request");
      else if (failure?.refusal === "blocked") headers.set(REFUSAL_HEADER, "blocked");
      return Response.json({ error: { type: failure?.type ?? (status < 500 ? "invalid_request_error" : "upstream_error"),
        message: error?.publicMessage ?? callerMessage(status) } }, { status, headers });
    }
  };
}
