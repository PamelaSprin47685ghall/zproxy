import { describe, expect, test } from 'bun:test'
import {
  normalize, normalizeUser, totalOf, mergedSeries, percentiles, latencyLabels,
  fmtBytes, fmtDuration, fmtPercent, aggregateReportStats, sortUsers, filterUsers,
  buildHourlySeries, reportToCsv,
} from './data.js'

const user = (extra = {}) => ({
  nickname: 'ada',
  requests: 10, succeeded: 8, failed: 1, canceled: 1, active: 0,
  requestBytes: 1000, responseBytes: 4000, durationMs: 9000,
  latency: [4, 3, 1, 1, 1, 0],
  series: [{ hour: 500000, requests: 2, succeeded: 2, failed: 0, canceled: 0, requestBytes: 10, responseBytes: 20, durationMs: 30 }],
  ...extra,
})

describe('a missing field is not zero', () => {
  test('an absent optional block stays null', () => {
    const page = normalize({ users: [{ nickname: 'ada' }] })
    expect(page.users[0].latency).toBeNull()
    expect(page.users[0].series).toBeNull()
    expect(page.users[0].statusBuckets).toBeNull()
    expect(page.users[0].requests).toBeNull()
  })

  test('an empty series means reported but empty, and is not null', () => {
    const page = normalize({ users: [user({ series: [] })] })
    expect(page.users[0].series).toEqual([])
    expect(mergedSeries(page)).toEqual([])
  })

  test('no user reporting a series keeps the merged view null', () => {
    const page = normalize({ users: [user({ series: undefined })] })
    expect(mergedSeries(page)).toBeNull()
  })
})

describe('hourly series', () => {
  test('accepts the server epoch hour and keeps UTC ordering', () => {
    const page = normalize({
      users: [user({
        series: [
          { hour: 500002, requests: 1, succeeded: 1, failed: 0, canceled: 0, requestBytes: 0, responseBytes: 0, durationMs: 0 },
          { hour: 500000, requests: 2, succeeded: 2, failed: 0, canceled: 0, requestBytes: 0, responseBytes: 0, durationMs: 0 },
        ],
      })],
    })
    const points = page.users[0].series
    expect(points.map((p) => p.at.getTime())).toEqual([500000, 500002].map((h) => h * 3_600_000))
    expect(points[0].hour).toBe(new Date(500000 * 3_600_000).toISOString())
  })

  test('merges buckets across users and drops nothing above the limit', () => {
    const page = normalize({
      users: [
        user({ series: [{ hour: 500000, requests: 2, succeeded: 2, failed: 0, canceled: 0, requestBytes: 5, responseBytes: 6, durationMs: 7 }] }),
        user({ nickname: 'bo', series: [{ hour: 500000, requests: 3, succeeded: 1, failed: 2, canceled: 0, requestBytes: 1, responseBytes: 1, durationMs: 1 }] }),
      ],
    })
    const merged = mergedSeries(page)
    expect(merged).toHaveLength(1)
    expect(merged[0].requests).toBe(5)
    expect(merged[0].failed).toBe(2)
  })
})

describe('latency histogram', () => {
  test('reads the positional array and labels it from the server bounds', () => {
    const page = normalize({ latencyBoundsMs: [100, 500, 1000, 5000, 30000], users: [user()] })
    expect(page.users[0].latency.map((b) => b.label)).toEqual(
      ['< 100 ms', '< 500 ms', '< 1 s', '< 5 s', '< 30 s', '≥ 30 s'],
    )
    expect(page.users[0].percentiles.samples).toBe(10)
  })

  test('coverage counts samples, not completed requests', () => {
    const page = normalize({ users: [user({ latency: [1, 0, 0, 0, 0, 0] })] })
    const covered = page.users[0].percentiles.samples
    expect(covered).toBe(1)
    expect(page.users[0].completed).toBe(10)
    expect(fmtPercent(covered, page.users[0].completed, 1)).toBe('10.0%')
  })

  test('an all-zero histogram has no percentiles', () => {
    const page = normalize({ users: [user({ latency: [0, 0, 0, 0, 0, 0] })] })
    expect(page.users[0].percentiles).toBeNull()
  })

  test('bounds drive the labels, so a boundary change is visible', () => {
    expect(latencyLabels([250, 750])).toEqual(['< 250 ms', '< 750 ms', '≥ 750 ms'])
    expect(latencyLabels(undefined)).toContain('≥ 30 s')
  })

  test('percentiles are bucket midpoints, not exact quantiles', () => {
    const buckets = [
      { count: 50, mark: 50 }, { count: 50, mark: 300 }, { count: 0, mark: 750 },
      { count: 0, mark: 3000 }, { count: 0, mark: 17500 }, { count: 0, mark: 45000 },
    ]
    expect(percentiles(buckets)).toEqual({ p50: 50, p95: 300, samples: 100 })
  })
})

