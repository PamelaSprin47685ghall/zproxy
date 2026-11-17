// Consumer-level proof for the rating weight patch.
//
// Every case runs in a temporary copy of the pinned shims. The workspace
// vendor directory is never edited, so the patch is proven where it is
// applied and nowhere else. Two copies are imported side by side: the patched
// one, and one restored to its pinned upstream text, so a single process can
// compare the two behaviours.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patches, patchShims, upstreamSources } from "./patch-shims.mjs";

const SOURCE_ROOT = fileURLToPath(new URL("./vendor/shims", import.meta.url));
/** A Monday at 12:00 Beijing time: outside the peak windows of the fixture. */
const AT = Date.parse("2026-01-05T04:00:00Z");
const sha = (text) => createHash("sha256").update(text).digest("hex");

/** A cheaper model with a warm prefix, and a stronger cold one. */
const PLAN = {
  contextWindow: 500_000,
  maxOutputTokens: 64_000,
  peakWindows: [{ from: "09:00", to: "12:00" }],
  routes: {
    "lazy/test": {
      displayName: "Rating test",
      graph: {
        type: "rating",
        children: [
          { type: "model", model: "p/cheap", effort: "high", intelligence: 50, cost: 1 },
          { type: "model", model: "q/rich", effort: "high", intelligence: 60, cost: 2 },
        ],
      },
    },
    "lazy/tie": {
      displayName: "Tie test",
      graph: {
        type: "rating",
        children: [
          { type: "model", model: "p/cheap", effort: "high", intelligence: 50, cost: 1 },
          { type: "model", model: "q/rich", effort: "high", intelligence: 50, cost: 1 },
        ],
      },
    },
    "lazy/chain": {
      displayName: "Chain test",
      graph: {
        type: "fallback",
        children: [
          { type: "model", model: "q/rich", effort: "high", intelligence: 60, cost: 2 },
          { type: "model", model: "p/cheap", effort: "high", intelligence: 50, cost: 1 },
        ],
      },
    },
  },
};

const AFFINITY = { p: { share: 1, bytes: 8192 } };

const roots = [];
function copyOfPinnedShims() {
  const root = mkdtempSync(join(tmpdir(), "rating-policy-"));
  cpSync(SOURCE_ROOT, root, { recursive: true });
  roots.push(root);
  return root;
}

let patchedRoot = "";
let patched;
let upstream;
let ranking;

beforeAll(async () => {
  patchedRoot = copyOfPinnedShims();
  await patchShims(patchedRoot);
  // Restore the pinned upstream text into a second, still-pristine copy.
  const restored = await upstreamSources(patchedRoot);
  const upstreamRoot = copyOfPinnedShims();
  for (const [relative, text] of restored) writeFileSync(join(upstreamRoot, relative), text);
  patched = await import(pathToFileURL(join(patchedRoot, "lib/router/plan.mjs")).href);
  upstream = await import(pathToFileURL(join(upstreamRoot, "lib/router/plan.mjs")).href);
  ranking = await import(pathToFileURL(join(patchedRoot, "lib/router/ranking.mjs")).href);
}, 60_000);

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function rankingOf(module, routeId, options) {
  const policy = new module.ComposedPolicy(PLAN, { now: () => AT });
  return policy.candidatesFor(routeId, { at: AT, ...options });
}

function scoreMap(list) {
  return Object.fromEntries(list.map(({ model, ratingScore }) => [model, ratingScore]));
}

test("every patch entry pins a real upstream text and its reviewed output", () => {
  const paths = patches.map((patch) => patch.path);
  expect(new Set(paths).size).toBe(paths.length);
  for (const patch of patches) {
    expect(patch.before).toMatch(/^[0-9a-f]{64}$/);
    expect(patch.after).toMatch(/^[0-9a-f]{64}$/);
    expect(patch.before).not.toBe(patch.after);
    // Every reviewed edit pins its own before and after text, so neither hash
    // can describe a file whose edits disagree with it.
    expect(patch.edits.length).toBeGreaterThan(0);
    for (const edit of patch.edits) {
      expect(typeof edit.old).toBe("string");
      expect(typeof edit.new).toBe("string");
      expect(edit.old.length).toBeGreaterThan(0);
      expect(edit.old).not.toBe(edit.new);
    }
  }
  // The rating weight set reaches the policy through these two files only.
  expect(paths).toContain("lib/router/plan.mjs");
  expect(paths).toContain("lib/router/router.mjs");
  // No preset changes: the shipped default weights stay upstream's own.
  expect(paths.some((path) => path.startsWith("presets/"))).toBe(false);
});

