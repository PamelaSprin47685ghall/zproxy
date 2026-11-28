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
