<script>
  import { onMount } from 'svelte'
  import {
    normalize, totalOf, fmtInt, fmtBytes, fmtPercent, fmtDuration, fmtTime, fmtHour,
    aggregateReportStats, sortUsers, filterUsers, buildHourlySeries, reportToCsv,
    FILTER_MODES,
  } from './lib/data.js'

  const POLL_MS = 15_000
  const CACHE_KEY = 'zproxy-status-v2'
  const THEME_KEY = 'zproxy-theme'
  const STATUS_LABELS = {
    '2xx': '2xx 成功', '3xx': '3xx 重定向', '4xx': '4xx 客户端错误',
    '5xx': '5xx 服务端错误', noResponse: '未收到响应头', other: '其他',
  }
  const VIEWS = [
    { key: 'results', label: '请求结果' },
    { key: 'traffic', label: '吞吐流量' },
    { key: 'latency', label: '平均耗时' },
  ]
  const SORTS = [
    { key: 'nickname', label: '昵称' },
    { key: 'requests', label: '请求' },
    { key: 'failed', label: '失败' },
    { key: 'averageMs', label: '平均耗时' },
    { key: 'p95', label: 'p95' },
    { key: 'traffic', label: '流量' },
    { key: 'lastSeen', label: '最近活动' },
  ]

  let data = $state(null)
  let raw = $state(null)
  let generatedAt = $state(null)
  let receivedAt = $state(null)
  let error = $state('')
  let loading = $state(false)
  let expanded = $state('')
  let clock = $state(0)
  let theme = $state('auto')
  let view = $state('results')
  let activeBar = $state(-1)
  let query = $state('')
  let mode = $state('all')
  let sortKey = $state('requests')
  let sortDir = $state('desc')
  let copied = $state('')

  const requests = $derived(totalOf(data, 'requests'))
  const succeeded = $derived(totalOf(data, 'succeeded'))
  const failed = $derived(totalOf(data, 'failed'))
  const canceled = $derived(totalOf(data, 'canceled'))
  const active = $derived(totalOf(data, 'active'))
  const requestBytes = $derived(totalOf(data, 'requestBytes'))
  const responseBytes = $derived(totalOf(data, 'responseBytes'))
  const durationMs = $derived(totalOf(data, 'durationMs'))
  const completed = $derived(
    succeeded === null && failed === null && canceled === null
      ? null
      : (succeeded ?? 0) + (failed ?? 0) + (canceled ?? 0),
  )
  const averageMs = $derived(completed && completed > 0 && durationMs !== null ? durationMs / completed : null)
  const storeLabel = $derived(
    data?.store ? (data.store.available ? (data.store.mode === 'file' ? '已持久化' : '内存中') : '存储不可用') : null,
  )

  const agg = $derived(data ? aggregateReportStats(data) : null)
  const hourly = $derived(buildHourlySeries(data?.users ?? [], 24))

  function tickLabel(value) {
    if (view === 'traffic') return fmtBytes(value)
    if (view === 'latency') return fmtDuration(value)
    return fmtInt(Math.round(value))
  }

  // Bar geometry lives in user units, so a missing value can never turn the
  // whole chart into `NaN` the way a division by an undefined peak did.
  const chart = $derived.by(() => {
    if (!hourly || hourly.length === 0) return null
    const points = hourly.map((p) => {
      const ok = p.succeeded ?? 0
      const bad = p.failed ?? 0
      const off = p.canceled ?? 0
      const inB = p.requestBytes ?? 0
      const outB = p.responseBytes ?? 0
      return {
        hour: p.hour,
        ok, bad, off, total: ok + bad + off,
        inB, outB, traffic: inB + outB,
        avg: Number.isFinite(p.averageMs) ? p.averageMs : null,
        successRate: p.successRate ?? null,
        completion: ok + bad + off,
      }
    })
    const values = view === 'results'
      ? points.map((p) => p.total)
      : view === 'traffic' ? points.map((p) => p.traffic) : points.map((p) => p.avg ?? 0)
    const max = Math.max(1, ...values)
    const slot = 720 / points.length
    const width = Math.min(46, Math.max(2, slot * 0.62))
    const scale = 194 / max
    const bars = points.map((p, index) => {
      const x = index * slot + (slot - width) / 2
      let segs
      if (view === 'latency') {
        const h = p.avg === null ? 0 : Math.max(1.5, p.avg * scale)
        segs = [{ cls: 'bar-lat', y: 200 - h, h }]
      } else if (view === 'traffic') {
        const hi = p.inB * scale
        const ho = p.outB * scale
        segs = [
          { cls: 'bar-in', y: 200 - hi, h: hi },
          { cls: 'bar-out', y: 200 - hi - ho, h: ho },
        ]
      } else {
        const hok = p.ok * scale
        const hbad = p.bad * scale
        const hoff = p.off * scale
        segs = [
          { cls: 'bar-ok', y: 200 - hok, h: hok },
          { cls: 'bar-bad', y: 200 - hok - hbad, h: hbad },
          { cls: 'bar-off', y: 200 - hok - hbad - hoff, h: hoff },
        ]
      }
      return { ...p, x, width, segs }
    })
    const ticks = [1, 0.75, 0.5, 0.25, 0].map((frac) => ({ frac, label: tickLabel(max * frac) }))
    return { bars, max, ticks }
  })

  const activePoint = $derived(chart && activeBar >= 0 ? chart.bars[activeBar] ?? null : null)

  // Whole-site composition: drawn only when at least one class reported a
  // count, so a page never shows an empty rail pretending to be data.
  const siteStatus = $derived.by(() => {
    const parts = agg?.statusBuckets
    if (!Array.isArray(parts)) return null
    const known = parts.filter((part) => part.count !== null && part.count > 0)
    if (known.length === 0) return null
    const total = known.reduce((sum, part) => sum + part.count, 0)
    if (total === 0) return null
    let cursor = 0
    const segments = known.map((part) => {
      const width = (part.count / total) * 100
      const segment = { key: part.key, count: part.count, x: cursor, width }
      cursor += width
      return segment
    })
    return { total, segments }
  })

  const siteLatency = $derived.by(() => {
    const buckets = agg?.latency
    if (!Array.isArray(buckets) || agg?.percentiles === null) return null
    const top = Math.max(0, ...buckets.map((bucket) => bucket.count ?? 0))
    return top > 0 ? { buckets, top } : null
  })

  const siteHeaders = $derived.by(() => {
    const buckets = agg?.headersLatency
    if (!Array.isArray(buckets)) return null
    const top = Math.max(0, ...buckets.map((bucket) => bucket.count ?? 0))
    return top > 0 ? { buckets, top } : null
  })

  const rows = $derived(sortUsers(filterUsers(data?.users ?? [], { query, mode }), sortKey, sortDir))

  function restore() {
    try {
      const saved = sessionStorage.getItem(CACHE_KEY)
      if (!saved) return
      const parsed = JSON.parse(saved)
      raw = parsed.payload ?? null
      data = normalize(parsed.payload)
      generatedAt = parsed.generatedAt ?? null
      receivedAt = parsed.receivedAt ?? null
      if (data.users.length > 0) error = '正在刷新，先显示上次成功读取的快照。'
    } catch {
      sessionStorage.removeItem(CACHE_KEY)
    }
  }

  function applyTheme(next) {
    theme = next
    const root = document.documentElement
    if (next === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // A private window without storage keeps the in-memory choice only.
    }
  }

  async function load() {
    if (loading) return
    loading = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch('/api/reports', {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`服务器返回 ${response.status}`)
      const payload = await response.json()
      const next = normalize(payload)
      raw = payload
      data = next
      generatedAt = next.generatedAt
      receivedAt = new Date().toISOString()
      error = ''
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ payload, generatedAt: next.generatedAt, receivedAt }))
      } catch {
        // A full quota only costs the next reload its fallback snapshot.
      }
    } catch (cause) {
      const reason = cause?.name === 'AbortError' ? '读取超时（8 秒）' : (cause?.message ?? '网络错误')
      error = data
        ? `刷新失败：${reason}。以下为 ${fmtTime(generatedAt) ?? '更早'} 的最后成功快照。`
        : `无法读取统计：${reason}。`
    } finally {
      clearTimeout(timer)
      loading = false
    }
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY)
      if (saved === 'light' || saved === 'dark' || saved === 'auto') applyTheme(saved)
    } catch {
      // Default follows the system when storage is unavailable.
    }
    restore()
    load()
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, POLL_MS)
    const tick = setInterval(() => { clock = Date.now() }, 1_000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  })

  const ageSeconds = $derived(receivedAt ? Math.max(0, Math.round((clock - new Date(receivedAt).getTime()) / 1000)) : null)
  const link = $derived(error ? 'degraded' : loading && !data ? 'connecting' : 'live')

  function toggle(nickname) {
    expanded = expanded === nickname ? '' : nickname
  }

  function toggleSort(key) {
    if (sortKey === key) sortDir = sortDir === 'desc' ? 'asc' : 'desc'
    else {
      sortKey = key
      sortDir = 'desc'
    }
  }

  function sortMark(key) {
    return sortKey === key ? (sortDir === 'desc' ? '↓' : '↑') : ''
  }

  function downloadCsv() {
    if (!data) return
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
    const blob = new Blob([reportToCsv(data)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `zproxy-reports-${stamp}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function copySnapshot() {
    if (raw === null) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(raw, null, 2))
      copied = '已复制'
    } catch {
      copied = '复制失败'
    }
    setTimeout(() => { copied = '' }, 2_000)
  }

  function barAria(point) {
    const hour = fmtHour(point.hour)
    if (view === 'traffic') return `${hour}：上行 ${fmtBytes(point.inB)}，下行 ${fmtBytes(point.outB)}`
    if (view === 'latency') return `${hour}：平均耗时 ${point.avg === null ? '无样本' : fmtDuration(point.avg)}`
    return `${hour}：成功 ${fmtInt(point.ok)}，失败 ${fmtInt(point.bad)}，取消 ${fmtInt(point.off)}`
  }
</script>

<div class="shell">
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <div>
        <h1>zproxy</h1>
        <p>流式补全代理 · 公开用量统计</p>
      </div>
    </div>
    <div class="controls">
      <span class="link-state {link}" role="status" aria-live="polite">
        <i aria-hidden="true"></i>{link === 'live' ? '实时' : link === 'degraded' ? '快照' : '连接中'}{ageSeconds !== null ? ` · ${ageSeconds}s` : ''}
      </span>
      <div class="seg" role="group" aria-label="配色">
        {#each [['auto', '自动'], ['light', '浅色'], ['dark', '深色']] as option}
          <button type="button" class:on={theme === option[0]} aria-pressed={theme === option[0]} onclick={() => applyTheme(option[0])}>{option[1]}</button>
        {/each}
      </div>
      <button class="ghost" type="button" onclick={downloadCsv} disabled={!data} title="导出当前快照为 CSV">CSV</button>
      <button class="ghost" type="button" onclick={copySnapshot} disabled={raw === null} title="复制原始 JSON 快照">{copied || 'JSON'}</button>
      <button class="refresh" type="button" onclick={load} disabled={loading} aria-label="立即刷新统计">{loading ? '刷新中…' : '刷新'}</button>
    </div>
  </header>

  {#if error}
    <div class="banner" role="status">
      <strong>{data ? '数据可能已过期' : '统计暂不可用'}</strong>
      <span>{error}</span>
      <button type="button" class="link" onclick={load}>重试</button>
    </div>
  {/if}

  <main class="wrap" id="main-content" tabindex="-1">
    <section class="hero" aria-label="全站概览">
      <div class="hero-main">
        <div class="hero-top">
          <p class="eyebrow">进行中</p>
          {#if storeLabel}<span class="chip">{storeLabel}</span>{/if}
        </div>
        <p class="huge">{fmtInt(active)}</p>
        <p class="hint">已认证且尚未结束的请求</p>
        <progress class="meter" max={requests ?? 1} value={active ?? 0} aria-label="进行中占累计请求的比例"></progress>
      </div>
      <dl class="hero-grid">
        <div>
          <dt>累计请求</dt>
          <dd>{fmtInt(requests)}</dd>
          <p>成功 {fmtInt(succeeded)} · 取消 {fmtInt(canceled)}</p>
        </div>
        <div>
          <dt>失败率</dt>
          <dd class:bad={agg && agg.successRate !== null && agg.successRate < 0.95}>
            {completed === null ? '—' : fmtPercent((failed ?? 0) + (canceled ?? 0), completed, 2)}
          </dd>
          <p>失败 {fmtInt(failed)} / 完成 {fmtInt(completed)}</p>
        </div>
        <div>
          <dt>平均耗时</dt>
          <dd>{averageMs === null ? '—' : fmtDuration(averageMs)}</dd>
          <p>p50 {agg?.percentiles ? fmtDuration(agg.percentiles.p50) : '—'} · p95 {agg?.percentiles ? fmtDuration(agg.percentiles.p95) : '—'}</p>
        </div>
        <div>
          <dt>流量</dt>
          <dd>{fmtBytes(requestBytes)}</dd>
          <p>下行 {fmtBytes(responseBytes)}</p>
        </div>
      </dl>
    </section>

    {#if siteStatus || siteLatency || siteHeaders}
      <section class="card compact" aria-label="全站分布">
        <div class="card-head tight">
          <h2>全站分布</h2>
          {#if siteStatus}<p class="card-total">{fmtInt(siteStatus.total)} <span>已完成</span></p>{/if}
        </div>
        {#if siteStatus}
          <div class="statusbar" role="img" aria-label="全站状态码构成">
            <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
              {#each siteStatus.segments as segment (segment.key)}
                <rect x={segment.x} y="0" width={segment.width} height="8" class="seg-{segment.key}"></rect>
              {/each}
            </svg>
          </div>
          <ul class="inline-legend">
            {#each siteStatus.segments as segment (segment.key)}
              <li><i class="seg-dot seg-{segment.key}" aria-hidden="true"></i>{STATUS_LABELS[segment.key] ?? segment.key}<b>{fmtInt(segment.count)}</b></li>
            {/each}
          </ul>
        {/if}
        <div class="dist-grid">
          {#if siteLatency}
            <div>
              <h3>总耗时分布</h3>
              <ul class="progress-list">
                {#each siteLatency.buckets as bucket}
                  <li>
                    <span class="plabel">{bucket.label}</span>
                    <progress max={siteLatency.top} value={bucket.count ?? 0}></progress>
                    <span class="pvalue">{fmtInt(bucket.count)}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if siteHeaders}
            <div>
              <h3>响应头等待</h3>
              <ul class="progress-list">
                {#each siteHeaders.buckets as bucket}
                  <li>
                    <span class="plabel">{bucket.label}</span>
                    <progress max={siteHeaders.top} value={bucket.count ?? 0}></progress>
                    <span class="pvalue">{fmtInt(bucket.count)}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      </section>
    {/if}

    <section class="card" aria-label="小时吞吐">
      <div class="card-head">
        <div>
          <h2>24 小时趋势</h2>
          <p>最近 {hourly?.length ?? '—'} 个小时桶；缺失的小时不补零。</p>
        </div>
        <div class="seg" role="group" aria-label="趋势指标">
          {#each VIEWS as option}
            <button type="button" class:on={view === option.key} aria-pressed={view === option.key} onclick={() => { view = option.key; activeBar = -1 }}>{option.label}</button>
          {/each}
        </div>
      </div>
      {#if hourly === null}
        <p class="absent">服务端尚未提供小时序列。累计值仍然准确；时间维度需要在统计存储中记录滚动小时桶。</p>
      {:else if hourly.length === 0}
        <p class="absent">此窗口内还没有小时记录。早于本次统计版本的请求只计入累计值，没有被分到小时桶，因此这里保持空白而不是补零。</p>
      {:else if chart}
        <div class="chart">
          <div class="y-axis" aria-hidden="true">
            {#each chart.ticks as tick}
              <span>{tick.label}</span>
            {/each}
          </div>
          <div class="plot">
            <svg viewBox="0 0 720 200" preserveAspectRatio="none" aria-hidden="true">
              {#each chart.ticks as tick}
                <line x1="0" x2="720" y1={200 * tick.frac} y2={200 * tick.frac} class="grid"></line>
              {/each}
              {#each chart.bars as bar, index (bar.hour)}
                {#each bar.segs as seg}
                  {#if seg.h > 0}
                    <rect x={bar.x} y={seg.y} width={bar.width} height={seg.h} class={seg.cls} class:on={activeBar === index}></rect>
                  {/if}
                {/each}
              {/each}
              <line x1="0" x2="720" y1="200" y2="200" class="axis"></line>
            </svg>
            <div class="hits">
              {#each chart.bars as bar, index (bar.hour)}
                <button
                  type="button"
                  class="hit"
                  aria-label={barAria(bar)}
                  onpointerenter={() => { activeBar = index }}
                  onpointerleave={() => { activeBar = -1 }}
                  onfocus={() => { activeBar = index }}
                  onblur={() => { activeBar = -1 }}
                ><span class="sr">{fmtHour(bar.hour)}</span></button>
              {/each}
            </div>
          </div>
        </div>
        <div class="readout" aria-live="polite">
          {#if activePoint}
            <b>{fmtHour(activePoint.hour)}</b>
            {#if view === 'traffic'}
              <span>上行 {fmtBytes(activePoint.inB)}</span>
              <span>下行 {fmtBytes(activePoint.outB)}</span>
              <span>合计 {fmtBytes(activePoint.traffic)}</span>
            {:else if view === 'latency'}
              <span>平均 {activePoint.avg === null ? '无样本' : fmtDuration(activePoint.avg)}</span>
              <span>完成 {fmtInt(activePoint.completion)}</span>
              <span>成功率 {activePoint.successRate === null ? '—' : fmtPercent(activePoint.ok, activePoint.completion, 1)}</span>
            {:else}
              <span>成功 {fmtInt(activePoint.ok)}</span>
              <span>失败 {fmtInt(activePoint.bad)}</span>
              <span>取消 {fmtInt(activePoint.off)}</span>
              <span>成功率 {activePoint.successRate === null ? '—' : fmtPercent(activePoint.ok, activePoint.completion, 1)}</span>
            {/if}
          {:else}
            <span class="muted">悬停或聚焦任意小时柱查看该时段明细。</span>
          {/if}
        </div>
        <p class="legend">
          {#if view === 'traffic'}
            <i class="dot bar-in"></i>上行 <i class="dot bar-out"></i>下行
          {:else if view === 'latency'}
            <i class="dot bar-lat"></i>平均耗时
          {:else}
            <i class="dot bar-ok"></i>成功 <i class="dot bar-bad"></i>失败 <i class="dot bar-off"></i>取消
          {/if}
          <span class="peak">峰值 {tickLabel(chart.max)} / 小时</span>
        </p>
      {:else}
        <p class="absent">此窗口内没有可绘制的小时数据。</p>
      {/if}
    </section>

    <section class="card users" aria-label="按用户">
      <div class="card-head">
        <div>
          <h2>用户用量</h2>
          <p>按昵称汇总；点击表头排序，展开一行可看延迟分布与状态码构成。</p>
        </div>
        <p class="card-total">{fmtInt(rows.length)} <span>/ {fmtInt(data?.users.length ?? 0)} 位用户</span></p>
      </div>
      <div class="filters">
        <label class="search">
          <span class="sr">按昵称筛选</span>
          <input type="search" placeholder="筛选昵称…" bind:value={query} />
        </label>
        <div class="seg" role="group" aria-label="筛选">
          {#each FILTER_MODES as option}
            <button type="button" class:on={mode === option.key} aria-pressed={mode === option.key} onclick={() => { mode = option.key }}>{option.label}</button>
          {/each}
        </div>
      </div>
      {#if data && data.users.length > 0}
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                {#each SORTS as column}
                  <th scope="col" class:num={column.key !== 'nickname' && column.key !== 'lastSeen'}>
                    <button type="button" class="sort" onclick={() => toggleSort(column.key)} aria-label="按{column.label}排序">
                      {column.label}<span class="mark-sort" aria-hidden="true">{sortMark(column.key)}</span>
                    </button>
                  </th>
                {/each}
                <th scope="col" class="num col-opt">成功</th>
                <th scope="col"><span class="sr">展开</span></th>
              </tr>
            </thead>
            <tbody>
              {#each rows as user (user.nickname)}
                <tr class:open={expanded === user.nickname}>
                  <th scope="row">
                    <button type="button" class="row-toggle" onclick={() => toggle(user.nickname)} aria-expanded={expanded === user.nickname}>
                      {user.nickname}
                    </button>
                  </th>
                  <td class="num">{fmtInt(user.requests)}</td>
                  <td class="num" class:bad={user.failed}>{fmtInt(user.failed)}</td>
                  <td class="num">{user.averageMs === null ? '—' : fmtDuration(user.averageMs)}</td>
                  <td class="num">{user.percentiles ? fmtDuration(user.percentiles.p95) : '—'}</td>
                  <td class="num">{fmtBytes((user.requestBytes ?? 0) + (user.responseBytes ?? 0))}</td>
                  <td>{user.lastSeen ? fmtTime(user.lastSeen) : '—'}</td>
                  <td class="num col-opt">{fmtInt(user.succeeded)}</td>
                  <td class="chev"><span aria-hidden="true">{expanded === user.nickname ? '▾' : '▸'}</span></td>
                </tr>
                {#if expanded === user.nickname}
                  <tr class="detail-row">
                    <td colspan="9">
                      <div class="detail">
                        <div class="detail-block">
                          <h3>延迟分布</h3>
                          {#if user.latency}
                            {@const top = Math.max(1, ...user.latency.map((bucket) => bucket.count))}
                            <ul class="progress-list">
                              {#each user.latency as bucket}
                                <li>
                                  <span class="plabel">{bucket.label}</span>
                                  <progress max={top} value={bucket.count ?? 0}></progress>
                                  <span class="pvalue">{fmtInt(bucket.count)}</span>
                                </li>
                              {/each}
                            </ul>
                            <p class="note">
                              p50 ≈ {user.percentiles ? fmtDuration(user.percentiles.p50) : '—'}，p95 ≈ {user.percentiles ? fmtDuration(user.percentiles.p95) : '—'}（{fmtInt(user.percentiles?.samples ?? 0)} 个样本，按桶中点估算）。
                              {#if user.completed && user.percentiles && user.percentiles.samples > 0}
                                覆盖率 {fmtPercent(user.percentiles.samples, user.completed, 1)}。
                              {:else if user.completed}
                                还没有可用的耗时样本：{fmtInt(user.completed)} 个完成请求都在延迟统计上线前结束，不能当作 0 延迟。
                              {:else}
                                尚无完成请求，因此没有延迟样本。
                              {/if}
                            </p>
                          {:else}
                            <p class="absent">服务端尚未提供该用户的延迟直方图。</p>
                          {/if}
                        </div>
                        <div class="detail-block">
                          <h3>结果构成</h3>
                          {#if user.statusBuckets}
                            {@const known = user.statusBuckets.filter((part) => part.count !== null && part.count > 0)}
                            {@const total = known.reduce((sum, part) => sum + part.count, 0)}
                            {#if total > 0}
                              <div class="statusbar" role="img" aria-label="该用户状态码构成">
                                <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                                  {#each known as part, index (part.key)}
                                    <rect x={known.slice(0, index).reduce((sum, prev) => sum + (prev.count / total) * 100, 0)} y="0" width={(part.count / total) * 100} height="8" class="seg-{part.key}"></rect>
                                  {/each}
                                </svg>
                              </div>
                            {/if}
                            <ul class="inline-legend">
                              {#each user.statusBuckets as part}
                                <li><i class="seg-dot seg-{part.key}" aria-hidden="true"></i>{STATUS_LABELS[part.key] ?? part.key}<b>{fmtInt(part.count)}</b></li>
                              {/each}
                            </ul>
                            {#if user.statusBuckets.some((part) => part.count === null)}
                              <p class="note">“—” 表示服务端没有上报该状态类别，不能视为 0。</p>
                            {/if}
                          {:else}
                            <p class="absent">服务端尚未提供状态码分桶。</p>
                          {/if}
                          <dl class="facts">
                            <div><dt>完成请求</dt><dd>{fmtInt(user.completed)}</dd></div>
                            <div><dt>成功率</dt><dd>{user.successRate === null ? '—' : fmtPercent(user.succeeded, user.completed, 1)}</dd></div>
                            <div><dt>累计耗时</dt><dd>{user.durationMs === null ? '—' : fmtDuration(user.durationMs)}</dd></div>
                            <div><dt>流量</dt><dd>{fmtBytes((user.requestBytes ?? 0) + (user.responseBytes ?? 0))}</dd></div>
                          </dl>
                        </div>
                        <div class="detail-block">
                          <h3>响应与并发</h3>
                          {#if user.kinds}
                            {@const kindTotal = user.kinds.filter((kind) => kind.count !== null).reduce((sum, kind) => sum + kind.count, 0)}
                            <ul class="inline-legend wide">
                              {#each user.kinds as kind}
                                <li>{kind.label}<b>{fmtInt(kind.count)}</b>{#if kind.count !== null && kindTotal > 0}<em>{fmtPercent(kind.count, kindTotal, 1)}</em>{/if}</li>
                              {/each}
                            </ul>
                            <p class="note">按请求路径分组，是代理接受的两条补全端点，不含模型维度。</p>
                          {:else}
                            <p class="absent">服务端尚未提供请求路径计数。</p>
                          {/if}
                          {#if user.streamed !== null || user.buffered !== null}
                            <dl class="facts">
                              <div><dt>流式响应</dt><dd>{fmtInt(user.streamed)}</dd></div>
                              <div><dt>缓冲响应</dt><dd>{fmtInt(user.buffered)}</dd></div>
                              <div><dt>并发峰值</dt><dd>{fmtInt(user.peakActive)}</dd></div>
                              <div><dt>最近活动</dt><dd>{user.lastSeen ? fmtTime(user.lastSeen) : '—'}</dd></div>
                            </dl>
                            <p class="note">流式/缓冲按响应是否带流式元数据分组，不解析正文；并发峰值是历史最高同时进行数，不随时间下降。</p>
                          {:else}
                            <p class="absent">服务端尚未提供响应形态与并发计数。</p>
                          {/if}
                          {#if user.headersLatency}
                            {@const headerTop = Math.max(1, ...user.headersLatency.map((bucket) => bucket.count))}
                            <h3 class="sub">响应头等待</h3>
                            <ul class="progress-list">
                              {#each user.headersLatency as bucket}
                                <li>
                                  <span class="plabel">{bucket.label}</span>
                                  <progress max={headerTop} value={bucket.count ?? 0}></progress>
                                  <span class="pvalue">{fmtInt(bucket.count)}</span>
                                </li>
                              {/each}
                            </ul>
                            <p class="note">
                              从请求开始到收到响应头的时间。
                              {#if user.completed && user.headersCovered !== null}
                                {#if user.headersGap === 0}
                                  全部 {fmtInt(user.completed)} 个完成请求都有可测的等待值。
                                {:else if user.noResponseCount !== null}
                                  {@const legacy = Math.max(0, user.headersGap - user.noResponseCount)}
                                  覆盖 {fmtInt(user.headersCovered)} / {fmtInt(user.completed)} 个完成请求。差额 {fmtInt(user.headersGap)} 个没有可测值：{fmtInt(user.noResponseCount)} 个未收到响应头{#if legacy > 0}，另有 {fmtInt(legacy)} 个是统计上线前的历史请求{/if}。都不能当作 0 毫秒。
                                {:else}
                                  覆盖 {fmtInt(user.headersCovered)} / {fmtInt(user.completed)} 个完成请求；差额 {fmtInt(user.headersGap)} 个没有可测值，不能当作 0 毫秒。
                                {/if}
                              {/if}
                            </p>
                          {:else}
                            <p class="absent">服务端尚未提供响应头等待直方图。</p>
                          {/if}
                        </div>
                        <div class="detail-block">
                          <h3>最近小时</h3>
                          {#if user.series === null}
                            <p class="absent">服务端尚未提供该用户的小时序列。</p>
                          {:else if user.series.length === 0}
                            <p class="absent">该用户在此窗口内还没有小时记录；更早的请求只计入累计值。</p>
                          {:else}
                            {@const top = Math.max(1, ...user.series.map((point) => point.succeeded + point.failed + point.canceled))}
                            {@const slice = user.series.slice(-12)}
                            <svg class="mini" viewBox="0 0 120 40" preserveAspectRatio="none" role="img" aria-label="该用户最近 12 小时的请求数">
                              {#each slice as point, index (point.hour)}
                                {@const value = point.succeeded + point.failed + point.canceled}
                                {@const height = value > 0 ? Math.max(1.5, (value / top) * 36) : 0}
                                <rect x={index * 10 + 1} y={40 - height} width="8" height={height} class="mini-bar"></rect>
                              {/each}
                            </svg>
                            <p class="note">{fmtHour(slice[0].hour)} → {fmtHour(slice[slice.length - 1].hour)}，峰值 {fmtInt(top)} / 小时。</p>
                          {/if}
                        </div>
                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        {#if rows.length === 0}
          <p class="absent">没有匹配当前筛选条件的用户。</p>
        {/if}
      {:else if data}
        <p class="absent">还没有用户统计。</p>
      {:else}
        <p class="absent">正在读取统计…</p>
      {/if}
    </section>

    <details class="card notes">
      <summary>口径、未展示的数据与快照</summary>
      <div class="notes-body">
        <p>请求、结果与耗时由服务器在流式读写时计数；流量是原始正文字节，不做编码解码。平均耗时 = 累计耗时 ÷ 完成请求数（成功 + 失败 + 取消）。缺失字段显示为 “—”，不按 0 处理；p50/p95 由延迟桶中点估算，不是精确分位。</p>
        <p><b>未在此页展示：</b>上游路由、token 台账与账号健康由远端共享池持有，无法归属到单个昵称，且属于运维信息，只在需要登录的 <a href="/admin/reports">路由统计</a> 页面展示。代理核心不解析模型内容，因此没有「按昵称的模型用量」。官方价等效值只是按公开标价的估算，不是账单；本页不展示任何凭据、密钥或账号标识。</p>
        <dl class="meta">
          <div><dt>快照生成</dt><dd>{fmtTime(generatedAt) ?? '未提供'}</dd></div>
          <div><dt>本页读取</dt><dd>{fmtTime(receivedAt) ?? '—'}{ageSeconds !== null ? `（${ageSeconds} 秒前）` : ''}</dd></div>
          <div><dt>存储</dt><dd>{storeLabel ?? '未提供'}</dd></div>
          <div><dt>刷新</dt><dd>每 15 秒，页面隐藏时暂停</dd></div>
        </dl>
      </div>
    </details>
  </main>
  <footer class="foot">公开统计只包含昵称与计数 · <a href="/admin">用户管理</a></footer>
</div>
