#!/usr/bin/env bun
// Keep original routing policies. Only the raw response boundary differs.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const patches = [
  {
    "path": "lib/router/dispatcher.mjs",
    "before": "c7b5bec5cbeadddf42db7644651715f951c371ac753c60a03d9a865d4cccf7b9",
    "after": "5ef72b8654f86599d343a9cf23374054665ecf9b85dfa49cc5cee702bafb10cc",
    "old": "    const streaming = isEventStream(response);",
    "new": "    // zproxy has already checked the raw provider response before handoff.\n    if (response.headers.get(\"x-zproxy-decode\") === \"1\") {\n      waiting.onOutput?.();\n      return { verdict: { ok: true, status: 200, source: VERDICT_SOURCE.UPSTREAM },\n        response, upstreamContacted: attempt.contacted };\n    }\n    const streaming = isEventStream(response);"
  },
  {
    "path": "lib/router/protocol-codec.mjs",
    "before": "499dd8a219f3072817875ec0fb068963fd5fc0ce6bbeea6f7ed1de247f7953a6",
    "after": "47f7a11c7a7871d16f884c006f594666610c0f0b13f433cc344621a1c129c731",
    "old": "export function rewriteResponseModel(format, response, publicModel) {",
    "new": "export function rewriteResponseModel(format, response, publicModel) {\n  // zproxy rewrites only the bounded decode metadata; the local OMP owns the body.\n  if (response?.headers.get(\"x-zproxy-decode\") === \"1\" || response?.headers.get(\"x-zproxy-passthrough\") === \"1\") return response;"
  }
];
const digest = text => createHash("sha256").update(text).digest("hex");

export async function patchShims(root) {
  const pending = [];
  for (const patch of patches) {
    const path = resolve(root, patch.path);
    const text = await readFile(path, "utf8");
    if (digest(text) === patch.after) continue;
    if (digest(text) !== patch.before || text.split(patch.old).length !== 2) {
      throw new Error(`The pinned shim source changed: ${patch.path}`);
    }
    const changed = text.replace(patch.old, patch.new);
    if (digest(changed) !== patch.after) throw new Error("The shim patch output changed.");
    pending.push([path, changed]);
  }
  for (const [path, text] of pending) await writeFile(path, text);
  return pending.length;
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun patch-shims.mjs SHIMS_SOURCE_ROOT");
  process.stdout.write(`Raw routing patch: ${await patchShims(process.argv[2])} changed files.\n`);
}
