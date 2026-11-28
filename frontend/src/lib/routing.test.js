import { describe, expect, test } from 'bun:test'
import { normalize, normalizeRouting } from './data.js'

const base = {
  generatedAt: '2026-11-25T10:00:00Z',
  latencyBoundsMs: [100, 500, 1000, 5000, 30000],
  users: [{ nickname: 'ada', requests: 4, succeeded: 3, failed: 1, canceled: 0, active: 0,
            requestBytes: 10, responseBytes: 20, durationMs: 400, latency: [1, 1, 1, 1, 0, 0], series: [] }],
}

const metric = (id, label, value, extra = {}) => ({
  id, label, value, unit: 'count', scope: 'site', window: '当前时段',
  available: true, tone: 'ok', ...extra,
})

describe('routing: absence and unavailability are different states', () => {
  test('no routing object means not reported', () => {
    expect(normalize(base).routing).toBeNull()
  })

  test('available:false keeps the block and carries the reason', () => {
    const page = normalize({
      ...base,
      routing: { available: false, reason: '共享存储不可用', metrics: [metric('M01', '当前时段', '—', { available: false, reason: '无快照' })] },
    })
    expect(page.routing.available).toBe(false)
    expect(page.routing.reason).toBe('共享存储不可用')
    expect(page.routing.metrics).toHaveLength(1)
    expect(page.routing.metrics[0].value).toBe('—')
    expect(page.routing.metrics[0].available).toBe(false)
    expect(page.routing.metrics[0].reason).toBe('无快照')
  })

  test('an unavailable metric keeps the server dash; it never becomes 0', () => {
    const page = normalize({ ...base, routing: { available: true, metrics: [metric('M08', '未缓存输入', '—', { available: false })] } })
    expect(page.routing.metrics[0].value).toBe('—')
  })
})

describe('routing: metric grouping', () => {
  test('groups by window and preserves server order inside a window', () => {
    const page = normalize({ ...base, routing: { available: true, metrics: [
      metric('M01', '当前时段', '12:00-14:00'),
      metric('M02', '下次切换', '14:00'),
      metric('M08', '未缓存输入', '1.2M', { window: '纪元' }),
    ] } })
    expect(page.routing.groups.map((g) => g.label)).toEqual(['当前时段', '纪元'])
    expect(page.routing.groups[0].items.map((i) => i.id)).toEqual(['M01', 'M02'])
  })

  test('a metric without a window is filed as global, not dropped', () => {
    const page = normalize({ ...base, routing: { available: true, metrics: [{ id: 'M27', label: '快照', value: '3 秒前' }] } })
    expect(page.routing.groups[0].label).toBe('全局')
    expect(page.routing.metrics[0].available).toBe(true)
  })

  test('a numeric value is formatted instead of rendered as undefined', () => {
    expect(normalizeRouting({ routing: { metrics: [{ id: 'M06', label: '路由数', value: 1234 }] } })
      .metrics[0].value).toBe('1,234')
  })
})

