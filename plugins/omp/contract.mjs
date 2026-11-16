// Keep the remote account boundary separate from the local response parser.
import { createHash } from "node:crypto";

export const RECIPE_LIMIT = 8192;
export const CODEC_APIS = Object.freeze([
  "openai-completions", "openai-responses", "anthropic-messages",
  "google-generative-ai", "google-gemini-cli",
  "antigravity2api",
]);
const API_MAP = Object.freeze({
  "openai-completions": "openai-completions",
  "openai-responses": "openai-responses",
  "openrouter": "openai-completions",
  "openai-codex-responses": "openai-responses",
  "azure-openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
  "google-generative-ai": "google-generative-ai",
  "google-vertex": "google-generative-ai",
  "google-gemini-cli": "google-gemini-cli",
});
const BOOLEAN_COMPAT = Object.freeze([
  "mistralReasoningContentParts", "stripDeepseekSpecialTokens",
  "reasoningDeltasMayBeCumulative", "emptyLengthFinishIsContextError",
  "escapeBuiltinToolNames", "flashStreamLeakWorkaround",
]);
const RECIPE_KEYS = new Set(["api", "provider", "id", "reasoning", "input", "contextWindow", "maxTokens", "compat"]);
const COMPAT_KEYS = new Set([...BOOLEAN_COMPAT, "streamMarkupHealingPattern", "toolNamePrefix", "agProvider"]);
const MARKUP = new Set(["thinking", "kimi", "dsml", "qwen"]);
const utf8 = new TextEncoder();

function record(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function plainName(value, limit, name, empty = false) {
  if (typeof value !== "string" || (!empty && value.length === 0) || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || utf8.encode(value).length > limit) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function uniqueJson(text) {
  const value = JSON.parse(text);
  const stack = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]/gu)) {
    const part = token[0];
    if (part === "{") stack.push({ keys: new Set(), key: true });
    else if (part === "[") stack.push({});
    else if (part === "}" || part === "]") stack.pop();
    else if (part === "," && stack.at(-1)?.keys) stack.at(-1).key = true;
    else if (part === ":" && stack.at(-1)?.keys) stack.at(-1).key = false;
    else if (part.startsWith('"') && stack.at(-1)?.key) {
      const key = JSON.parse(part);
      if (stack.at(-1).keys.has(key)) throw new Error("Duplicate OMP recipe field.");
      stack.at(-1).keys.add(key);
    }
  }
  return value;
}

export function supportsRawApi(api) {
  return Object.hasOwn(API_MAP, api);
}

/** Validate a fixed public recipe. Never accept an account or request option bag. */
export function parseRecipe(text) {
  if (typeof text !== "string" || utf8.encode(text).length > RECIPE_LIMIT) throw new Error("Invalid OMP recipe size.");
  const value = record(uniqueJson(text), "OMP recipe");
  for (const key of Object.keys(value)) if (!RECIPE_KEYS.has(key)) throw new Error("Unknown OMP recipe field.");
  if (!CODEC_APIS.includes(value.api)) throw new Error("Unsupported local OMP codec.");
  plainName(value.provider, 128, "provider");
  plainName(value.id, 256, "model id");
  if (typeof value.reasoning !== "boolean") throw new Error("Invalid reasoning flag.");
  if (!Array.isArray(value.input) || value.input.length < 1 || value.input.length > 2 || new Set(value.input).size !== value.input.length || value.input.some(item => item !== "text" && item !== "image")) {
    throw new Error("Invalid model input types.");
  }
  for (const key of ["contextWindow", "maxTokens"]) {
    if (!Number.isInteger(value[key]) || value[key] <= 0 || value[key] > 2147483647) throw new Error(`Invalid ${key}.`);
  }
  record(value.compat, "parser compatibility");
  for (const [key, item] of Object.entries(value.compat)) {
    if (!COMPAT_KEYS.has(key)) throw new Error("Unknown parser compatibility field.");
    if (BOOLEAN_COMPAT.includes(key) && typeof item !== "boolean") throw new Error(`Invalid ${key}.`);
    if (key === "streamMarkupHealingPattern" && item !== null && !MARKUP.has(item)) throw new Error("Invalid markup parser.");
    if (key === "toolNamePrefix") plainName(item, 64, "tool name prefix", true);
    if (key === "agProvider" && !["google", "anthropic", "openai"].includes(item)) throw new Error("Invalid Antigravity model family.");
  }
  if (value.api === "antigravity2api") {
    if (value.provider !== "google-antigravity" || !value.compat.agProvider) throw new Error("Invalid Antigravity recipe.");
  } else if (value.compat.agProvider !== undefined) throw new Error("Unexpected Antigravity model family.");
  return value;
}

