// The public summary must be an allowlist: a field the snapshot grows later
// must not appear here by accident.
import { expect, test } from "bun:test";
import { buildPublicSummary, encodePublicSummary, SUMMARY_SCHEMA } from "./router/status-page/public-summary.mjs";

const snapshot = {
  schemaVersion: 3,
  snapshotId: "snap-1",
  generatedAt: "2026-11-25T10:00:00.000Z",
  answeredBy: "secret-host:4242",
  buildVersion: "v9",
  epoch: { id: "epoch-uuid", since: "2026-11-01T00:00:00.000Z" },
  store: { mode: "sqlite", available: true, reason: null },
  period: { id: "peak", label: "高峰时段", nextSwitch: "2026-11-25T14:00:00.000Z" },
  catalog: true,
  metrics: [
    { id: "M03", label: "在途请求", value: "7", exact: 7, unit: "count", scope: "global", window: "now", available: true, reason: null, detail: "4 个 worker", tone: "normal" },
    { id: "M23", label: "冷却原因", value: "配额", exact: null, unit: "text", scope: "global", window: "current", available: true, reason: null, detail: "见账号表", tone: "warn" },
    { notAMetric: true },
  ],
  capacity: {
    available: true,
    reason: null,
    liveCount: 2,
    staleCount: 1,
    rows: [
      { unitRef: "u_0123456789abcdef", displayName: "acct@example.com", provider: "anthropic", model: "claude", held: 3, max: 8, stale: false },
      { unitRef: "u_fedcba9876543210", displayName: "other", provider: "openai", model: "gpt", held: 2, max: 4, stale: false },
      { unitRef: "u_0000000000000000", displayName: "stale", provider: "x", model: "y", held: 9, max: 9, stale: true },
    ],
  },
  health: {
    available: true,
    rows: [
      { unitRef: "u_0123456789abcdef", provider: "anthropic", accountId: "a@example.com", state: "alive", health: "alive", reason: null },
      { unitRef: "u_fedcba9876543210", provider: "openai", accountId: "b@example.com", state: "dead", health: "cooling", reason: "429 quota" },
    ],
  },
  proof: { available: true, byModel: { "claude-opus": { verified: 4 }, "gpt-5": { verified: 2 } } },
  affinity: { available: true, windowMinutes: 5, hits: 30, lookups: 40, hitRate: 0.75 },
  tokenTotals: {
    available: true,
    mode: "sqlite",
    epoch: { id: "epoch-uuid", since: "2026-11-01T00:00:00.000Z" },
    totals: { uncachedInput: 1000, cachedInput: 500, output: 250 },
    coverage: { complete: 12, uncachedInput: 10, cachedInput: 4, output: 11 },
    officialValue: { usd: 1.25, cny: 9, pricedModels: 2, totalModels: 3, asOf: "2026-11-20" },
    models: [{ provider: "anthropic", model: "claude-opus", uncachedInput: 1000 }],
  },
  workers: { rows: [{ id: "w1", inFlight: 3, stale: false }, { id: "w2", inFlight: 4, stale: false }] },
};

const text = JSON.stringify(buildPublicSummary(snapshot));

test("the summary carries no account, model, or worker identity", () => {
  for (const forbidden of [
    "u_0123456789abcdef", "u_fedcba9876543210", "acct@example.com", "a@example.com",
    "anthropic", "openai", "claude", "gpt-5", "secret-host", "4242", "epoch-uuid", "w1",
  ]) {
    expect(text).not.toContain(forbidden);
  }
});

test("aggregate counts survive the projection", () => {
  const summary = buildPublicSummary(snapshot);
  expect(summary.schemaVersion).toBe(SUMMARY_SCHEMA);
  // held/max sum only live rows: 3+2 and 8+4; the stale row is excluded.
  expect(summary.aggregate.capacity).toMatchObject({ liveCount: 2, staleCount: 1, held: 5, max: 12 });
  expect(summary.aggregate.health).toMatchObject({ total: 2, alive: 1, cooling: 1, busy: 0 });
  expect(summary.aggregate.proof.verifiedModels).toBe(2);
  expect(summary.aggregate.affinity).toMatchObject({ hits: 30, lookups: 40, hitRate: 0.75 });
  expect(summary.aggregate.tokens.totals).toEqual({ uncachedInput: 1000, cachedInput: 500, output: 250 });
  expect(summary.aggregate.tokens.coverage.complete).toBe(12);
  expect(summary.aggregate.tokens.models).toBe(1);
  expect(summary.aggregate.workers).toMatchObject({ total: 2, live: 2, inFlight: 7 });
  expect(summary.store).toEqual({ mode: "sqlite", available: true, reason: null });
  expect(summary.period.label).toBe("高峰时段");
});

