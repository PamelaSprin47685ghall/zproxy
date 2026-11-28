// Reading the public report. Every optional block is treated as "not reported"
// rather than zero, so the page never invents a number the server did not send.

export const LATENCY_KEYS = ['lt100', 'lt500', 'lt1000', 'lt5000', 'lt30000', 'gte30000']
export const LATENCY_LABELS = ['< 100 ms', '< 500 ms', '< 1 s', '< 5 s', '< 30 s', '≥ 30 s']
/// The two completion paths the proxy accepts. This is a route, not a model.
export const KIND_KEYS = ['chat', 'completions']
export const KIND_LABELS = { chat: '/v1/chat/completions', completions: '/v1/completions' }
// Bucket midpoints used for an honest estimate; the last bucket is unbounded.
const LATENCY_MARKS = [50, 300, 750, 3000, 17500, 45000]
export const STATUS_KEYS = ['2xx', '3xx', '4xx', '5xx', 'noResponse']

export function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function sum(values) {
  return values.reduce((total, value) => total + (num(value) ?? 0), 0)
}

export function fmtInt(value) {
  if (num(value) === null) return '—'
  return Math.round(value).toLocaleString('zh-CN')
}

export function fmtBytes(value) {
  const size = num(value)
  if (size === null) return '—'
  if (size < 1000) return `${size} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let scaled = size / 1000
  let unit = 0
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000
    unit += 1
  }
  return `${scaled.toFixed(scaled < 10 ? 2 : 1)} ${units[unit]}`
}

export function fmtPercent(part, total, digits = 1) {
  const p = num(part)
  const t = num(total)
  if (p === null || t === null || t <= 0) return '—'
  return `${((p / t) * 100).toFixed(digits)}%`
}

export function fmtDuration(ms) {
  const value = num(ms)
  if (value === null) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 90_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes} min ${seconds} s`
}

