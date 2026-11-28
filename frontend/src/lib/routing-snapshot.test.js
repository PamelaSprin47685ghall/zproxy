import { describe, expect, test } from 'bun:test'
import { normalize, normalizeRouting } from './data.js'

const base = {
  generatedAt: '2026-11-28T00:00:00Z',
  latencyBoundsMs: [100, 500, 1000, 5000, 30000],
  users: [{ nickname: 'ada', requests: 4, succeeded: 3, failed: 1, canceled: 0 }],
}

const snapshot = {
  schemaVersion: 3,
  snapshotId: 's-1',
  buildVersion: 'test',
  store: { mode: 'sqlite', available: true },
  period: { id: 'peak', label: '高峰时段' },
  catalog: { ready: true, workerReady: true, aggregateReady: true },
  epoch: { id: 'e1', since: '2026-11-01T00:00:00Z' },
  metrics: {
    M01: { id: 'M01', label: '当前时段', value: '高峰时段', window: '当前时段', available: true },
    M06: { label: '路由/模型', value: '1 条路由 · 2 个模型', window: '全局', available: true },
  },
  routes: [{
    id: 'main', title: '主力路由', state: 'alive', available: 1, totalUnits: 2,
    strategy: '按总耗时评分 · 带温度探索',
    graph: { type: 'rating', label: '按总耗时评分 · 带温度探索', children: [
      { type: 'model', model: 'gpt-x', effort: 'high', tier: 'premium' },
      { type: 'model', model: 'gpt-y' },
    ] },
    channels: [{
      id: 'main|gpt-x', model: 'gpt-x', effort: 'high', available: 1, totalUnits: 2,
      perf: { M13: { id: 'M13', label: '预测总耗时', value: '2.5 s', available: true } },
      units: [
        { unitRef: 'u_aaaaaaaaaaaaaaaa', displayName: 'provider-a', health: 'alive', capacity: { held: 1, max: 8, scope: 'unit' } },
        { unitRef: 'u_bbbbbbbbbbbbbbbb', displayName: 'provider-b', health: 'cooling', healthLabel: '冷却', reason: '429', capacity: null },
      ],
    }],
  }],
  diagnostics: { windowMinutes: 30, available: true, rows: [
    { model: 'gpt-x', completeSamples: 9, imputedSamples: 2, meanTotalMs: 1200, ttftSamples: 7, speedSamples: 5, tokensPerSecond: 88.5 },
  ] },
  workers: [{ worker: 'w1', inFlight: 3, ageMs: 1200, stale: false }],
  capacity: { available: true, liveCount: 1, rows: [{ displayName: 'provider-a', held: 1, max: 8, model: 'gpt-x' }] },
  health: { available: true, rows: [{ displayName: 'provider-b', health: 'cooling', reason: '429' }] },
  proof: { available: true, byModel: { 'gpt-x': { verified: 3 } } },
  affinity: { available: true, hits: 5, lookups: 10, hitRate: 0.5 },
  tokenTotals: { available: true, totals: { uncachedInput: 100, cachedInput: 50, output: 25 } },
  notices: [{ level: 'warning', code: 'worker_stale', title: '进程过期', message: '心跳过期', action: null }],
}

describe('routing: schema-3 snapshot at the top level', () => {
  test('an unnested snapshot is read as routing instead of being dropped', () => {
    const routing = normalize({ ...base, ...snapshot }).routing
    expect(routing).not.toBeNull()
    expect(routing.metrics.map((item) => item.id)).toEqual(['M01', 'M06'])
    expect(routing.meta.map((item) => item.label)).toEqual(['存储', '时段', '目录', '纪元起点'])
    expect(routing.snapshotId).toBe('s-1')
  })

  test('each route keeps its strategy graph, model channels and account units', () => {
    const [route] = normalize({ ...base, ...snapshot }).routing.routes
    expect(route.title).toBe('主力路由')
    expect(route.strategy).toBe('按总耗时评分 · 带温度探索')
    expect(route.graph.children.map((node) => node.label)).toEqual(['gpt-x', 'gpt-y'])
    expect(route.graph.children[0].effort).toBe('high')
    const [channel] = route.channels
    expect(channel.model).toBe('gpt-x')
    expect(channel.metrics.M13.value).toBe('2.5 s')
    expect(channel.units.map((unit) => unit.displayName)).toEqual(['provider-a', 'provider-b'])
    expect(channel.units[1].healthLabel).toBe('冷却')
    expect(channel.units[1].reason).toBe('429')
    expect(channel.units[0].capacity.held).toBe(1)
  })

  test('diagnostics, processes, leases and notices survive the mapping', () => {
    const routing = normalize({ ...base, ...snapshot }).routing
    expect(routing.diagnostics.rows[0]).toMatchObject({ model: 'gpt-x', complete: 9, imputed: 2, tokensPerSecond: 88.5 })
    expect(routing.workers[0]).toMatchObject({ worker: 'w1', inFlight: 3, stale: false })
    expect(routing.capacity.rows[0]).toMatchObject({ displayName: 'provider-a', held: 1, max: 8 })
    expect(routing.health.rows[0]).toMatchObject({ displayName: 'provider-b', healthLabel: '冷却' })
    expect(routing.notices[0]).toMatchObject({ level: 'warning', message: '心跳过期' })
    expect(routing.tokenTotals.tiers.map((tier) => tier.label)).toEqual(['未缓存输入', '缓存输入', '输出'])
  })

  test('a missing route list is null and an empty one is empty', () => {
    expect(normalize({ ...base, ...snapshot, routes: undefined }).routing.routes).toBeNull()
    expect(normalize({ ...base, ...snapshot, routes: [] }).routing.routes).toEqual([])
  })

  test('the one-way unit handle never replaces the display name', () => {
    const routing = normalize({ ...base, ...snapshot }).routing
    const names = routing.routes.flatMap((route) => route.channels.flatMap((channel) => channel.units.map((unit) => unit.displayName)))
    expect(names.join(' ')).not.toContain('u_')
  })
})

describe('routing: the legacy envelope is still readable', () => {
  const legacy = {
    available: true, epochSince: 1_763_000_000, schemaVersion: 2,
    metrics: [{ id: 'M01', label: '当前时段', value: '高峰时段' }],
    aggregate: { capacity: { held: 1, max: 2 } },
  }

  test('a metrics array at the top level is not mistaken for schema 3', () => {
    const routing = normalize({ ...base, ...legacy }).routing
    expect(routing).not.toBeNull()
    expect(routing.routes).toBeNull()
    expect(routing.metrics).toHaveLength(1)
    expect(routing.aggregate.find((group) => group.key === 'capacity')).toBeDefined()
  })

  test('a report that is only user rows has no routing block', () => {
    expect(normalize(base).routing).toBeNull()
  })

  test('the nested call shape keeps working', () => {
    const routing = normalizeRouting({ routing: { available: false, reason: '共享存储不可用' } })
    expect(routing.available).toBe(false)
    expect(routing.reason).toBe('共享存储不可用')
  })
})