test("metrics keep only the documented fields and drop unknown entries", () => {
  const summary = buildPublicSummary(snapshot);
  expect(summary.metrics).toHaveLength(2);
  expect(Object.keys(summary.metrics[0]).sort()).toEqual([
    "available", "detail", "exact", "id", "label", "reason", "scope", "tone", "unit", "value", "window",
  ]);
  expect(summary.metrics[0].id).toBe("M03");
  expect(summary.metrics[1].id).toBe("M23");
});

test("a missing snapshot is unavailable, never zero", () => {
  const summary = buildPublicSummary(null, { reason: "路由统计未启用" });
  expect(summary.available).toBe(false);
  expect(summary.reason).toBe("路由统计未启用");
  expect(summary.store.available).toBe(false);
  expect(summary.aggregate.capacity.held).toBeNull();
  expect(summary.aggregate.tokens.totals.uncachedInput).toBeNull();
  expect(summary.metrics).toEqual([]);
});

test("an over-limit document degrades to the unavailable shape", () => {
  const body = encodePublicSummary(buildPublicSummary(snapshot), 100);
  const parsed = JSON.parse(body);
  expect(parsed.available).toBe(false);
  expect(parsed.reason).toBe("统计快照超出上限");
});

test("a real snapshot maps to non-null public values", async () => {
  // Every assertion below reads a value that a real `buildSnapshot` produced.
  // The previous projection read key names the snapshot does not use
  // (`usd`, `asOf`, a boolean `catalog`, a string `nextSwitch`), so those
  // values were permanently null while the code looked correct.
  const { buildSnapshot } = await import("./router/status-page/snapshot.mjs");
  const now = new Date("2026-11-25T10:00:00.000Z");
  const real = buildSnapshot({
    now,
    answeredBy: "worker-1",
    buildVersion: "v9",
    store: { mode: "sqlite", available: true, reason: null },
    epoch: { id: "epoch-1", since: "2026-11-01T00:00:00.000Z" },
    period: {
      id: "peak",
      nextSwitch: { at: "2026-11-25T14:00:00.000Z", period: "offPeak", label: "闲时" },
    },
    catalog: { ready: true, workerReady: true, aggregateReady: true },
    workerRows: [
      { worker: "worker-1", answeredBy: "worker-1", inFlight: 3, catalogReady: true, updatedAt: now.toISOString() },
      { worker: "worker-2", answeredBy: "worker-1", inFlight: 4, catalogReady: true, updatedAt: now.toISOString() },
    ],
    // `updatedAt` must be an ISO string or epoch millis: the snapshot treats an
    // unparseable stamp as stale, which is what hides live rows from the panel.
    capacityRows: [
      { unit: "anthropic/acct-a", provider: "anthropic", accountId: "acct-a", model: "claude-opus", held: 3, max: 8, updatedAt: now.toISOString() },
      { unit: "openai/acct-b", provider: "openai", accountId: "acct-b", model: "gpt-5", held: 2, max: 4, updatedAt: now.toISOString() },
    ],
    healthRows: [
      { key: "anthropic/acct-a", state: "alive", updatedAt: now.toISOString() },
      { key: "openai/acct-b", state: "dead", reason: "quota", updatedAt: now.toISOString() },
    ],
    // `until` is also parsed by `epochMillis`: a Date object is rejected exactly
    // like an unparseable stamp, which silently drops every verified model.
    proofRows: { "claude-opus": { verified: 4, until: "2026-11-25T12:00:00.000Z" } },
    affinityStats: { hits: 30, lookups: 40 },
    tokenTotals: {
      epoch: { id: "epoch-1", since: "2026-11-01T00:00:00.000Z" },
      rows: [
        {
          provider: "anthropic",
          model: "claude-opus",
          uncachedInput: 1000,
          cachedInput: 500,
          output: 250,
          complete: 12,
          seenUncached: 10,
          seenCached: 4,
          seenOutput: 11,
        },
      ],
    },
  });
  const summary = buildPublicSummary(real);

  expect(summary.available).toBe(true);
  expect(summary.store).toEqual({ mode: "sqlite", available: true, reason: null });

  // The money value: this is the field that was silently null before.
  const money = summary.aggregate.tokens.officialValue;
  expect(money).not.toBeNull();
  expect(typeof money.usd).toBe("number");
  expect(money.currency).toBe("USD");
  expect(money.pricedModels).not.toBeNull();
  expect(money.totalModels).toBe(1);
  expect(money.asOf).not.toBeNull();
  expect(money.cny).toBeUndefined();

  // Token totals carry their denominators.
  expect(summary.aggregate.tokens.totals).toEqual({ uncachedInput: 1000, cachedInput: 500, output: 250 });
  expect(summary.aggregate.tokens.coverage).toEqual({
    complete: 12, uncachedInput: 10, cachedInput: 4, output: 11,
  });

  // Catalogue readiness is three booleans, not one unknown.
  expect(summary.catalog).toEqual({ ready: true, workerReady: true, aggregateReady: true });

  // The next switch survives as a structured instant.
  expect(summary.period.label).toBe("高峰时段");
  expect(summary.period.nextSwitch.at).toBe("2026-11-25T14:00:00.000Z");
  expect(summary.period.nextSwitch.period).toBe("offPeak");

  // Aggregates derived from row lists.
  expect(summary.aggregate.capacity).toMatchObject({ liveCount: 2, staleCount: 0, held: 5, max: 12 });
  expect(summary.aggregate.health).toMatchObject({ total: 2, alive: 1, cooling: 1, busy: 0 });
  expect(summary.aggregate.proof.verifiedModels).toBe(1);
  expect(summary.aggregate.affinity).toMatchObject({ hits: 30, lookups: 40, hitRate: 0.75 });
  expect(summary.aggregate.workers).toMatchObject({ total: 2, live: 2, inFlight: 7 });

  // Real metrics arrive with formatted values; `exact` is a count string or a
  // dash, so the projection must not depend on it being a number. What matters
  // is that token metrics carried real totals, not dashes.
  expect(summary.metrics.length).toBeGreaterThan(0);
  for (const metric of summary.metrics) {
    expect(typeof metric.id).toBe("string");
    expect(typeof metric.value).toBe("string");
    expect(typeof metric.available).toBe("boolean");
  }
  const byId = Object.fromEntries(summary.metrics.map((metric) => [metric.id, metric]));
  expect(byId.M08.exact).toBe("1,000");
  expect(byId.M09.exact).toBe("500");
  expect(byId.M10.exact).toBe("250");
  expect(byId.M11.available).toBe(true);
  expect(byId.M26.exact).toContain("SQLite");
  // A metric the snapshot marks unavailable keeps its dash and its reason.
  expect(byId.M25.available).toBe(false);

  // The projection still carries no identity, model, or host from that snapshot.
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["anthropic", "openai", "acct-a", "acct-b", "claude-opus", "gpt-5", "u_", "worker-1", "worker-2"]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test("metric coverage keeps only numeric counters", () => {
  const summary = buildPublicSummary({
    ...snapshot,
    metrics: [{ id: "M11", label: "覆盖率", value: "8/12", coverage: { complete: 12, uncachedInput: 8, extra: "leak" } }],
  });
  expect(summary.metrics[0].coverage).toEqual({ complete: 12, uncachedInput: 8 });
});

test("an exact label is redacted like every other string", () => {
  // M23 writes a provider cooldown reason into `exact`, so the field is not
  // always a number or a dash. It used to be copied verbatim.
  const summary = buildPublicSummary({
    ...snapshot,
    metrics: [
      { id: "M23", label: "冷却原因", value: "配额", exact: "quota for ops@example.com via https://internal.example/x", available: true },
      { id: "M08", label: "未缓存输入", value: "1,000", exact: "1,000", available: true },
    ],
  });
  expect(summary.metrics[0].exact).not.toContain("ops@example.com");
  expect(summary.metrics[0].exact).not.toContain("internal.example");
  expect(summary.metrics[0].exact).toContain("[redacted]");
  // A numeric label stays exactly as the snapshot wrote it.
  expect(summary.metrics[1].exact).toBe("1,000");
});

test("a numeric exact survives as a number", () => {
  const summary = buildPublicSummary({ ...snapshot, metrics: [{ id: "M03", label: "在途", value: "7", exact: 7 }] });
  expect(summary.metrics[0].exact).toBe(7);
});

test("history text is flattened, bounded, and redacted", () => {
  const summary = buildPublicSummary({
    ...snapshot,
    metrics: [{ id: "M01", label: "x", value: "1", detail: `a\nb\u0000${"z".repeat(500)}` }],
  });
  expect(summary.metrics[0].detail.length).toBeLessThanOrEqual(120);
  expect(summary.metrics[0].detail).not.toContain("\u0000");
});

test("free text cannot carry an account identity out of the process", () => {
  const summary = buildPublicSummary({
    ...snapshot,
    metrics: [{
      id: "M23",
      label: "ops@example.com",
      value: "Bearer sk-abcdefgh12345678",
      detail: "see https://internal.example/secret for api_key=abc123",
      reason: "password=hunter2",
    }],
  });
  const text = JSON.stringify(summary);
  for (const leaked of ["ops@example.com", "sk-abcdefgh12345678", "internal.example", "hunter2"]) {
    expect(text).not.toContain(leaked);
  }
  expect(summary.metrics[0].label).toBe("[redacted]");
});
