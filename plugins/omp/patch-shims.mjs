#!/usr/bin/env bun
// Keep the pinned shim sources. Only reviewed source edits and the raw
// response boundary differ from upstream.
//
// Every entry pins one whole file twice: `before` is the pinned upstream text
// and `after` is the reviewed text with all of its `edits` applied in order.
// A file is therefore accepted only at one of those two hashes, and every edit
// must appear exactly once in the text it is applied to, so a drifted upstream
// file, a partially edited file, or a locally edited patched file is refused
// instead of guessed. Restoring applies the edits in reverse and must land on
// `before` again, which is what proves the two hashes describe one patch.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const patches = [
  {
    "path": "lib/router/dispatcher.mjs",
    "before": "c7b5bec5cbeadddf42db7644651715f951c371ac753c60a03d9a865d4cccf7b9",
    "after": "644e097787b1e27f65a0865da55edf681a7280b837d1a2471467a2bc4536d3b9",
    "edits": [
      {
        "old": "      const error = await readErrorVerdict(response);\n",
        "new": "      const error = await readErrorVerdict(response);\n      // zproxy: an Antigravity answer can carry the private classification of\n      // a request-content refusal. That classification is authoritative, it is\n      // never provider text, and it stays inside this process: the verdict\n      // keeps one flag and no body, reason, account, or project.\n      const refusal =\n        response.status === 429 &&\n        attempt.provider === \"google-antigravity\" &&\n        response.headers.get(\"x-zproxy-refusal\") === \"request\";\n      // zproxy: the same header also reports that the upstream withdrew the\n      // account. That answer covers every model of the account, so the verdict\n      // carries its own flag and the router benches the account instead of one\n      // model. It stays inside this process like the refusal flag.\n      const blocked =\n        attempt.provider === \"google-antigravity\" &&\n        response.headers.get(\"x-zproxy-refusal\") === \"blocked\";\n"
      },
      {
        "old": "        category: error.category,\n      });\n",
        "new": "        category: error.category,\n        ...(refusal ? { refusal: \"request\" } : {}),\n        ...(blocked ? { refusal: \"blocked\" } : {}),\n      });\n"
      },
      {
        "old": "    const streaming = isEventStream(response);",
        "new": "    // zproxy has already checked the raw provider response before handoff.\n    if (response.headers.get(\"x-zproxy-decode\") === \"1\") {\n      waiting.onOutput?.();\n      return { verdict: { ok: true, status: 200, source: VERDICT_SOURCE.UPSTREAM },\n        response, upstreamContacted: attempt.contacted };\n    }\n    const streaming = isEventStream(response);"
      }
    ]
  },
  {
    "path": "lib/router/protocol-codec.mjs",
    "before": "499dd8a219f3072817875ec0fb068963fd5fc0ce6bbeea6f7ed1de247f7953a6",
    "after": "47f7a11c7a7871d16f884c006f594666610c0f0b13f433cc344621a1c129c731",
    "edits": [
      {
        "old": "export function rewriteResponseModel(format, response, publicModel) {",
        "new": "export function rewriteResponseModel(format, response, publicModel) {\n  // zproxy rewrites only the bounded decode metadata; the local OMP owns the body.\n  if (response?.headers.get(\"x-zproxy-decode\") === \"1\" || response?.headers.get(\"x-zproxy-passthrough\") === \"1\") return response;"
      }
    ]
  },
  {
    "path": "lib/router/plan.mjs",
    "before": "ba8570d8d0abdb222b148cfadb751084aa7e38627cc1c734ea631ee6af9417a2",
    "after": "f78094d9694d6b59e88d711f6d854e67c79819593a8bb360c3782f304f3466eb",
    "edits": [
      {
        "old": "      const stickiness =\n        value && typeof value === \"object\"\n          ? affinityStickiness(value.share, value.bytes).stickiness\n          : Number.isFinite(value)\n            ? Math.max(0, value)\n            : 0;\n      if (stickiness > lockStickiness) lockStickiness = stickiness;\n    }\n\n    const scored = groups.map((row) => {\n      const representative = row.group[0];\n      const routing = scoreCandidate(representative, {\n        perf: perfOf(representative),\n        affinity: affinityOf(representative),\n        referenceMs,\n        referenceCost,\n        lockStickiness,\n        temperature: options.temperature,\n        random,\n      });",
        "new": "      const stickiness =\n        value && typeof value === \"object\"\n          ? affinityStickiness(value.share, value.bytes, options.settings).stickiness\n          : Number.isFinite(value)\n            ? Math.max(0, value)\n            : 0;\n      if (stickiness > lockStickiness) lockStickiness = stickiness;\n    }\n\n    const scored = groups.map((row) => {\n      const representative = row.group[0];\n      const routing = scoreCandidate(representative, {\n        perf: perfOf(representative),\n        affinity: affinityOf(representative),\n        referenceMs,\n        referenceCost,\n        lockStickiness,\n        settings: options.settings,\n        temperature: options.temperature,\n        random,\n      });"
      }
    ]
  },
  {
    "path": "lib/router/router.mjs",
    "before": "3039794ef318f8854b71824885151ec88719fadbfbed0d1b9b79b175150100b2",
    "after": "0517d5e27393a0a90285f8e38c7ed8c7246e7068061b8ae42f4ae2b8dab5a74c",
    "edits": [
      {
        "old": "    const tierOf = (provider, account) => this.accountDirectory?.tierOf(provider, account);\n    const raw = this.policy.candidatesFor(routeId, {\n      ...options,\n      period,",
        "new": "    const tierOf = (provider, account) => this.accountDirectory?.tierOf(provider, account);\n    // One runtime weight set governs every ranking site: the policy scores\n    // with `settings.routing`, never a silent preset default.\n    const raw = this.policy.candidatesFor(routeId, {\n      ...options,\n      settings: options.settings ?? this.settings?.routing,\n      period,"
      },
      {
        "old": "      this.emit(\"attempt-failed\", { ...where, try: tries, failure: kind, ...this.#describe(outcome.verdict) });\n      if (kind === FAILURE.REQUEST || kind === FAILURE.ADAPTER) {",
        "new": "      // zproxy: the official endpoint refused this request's content. The\n      // worker classifies that privately, and the pinned service answers it\n      // without cooling the account because every account would refuse the\n      // same content. So this ends the request with the upstream status and\n      // one fixed sentence: no cooldown, no probe, no other account, and no\n      // provider text, reason, project, or retry moment.\n      if (outcome.verdict?.refusal === \"request\") {\n        this.emit(\"refused\", where);\n        const id = this.modelIdOf(route);\n        return { response: jsonResponse(429,\n          format.errorBody(`${id}: the request was refused by the provider`, \"rate_limit_error\")) };\n      }\n      this.emit(\"attempt-failed\", { ...where, try: tries, failure: kind, ...this.#describe(outcome.verdict) });\n      if (kind === FAILURE.REQUEST || kind === FAILURE.ADAPTER) {"
      }
    ]
  }
];
const digest = text => createHash("sha256").update(text).digest("hex");

