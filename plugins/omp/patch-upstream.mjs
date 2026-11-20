#!/usr/bin/env bun
// Apply only reviewed source edits to the pinned OMP revision.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const patches = [
  {
    "path": "packages/ai/src/registry/oauth/index.ts",
    "before": "8c1e2821068805be1d733d48880fc0811b576f6bdbb9161fed4d894072ae9b18",
    "after": "b3ac10af301ed322fde6369ecfbbc68922846266a70652d1c6ce36238684de81",
    "old": "/**\n * Turns paused providers back on:",
    "new": "/** zproxy: read a copy so server opt-in leases preserve the user's existing choices. */\nexport function getUnpausedProviders(): ReadonlySet<string> {\n\treturn new Set(unpausedProviders);\n}\n\n/**\n * Turns paused providers back on:"
  },
  {
    "path": "packages/ai/src/auth-gateway/dispatch.ts",
    "before": "6b373e075702dba38902bbcbdc8d4fca4bd4d96319b8b18db2864004a9c2a096",
    "after": "918862b879ac883a8284ab2603d5d325b33acf63f93d860479d2a90050e1f72c",
    "old": "\t/** Upstream transport for every provider call; defaults to global `fetch`. Test seam. */\n\tfetch?: FetchImpl;",
    "new": "\t/** Upstream transport for every provider call; defaults to global `fetch`. Test seam. */\n\tfetch?: FetchImpl;\n\t/** zproxy: server-only raw-response handoff before provider response parsing. */\n\trawResponseHandoff?: (turn: {\n\t\trequest: Request;\n\t\tmodel: Model<Api>;\n\t\tparsed: import(\"./types\").AuthGatewayParsedRequest;\n\t\toptions: import(\"../types\").SimpleStreamOptions;\n\t\tcontroller: AbortController;\n\t\tstream: () => import(\"../types\").AssistantMessageEventStream;\n\t\tsettle: () => void;\n\t\tobserveUsage: (usage: Usage) => void;\n\t}) => Promise<Response | undefined>;"
  },
  {
    "path": "packages/ai/src/auth-gateway/server.ts",
    "before": "c46aa1f0d34f38d16686232a30b5f4bc0ef255e7ade56f6317786d80e777552f",
    "after": "1807f3707d8c63519ba32b7e8316d5a971cce756c14630aaa88b5dff531b3036",
    "old": "\tif (!parsed.stream) {\n\t\ttry {\n\t\t\tif (controller.signal.aborted) return clientClosedResponse(route);",
    "new": "\t// zproxy owns only the successful raw body. OMP still shapes requests and resolves credentials.\n\tif (bootOpts.rawResponseHandoff) {\n\t\tconst clientHold = bootOpts.client?.retain();\n\t\tlet released = false;\n\t\tconst settle = (): void => {\n\t\t\tif (released) return;\n\t\t\treleased = true;\n\t\t\tlease.release();\n\t\t\tclientHold?.();\n\t\t};\n\t\ttry {\n\t\t\tconst raw = await bootOpts.rawResponseHandoff({\n\t\t\t\trequest: req, model, parsed, options: streamOpts, controller,\n\t\t\t\tstream: () => streamSimple(model, parsed.context, streamOpts),\n\t\t\t\tsettle,\n\t\t\t\tobserveUsage: usage => recordGatewayUsage(bootOpts.storage, model, client, usage),\n\t\t\t});\n\t\t\tif (raw !== undefined) return raw;\n\t\t\t// A transport with no fetch seam keeps the complete official gateway path.\n\t\t\tclientHold?.();\n\t\t} catch (error) {\n\t\t\tsettle();\n\t\t\tthrow error;\n\t\t}\n\t}\n\n\tif (!parsed.stream) {\n\t\ttry {\n\t\t\tif (controller.signal.aborted) return clientClosedResponse(route);"
  }
];
const digest = text => createHash("sha256").update(text).digest("hex");

export async function patchUpstream(root) {
  const pending = [];
  for (const patch of patches) {
    const path = resolve(root, patch.path);
    const text = await readFile(path, "utf8");
    const hash = digest(text);
    if (hash === patch.after) continue;
    if (hash !== patch.before || text.split(patch.old).length !== 2) {
      throw new Error(`The pinned OMP source changed: ${patch.path}`);
    }
    const changed = text.replace(patch.old, patch.new);
    if (digest(changed) !== patch.after) throw new Error("The OMP patch did not match its checked output.");
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