test("the patch applies once to a copy, then reports nothing", async () => {
  const root = copyOfPinnedShims();
  const already = patches.filter((patch) => sha(readFileSync(join(root, patch.path), "utf8")) === patch.after);
  expect(await patchShims(root)).toBe(patches.length - already.length);
  expect(await patchShims(root)).toBe(0);
  for (const patch of patches) {
    expect(sha(readFileSync(join(root, patch.path), "utf8"))).toBe(patch.after);
  }
}, 60_000);

test("restored upstream text matches the pinned hashes and reapplies completely", async () => {
  const root = copyOfPinnedShims();
  const restored = await upstreamSources(root);
  expect(restored.size).toBe(patches.length);
  for (const patch of patches) {
    expect(sha(restored.get(patch.path))).toBe(patch.before);
  }
  const target = copyOfPinnedShims();
  for (const [relative, text] of restored) writeFileSync(join(target, relative), text);
  expect(await patchShims(target)).toBe(patches.length);
  for (const patch of patches) {
    expect(sha(readFileSync(join(target, patch.path), "utf8"))).toBe(patch.after);
  }
}, 60_000);

test("drifted upstream text is refused instead of guessed", async () => {
  const root = copyOfPinnedShims();
  const target = join(root, "lib/router/plan.mjs");
  const text = readFileSync(target, "utf8");
  writeFileSync(target, text.replace("const scored = groups.map", "const scored  = groups.map"));
  await expect(patchShims(root)).rejects.toThrow(/pinned shim source changed/);
  await expect(upstreamSources(root)).rejects.toThrow(/pinned shim source changed/);
}, 30_000);

test("a locally edited patched file is refused as well", async () => {
  const root = copyOfPinnedShims();
  await patchShims(root);
  const target = join(root, "lib/router/router.mjs");
  writeFileSync(target, `${readFileSync(target, "utf8")}// local edit\n`);
  await expect(patchShims(root)).rejects.toThrow(/pinned shim source changed/);
  await expect(upstreamSources(root)).rejects.toThrow(/pinned shim source changed/);
}, 30_000);

test("default weights score exactly as upstream does", () => {
  const options = { temperature: 0.6, affinity: AFFINITY };
  const patchedScores = scoreMap(rankingOf(patched, "lazy/test", { ...options, random: ranking.seededRandom(9) }));
  expect(patchedScores).toEqual(
    scoreMap(rankingOf(upstream, "lazy/test", { ...options, random: ranking.seededRandom(9) })),
  );
  // The exploration draw itself is upstream's and stays reproducible.
  expect(patchedScores).toEqual(
    scoreMap(rankingOf(patched, "lazy/test", { ...options, random: ranking.seededRandom(9) })),
  );
});

test("the caller's whole weight set reaches the affinity lock and every score", () => {
  const base = { temperature: 0.6, affinity: AFFINITY };
  const defaults = scoreMap(rankingOf(patched, "lazy/test", { ...base, random: ranking.seededRandom(3) }));
  // affinityLengthScaleBytes used to reach the score but not the affinity lock.
  const scaled = { affinityLengthScaleBytes: 1e12 };
  const patchedScaled = scoreMap(
    rankingOf(patched, "lazy/test", { ...base, settings: scaled, random: ranking.seededRandom(3) }),
  );
  const upstreamScaled = scoreMap(
    rankingOf(upstream, "lazy/test", { ...base, settings: scaled, random: ranking.seededRandom(3) }),
  );
  expect(patchedScaled["p/cheap"]).not.toBe(defaults["p/cheap"]);
  expect(patchedScaled).not.toEqual(upstreamScaled);

  // A configured cost weight reaches the score: the cheaper model gains.
  const expensive = scoreMap(
    rankingOf(patched, "lazy/test", { ...base, settings: { costWeight: 40 }, random: ranking.seededRandom(3) }),
  );
  expect(expensive).not.toEqual(defaults);
  expect(expensive["p/cheap"]).toBeGreaterThan(defaults["p/cheap"]);

  // Passing the shipped defaults changes nothing: the override equals the
  // preset, so upstream and patched agree again.
  expect(
    scoreMap(
      rankingOf(patched, "lazy/test", {
        ...base,
        settings: { ...ranking.ROUTING_DEFAULTS },
        random: ranking.seededRandom(3),
      }),
    ),
  ).toEqual(scoreMap(rankingOf(upstream, "lazy/test", { ...base, random: ranking.seededRandom(3) })));
});

