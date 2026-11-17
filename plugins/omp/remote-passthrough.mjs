// An explicit shortcut for server-configured providers that already speak the caller's OpenAI wire.
import { createHash } from "node:crypto";
import { seedApiKeyResolver, withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { recordGatewayUsage } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { mapRequestToolIds } from "./contract.mjs";
import { admit, rejectedResponse, timeoutRead } from "./remote-handoff.mjs";
import { createUsageTap } from "./router/router.mjs";

const SAFE_HEADERS = ["content-type", "cache-control", "retry-after"];

export function createPassthrough({ config, storage, registry, resolveModel, fetch: baseFetch = fetch,
  observeTurn = () => ({}), usesCustomTransport = () => false }) {
  const providers = new Set(config.passthroughProviders ?? []);
  return async (request, scope) => {
    if (!providers.size || scope.completionPath === "/v1/completions") return undefined;
    const body = await request.clone().json();
    const model = resolveModel(body.model);
    if (!model || !providers.has(model.provider) || model.api !== "openai-completions" || getProviderDefinition(model.provider)
      || usesCustomTransport(model) || storage.credentials.hasOAuth(model.provider) || !scope.allows(model)) return undefined;
    const url = new URL(model.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
    const key = createHash("sha256").update(JSON.stringify([model.id, body.prompt_cache_key ?? body.messages?.[0]])).digest("hex");
    const session = scope.credentialSessionId(model.provider, key);
    const initial = await registry.getApiKeyWithCredentialForProvider(model.provider, session, {
      modelId: model.id, baseUrl: model.baseUrl, signal: request.signal,
    });
    if (!initial || initial.oauthAccess) return undefined;
    const resolveKey = registry.resolver(model, session);
    const resolver = seedApiKeyResolver(initial, async context => {
      const resolved = await resolveKey(context);
      return typeof resolved === "object" && resolved?.oauthAccess ? undefined : resolved;
    });
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    const release = scope.retain();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      controller.abort();
      request.signal.removeEventListener("abort", onAbort);
      release();
    };
    const observer = observeTurn(model);
    const outgoing = { ...body, model: model.id };
    for (const name of ["omp", "headers", "apiKey", "baseUrl", "transport", "billing"]) delete outgoing[name];
    if (scope.toolIds) mapRequestToolIds(outgoing, id => scope.toolIds.get(id) ?? id);
    const json = JSON.stringify(outgoing);
    let failure;
    try {
      const fetch = transportFetch(model, baseFetch);
      const response = await withAuth(resolver, async apiKey => {
        const configuredHeaders = await registry.resolveModelHeaders(model, controller.signal);
        const headers = new Headers(configuredHeaders);
        for (const name of ["host", "connection", "content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
        headers.set("content-type", "application/json");
        headers.set("accept", body.stream === true ? "text/event-stream" : "application/json");
        headers.set("accept-encoding", "identity");
        if (apiKey !== "N/A") headers.set("authorization", `Bearer ${apiKey}`);
        const deadline = setTimeout(() => controller.abort(new Error("The OpenAI shortcut timed out.")), config.headerTimeoutMs);
        try {
          observer.onContact?.(url);
          let response = await fetch(url, { method: "POST", headers, body: json, signal: controller.signal, timeout: false });
          if (response.ok && /text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
            const checked = await admit(response, controller.signal, config.headerTimeoutMs);
            response = checked.response ?? checked.error;
          }
          if (response.ok) return response;
          const rejected = await rejectedResponse(response, controller.signal, config.headerTimeoutMs);
          const type = observer.classifyError?.(rejected.text) === "quota" ? "insufficient_quota" : "upstream_error";
          failure = { status: response.status, type, retryAfter: response.headers.get("retry-after") };
          throw Object.assign(new Error(rejected.text), { status: response.status, headers: response.headers });
        } finally { clearTimeout(deadline); }
      }, { signal: controller.signal, isAuthError: error => [401, 402, 403, 429].includes(error?.status) });
      const observed = createUsageTap(response, { onUsage(value) {
        const usage = { input: value.uncachedInput ?? 0, output: value.output ?? 0, cacheRead: value.cachedInput ?? 0,
          cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        usage.totalTokens = usage.input + usage.output + usage.cacheRead;
        usage.cost = calculateCost(model, usage);
        recordGatewayUsage(storage, model, { installId: scope.name, app: "zproxy" }, usage);
      } });
      const headers = new Headers({ "x-zproxy-passthrough": "1" });
      for (const name of SAFE_HEADERS) if (response.headers.has(name)) headers.set(name, response.headers.get(name));
      if (!observed.body) { finish(); return new Response(null, { status: response.status, headers }); }
      const reader = observed.body.getReader();
      return new Response(new ReadableStream({
        async pull(target) {
          try {
            const item = await timeoutRead(reader, config.idleTimeoutMs, controller.signal);
            if (item.done) { reader.releaseLock(); finish(); target.close(); }
            else target.enqueue(item.value);
          } catch {
            finish();
            try { await reader.cancel(); } catch {}
            try { reader.releaseLock(); } catch {}
            target.error(new Error("The OpenAI shortcut response stopped."));
          }
        },
        async cancel(reason) {
          finish();
          try { await reader.cancel(reason); } finally { try { reader.releaseLock(); } catch {} }
        },
      }, { highWaterMark: 0 }), { status: response.status, headers });
    } catch {
      finish();
      const headers = new Headers({ "content-type": "application/json" });
      if (failure?.retryAfter?.length <= 128) headers.set("retry-after", failure.retryAfter);
      return Response.json({ error: { type: failure?.type ?? "upstream_error", message: "The OpenAI shortcut request failed." } },
        { status: failure?.status >= 400 && failure.status <= 599 ? failure.status : 502, headers });
    }
  };
}