describe('global totals', () => {
  test('prefers a server total over the sum of public rows', () => {
    const page = normalize({ global: { requests: 99, succeeded: 98 }, users: [user(), user({ nickname: 'bo' })] })
    expect(totalOf(page, 'requests')).toBe(99)
    expect(totalOf(page, 'succeeded')).toBe(98)
  })

  test('falls back to summing public rows when no total is sent', () => {
    const page = normalize({ users: [user(), user({ nickname: 'bo' })] })
    expect(totalOf(page, 'requests')).toBe(20)
  })

  test('a total of zero is reported, not replaced by a sum', () => {
    const page = normalize({ global: { requests: 0 }, users: [user()] })
    expect(totalOf(page, 'requests')).toBe(0)
  })
})

describe('status buckets', () => {
  test('a reported bucket set exposes all five classes', () => {
    const page = normalize({ users: [user({ statusBuckets: { '2xx': 7, '4xx': 1, '5xx': 2 } })] })
    expect(page.users[0].statusBuckets.map((b) => b.key)).toEqual(['2xx', '3xx', '4xx', '5xx', 'noResponse'])
    expect(page.users[0].statusBuckets.find((b) => b.key === '3xx').count).toBeNull()
  })

  test('an absent bucket set is null rather than five zeroes', () => {
    const page = normalize({ users: [user()] })
    expect(page.users[0].statusBuckets).toBeNull()
  })
})

describe('formatting', () => {
  test('formats bytes in decimal units with exact small values', () => {
    expect(fmtBytes(999)).toBe('999 B')
    expect(fmtBytes(1500)).toBe('1.50 kB')
    expect(fmtBytes(2_000_000)).toBe('2.00 MB')
    expect(fmtBytes(null)).toBe('—')
  })

  test('formats durations without inventing precision', () => {
    expect(fmtDuration(40)).toBe('40 ms')
    expect(fmtDuration(2500)).toBe('2.50 s')
    expect(fmtDuration(125_000)).toBe('2 min 5 s')
    expect(fmtDuration(null)).toBe('—')
  })

  test('a zero denominator is unknown, not 0%', () => {
    expect(fmtPercent(0, 0)).toBe('—')
    expect(fmtPercent(1, 4, 2)).toBe('25.00%')
  })
})

describe('user normalization', () => {
  test('average duration divides by completed requests only', () => {
    const value = normalizeUser(user({ durationMs: 8000, active: 2 }), 0)
    expect(value.completed).toBe(10)
    expect(value.averageMs).toBe(800)
  })

  test('a nickname is never taken from an internal id', () => {
    const value = normalizeUser({ id: 'uuid-should-not-leak', requests: 1 }, 3)
    expect(value.nickname).toBe('用户 4')
    expect(JSON.stringify(value)).not.toContain('uuid-should-not-leak')
  })
})

describe('head-wait coverage has two distinct causes', () => {
  const buckets = (noResponse) => ({ '2xx': 8, '3xx': 0, '4xx': 0, '5xx': 0, noResponse })

  test('a current-version row explains the gap as unanswered heads', () => {
    const value = normalizeUser(user({
      headersLatency: [5, 3, 0, 0, 0, 0],
      statusBuckets: buckets(2),
      succeeded: 8, failed: 0, canceled: 2, requests: 10,
    }), 0)
    expect(value.completed).toBe(10)
    expect(value.headersCovered).toBe(8)
    expect(value.headersGap).toBe(2)
    expect(value.noResponseCount).toBe(2)
    // Every missing sample is accounted for by an unanswered head: no legacy rows.
    expect(value.headersGap - value.noResponseCount).toBe(0)
  })

  test('a migrated row has no samples at all, which is not "no response head"', () => {
    const value = normalizeUser(user({
      headersLatency: [0, 0, 0, 0, 0, 0],
      statusBuckets: buckets(0),
      succeeded: 10, failed: 0, canceled: 0, requests: 10,
    }), 0)
    expect(value.headersCovered).toBe(0)
    expect(value.headersGap).toBe(10)
    expect(value.noResponseCount).toBe(0)
    // 10 legacy samples with zero unanswered heads: the page must say "before this
    // counter existed", never "ended without a response head".
    expect(value.headersGap - value.noResponseCount).toBe(10)
  })

  test('without status buckets the gap cannot be attributed and stays whole', () => {
    const value = normalizeUser(user({ headersLatency: [4, 0, 0, 0, 0, 0] }), 0)
    expect(value.headersGap).toBe(6)
    expect(value.noResponseCount).toBeNull()
  })

  test('an absent head-wait histogram reports no coverage rather than full coverage', () => {
    const value = normalizeUser(user({ headersLatency: undefined }), 0)
    expect(value.headersCovered).toBeNull()
    expect(value.headersGap).toBeNull()
  })
})

