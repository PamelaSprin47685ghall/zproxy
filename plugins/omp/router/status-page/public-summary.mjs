// The public projection of a routing status snapshot.
//
// `buildSnapshot` is a full operational view: per-route rows, per-account
// capacity, health and cooldown rows carrying a hashed `unitRef`, per-model
// token rows, and a worker identity. None of that may cross into the local
// public report, so this module rebuilds the view from an explicit whitelist
// of aggregate fields. A field that is not named here does not reach a caller,
// even if a future snapshot version adds it.

import { sanitizeStatusReason } from "./snapshot.mjs";

/** Version of the summary shape. Bumped only when a key changes meaning. */
export const SUMMARY_SCHEMA = 1

/** A metric detail is a short count sentence, never a list of accounts. */
const DETAIL_MAX = 200
const METRICS_MAX = 40
const TEXT_MAX = 200
/// An `exact` label is a count or a short reason; M23 puts a provider message
/// there, so the cap matches `sanitizeStatusReason`'s own bound.
const EXACT_MAX = 120
const COVERAGE_KEYS = ['complete', 'uncachedInput', 'cachedInput', 'output']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/// Every string that leaves this module is flattened and redacted here. The
/// snapshot's own `sanitizeStatusReason` also removes URLs, bearer tokens,
/// e-mail addresses and key-shaped secrets, so a provider message that slipped
/// into a metric label cannot carry an account identity out of the process.
function text(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return null
  const flat = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
  if (flat.length === 0) return null
  return sanitizeStatusReason(flat.slice(0, max)) ?? flat.slice(0, max)
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function bool(value) {
  return typeof value === 'boolean' ? value : null
}

/** Sum a numeric row field, or null when no row carries it. */
function sumField(rows, fields) {
  let total = null
  for (const row of rows) {
    for (const field of fields) {
      const value = count(row?.[field])
      if (value !== null) {
        total = (total ?? 0) + value
        break
      }
    }
  }
  return total
}

/// A metric is rebuilt field by field, so a field added to the snapshot later
/// cannot arrive here by accident. `coverage` is the token ledger denominator
/// (M11): without it a token total is a number with no sample count, which is
/// exactly how "missing samples" gets mistaken for zero.
function coverageOf(source) {
  if (!isObject(source)) return null
  const out = {}
  let seen = false
  for (const key of COVERAGE_KEYS) {
    const value = count(source[key])
    if (value === null) continue
    out[key] = value
    seen = true
  }
  return seen ? out : null
}

function metricOf(metric) {
  // A fixed key set: the page must not have to probe for the presence of a
  // field that only appears when a value happens to be present.
  return {
    id: metric.id,
    label: text(metric.label),
    value: text(metric.value),
    // `exact` is a number when known and a label when not, and the distinction
    // is the whole point of the field. A label is not always a dash: M23 writes
    // a provider's cooldown reason into it, so it passes the same redaction as
    // every other string. Copying it verbatim was the one path that could carry
    // provider-authored text out of the process unsanitised.
    exact: typeof metric.exact === 'number' && Number.isFinite(metric.exact)
      ? metric.exact
      : typeof metric.exact === 'string' ? text(metric.exact, EXACT_MAX) : null,
    unit: text(metric.unit, 32),
    scope: text(metric.scope, 32),
    window: text(metric.window, 32),
    available: bool(metric.available),
    reason: text(metric.reason),
    tone: text(metric.tone, 16),
    detail: text(metric.detail, DETAIL_MAX),
    ...(coverageOf(metric.coverage) === null ? {} : { coverage: coverageOf(metric.coverage) }),
  }
}

/// `buildSnapshotMetrics` returns a keyed map (`M01`…`M27`), not an array. An
/// `Array.isArray` guard therefore discarded every metric the panel exists to
/// show; both shapes are accepted, and the map key supplies the id.
function metricsOf(snapshot) {
  const source = snapshot.metrics
  let rows
  if (Array.isArray(source)) rows = source
  else if (isObject(source)) {
    rows = Object.entries(source).map(([key, metric]) =>
      isObject(metric) ? { id: typeof metric.id === 'string' ? metric.id : key, ...metric } : null,
    )
  } else rows = []
  return rows
    .filter((metric) => isObject(metric) && typeof metric.id === 'string')
    .slice(0, METRICS_MAX)
    .map(metricOf)
}

function capacityOf(capacity) {
  const source = isObject(capacity) ? capacity : {}
  const rows = Array.isArray(source.rows) ? source.rows.filter(isObject) : []
  const live = rows.filter((row) => row.stale !== true)
  return {
    available: bool(source.available),
    reason: text(source.reason),
    // Counts and sums only: no unitRef, provider, model or display name.
    liveCount: count(source.liveCount) ?? live.length,
    staleCount: count(source.staleCount) ?? rows.length - live.length,
    held: sumField(live, ['held']),
    max: sumField(live, ['max', 'maxInFlight']),
  }
}

function healthOf(health) {
  const source = isObject(health) ? health : {}
  const rows = Array.isArray(source.rows) ? source.rows.filter(isObject) : []
  const counts = { alive: 0, cooling: 0, busy: 0 }
  let categorized = 0
  for (const row of rows) {
    const state = typeof row.health === 'string' ? row.health
      : typeof row.state === 'string' ? row.state
        : null
    const name = state === 'cooling' || state === 'dead' ? 'cooling' : state === 'busy' ? 'busy' : state === 'alive' ? 'alive' : null
    if (name === null) continue
    counts[name] += 1
    categorized += 1
  }
  return {
    available: bool(source.available),
    reason: text(source.reason),
    total: rows.length,
    alive: categorized === rows.length ? counts.alive : null,
    cooling: categorized === rows.length ? counts.cooling : null,
    busy: categorized === rows.length ? counts.busy : null,
  }
}

function proofOf(proof) {
  const source = isObject(proof) ? proof : {}
  let models = null
  if (Array.isArray(source.rows)) models = source.rows.length
  else if (isObject(source.byModel)) models = Object.keys(source.byModel).length
  return { available: bool(source.available), reason: text(source.reason), verifiedModels: models }
}

function affinityOf(affinity) {
  const source = isObject(affinity) ? affinity : {}
  const hits = count(source.hits)
  const lookups = count(source.lookups)
  return {
    available: bool(source.available),
    windowMinutes: count(source.windowMinutes),
    hits,
    lookups,
    hitRate: typeof source.hitRate === 'number' && Number.isFinite(source.hitRate) ? source.hitRate : null,
  }
}

/// The real snapshot computes a USD equivalent and nothing else: there is no
/// exchange rate in this process, so a CNY figure is never invented here. The
/// keys are the ones `officialApiEquivalent` actually returns — reading `usd`
/// or `asOf` instead left the money value permanently null.
function officialValueOf(value) {
  if (!isObject(value)) return null
  const usd =
    typeof value.valueUsd === 'number' && Number.isFinite(value.valueUsd) ? value.valueUsd
      : typeof value.usd === 'number' && Number.isFinite(value.usd) ? value.usd : null
  return {
    currency: text(value.currency, 8),
    usd,
    // `pricedModels === 0` means no official price is known; callers must show
    // the denominator rather than a zero amount.
    pricedModels: count(value.pricedModels),
    totalModels: count(value.totalModels),
    unpricedModels: count(value.unpricedModels),
    asOf: text(value.ratesAsOf, 40) ?? text(value.asOf, 40),
  }
}

/// `catalogState` returns an object, not a boolean: reading it as a boolean made
/// catalogue readiness permanently unknown.
function catalogOf(catalog) {
  if (typeof catalog === 'boolean') {
    return { ready: catalog, workerReady: catalog, aggregateReady: catalog }
  }
  if (!isObject(catalog)) return null
  return {
    ready: bool(catalog.ready),
    workerReady: bool(catalog.workerReady),
    aggregateReady: bool(catalog.aggregateReady),
  }
}

/// `periodView` nests the next switch as `{at, period, label}`; treating it as a
/// string erased the "next switch" field entirely.
function periodOf(period) {
  const source = isObject(period) ? period : {}
  const next = isObject(source.nextSwitch) ? source.nextSwitch : null
  return {
    id: text(source.id, 32),
    label: text(source.label),
    nextSwitch:
      next === null
        ? null
        : { at: text(next.at, 40), period: text(next.period, 32), label: text(next.label) },
  }
}

function tokensOf(tokenTotals) {
  const source = isObject(tokenTotals) ? tokenTotals : {}
  const totals = isObject(source.totals) ? source.totals : {}
  const coverage = isObject(source.coverage) ? source.coverage : {}
  const models = Array.isArray(source.models) ? source.models : []
  return {
    available: bool(source.available),
    mode: text(source.mode),
    totals: {
      uncachedInput: count(totals.uncachedInput),
      cachedInput: count(totals.cachedInput),
      output: count(totals.output),
    },
    // `complete` is the denominator: a model that never reported usage is not
    // a zero, it is a missing sample.
    coverage: {
      complete: count(coverage.complete),
      uncachedInput: count(coverage.uncachedInput),
      cachedInput: count(coverage.cachedInput),
      output: count(coverage.output),
    },
    officialValue: officialValueOf(source.officialValue),
    // Model names stay remote; only how many models reported is public.
    models: models.length,
    epochSince: text(source.epoch?.since),
  }
}

function workersOf(workers) {
  const source = isObject(workers) ? workers : {}
  const rows = Array.isArray(source.rows) ? source.rows.filter(isObject)
    : Array.isArray(workers) ? workers.filter(isObject) : []
  const live = rows.filter((row) => row.stale !== true && row.alive !== false)
  return {
    total: rows.length,
    live: live.length,
    inFlight: sumField(live, ['inFlight']),
  }
}

function unavailable(reason) {
  const summary = {
    schemaVersion: SUMMARY_SCHEMA,
    available: false,
    reason,
    generatedAt: null,
    epochSince: null,
    store: { mode: 'unavailable', available: false, reason },
    period: { id: null, label: null, nextSwitch: null },
    catalog: null,
    metrics: [],
    aggregate: {
      capacity: capacityOf(null),
      health: healthOf(null),
      proof: proofOf(null),
      affinity: affinityOf(null),
      tokens: tokensOf(null),
      workers: workersOf(null),
    },
  }
  return { ...summary, available: false }
}

/** A worker-local pool is not a global value: publish availability, not numbers. */
function gated(aggregate, global, reason) {
  if (global) return aggregate
  const blank = (value) => (typeof value === 'number' ? null : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, blank(item)])) : value)
  return {
    capacity: { ...blank(aggregate.capacity), available: false, reason },
    health: { ...blank(aggregate.health), available: false, reason },
    proof: { ...blank(aggregate.proof), available: false, reason },
    affinity: { ...blank(aggregate.affinity), available: false },
    tokens: { ...blank(aggregate.tokens), available: false },
    workers: { ...blank(aggregate.workers), inFlight: null },
  }
}

