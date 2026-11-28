import { describe, expect, test } from 'bun:test'
import {
  normalize, aggregateReportStats, sortUsers, filterUsers, buildHourlySeries, reportToCsv,
} from './data.js'

const row = (patch = {}) => ({
  nickname: 'ada', requests: 4, succeeded: 3, failed: 1, canceled: 0, active: 0,
  requestBytes: 1000, responseBytes: 4000, durationMs: 9000, latency: [1, 0, 0, 0, 0, 0],
  ...patch,
})

const page = (users) => normalize({ generatedAt: '2026-11-28T00:00:00Z', latencyBoundsMs: [100, 500, 1000, 5000, 30000], users })

describe('site-wide aggregate', () => {
  test('sums every reported bucket and keeps an unreported class unknown', () => {
    const stats = aggregateReportStats(page([
      row({ statusBuckets: { '2xx': 8, '4xx': 2 }, latency: [5, 5, 0, 0, 0, 0] }),
      row({ nickname: 'bo', statusBuckets: { '2xx': 1, '5xx': 3 }, latency: [0, 10, 0, 0, 0, 0] }),
    ]))
    expect(stats.users).toBe(2)
    expect(stats.statusBuckets.find((item) => item.key === '2xx').count).toBe(9)
    expect(stats.statusBuckets.find((item) => item.key === '3xx').count).toBeNull()
    expect(stats.latency.map((item) => item.count)).toEqual([5, 15, 0, 0, 0, 0])
  })

  test('a histogram nobody reported stays null for the whole site', () => {
    const stats = aggregateReportStats(page([row({ latency: undefined, statusBuckets: undefined, headersLatency: undefined })]))
    expect(stats.latency).toBeNull()
    expect(stats.statusBuckets).toBeNull()
    expect(stats.headersLatency).toBeNull()
    expect(stats.percentiles).toBeNull()
  })

  test('rates divide by completed requests, and an idle site has no rate', () => {
    const stats = aggregateReportStats(page([row(), row({ nickname: 'bo' })]))
    expect(stats.completed).toBe(8)
    expect(stats.succeeded).toBe(6)
    expect(stats.successRate).toBeCloseTo(0.75)
    expect(stats.averageMs).toBeCloseTo(2250)
    const idle = aggregateReportStats(page([{ nickname: 'idle' }]))
    expect(idle.successRate).toBeNull()
    expect(idle.averageMs).toBeNull()
    expect(idle.requests).toBeNull()
  })

  test('per-user concurrency peaks are not added together', () => {
    const stats = aggregateReportStats(page([row({ peakActive: 3 }), row({ nickname: 'bo', peakActive: 5 })]))
    expect(stats.peakActive).toBe(5)
  })
})

describe('table ordering and filtering', () => {
  const rows = () => page([
    row({ nickname: 'ada', requests: 10, failed: 2, active: 0 }),
    row({ nickname: 'bo', requests: 30, failed: 0, active: 2 }),
    { nickname: 'cy' },
  ]).users

  test('an unknown value sorts last in both directions', () => {
    expect(sortUsers(rows(), 'requests', 'desc').map((item) => item.nickname)).toEqual(['bo', 'ada', 'cy'])
    expect(sortUsers(rows(), 'requests', 'asc').map((item) => item.nickname)).toEqual(['ada', 'bo', 'cy'])
  })

  test('sorting returns a new list and never reorders the input', () => {
    const list = rows()
    const before = list.map((item) => item.nickname)
    sortUsers(list, 'requests')
    expect(list.map((item) => item.nickname)).toEqual(before)
  })

  test('filters by nickname and by reported state', () => {
    const list = rows()
    expect(filterUsers(list, { query: 'A' }).map((item) => item.nickname)).toEqual(['ada'])
    expect(filterUsers(list, { query: '  ' })).toHaveLength(3)
    expect(filterUsers(list, { mode: 'active' }).map((item) => item.nickname)).toEqual(['bo'])
    expect(filterUsers(list, { mode: 'failing' }).map((item) => item.nickname)).toEqual(['ada'])
  })
})

describe('hourly rates', () => {
  test('a rate exists only where the bucket completed work', () => {
    const points = buildHourlySeries(page([row({ series: [
      { hour: 500000, requests: 4, succeeded: 3, failed: 1, canceled: 0, requestBytes: 10, responseBytes: 20, durationMs: 800 },
      { hour: 500001, requests: 2, succeeded: 0, failed: 0, canceled: 0, requestBytes: 5, responseBytes: 5, durationMs: 0 },
    ] })]).users)
    expect(points).toHaveLength(2)
    expect(points[0].successRate).toBeCloseTo(0.75)
    expect(points[0].averageMs).toBe(200)
    expect(points[0].traffic).toBe(30)
    expect(points[1].successRate).toBeNull()
    expect(points[1].averageMs).toBeNull()
    expect(points[1].traffic).toBe(10)
  })

  test('no reported series stays null; a reported empty series stays empty', () => {
    expect(buildHourlySeries(page([row({ series: undefined })]).users)).toBeNull()
    expect(buildHourlySeries(page([row({ series: [] })]).users)).toEqual([])
  })
})

describe('csv export', () => {
  test('quotes the delimiter and leaves every unknown cell empty', () => {
    const csv = reportToCsv(page([{ nickname: 'ada, the "first"' }, { nickname: 'bo' }]))
    const lines = csv.split('\n')
    expect(lines[0]).toBe('nickname,requests,succeeded,failed,canceled,active,completed,successRatePct,averageMs,p50Ms,p95Ms,requestBytes,responseBytes,streamed,buffered,peakActive,lastSeen')
    expect(lines[1]).toBe('"ada, the ""first"""' + ','.repeat(16))
    expect(csv.endsWith('\n')).toBe(true)
  })

  test('a reported completion is written as a percentage', () => {
    const csv = reportToCsv(page([row({ requests: 4, succeeded: 3, failed: 1, canceled: 0, durationMs: 9000 })]))
    const cells = csv.trimEnd().split('\n')[1].split(',')
    expect(cells[6]).toBe('4')
    expect(cells[7]).toBe('75')
    expect(cells[8]).toBe('2250')
  })
})