describe('whole-site aggregate over public rows', () => {
  test('sums every reported bucket and leaves an unreported class unknown', () => {
    const page = normalize({
      users: [
        user({ statusBuckets: { '2xx': 8, '4xx': 2 }, latency: [5, 5, 0, 0, 0, 0] }),
        user({ nickname: 'bo', statusBuckets: { '2xx': 1, '5xx': 3 }, latency: [0, 10, 0, 0, 0, 0] }),
      ],
    })
    const stats = aggregateReportStats(page)
    expect(stats.users).toBe(2)
    expect(stats.statusBuckets.find((row) => row.key === '2xx').count).toBe(9)
    expect(stats.statusBuckets.find((row) => row.key === '3xx').count).toBeNull()
    expect(stats.latency.map((row) => row.count)).toEqual([5, 15, 0, 0, 0, 0])
    expect(stats.percentiles.samples).toBe(20)
  })

  test('a histogram nobody reported stays null for the whole site', () => {
    const stats = aggregateReportStats(normalize({
      users: [user({ latency: undefined, statusBuckets: undefined, headersLatency: undefined })],
    }))
    expect(stats.latency).toBeNull()
    expect(stats.statusBuckets).toBeNull()
    expect(stats.percentiles).toBeNull()
  })

  test('rates divide by completed requests, and an idle site has no rate', () => {
    const stats = aggregateReportStats(normalize({ users: [user(), user({ nickname: 'bo' })] }))
    expect(stats.completed).toBe(20)
    expect(stats.successRate).toBeCloseTo(0.8)
    expect(stats.averageMs).toBeCloseTo(900)
    const idle = aggregateReportStats(normalize({ users: [{ nickname: 'idle' }] }))
    expect(idle.successRate).toBeNull()
    expect(idle.averageMs).toBeNull()
  })

  test('per-user concurrency peaks are not added together', () => {
    const stats = aggregateReportStats(normalize({
      users: [user({ peakActive: 3 }), user({ nickname: 'bo', peakActive: 5 })],
    }))
    expect(stats.peakActive).toBe(5)
  })
})

describe('table ordering and filtering', () => {
  const rowsOf = () => normalize({ users: [
    { nickname: 'ada', requests: 10, succeeded: 8, failed: 2, canceled: 0, active: 0, requestBytes: 1000, responseBytes: 4000, durationMs: 5000, latency: [1, 0, 0, 0, 0, 0] },
    { nickname: 'bo', requests: 30, succeeded: 30, failed: 0, canceled: 0, active: 2, requestBytes: 9000, responseBytes: 1000, durationMs: 9000, latency: [0, 0, 0, 1, 0, 0] },
    { nickname: 'cy' },
  ] }).users

  test('unknown values sort last in both directions', () => {
    const rows = rowsOf()
    expect(sortUsers(rows, 'requests', 'desc').map((row) => row.nickname)).toEqual(['bo', 'ada', 'cy'])
    expect(sortUsers(rows, 'requests', 'asc').map((row) => row.nickname)).toEqual(['ada', 'bo', 'cy'])
  })

  test('sorting returns a new list and never reorders the input', () => {
    const rows = rowsOf()
    const before = rows.map((row) => row.nickname)
    sortUsers(rows, 'requests')
    expect(rows.map((row) => row.nickname)).toEqual(before)
  })

  test('filters by nickname and by reported state', () => {
    const rows = rowsOf()
    expect(filterUsers(rows, { query: 'A' }).map((row) => row.nickname)).toEqual(['ada'])
    expect(filterUsers(rows, { mode: 'active' }).map((row) => row.nickname)).toEqual(['bo'])
    expect(filterUsers(rows, { mode: 'failing' }).map((row) => row.nickname)).toEqual(['ada'])
  })
})

describe('hourly rates and csv export', () => {
  test('a rate exists only where the bucket completed work', () => {
    const page = normalize({ users: [user({ series: [
      { hour: 500000, requests: 4, succeeded: 3, failed: 1, canceled: 0, requestBytes: 10, responseBytes: 20, durationMs: 800 },
      { hour: 500001, requests: 2, succeeded: 0, failed: 0, canceled: 0, requestBytes: 5, responseBytes: 5, durationMs: 0 },
    ] })] })
    const points = buildHourlySeries(page.users)
    expect(points[0].successRate).toBeCloseTo(0.75)
    expect(points[0].averageMs).toBe(200)
    expect(points[1].successRate).toBeNull()
    expect(points[1].traffic).toBe(10)
  })

  test('no reported series stays null; a reported empty series stays empty', () => {
    expect(buildHourlySeries(normalize({ users: [user({ series: undefined })] }).users)).toBeNull()
    expect(buildHourlySeries(normalize({ users: [user({ series: [] })] }).users)).toEqual([])
  })

  test('csv quotes delimiters and leaves an unknown cell empty', () => {
    const page = normalize({ users: [
      user({ nickname: 'ada, the "first"', requests: 10, succeeded: 8, failed: 2, canceled: 0 }),
      { nickname: 'bo' },
    ] })
    const lines = reportToCsv(page).trimEnd().split('\n')
    expect(lines[0]).toBe('nickname,requests,succeeded,failed,canceled,active,completed,successRatePct,averageMs,p50Ms,p95Ms,requestBytes,responseBytes,streamed,buffered,peakActive,lastSeen')
    // `active` is the fixture's reported zero; the percentile cells are bucket
    // midpoints, and p95 lands in the 5-30 s bucket. Unreported cells stay empty.
    expect(lines[1]).toBe('"ada, the ""first""",10,8,2,0,0,10,80,900,300,17500,1000,4000,,,,')
    expect(lines[2]).toBe(`bo${','.repeat(16)}`)
  })
})