export function buildPublicSummary(snapshot, options = {}) {
  if (!isObject(snapshot)) return unavailable(text(options.reason) ?? '路由统计不可用')
  const store = isObject(snapshot.store) ? snapshot.store : {}
  const mode = text(store.mode) ?? 'unavailable'
  const global = mode === 'sqlite' && store.available === true
  const reason = text(store.reason) ?? (global ? null : '共享状态不可用')
  const metrics = metricsOf(snapshot)
  const aggregate = gated({
    capacity: capacityOf(snapshot.capacity),
    health: healthOf(snapshot.health),
    proof: proofOf(snapshot.proof),
    affinity: affinityOf(snapshot.affinity),
    tokens: tokensOf(snapshot.tokenTotals),
    workers: workersOf(snapshot.workers),
  }, global, reason)
  return {
    schemaVersion: SUMMARY_SCHEMA,
    available: true,
    reason: null,
    // `answeredBy` is deliberately absent: it carries a host and a pid.
    generatedAt: text(snapshot.generatedAt, 40),
    buildVersion: text(snapshot.buildVersion, 40),
    snapshotId: text(snapshot.snapshotId, 80),
    epochSince: text(snapshot.epoch?.since, 40),
    store: {
      mode: text(store.mode) ?? 'unavailable',
      available: bool(store.available) ?? false,
      reason: text(store.reason),
    },
    period: periodOf(snapshot.period),
    catalog: catalogOf(snapshot.catalog),
    metrics,
    aggregate,
  }
}

/** Cap a summary before it crosses the private socket. */
export function encodePublicSummary(value, limit = 65536) {
  const body = JSON.stringify(value)
  if (body.length <= limit) return body
  return JSON.stringify(unavailable('统计快照超出上限'))
}