export function serializeRecipe(recipe) {
  const text = JSON.stringify(recipe);
  parseRecipe(text);
  return text;
}

/** Read only public model properties. Credential-shaped objects stay remote. */
export function descriptorFor(model, options = {}, wireApi) {
  if (!supportsRawApi(model.api)) return undefined;
  const api = wireApi ?? API_MAP[model.api];
  const compat = {};
  for (const key of BOOLEAN_COMPAT) {
    if (typeof model.compat?.[key] === "boolean") compat[key] = model.compat[key];
  }
  if (api === "anthropic-messages" && options.isOAuth === true) compat.escapeBuiltinToolNames = true;
  if (typeof model.compat?.toolNamePrefix === "string") compat.toolNamePrefix = model.compat.toolNamePrefix;
  if (api === "openai-completions") compat.streamMarkupHealingPattern = model.compat?.streamMarkupHealingPattern ?? null;
  const recipe = {
    api, provider: model.provider, id: model.id, reasoning: model.reasoning === true,
    input: model.input ?? ["text"], contextWindow: model.contextWindow, maxTokens: model.maxTokens, compat,
  };
  return parseRecipe(JSON.stringify(recipe));
}

export function shortToolId(id) {
  return `t_${createHash("sha256").update(id, "utf8").digest("base64url").slice(0, 32)}`;
}

/** Only OpenAI message identifier slots are inspected. Tool arguments are opaque. */
export function mapRequestToolIds(body, transform) {
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;
    if (typeof message.tool_call_id === "string") message.tool_call_id = transform(message.tool_call_id);
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call && typeof call.id === "string") call.id = transform(call.id);
      }
    }
  }
}

export function buildToolIdMap(body) {
  const mapping = new Map();
  mapRequestToolIds(structuredClone(body), id => {
    const short = shortToolId(id);
    if (mapping.has(short) && mapping.get(short) !== id) throw new Error("Tool id collision.");
    mapping.set(short, id);
    return id;
  });
  return mapping;
}

/** This is the only ingress normalization outside the official gateway. */
export function normalizeOpenAIRequest(path, body) {
  record(body, "OpenAI request");
  const result = structuredClone(body);
  delete result._zproxy_ag;
  if (result.tools === null) delete result.tools;
  if (result.metadata === null) delete result.metadata;
  if (path === "/v1/completions") {
    const prompt = Array.isArray(result.prompt) && result.prompt.length === 1 ? result.prompt[0] : result.prompt;
    if (typeof prompt !== "string") throw new Error("Legacy completions require one text prompt.");
    if (result.echo === true || result.suffix != null || result.logprobs != null || (result.best_of != null && result.best_of !== 1)) {
      throw new Error("Echo, suffix, logprobs, and best_of are not supported by the OMP chat adapter.");
    }
    result.messages = [{ role: "user", content: prompt }];
    for (const key of ["prompt", "echo", "suffix", "logprobs", "best_of"]) delete result[key];
  } else if (path !== "/v1/chat/completions") {
    throw new Error("Unsupported OpenAI route.");
  }
  if (result.n != null && result.n !== 1) throw new Error("The OMP adapter supports one completion per request.");
  mapRequestToolIds(result, shortToolId);
  return result;
}