/** Every edit of one entry, applied in order, or an error naming the file. */
function applyEdits(path, text, edits, forward) {
  const ordered = forward ? edits : [...edits].reverse();
  let next = text;
  for (const edit of ordered) {
    const [search, replacement] = forward ? [edit.old, edit.new] : [edit.new, edit.old];
    if (search === "") throw new Error(`The shim edit has no anchor: ${path}`);
    if (next.split(search).length !== 2) {
      throw new Error(`The ${forward ? "upstream" : "patched"} shim text changed: ${path}`);
    }
    next = next.replace(search, replacement);
  }
  return next;
}

/**
 * The pinned upstream text of every patched file, whether or not this
 * workspace already applied the patch. A file that matches neither
 * hash, or whose applied text is no longer present, has drifted:
 * the restore or the patch is refused rather than guessed.
 *
 * @returns {Promise<Map<string, string>>} path -> upstream text
 */
export async function upstreamSources(root) {
  const sources = new Map();
  for (const patch of patches) {
    const path = resolve(root, patch.path);
    const text = await readFile(path, "utf8");
    const hash = digest(text);
    if (hash === patch.before) {
      // The upstream text must still carry every anchor exactly once.
      applyEdits(patch.path, text, patch.edits, true);
      sources.set(patch.path, text);
      continue;
    }
    if (hash === patch.after) {
      // The patched text must restore onto the pinned upstream hash.
      const restored = applyEdits(patch.path, text, patch.edits, false);
      if (digest(restored) === patch.before) {
        sources.set(patch.path, restored);
        continue;
      }
    }
    throw new Error(`The pinned shim source changed: ${patch.path}`);
  }
  return sources;
}

export async function patchShims(root) {
  const pending = [];
  for (const patch of patches) {
    const path = resolve(root, patch.path);
    const text = await readFile(path, "utf8");
    if (digest(text) === patch.after) continue;
    if (digest(text) !== patch.before) {
      throw new Error(`The pinned shim source changed: ${patch.path}`);
    }
    const changed = applyEdits(patch.path, text, patch.edits, true);
    if (digest(changed) !== patch.after) throw new Error("The shim patch output changed.");
    pending.push([path, changed]);
  }
  for (const [path, text] of pending) await writeFile(path, text);
  return pending.length;
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun patch-shims.mjs SHIMS_SOURCE_ROOT");
  process.stdout.write(`Reviewed shim patch: ${await patchShims(process.argv[2])} changed files.\n`);
}