describe('routing: aggregate and token ledger', () => {
  test('capacity draws a ratio only from an unambiguous denominator', () => {
    const page = normalize({ ...base, routing: { aggregate: { capacity: { held: 6, max: 8, liveCount: 3, staleCount: 1 } } } })
    const group = page.routing.aggregate.find((g) => g.key === 'capacity')
    expect(group.items.map((i) => i.label)).toEqual(['已占用', '上限', '活跃账号', '过期账号'])
    expect(group.items[0].ratio).toBeCloseTo(0.75)
  })

  test('a zero denominator draws no bar rather than a full one', () => {
    const page = normalize({ ...base, routing: { aggregate: { capacity: { held: 0, max: 0 } } } })
    expect(page.routing.aggregate[0].items[0].ratio).toBeNull()
  })

  test('token tiers travel with their completeness denominator', () => {
    const page = normalize({ ...base, routing: { aggregate: { tokens: {
      uncachedInput: 1000, cachedInput: 5000, output: 800,
      coverage: { complete: 7, total: 9 },
      officialValue: { amount: 1.25, currency: 'USD', pricedModels: 2, totalModels: 3 },
    } } } })
    const tokens = page.routing.aggregate.find((g) => g.key === 'tokens')
    const labels = tokens.items.map((i) => i.label)
    expect(labels).toEqual(['未缓存输入', '缓存输入', '输出', '完整上报', '官方价等效'])
    expect(tokens.items[3].text).toBe('7 / 9')
    expect(tokens.items[3].ratio).toBeCloseTo(7 / 9)
    expect(tokens.items[4].text).toBe('≈ USD 1.25（2/3 模型已定价）')
  })

  test('a token block with only counts still shows the counts, with no invented coverage', () => {
    const page = normalize({ ...base, routing: { aggregate: { tokens: { output: 42 } } } })
    const tokens = page.routing.aggregate.find((g) => g.key === 'tokens')
    expect(tokens.items.map((i) => i.label)).toEqual(['输出'])
  })

  test('an empty aggregate block is omitted entirely', () => {
    expect(normalize({ ...base, routing: { aggregate: {} } }).routing.aggregate).toEqual([])
  })

  test('unknown aggregate keys are ignored instead of rendered raw', () => {
    const page = normalize({ ...base, routing: { aggregate: { mystery: { foo: 1 } } } })
    expect(page.routing.aggregate).toEqual([])
  })
})

describe('routing: metadata strip', () => {
  test('string and object metadata both become one readable line', () => {
    const page = normalize({ ...base, routing: {
      store: { mode: 'sqlite', available: true },
      period: '当前时段 12:00-14:00',
      epochSince: 1_763_000_000,
    } })
    expect(page.routing.meta).toEqual([
      { label: '存储', value: 'sqlite · 可用' },
      { label: '时段', value: '当前时段 12:00-14:00' },
      { label: '纪元起点', value: '1763000000' },
    ])
  })

  test('missing metadata produces no empty rows', () => {
    expect(normalize({ ...base, routing: {} }).routing.meta).toEqual([])
  })
})

describe('privacy', () => {
  test('routing with an internal identifier never reaches the nickname', () => {
    const page = normalize({ ...base, routing: { aggregate: { capacity: { held: 1, max: 2 } } } })
    expect(JSON.stringify(page.users)).not.toContain('routing')
    expect(JSON.stringify(page.routing)).not.toContain('ada')
  })
})

