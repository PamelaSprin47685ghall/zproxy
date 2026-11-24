#!/usr/bin/env bun
// Apply the reviewed source edits to whatever OMP revision the snapshot holds.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// A marker proves the edit is already present, so a newer OMP that carries it
// needs no change. Otherwise the anchor must occur exactly once in the file.
const patches = [
  {
    "path": "packages/ai/src/registry/oauth/index.ts",
    "marker": "export function getUnpausedProviders",
    "anchor": "/**\n * Turns paused providers back on:",
    "position": "before",
    "insert": "/** zproxy: read a copy so server opt-in leases preserve the user's existing choices. */\nexport function getUnpausedProviders(): ReadonlySet<string> {\n\treturn new Set(unpausedProviders);\n}\n\n"
  },
  {
    "path": "packages/ai/src/auth-gateway/dispatch.ts",
    "marker": "rawResponseHandoff?: (",
    "anchor": "\t/** Upstream transport for every provider call; defaults to global `fetch`. Test seam. */\n\tfetch?: FetchImpl;",
    "position": "after",
    "insert": "\n\t/** zproxy: server-only raw-response handoff before provider response parsing. */\n\trawResponseHandoff?: (turn: {\n\t\trequest: Request;\n\t\tmodel: Model<Api>;\n\t\tparsed: import(\"./types\").AuthGatewayParsedRequest;\n\t\toptions: import(\"../types\").SimpleStreamOptions;\n\t\tcontroller: AbortController;\n\t\tstream: () => import(\"../types\").AssistantMessageEventStream;\n\t\tsettle: () => void;\n\t\tobserveUsage: (usage: Usage) => void;\n\t}) => Promise<Response | undefined>;"
  },
  {
    "path": "packages/ai/src/auth-gateway/server.ts",
    "marker": "bootOpts.rawResponseHandoff",
    "anchor": "\tif (!parsed.stream) {\n\t\ttry {\n\t\t\tif (controller.signal.aborted) return clientClosedResponse(route);",
    "position": "before",
    "insert": "\t// zproxy owns only the successful raw body. OMP still shapes requests and resolves credentials.\n\tif (bootOpts.rawResponseHandoff) {\n\t\tconst clientHold = bootOpts.client?.retain();\n\t\tlet released = false;\n\t\tconst settle = (): void => {\n\t\t\tif (released) return;\n\t\t\treleased = true;\n\t\t\tlease.release();\n\t\t\tclientHold?.();\n\t\t};\n\t\ttry {\n\t\t\tconst raw = await bootOpts.rawResponseHandoff({\n\t\t\t\trequest: req, model, parsed, options: streamOpts, controller,\n\t\t\t\tstream: () => streamSimple(model, parsed.context, streamOpts),\n\t\t\t\tsettle,\n\t\t\t\tobserveUsage: usage => recordGatewayUsage(bootOpts.storage, model, client, usage),\n\t\t\t});\n\t\t\tif (raw !== undefined) return raw;\n\t\t\t// A transport with no fetch seam keeps the complete official gateway path.\n\t\t\tclientHold?.();\n\t\t} catch (error) {\n\t\t\tsettle();\n\t\t\tthrow error;\n\t\t}\n\t}\n\n"
  }
];

export async function patchUpstream(root) {
  const pending = [];
  for (const patch of patches) {
    const path = resolve(root, patch.path);
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new Error(`The OMP source has no ${patch.path}.`);
    }
    if (text.includes(patch.marker)) continue;
    const matches = text.split(patch.anchor).length - 1;
    if (matches !== 1) {
      throw new Error(
        `${patch.path} has ${matches} matches for ${JSON.stringify(patch.anchor)}; expected exactly one. Update patch-upstream.mjs for the current OMP source.`,
      );
    }
    const changed = patch.position === "before"
      ? text.replace(patch.anchor, () => patch.insert + patch.anchor)
      : text.replace(patch.anchor, () => patch.anchor + patch.insert);
    pending.push([path, changed]);
  }
  for (const [path, text] of pending) await writeFile(path, text);
  return pending.length;
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun patch-upstream.mjs OMP_SOURCE_ROOT");
  const count = await patchUpstream(process.argv[2]);
  process.stdout.write(`OMP raw handoff patch: ${count} changed files.\n`);
}