test("group order and the exploration algorithm are unchanged", () => {
  // Equal scores fall back to declaration order, not to a sort artefact.
  expect(rankingOf(patched, "lazy/tie", { temperature: 0 }).map(({ model }) => model)).toEqual([
    "p/cheap",
    "q/rich",
  ]);
  // A fallback node keeps its strict order.
  expect(rankingOf(patched, "lazy/chain", {}).map(({ model }) => model)).toEqual(["q/rich", "p/cheap"]);
  // A seeded stream explores exactly like upstream's.
  const options = { temperature: 0.6, affinity: AFFINITY };
  expect(scoreMap(rankingOf(patched, "lazy/test", { ...options, random: ranking.seededRandom(41) }))).toEqual(
    scoreMap(rankingOf(upstream, "lazy/test", { ...options, random: ranking.seededRandom(41) })),
  );
  // Temperature still moves the selection, and zero removes the draw.
  const warm = scoreMap(rankingOf(patched, "lazy/test", { temperature: 3, random: () => 0.99 }));
  const cold = scoreMap(rankingOf(patched, "lazy/test", { temperature: 0, random: () => 0.99 }));
  expect(warm).not.toEqual(cold);
});

test("LazyRouter hands settings.routing to every policy call", async () => {
  const { LazyRouter } = await import(pathToFileURL(join(patchedRoot, "lib/router/router.mjs")).href);
  const real = new patched.ComposedPolicy(PLAN, { now: () => AT });
  const seen = [];
  const policy = new Proxy(real, {
    get(target, key) {
      if (key === "candidatesFor") {
        return (routeId, options = {}) => {
          seen.push(options.settings);
          return target.candidatesFor(routeId, options);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const catalog = {
    ready: true,
    find: () => ({ contextWindow: 1_000_000, input: ["text"] }),
    rows: () => [],
    host: new Map(),
    gateway: new Map(),
  };
  const health = { stateOf: () => "alive", localRow: () => null };
  const accountDirectory = { all: () => [{ provider: "p", id: 1, tier: null }], tierOf: () => null };
  const build = (routing) =>
    new LazyRouter({
      policy,
      catalog,
      health,
      dispatcher: {},
      faults: { active: false },
      emit: () => {},
      settings: routing === undefined ? {} : { routing },
      planData: PLAN,
      accountDirectory,
      now: () => new Date(AT),
    });
  const order = (router) => router.statusView().routes[0].channels.map(({ model }) => model);

  // Temperature 0 removes the exploration draw, so the order is exact.
  const routing = { ...ranking.ROUTING_DEFAULTS, costWeight: 40, temperature: 0 };
  const configured = build(routing);
  expect(order(configured)[0]).toBe("p/cheap");
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((value) => value === routing)).toBe(true);

  // The configured cost weight alone flips the default order.
  expect(order(build({ ...ranking.ROUTING_DEFAULTS, temperature: 0 }))[0]).toBe("q/rich");

  seen.length = 0;
  const defaulted = build(undefined);
  order(defaulted);
  // No weight set is invented: the policy keeps its own defaults.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((value) => value === undefined)).toBe(true);
}, 60_000);

test("the shipped ranking preset still defines the default weights", () => {
  const preset = JSON.parse(readFileSync(join(SOURCE_ROOT, "presets/ranking.json"), "utf8"));
  expect(ranking.ROUTING_DEFAULTS).toEqual(preset.routing);
  expect(ranking.ROUTING_DEFAULTS.temperature).toBe(0.6);
  expect(ranking.ROUTING_DEFAULTS.costWeight).toBe(0.2);
  expect(ranking.ROUTING_DEFAULTS.latencyWeight).toBe(1);
  expect(ranking.ROUTING_DEFAULTS.intelligenceCenter).toBe(50);
});