export function fmtTime(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function fmtHour(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function counters(source) {
  const raw = objectOf(source)
  if (raw === null) return null
  const result = {}
  let reported = false
  for (const key of ['requests', 'succeeded', 'failed', 'canceled', 'active', 'requestBytes', 'responseBytes', 'durationMs']) {
    const value = num(raw[key])
    result[key] = value
    if (value !== null && value > 0) reported = true
  }
  return reported || Object.keys(raw).length > 0 ? result : null
}

/// The server sends either a keyed object or a positional array aligned with
/// `latencyBoundsMs`; both are accepted so the page survives a backend shape change.
function latencyOf(source, labels = LATENCY_LABELS) {
  if (Array.isArray(source)) {
    const counts = source.map((value) => num(value))
    if (counts.length === 0 || counts.every((value) => value === null)) return null
    return counts.map((count, index) => ({
      key: LATENCY_KEYS[index] ?? `b${index}`,
      label: labels[index] ?? '—',
      mark: LATENCY_MARKS[index] ?? LATENCY_MARKS[LATENCY_MARKS.length - 1],
      count: count ?? 0,
    }))
  }
  const raw = objectOf(source)
  if (raw === null) return null
  const counts = LATENCY_KEYS.map((key) => num(raw[key]))
  if (counts.every((value) => value === null)) return null
  return LATENCY_KEYS.map((key, index) => ({
    key,
    label: labels[index] ?? LATENCY_LABELS[index],
    mark: LATENCY_MARKS[index],
    count: counts[index] ?? 0,
  }))
}

/// A bucket set is reported only when at least one class carries a number. A key
/// the server omits inside a reported set stays unknown: guessing zero is exactly
/// the mistake this page refuses to make.
function statusBucketsOf(source) {
  const raw = objectOf(source)
  if (raw === null) return null
  const rows = STATUS_KEYS.map((key) => ({ key, count: num(raw[key]) }))
  if (rows.every((row) => row.count === null)) return null
  return rows
}

function seriesOf(source) {
  if (!Array.isArray(source)) return null
  const rows = source
    .map((item) => {
      const raw = objectOf(item)
      if (raw === null) return null
      // The server keys a bucket by UTC epoch hour; older builds sent an ISO string.
      const at = typeof raw.hour === 'number' ? new Date(raw.hour * 3_600_000) : new Date(raw.hour)
      if (Number.isNaN(at.getTime())) return null
      return {
        at,
        hour: at.toISOString(),
        requests: num(raw.requests) ?? 0,
        succeeded: num(raw.succeeded) ?? 0,
        failed: num(raw.failed) ?? 0,
        canceled: num(raw.canceled) ?? 0,
        requestBytes: num(raw.requestBytes) ?? 0,
        responseBytes: num(raw.responseBytes) ?? 0,
        durationMs: num(raw.durationMs) ?? 0,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
  // An empty array means the server reported the series but has no buckets yet.
  // Only a missing or malformed field returns null ("not reported").
  return rows
}

/// Bucket labels derived from the server's own bounds, so a boundary change does
/// not leave the page describing buckets the server no longer uses.
export function latencyLabels(bounds) {
  if (!Array.isArray(bounds) || bounds.length === 0) return LATENCY_LABELS
  const edges = bounds.map(num).filter((value) => value !== null).sort((a, b) => a - b)
  if (edges.length === 0) return LATENCY_LABELS
  const label = (ms) => (ms < 1000 ? `${ms} ms` : `${+(ms / 1000).toFixed(1)} s`)
  return [...edges.map((ms) => `< ${label(ms)}`), `≥ ${label(edges[edges.length - 1])}`]
}

/// p50/p95 estimated from bucket midpoints. The estimate is only shown when the
/// server sent a histogram, and it says so.
export function percentiles(latency) {
  if (!latency) return null
  const total = sum(latency.map((row) => row.count))
  if (total <= 0) return null
  const pick = (fraction) => {
    const target = total * fraction
    let seen = 0
    for (const row of latency) {
      seen += row.count
      if (seen >= target) return row.mark
    }
    return latency[latency.length - 1].mark
  }
  return { p50: pick(0.5), p95: pick(0.95), samples: total }
}

export function normalizeUser(raw, index, labels = LATENCY_LABELS) {
  const source = objectOf(raw) ?? {}
  const base = counters(source) ?? {
    requests: null, succeeded: null, failed: null, canceled: null, active: null,
    requestBytes: null, responseBytes: null, durationMs: null,
  }
  const nickname = typeof source.nickname === 'string' && source.nickname.length > 0
    ? source.nickname
    : `用户 ${index + 1}`
  const completed = [base.succeeded, base.failed, base.canceled].every((value) => value === null)
    ? null
    : sum([base.succeeded, base.failed, base.canceled])
  const latency = latencyOf(source.latency, labels)
  const headersLatency = latencyOf(source.headersLatency, labels)
  const statusBuckets = statusBucketsOf(source.statusBuckets)
  const kinds = kindsOf(source.kinds)
  const series = seriesOf(source.series)
  const averageMs = completed && completed > 0 && num(base.durationMs) !== null
    ? base.durationMs / completed
    : null
  const headersCovered = headersLatency ? sum(headersLatency.map((row) => row.count)) : null
  // The gap between completed requests and head-wait samples has two causes, and
  // they are not interchangeable: a request that ended before any response head
  // has no measurable wait, and a request recorded before this counter existed
  // has no sample at all. Both are absent, neither is zero.
  const headersGap = completed !== null && headersCovered !== null
    ? Math.max(0, completed - headersCovered)
    : null
  const noResponseCount = statusBuckets
    ? statusBuckets.find((bucket) => bucket.key === 'noResponse')?.count ?? null
    : null
  return {
    nickname,
    ...base,
    completed,
    averageMs,
    successRate: completed && completed > 0 ? (base.succeeded ?? 0) / completed : null,
    latency,
    percentiles: percentiles(latency),
    headersLatency,
    headersCovered,
    headersGap,
    noResponseCount,
    statusBuckets,
    kinds,
    streamed: num(source.streamed),
    buffered: num(source.buffered),
    peakActive: num(source.peakActive),
    lastSeen: typeof source.lastSeen === 'string' ? source.lastSeen : null,
    series,
  }
}

/// Request-path counts. A route the proxy does not know stays visible under its
/// own key rather than being folded into a total that hides it.
function kindsOf(source) {
  const raw = objectOf(source)
  if (raw === null) return null
  const keys = [...KIND_KEYS, ...Object.keys(raw).filter((key) => !KIND_KEYS.includes(key))]
  const rows = keys.map((key) => ({
    key,
    label: KIND_LABELS[key] ?? key,
    count: num(raw[key]),
  }))
  if (rows.every((row) => row.count === null)) return null
  return rows
}

/// Upstream routing is a whole-site view produced by the remote OMP plugin. Its
/// numbers are already formatted by the server ("—" when unavailable), so this
/// reader only groups and never recomputes a value.
const AGGREGATE_GROUPS = [
  { key: 'capacity', label: '容量占用', fields: [
    ['held', '已占用'], ['max', '上限'], ['liveCount', '活跃账号'], ['staleCount', '过期账号'],
  ] },
  { key: 'health', label: '账号健康', fields: [
    ['alive', '可用'], ['cooling', '冷却'], ['busy', '繁忙'], ['total', '账号总数'],
  ] },
  { key: 'affinity', label: '前缀亲和', fields: [
    ['hits', '命中'], ['lookups', '查询'], ['hitRate', '命中率'],
  ] },
  { key: 'proof', label: '并发实证', fields: [
    ['verifiedModels', '已验证模型'],
  ] },
  { key: 'workers', label: '工作进程', fields: [
    ['total', '总数'], ['live', '存活'], ['inFlight', '在途'],
  ] },
]

function metricOf(raw, index) {
  const source = objectOf(raw)
  if (source === null) return null
  const id = typeof source.id === 'string' ? source.id : `#${index + 1}`
  const label = typeof source.label === 'string' ? source.label : id
  // The server formats `value` and uses "—" for unavailable. Accept a number too,
  // so a stricter future server cannot silently render "undefined".
  const value = typeof source.value === 'string'
    ? source.value
    : num(source.value) !== null ? fmtInt(source.value) : '—'
  return {
    id,
    label,
    value,
    exact: typeof source.exact === 'string' ? source.exact : null,
    unit: typeof source.unit === 'string' ? source.unit : null,
    scope: typeof source.scope === 'string' ? source.scope : null,
    window: typeof source.window === 'string' && source.window.length > 0 ? source.window : '全局',
    available: source.available !== false,
    reason: typeof source.reason === 'string' ? source.reason : null,
    tone: typeof source.tone === 'string' ? `tone-${source.tone}` : '',
  }
}

function aggregateOf(source) {
  const raw = objectOf(source)
  if (raw === null) return []
  const groups = []
  for (const group of AGGREGATE_GROUPS) {
    const block = objectOf(raw[group.key])
    if (block === null) continue
    const items = []
    for (const [field, label] of group.fields) {
      const value = num(block[field])
      if (value === null) continue
      items.push({ label, text: fmtInt(value), ratio: null })
    }
    if (groups.length >= 0 && items.length > 0) {
      // A bar is drawn only when the denominator is unambiguous.
      const denominator = { capacity: 'max', health: 'total', workers: 'total' }[group.key]
      if (denominator) {
        const total = num(block[denominator])
        const part = num(block[{ capacity: 'held', health: 'alive', workers: 'live' }[group.key]])
        if (total && total > 0 && part !== null) items[0].ratio = Math.min(1, part / total)
      }
      groups.push({ key: group.key, label: group.label, scope: null, items })
    }
  }
  return groups
}

function tokensOf(tokens) {
  const raw = objectOf(tokens)
  if (raw === null) return null
  // The tiers live under `totals`, next to `coverage`. Reading them from the
  // top level left every token figure blank while the coverage denominator
  // rendered alone, which is exactly the shape that reads as "zero tokens".
  const totals = objectOf(raw.totals) ?? raw
  const tiers = [
    ['uncachedInput', '未缓存输入'],
    ['cachedInput', '缓存输入'],
    ['output', '输出'],
  ].map(([key, label]) => ({ key, label, count: num(totals[key]) })).filter((tier) => tier.count !== null)
  const coverage = objectOf(raw.coverage)
  const complete = coverage ? num(coverage.complete) : null
  const total = coverage ? (num(coverage.total) ?? num(coverage.requests)) : null
  const officialRaw = objectOf(raw.officialValue)
  let official = null
  if (officialRaw) {
    const amount = num(officialRaw.amount) ?? num(officialRaw.value) ?? num(officialRaw.usd)
    if (amount !== null) {
      official = {
        amount,
        currency: typeof officialRaw.currency === 'string' ? officialRaw.currency : 'USD',
        priced: num(officialRaw.pricedModels),
        total: num(officialRaw.totalModels),
      }
    }
  } else if (num(raw.officialValue) !== null) {
    official = { amount: num(raw.officialValue), currency: 'USD', priced: null, total: null }
  }
  if (tiers.length === 0 && complete === null && official === null) return null
  return { tiers, complete, total, official }
}

function textOfMeta(value) {
  if (typeof value === 'string') return value
  if (num(value) !== null) return String(value)
  const raw = objectOf(value)
  if (raw === null) return null
  // `period` is {id, label, nextSwitch:{at,period,label}}; showing only a mode
  // and an availability flag left the current window and its end invisible.
  if (typeof raw.label === 'string') {
    const next = objectOf(raw.nextSwitch)
    const at = next && typeof next.at === 'string' ? fmtTime(next.at) : null
    const name = next && typeof next.label === 'string' ? next.label : null
    const suffix = at === null ? '' : ` · 下次切换 ${at}${name ? `（${name}）` : ''}`
    return raw.label + suffix
  }
  // `catalog` is {ready, workerReady, aggregateReady}: three independent
  // readiness facts, and a partial catalogue is neither ready nor missing.
  if (typeof raw.ready === 'boolean' || typeof raw.aggregateReady === 'boolean') {
    const mark = (flag) => (flag === true ? '就绪' : flag === false ? '未就绪' : '未知')
    return `本地 ${mark(raw.workerReady)} · 聚合 ${mark(raw.aggregateReady)} · 整体 ${mark(raw.ready)}`
  }
  const mode = typeof raw.mode === 'string' ? raw.mode : null
  const available = raw.available === false ? '不可用' : raw.available === true ? '可用' : null
  const parts = [mode, available].filter(Boolean)
  if (parts.length === 0) return null
  const reason = typeof raw.reason === 'string' ? `（${raw.reason}）` : ''
  return parts.join(' · ') + reason
}

export function normalizeRouting(root) {
  const payload = objectOf(root) ?? {}
  const nested = objectOf(payload.routing)
  // A snapshot is read where it actually is: nested for the old call shape, at
  // the top level for the live admin route.
  const source = nested ?? (isSnapshot(payload) || isLegacyEnvelope(payload) ? payload : null)
  if (source === null) return null
  const metrics = metricsOf(source.metrics)
  const byWindow = new Map()
  for (const metric of metrics) {
    const list = byWindow.get(metric.window) ?? []
    list.push(metric)
    byWindow.set(metric.window, list)
  }
  const groups = [...byWindow.entries()].map(([label, items]) => ({ label, items }))
  const meta = [
    ['存储', textOfMeta(source.store)],
    ['时段', textOfMeta(source.period)],
    ['目录', textOfMeta(source.catalog)],
    ['纪元起点', textOfMeta(source.epoch?.since ?? source.epochSince)],
  ].filter(([, value]) => value !== null).map(([label, value]) => ({ label, value }))
  const aggregate = aggregateOf(source.aggregate)
  const tokens = tokensOf(source.tokenTotals ?? source.aggregate?.tokens)
  if (tokens) {
    const items = tokens.tiers.map((tier) => ({
      label: tier.label,
      text: fmtInt(tier.count),
      ratio: null,
    }))
    if (tokens.complete !== null) {
      items.push({
        label: '完整上报',
        text: tokens.total ? `${fmtInt(tokens.complete)} / ${fmtInt(tokens.total)}` : fmtInt(tokens.complete),
        ratio: tokens.total && tokens.total > 0 ? Math.min(1, tokens.complete / tokens.total) : null,
      })
    }
    if (tokens.official) {
      const priced = tokens.official.priced !== null && tokens.official.total !== null
        ? `（${fmtInt(tokens.official.priced)}/${fmtInt(tokens.official.total)} 模型已定价）`
        : ''
      items.push({
        label: '官方价等效',
        text: `≈ ${tokens.official.currency} ${tokens.official.amount.toFixed(2)}${priced}`,
        ratio: null,
      })
    }
    if (items.length > 0) aggregate.push({ key: 'tokens', label: 'token 台账', scope: '全站', items })
  }
  return {
available: source.available !== false,
reason: typeof source.reason === 'string' ? source.reason : null,
meta,
aggregate,
groups,
metrics,
// The three layers the router reports. A missing layer stays null and an
// empty one stays [], so \"no routes\" never merges into \"not reported\".
routes: Array.isArray(source.routes) ? source.routes.map(routeOf).filter(Boolean) : null,
diagnostics: diagnosticsOf(source.diagnostics),
workers: workersOf(source.workers),
capacity: capacityOf(source.capacity),
health: healthOf(source.health),
proof: objectOf(source.proof),
affinity: objectOf(source.affinity),
tokenTotals: tokens,
notices: noticesOf(source.notices),
overview: objectOf(source.overview),
store: objectOf(source.store),
period: objectOf(source.period),
catalog: objectOf(source.catalog),
epoch: objectOf(source.epoch),
snapshotId: typeof source.snapshotId === 'string' ? source.snapshotId : null,
buildVersion: typeof source.buildVersion === 'string' ? source.buildVersion : null,
  }
}

export function normalize(payload) {
  const root = objectOf(payload) ?? {}
  const labels = latencyLabels(root.latencyBoundsMs)
  const users = Array.isArray(root.users) ? root.users.map((raw, index) => normalizeUser(raw, index, labels)) : []
  const global = counters(root.global)
  const store = objectOf(root.store)
  const generatedAt = typeof root.generatedAt === 'string' ? root.generatedAt : null
  return {
    generatedAt,
    store: store && typeof store.mode === 'string'
      ? { mode: store.mode, available: store.available !== false }
      : null,
    global,
    users,
    routing: normalizeRouting(root),
  }
}

/// The global view of one field: server-provided total when present, otherwise
/// the sum over public rows (which is exact, because rows are complete).
export function totalOf(data, key) {
  if (!data) return null
  if (data.global && num(data.global[key]) !== null) return data.global[key]
  const values = data.users.map((user) => user[key]).filter((value) => num(value) !== null)
  return values.length > 0 ? sum(values) : null
}

/// Hourly buckets merged across users, used when the server does not send a
/// global series. Hours with no data are absent, not zero.
export function mergedSeries(data, limit = 24) {
  if (!data) return null
  const map = new Map()
  let reported = false
  for (const user of data.users) {
    if (user.series === null) continue
    reported = true
    for (const point of user.series) {
      const existing = map.get(point.hour)
      if (existing) {
        existing.requests += point.requests
        existing.succeeded += point.succeeded
        existing.failed += point.failed
        existing.canceled += point.canceled
        existing.requestBytes += point.requestBytes
        existing.responseBytes += point.responseBytes
        existing.durationMs += point.durationMs
      } else {
        map.set(point.hour, { ...point })
      }
    }
  }
  // Empty array: the server reported a series and every bucket is outside the
  // window. Null: no user reported a series at all.
  if (!reported) return null
  return [...map.values()].sort((a, b) => a.at - b.at).slice(-limit)
}
// --- schema-3 snapshot -------------------------------------------------
// The remote router sends one snapshot whose top level *is* the view. An
// older build nested it under `routing`, and the thin `/status` projection
// still sends the legacy envelope (aggregate + a metrics array). All three
// are read here; a strong feature decides which, because `metrics` alone
// exists in both shapes.

function isSnapshot(raw) {
  if (Array.isArray(raw.routes)) return true
  if (raw.tokenTotals !== undefined) return true
  // Schema 3 keys metrics by id (an object); the legacy envelope sends an
  // array. That difference is the discriminator.
  return raw.schemaVersion === 3 && objectOf(raw.metrics) !== null
}

function isLegacyEnvelope(raw) {
  if (Array.isArray(raw.metrics)) return true
  if (raw.epochSince !== undefined) return true
  return raw.aggregate !== undefined && raw.users === undefined
}

/// Metrics arrive keyed by id (M01..M27) in schema 3 and as an array in the
/// legacy envelope. Both become one ordered list; a missing id is the key.
function metricsOf(source) {
  if (Array.isArray(source)) return source.map((item, index) => metricOf(item, index)).filter(Boolean)
  const raw = objectOf(source)
  if (raw === null) return []
  return Object.entries(raw)
    .map(([key, value], index) => {
      const item = objectOf(value)
      if (item === null) return null
      return metricOf(item.id ? item : { ...item, id: key }, index)
    })
    .filter(Boolean)
}

function metricMapOf(source) {
  const out = {}
  const raw = objectOf(source)
  if (raw === null) return out
  for (const [key, value] of Object.entries(raw)) {
    const item = objectOf(value)
    if (item === null) continue
    const metric = metricOf(item.id ? item : { ...item, id: key }, 0)
    if (metric !== null) out[key] = metric
  }
  return out
}

const ROUTE_OPS = {
  rating: '按总耗时评分 · 带温度探索',
  fallback: '严格有序的后备链',
  random: '温度随机分配',
  model: '单一模型通道',
  op: '组合算子',
}

/// The strategy graph is recursive: `model` leaves name one channel, the
/// operator nodes hold their children in evaluation order.
function graphOf(source) {
  const raw = objectOf(source)
  if (raw === null) return null
  const type = typeof raw.type === 'string' ? raw.type : 'op'
  const children = Array.isArray(raw.children) ? raw.children.map(graphOf).filter(Boolean) : []
  const name = typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : null
  const model = typeof raw.model === 'string' ? raw.model : null
  return {
    type,
    label: type === 'model'
      ? name ?? model ?? '未知模型'
      : name ?? ROUTE_OPS[type] ?? '未知策略',
    model: type === 'model' ? model ?? name : null,
    tier: typeof raw.tier === 'string' ? raw.tier : null,
    effort: typeof raw.effort === 'string' ? raw.effort : null,
    offPeakOnly: raw.offPeakOnly === true,
    children,
  }
}

const HEALTH_LABELS = { alive: '可用', cooling: '冷却', busy: '繁忙', unknown: '待检查' }

/// One account under one model. `unitRef` is a one-way handle; the page shows
/// `displayName` and never promotes the handle into a name.
function unitOf(raw) {
  const source = objectOf(raw)
  if (source === null) return null
  const health = HEALTH_LABELS[source.health] ? source.health : 'unknown'
  const capacity = objectOf(source.capacity)
  return {
    unitRef: typeof source.unitRef === 'string' ? source.unitRef : null,
    displayName: typeof source.displayName === 'string' && source.displayName.length > 0
      ? source.displayName
      : '未知账号',
    provider: typeof source.provider === 'string' ? source.provider : null,
    model: typeof source.model === 'string' ? source.model : null,
    health,
    healthLabel: typeof source.healthLabel === 'string' ? source.healthLabel : HEALTH_LABELS[health],
    metrics: metricMapOf(source.metrics),
    capacity: capacity === null ? null : {
      held: num(capacity.held),
      max: num(capacity.max),
      scope: typeof capacity.scope === 'string' ? capacity.scope : null,
      stale: capacity.stale === true,
      updatedAt: typeof capacity.updatedAt === 'string' ? capacity.updatedAt : null,
    },
    reason: typeof source.reason === 'string' ? source.reason : null,
    nextProbeAt: typeof source.nextProbeAt === 'string' ? source.nextProbeAt : null,
    coolingSince: typeof source.coolingSince === 'string' ? source.coolingSince : null,
    stale: source.stale === true,
  }
}

/// One model channel: its own metrics (M13..M19) plus the accounts serving it.
function channelOf(raw) {
  const source = objectOf(raw)
  if (source === null) return null
  const units = Array.isArray(source.units) ? source.units.map(unitOf).filter(Boolean) : []
  const alive = units.filter((unit) => unit.health === 'alive').length
  return {
    id: typeof source.id === 'string' ? source.id : null,
    model: typeof source.model === 'string' && source.model.length > 0 ? source.model : '未知模型',
    effort: typeof source.effort === 'string' && source.effort.length > 0 ? source.effort : '—',
    available: num(source.available) ?? alive,
    totalUnits: num(source.totalUnits) ?? units.length,
    metrics: metricMapOf(source.perf),
    units,
  }
}

function routeOf(raw) {
  const source = objectOf(raw)
  if (source === null) return null
  const graph = graphOf(source.graph)
  const channels = Array.isArray(source.channels) ? source.channels.map(channelOf).filter(Boolean) : []
  const available = num(source.available) ?? channels.reduce((total, channel) => total + channel.available, 0)
  const totalUnits = num(source.totalUnits) ?? channels.reduce((total, channel) => total + channel.totalUnits, 0)
  const id = typeof source.id === 'string' ? source.id : '—'
  return {
    id,
    title: typeof source.title === 'string' && source.title.length > 0 ? source.title : id,
    state: ['loading', 'empty', 'alive', 'cooling'].includes(source.state)
      ? source.state
      : available > 0 ? 'alive' : 'cooling',
    available,
    totalUnits,
    strategy: typeof source.strategy === 'string' && source.strategy.length > 0
      ? source.strategy
      : graph ? ROUTE_OPS[graph.type] ?? '未知策略' : '未知策略',
    graph,
    channels,
  }
}

function diagnosticsOf(source) {
  const raw = objectOf(source)
  if (raw === null) return null
  return {
    windowMinutes: num(raw.windowMinutes),
    available: raw.available !== false,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    rows: Array.isArray(raw.rows)
      ? raw.rows.map((item) => {
          const row = objectOf(item)
          if (row === null) return null
          return {
            model: typeof row.model === 'string' ? row.model : '—',
            complete: num(row.completeSamples),
            imputed: num(row.imputedSamples),
            legacyMixed: num(row.legacyMixedSamples),
            meanMs: num(row.meanTotalMs),
            meanText: typeof row.meanTotalText === 'string' ? row.meanTotalText : null,
            ttft: num(row.ttftSamples),
            speed: num(row.speedSamples),
            tokensPerSecond: num(row.tokensPerSecond),
          }
        }).filter(Boolean)
      : null,
  }
}

function workersOf(source) {
  if (!Array.isArray(source)) return null
  return source.map((item, index) => {
    const raw = objectOf(item)
    if (raw === null) return null
    return {
      worker: typeof raw.worker === 'string' ? raw.worker : `worker ${index + 1}`,
      answeredBy: typeof raw.answeredBy === 'string' ? raw.answeredBy : null,
      buildVersion: typeof raw.buildVersion === 'string' ? raw.buildVersion : null,
      inFlight: num(raw.inFlight),
      catalogReady: raw.catalogReady === true,
      ageMs: num(raw.ageMs),
      stale: raw.stale === true,
      metric: objectOf(raw.metric) === null ? null : metricOf(raw.metric, 0),
    }
  }).filter(Boolean)
}

function capacityOf(source) {
  const raw = objectOf(source)
  if (raw === null) return null
  return {
    available: raw.available !== false,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    liveCount: num(raw.liveCount),
    staleCount: num(raw.staleCount),
    rows: Array.isArray(raw.rows)
      ? raw.rows.map((item) => {
          const row = objectOf(item)
          if (row === null) return null
          return {
            displayName: typeof row.displayName === 'string'
              ? row.displayName
              : typeof row.unitRef === 'string' ? row.unitRef : '—',
            provider: typeof row.provider === 'string' ? row.provider : null,
            model: typeof row.model === 'string' ? row.model : null,
            scope: typeof row.scope === 'string' ? row.scope : null,
            held: num(row.held),
            max: num(row.max),
            worker: typeof row.worker === 'string' ? row.worker : null,
            ageMs: num(row.ageMs),
            stale: row.stale === true,
          }
        }).filter(Boolean)
      : null,
  }
}

function healthOf(source) {
  const raw = objectOf(source)
  if (raw === null) return null
  return {
    available: raw.available !== false,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    rows: Array.isArray(raw.rows)
      ? raw.rows.map((item) => {
          const row = objectOf(item)
          if (row === null) return null
          const health = typeof row.health === 'string'
            ? row.health
            : typeof row.state === 'string' ? row.state : 'unknown'
          return {
            displayName: typeof row.displayName === 'string'
              ? row.displayName
              : typeof row.unitRef === 'string' ? row.unitRef : '—',
            provider: typeof row.provider === 'string' ? row.provider : null,
            model: typeof row.model === 'string' ? row.model : null,
            health,
            healthLabel: HEALTH_LABELS[health] ?? health,
            reason: typeof row.reason === 'string' ? row.reason : null,
            nextProbeAt: typeof row.nextProbeAt === 'string' ? row.nextProbeAt : null,
            ageMs: num(row.ageMs),
          }
        }).filter(Boolean)
      : null,
  }
}

function noticesOf(source) {
  if (!Array.isArray(source)) return null
  return source.map((item) => {
    const raw = objectOf(item)
    if (raw === null) return null
    const message = typeof raw.message === 'string' ? raw.message : null
    if (message === null) return null
    return {
      level: typeof raw.level === 'string' ? raw.level : 'info',
      code: typeof raw.code === 'string' ? raw.code : null,
      title: typeof raw.title === 'string' ? raw.title : null,
      message,
      action: typeof raw.action === 'string' ? raw.action : null,
    }
  }).filter(Boolean)
}


// -------------------------------------------------------------------------
// Whole-site view of the public report. The same rule holds here: a value no
// row reported stays null, because an empty sum reads as a real zero.

function mergedHistogram(users, pick) {
  let base = null
  const counts = new Map()
  for (const user of users) {
    const rows = pick(user)
    if (!Array.isArray(rows) || rows.length === 0) continue
    if (base === null) base = rows
    for (const row of rows) {
      const value = num(row.count)
      if (value === null) continue
      counts.set(row.key, (counts.get(row.key) ?? 0) + value)
    }
  }
  if (base === null) return null
  return base.map((row) => ({
    key: row.key,
    label: row.label,
    mark: num(row.mark),
    count: counts.has(row.key) ? counts.get(row.key) : null,
  }))
}

function mergedSum(users, key) {
  let reported = false
  let total = 0
  for (const user of users) {
    const value = num(user[key])
    if (value === null) continue
    reported = true
    total += value
  }
  return reported ? total : null
}

/// The site-wide view. Histograms are summed per bucket; a bucket no row
/// reported stays null. Concurrency peaks are not additive, so the site value
/// is the largest single-user peak and nothing more.
export function aggregateReportStats(data) {
  const users = data && Array.isArray(data.users) ? data.users : []
  const completed = mergedSum(users, 'completed')
  const succeeded = mergedSum(users, 'succeeded')
  const durationMs = mergedSum(users, 'durationMs')
  let peakActive = null
  let lastSeen = null
  for (const user of users) {
    const peak = num(user.peakActive)
    if (peak !== null) peakActive = peakActive === null ? peak : Math.max(peakActive, peak)
    const seen = typeof user.lastSeen === 'string' ? user.lastSeen : null
    if (seen !== null && (lastSeen === null || seen > lastSeen)) lastSeen = seen
  }
  const latency = mergedHistogram(users, (user) => user.latency)
  return {
    users: users.length,
    requests: mergedSum(users, 'requests'),
    succeeded,
    failed: mergedSum(users, 'failed'),
    canceled: mergedSum(users, 'canceled'),
    active: mergedSum(users, 'active'),
    completed,
    requestBytes: mergedSum(users, 'requestBytes'),
    responseBytes: mergedSum(users, 'responseBytes'),
    durationMs,
    averageMs: completed && completed > 0 && durationMs !== null ? durationMs / completed : null,
    successRate: completed && completed > 0 && succeeded !== null ? succeeded / completed : null,
    streamed: mergedSum(users, 'streamed'),
    buffered: mergedSum(users, 'buffered'),
    peakActive,
    lastSeen,
    latency,
    headersLatency: mergedHistogram(users, (user) => user.headersLatency),
    statusBuckets: mergedHistogram(users, (user) => user.statusBuckets),
    kinds: mergedHistogram(users, (user) => user.kinds),
    percentiles: percentiles(latency),
  }
}

export const SORT_COLUMNS = [
  { key: 'requests', label: '请求数' },
  { key: 'failed', label: '失败数' },
  { key: 'averageMs', label: '平均耗时' },
  { key: 'p95', label: 'p95 估算' },
  { key: 'traffic', label: '总流量' },
  { key: 'lastSeen', label: '最近活动' },
  { key: 'nickname', label: '昵称' },
]

function trafficOf(user) {
  const parts = [user.requestBytes, user.responseBytes].filter((value) => num(value) !== null)
  return parts.length > 0 ? sum(parts) : null
}

function sortValue(user, key) {
  if (key === 'nickname') return typeof user.nickname === 'string' ? user.nickname : null
  if (key === 'lastSeen') return typeof user.lastSeen === 'string' ? user.lastSeen : null
  if (key === 'traffic') return trafficOf(user)
  if (key === 'p95') return user.percentiles ? num(user.percentiles.p95) : null
  return num(user[key])
}

/// Unknown values sort last in both directions: a row that reported nothing is
/// neither the best nor the worst. Ties keep their incoming order.
export function sortUsers(users, key, direction = 'desc') {
  const list = Array.isArray(users) ? users : []
  const sign = direction === 'asc' ? 1 : -1
  return list
    .map((user, index) => ({ user, index, value: sortValue(user, key) }))
    .sort((left, right) => {
      if (left.value === null && right.value === null) return left.index - right.index
      if (left.value === null) return 1
      if (right.value === null) return -1
      const order = typeof left.value === 'string'
        ? left.value.localeCompare(right.value, 'zh-CN')
        : left.value - right.value
      return order === 0 ? left.index - right.index : sign * order
    })
    .map((entry) => entry.user)
}

export const FILTER_MODES = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'failing', label: '有失败' },
]

export function filterUsers(users, { query = '', mode = 'all' } = {}) {
  const list = Array.isArray(users) ? users : []
  const needle = String(query ?? '').trim().toLocaleLowerCase('zh-CN')
  return list.filter((user) => {
    const nickname = String(user.nickname ?? '').toLocaleLowerCase('zh-CN')
    if (needle.length > 0 && !nickname.includes(needle)) return false
    if (mode === 'active') return (num(user.active) ?? 0) > 0
    if (mode === 'failing') return (num(user.failed) ?? 0) > 0
    return true
  })
}

/// Hourly buckets merged across users, with the rates a chart needs. A bucket
/// that completed nothing has no rate: null, never 0%.
export function buildHourlySeries(users, limit = 24) {
  const list = Array.isArray(users) ? users : []
  const map = new Map()
  let reported = false
  for (const user of list) {
    if (!Array.isArray(user.series)) continue
    reported = true
    for (const point of user.series) {
      const existing = map.get(point.hour)
      if (existing) {
        existing.requests += point.requests
        existing.succeeded += point.succeeded
        existing.failed += point.failed
        existing.canceled += point.canceled
        existing.requestBytes += point.requestBytes
        existing.responseBytes += point.responseBytes
        existing.durationMs += point.durationMs
      } else {
        map.set(point.hour, { ...point })
      }
    }
  }
  if (!reported) return null
  return [...map.values()]
    .map((point) => {
      const completed = point.succeeded + point.failed + point.canceled
      return {
        ...point,
        completed,
        traffic: point.requestBytes + point.responseBytes,
        successRate: completed > 0 ? point.succeeded / completed : null,
        averageMs: completed > 0 ? point.durationMs / completed : null,
      }
    })
    .sort((left, right) => left.at - right.at)
    .slice(-limit)
}

const CSV_COLUMNS = [
  'nickname', 'requests', 'succeeded', 'failed', 'canceled', 'active', 'completed',
  'successRatePct', 'averageMs', 'p50Ms', 'p95Ms', 'requestBytes', 'responseBytes',
  'streamed', 'buffered', 'peakActive', 'lastSeen',
]

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/// One flat sheet of the public report. An unknown value is an empty cell, not
/// a zero a spreadsheet would average into the total.
export function reportToCsv(data) {
  const users = data && Array.isArray(data.users) ? data.users : []
  const lines = [CSV_COLUMNS.join(',')]
  for (const user of users) {
    const own = user.percentiles
    lines.push([
      user.nickname,
      user.requests,
      user.succeeded,
      user.failed,
      user.canceled,
      user.active,
      user.completed,
      num(user.successRate) === null ? null : user.successRate * 100,
      user.averageMs,
      own ? own.p50 : null,
      own ? own.p95 : null,
      user.requestBytes,
      user.responseBytes,
      user.streamed,
      user.buffered,
      user.peakActive,
      user.lastSeen,
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