describe('routing: structured sections', () => {
  test('store, epoch and workers keep their own shapes', () => {
    const page = normalize({ ...base, routing: {
      store: { mode: 'sqlite', available: false, reason: '共享存储不可用' },
      epoch: { id: 'e1', since: '2026-11-01T00:00:00Z' },
      workers: [
        { id: 'w1', inFlight: 3, heartbeatMs: 1200, stale: false },
        { inFlight: null, heartbeatMs: null, stale: true },
      ],
    } })
    expect(page.routing.store).toEqual({ mode: 'sqlite', available: false, reason: '共享存储不可用' })
    expect(page.routing.epoch).toEqual({ id: 'e1', since: '2026-11-01T00:00:00Z' })
    expect(page.routing.workers[0]).toMatchObject({ id: 'w1', inFlight: 3, heartbeatMs: 1200, stale: false })
    expect(page.routing.workers[1].id).toBe('worker 2')
    expect(page.routing.workers[1].inFlight).toBeNull()
  })

  test('an absent section is null, an empty one is empty', () => {
    const page = normalize({ ...base, routing: {} })
    expect(page.routing.store).toBeNull()
    expect(page.routing.epoch).toBeNull()
    expect(page.routing.workers).toBeNull()
    expect(page.routing.capacity).toBeNull()
    expect(page.routing.health).toBeNull()
    expect(page.routing.routes).toBeNull()
    expect(page.routing.diagnostics).toBeNull()
    expect(page.routing.notices).toBeNull()
    expect(page.routing.tokenModels).toBeNull()
    const empty = normalize({ ...base, routing: { workers: [], routes: [], notices: [] } }).routing
    expect(empty.workers).toEqual([])
    expect(empty.routes).toEqual([])
    expect(empty.notices).toEqual([])
  })

  test('capacity and health rows keep every scalar cell under a label', () => {
    const page = normalize({ ...base, routing: {
      capacity: { rows: [{ account: 'acc-1', held: 3, maxInFlight: 8 }] },
      health: { rows: [{ account: 'acc-1', state: 'cooling', nextProbeIn: 42, coolingReason: '429' }] },
    } })
    const [capacity] = page.routing.capacity
    expect(capacity.name).toBe('acc-1')
    expect(capacity.cells.map((cell) => cell.label)).toEqual(['账号', '已占用', '并发上限'])
    expect(capacity.cells[1].text).toBe('3')
    const [health] = page.routing.health
    expect(health.cells.find((cell) => cell.key === 'state').text).toBe('cooling')
    expect(health.cells.find((cell) => cell.key === 'nextProbeIn').text).toBe('42')
    expect(health.cells.find((cell) => cell.key === 'coolingReason').text).toBe('429')
  })

  test('routes carry status, strategy and per-channel rows', () => {
    const page = normalize({ ...base, routing: { routes: [
      { id: 'openai', status: '可用', tone: 'positive', strategy: 'round-robin', accounts: 4, channels: [
        { model: 'gpt-x', state: 'live', tone: 'positive' },
        { model: 'gpt-y', state: 'cooling', detail: '5 分钟后重试' },
      ] },
    ] } })
    const [route] = page.routing.routes
    expect(route.id).toBe('openai')
    expect(route.tone).toBe('tone-positive')
    expect(route.accounts).toBe(4)
    expect(route.channels.map((channel) => channel.model)).toEqual(['gpt-x', 'gpt-y'])
    expect(route.channels[1]).toMatchObject({ state: 'cooling', detail: '5 分钟后重试' })
  })

  test('diagnostics keep censored samples apart from complete ones', () => {
    const page = normalize({ ...base, routing: { diagnostics: { available: true, windowMinutes: 30, rows: [
      { model: 'gpt-x', completeSamples: 9, censoredSamples: 2, meanDurationMs: 1200, ttftSamples: 7, speedSamples: 5, tokensPerSecond: 88.5 },
    ] } } })
    const diagnostics = page.routing.diagnostics
    expect(diagnostics.windowMinutes).toBe(30)
    expect(diagnostics.rows[0]).toMatchObject({
      model: 'gpt-x', complete: 9, censored: 2, durationMs: 1200,
      ttft: 7, speed: 5, tokensPerSecond: 88.5,
    })
  })

  test('an unavailable diagnostics block keeps no rows and no invented zeroes', () => {
    const diagnostics = normalize({ ...base, routing: { diagnostics: { available: false, windowMinutes: 30 } } }).routing.diagnostics
    expect(diagnostics.available).toBe(false)
    expect(diagnostics.rows).toBeNull()
  })

  test('the token price table keeps amount, basis and priced flags', () => {
    const page = normalize({ ...base, routing: { tokenTotals: { officialValue: { currency: 'USD', models: [
      { model: 'gpt-x', amount: 1.5, basis: 'input+output' },
      { model: 'gpt-z', amount: null, priced: false },
    ] } } } })
    expect(page.routing.tokenModels[0]).toMatchObject({
      model: 'gpt-x', amount: 1.5, currency: 'USD', basis: 'input+output', priced: true,
    })
    expect(page.routing.tokenModels[1]).toMatchObject({ model: 'gpt-z', amount: null, priced: false })
  })

  test('notices keep their level and message', () => {
    const page = normalize({ ...base, routing: { notices: [{ level: 'warning', message: '共享存储降级' }] } })
    expect(page.routing.notices).toEqual([{ level: 'warning', message: '共享存储降级' }])
  })
})
