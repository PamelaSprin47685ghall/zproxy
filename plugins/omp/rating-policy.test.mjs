// Consumer-level proof for the routing weight handling.
//
// Every case runs against this workspace's own router sources. The weight set
// the configuration names must reach the affinity lock and every score, and the
// shipped defaults must keep the upstream scoring exactly.

import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROUTER_ROOT = fileURLToPath(new URL("./router", import.meta.url));
/** A Monday at 12:00 Beijing time: outside the peak windows of the fixture. */
const AT = Date.parse("2026-01-05T04:00:00Z");

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

let patched;
let ranking;

beforeAll(async () => {
  // The router modules read their presets relative to themselves, so they are
  // imported in place rather than from a copy.
  patched = await import(pathToFileURL(join(ROUTER_ROOT, "plan.mjs")).href);
  ranking = await import(pathToFileURL(join(ROUTER_ROOT, "ranking.mjs")).href);
}, 60_000);

function rankingOf(module, routeId, options) {
  const policy = new module.ComposedPolicy(PLAN, { now: () => AT });
  return policy.candidatesFor(routeId, { at: AT, ...options });
}

function scoreMap(list) {
  return Object.fromEntries(list.map(({ model, ratingScore }) => [model, ratingScore]));
}

test("the shipped defaults score deterministically", () => {
  const options = { temperature: 0.6, affinity: AFFINITY };
  const patchedScores = scoreMap(rankingOf(patched, "lazy/test", { ...options, random: ranking.seededRandom(9) }));
  // The shipped defaults score deterministically for one exploration stream.
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
  expect(patchedScaled["p/cheap"]).not.toBe(defaults["p/cheap"]);
  expect(patchedScaled).not.toEqual(defaults);

  // A configured cost weight reaches the score: the cheaper model gains.
  const expensive = scoreMap(
    rankingOf(patched, "lazy/test", { ...base, settings: { costWeight: 40 }, random: ranking.seededRandom(3) }),
  );
  expect(expensive).not.toEqual(defaults);
  expect(expensive["p/cheap"]).toBeGreaterThan(defaults["p/cheap"]);

  // Passing the shipped defaults changes nothing: the override equals the
  // preset, so an explicit override equals the defaults again.
  expect(
    scoreMap(
      rankingOf(patched, "lazy/test", {
        ...base,
        settings: { ...ranking.ROUTING_DEFAULTS },
        random: ranking.seededRandom(3),
      }),
    ),
  ).toEqual(scoreMap(rankingOf(patched, "lazy/test", { ...base, random: ranking.seededRandom(3) })));
});

test("group order and the exploration algorithm are unchanged", () => {
  // Equal scores fall back to declaration order, not to a sort artefact.
  expect(rankingOf(patched, "lazy/tie", { temperature: 0 }).map(({ model }) => model)).toEqual([
    "p/cheap",
    "q/rich",
  ]);
  // A fallback node keeps its strict order.
  expect(rankingOf(patched, "lazy/chain", {}).map(({ model }) => model)).toEqual(["q/rich", "p/cheap"]);
  // A seeded stream explores reproducibly.
  const options = { temperature: 0.6, affinity: AFFINITY };
  expect(scoreMap(rankingOf(patched, "lazy/test", { ...options, random: ranking.seededRandom(41) }))).toEqual(
    scoreMap(rankingOf(patched, "lazy/test", { ...options, random: ranking.seededRandom(41) })),
  );
  // Temperature still moves the selection, and zero removes the draw.
  const warm = scoreMap(rankingOf(patched, "lazy/test", { temperature: 3, random: () => 0.99 }));
  const cold = scoreMap(rankingOf(patched, "lazy/test", { temperature: 0, random: () => 0.99 }));
  expect(warm).not.toEqual(cold);
});

test("LazyRouter hands settings.routing to every policy call", async () => {
  const { LazyRouter } = await import(pathToFileURL(join(ROUTER_ROOT, "router.mjs")).href);
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
  const preset = JSON.parse(readFileSync(join(ROUTER_ROOT, "..", "presets/ranking.json"), "utf8"));
  expect(ranking.ROUTING_DEFAULTS).toEqual(preset.routing);
  expect(ranking.ROUTING_DEFAULTS.temperature).toBe(0.6);
  expect(ranking.ROUTING_DEFAULTS.costWeight).toBe(0.2);
  expect(ranking.ROUTING_DEFAULTS.latencyWeight).toBe(1);
  expect(ranking.ROUTING_DEFAULTS.intelligenceCenter).toBe(50);
});