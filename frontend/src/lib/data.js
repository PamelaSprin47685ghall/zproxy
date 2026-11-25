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
  const source = objectOf(root.routing)
  if (source === null) return null
  const metrics = Array.isArray(source.metrics)
    ? source.metrics.map(metricOf).filter(Boolean)
    : []
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
    ['纪元起点', textOfMeta(source.epochSince)],
  ].filter(([, value]) => value !== null).map(([label, value]) => ({ label, value }))
  const aggregate = aggregateOf(source.aggregate)
  const tokens = tokensOf(source.aggregate?.tokens)
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
