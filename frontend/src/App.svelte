<script>
  import { onMount } from 'svelte'
  import {
    normalize, fmtInt, fmtBytes, fmtPercent, fmtDuration, fmtTime, fmtHour,
    aggregateReportStats, sortUsers, filterUsers, reportToCsv, FILTER_MODES,
  } from './lib/data.js'

  const POLL_MS = 15_000
  const CACHE_KEY = 'zproxy-status-v1'
  const THEME_KEY = 'zproxy-theme'

  const VIEWS = [
    { key: 'results', label: '请求结果', hint: '柱高为完成请求数（成功 + 失败 + 取消）' },
    { key: 'traffic', label: '吞吐流量', hint: '上行与下行正文原始字节' },
    { key: 'latency', label: '平均耗时', hint: '桶内完成请求的平均总耗时' },
  ]
  const THEMES = [
    { key: 'system', label: '跟随系统' },
    { key: 'light', label: '浅色' },
    { key: 'dark', label: '深色' },
  ]
  const STATUS_LABELS = {
    '2xx': '2xx 成功', '3xx': '3xx 重定向', '4xx': '4xx 客户端错误', '5xx': '5xx 服务端错误',
    noResponse: '未收到响应头', other: '其他',
  }

  let data = $state(null)
  let raw = $state(null)
  let generatedAt = $state(null)
  let receivedAt = $state(null)
  let error = $state('')
  let loading = $state(false)
  let expanded = $state(new Set())
  let clock = $state(0)
  let nextPollAt = $state(0)
  let paused = $state(false)
  let theme = $state('system')
  let view = $state('results')
  let selected = $state(null)
  let query = $state('')
  let mode = $state('all')
  let sortKey = $state('requests')
  let sortDir = $state('desc')
  let copied = $state('')
  let announce = $state('')

  const stats = $derived(aggregateReportStats(data))
  const anySeries = $derived((data?.users ?? []).some((user) => Array.isArray(user.series)))
  const storeLabel = $derived(
    data?.store ? (data.store.available ? (data.store.mode === 'file' ? '已持久化' : data.store.mode) : '存储不可用') : null,
  )

  /// Hourly buckets merged across every user, with the rates each view needs.
  /// An idle bucket has no rate: null, never 0%.
  const points = $derived.by(() => {
    const map = new Map()
    for (const user of data?.users ?? []) {
      for (const point of user.series ?? []) {
        const bucket = map.get(point.hour)
        if (bucket) {
          bucket.requests += point.requests
          bucket.succeeded += point.succeeded
          bucket.failed += point.failed
          bucket.canceled += point.canceled
          bucket.requestBytes += point.requestBytes
          bucket.responseBytes += point.responseBytes
          bucket.durationMs += point.durationMs
        } else {
          map.set(point.hour, { ...point })
        }
      }
    }
    return [...map.values()]
      .sort((a, b) => a.hour - b.hour)
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
  })

  const activeView = $derived(VIEWS.find((entry) => entry.key === view) ?? VIEWS[0])
  const planeMax = $derived(niceMax(Math.max(0, ...points.map((point) => valueOf(point)))))
  const ticks = $derived([0, 0.25, 0.5, 0.75, 1].map((share) => planeMax * share))
  const focusPoint = $derived(points[selected ?? points.length - 1] ?? null)
  const windowHours = $derived(points.length)

  const visibleUsers = $derived(sortUsers(filterUsers(data?.users ?? [], { query, mode }), sortKey, sortDir))
  const allExpanded = $derived(visibleUsers.length > 0 && visibleUsers.every((user) => expanded.has(user.nickname)))

  const ageSeconds = $derived(receivedAt ? Math.max(0, Math.round((clock - new Date(receivedAt).getTime()) / 1000)) : null)
  const countdown = $derived(
    nextPollAt > clock ? Math.min(Math.round(POLL_MS / 1000), Math.ceil((nextPollAt - clock) / 1000)) : 0,
  )
  const link = $derived(error ? 'stale' : loading && !data ? 'connecting' : 'live')
  const linkLabel = $derived(
    link === 'live' ? (paused ? '已暂停' : '实时') : link === 'stale' ? '快照' : '连接中',
  )

  function valueOf(point) {
    if (view === 'traffic') return point.traffic
    if (view === 'latency') return point.averageMs ?? 0
    return point.completed
  }

  function niceMax(value) {
    if (!(value > 0)) return 1
    const step = Math.pow(10, Math.floor(Math.log10(value)))
    for (const multiple of [1, 2, 2.5, 5, 10]) {
      if (value <= multiple * step) return multiple * step
    }
    return 10 * step
  }

  function tickLabel(value) {
    if (view === 'traffic') return fmtBytes(value)
    if (view === 'latency') return fmtDuration(value)
    return fmtInt(value)
  }

  const PLOT_LEFT = 56
  const PLOT_RIGHT = 712
  const PLOT_TOP = 18
  const PLOT_BOTTOM = 186

  function yOf(value) {
    const share = planeMax > 0 ? Math.min(1, value / planeMax) : 0
    return PLOT_BOTTOM - share * (PLOT_BOTTOM - PLOT_TOP)
  }

  function slotWidth() {
    return points.length > 0 ? (PLOT_RIGHT - PLOT_LEFT) / points.length : 1
  }

  function barWidth() {
    return Math.max(2.5, Math.min(28, slotWidth() * 0.6))
  }

  function barX(index) {
    const slot = slotWidth()
    return PLOT_LEFT + index * slot + (slot - barWidth()) / 2
  }

  function labelOf(point) {
    const share = point.completed > 0 ? fmtPercent(point.succeeded, point.completed, 1) : '—'
    return `${fmtHour(point.hour)}：完成 ${fmtInt(point.completed)}，成功 ${fmtInt(point.succeeded)}，失败 ${fmtInt(point.failed)}，成功率 ${share}，流量 ${fmtBytes(point.traffic)}`
  }

  function applyTheme(next) {
    theme = next
    const root = document.documentElement
    if (next === 'system') root.removeAttribute('data-theme')
    else root.dataset.theme = next
    try { localStorage.setItem(THEME_KEY, next) } catch { /* a blocked storage only costs the choice */ }
  }

  function toggle(nickname) {
    const next = new Set(expanded)
    if (next.has(nickname)) next.delete(nickname)
    else next.add(nickname)
    expanded = next
  }

  function toggleAll() {
    expanded = allExpanded ? new Set() : new Set(visibleUsers.map((user) => user.nickname))
  }

  function orderBy(key) {
    if (sortKey === key) sortDir = sortDir === 'desc' ? 'asc' : 'desc'
    else {
      sortKey = key
      sortDir = key === 'nickname' ? 'asc' : 'desc'
    }
  }

  function sortMark(key) {
    if (sortKey !== key) return ''
    return sortDir === 'desc' ? '▾' : '▴'
  }

  function restore() {
    try {
      const saved = sessionStorage.getItem(CACHE_KEY)
      const savedTheme = localStorage.getItem(THEME_KEY)
      if (savedTheme) applyTheme(savedTheme)
      if (!saved) return
      const parsed = JSON.parse(saved)
      data = normalize(parsed.payload)
      raw = parsed.payload
      generatedAt = parsed.generatedAt ?? null
      receivedAt = parsed.receivedAt ?? null
      if (data.users.length > 0) error = '正在刷新，先显示上次成功读取的快照。'
    } catch {
      sessionStorage.removeItem(CACHE_KEY)
    }
  }

  async function load() {
    if (loading) return
    loading = true
    nextPollAt = Date.now() + POLL_MS
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
      data = next
      raw = payload
      generatedAt = next.generatedAt
      receivedAt = new Date().toISOString()
      error = ''
      announce = `统计已更新：${fmtInt(stats.requests)} 个请求，${fmtInt(next.users.length)} 位用户。`
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ payload, generatedAt: next.generatedAt, receivedAt }))
      } catch {
        // A full quota only costs the next reload its fallback snapshot.
      }
    } catch (cause) {
      const reason = cause?.name === 'AbortError' ? '读取超时（8 秒）' : (cause?.message ?? '网络错误')
      error = data ? `刷新失败：${reason}。以下为 ${fmtTime(generatedAt) ?? '更早'} 的最后成功快照。` : `无法读取统计：${reason}。`
    } finally {
      clearTimeout(timer)
      loading = false
    }
  }

  function exportCsv() {
    const csv = reportToCsv(data)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `zproxy-usage-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    copied = '已导出 CSV'
    setTimeout(() => { copied = '' }, 2600)
  }

  async function copySnapshot() {
    const text = JSON.stringify(raw ?? { generatedAt }, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      copied = '已复制 JSON 快照'
    } catch {
      copied = '复制失败：浏览器拒绝了剪贴板访问'
    }
    setTimeout(() => { copied = '' }, 2600)
  }

  onMount(() => {
    restore()
    load()
    const tick = setInterval(() => {
      clock = Date.now()
      if (!paused && document.visibilityState === 'visible' && clock >= nextPollAt && nextPollAt > 0) load()
    }, 1000)
    const onVisible = () => { if (document.visibilityState === 'visible' && !paused) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  })
</script>

<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <div>
        <h1>zproxy</h1>
        <p>流式补全代理 · 公开用量统计</p>
      </div>
    </div>
    <div class="controls">
      <span class="link-state {link}" title={paused ? '自动刷新已暂停' : '每 15 秒刷新一次'}> 
        <i aria-hidden="true"></i>{linkLabel}
        {#if ageSeconds !== null}<em>{ageSeconds < 2 ? '刚刚' : `${ageSeconds}s 前`}</em>{/if}
      </span>
      <div class="countdown" role="progressbar" aria-label="自动刷新倒计时" aria-valuemin="0" aria-valuemax={Math.round(POLL_MS / 1000)} aria-valuenow={paused ? 0 : Math.round(POLL_MS / 1000) - countdown}>
        <span class={`w-${Math.round(paused ? 0 : Math.max(0, Math.min(100, (1 - countdown / (POLL_MS / 1000)) * 100)))}`}></span>
      </div>
      <div class="segmented compact" role="group" aria-label="主题">
        {#each THEMES as option}
          <button type="button" class:on={theme === option.key} aria-pressed={theme === option.key} onclick={() => applyTheme(option.key)} title={option.label}>
            <span aria-hidden="true">{option.key === 'system' ? '◐' : option.key === 'light' ? '☀' : '☾'}</span>
            <span class="sr">{option.label}</span>
          </button>
        {/each}
      </div>
      <button type="button" class="ghost" onclick={() => { paused = !paused; announce = paused ? '已暂停自动刷新' : '已恢复自动刷新' }} aria-pressed={paused}>
        {paused ? '继续' : '暂停'}
      </button>
      <button type="button" class="ghost" onclick={exportCsv} disabled={!data}>导出 CSV</button>
      <button type="button" class="ghost" onclick={copySnapshot} disabled={!raw}>复制 JSON</button>
      <button class="refresh" type="button" onclick={load} disabled={loading} aria-label="立即刷新统计">{loading ? '刷新中…' : '刷新'}</button>
    </div>
  </header>

  {#if copied}<p class="toast" role="status">{copied}</p>{/if}

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
        <p class="eyebrow">进行中</p>
        <p class="huge">{fmtInt(stats.active)}</p>
        <p class="hint">已认证且尚未结束的请求</p>
        <div class="hero-meter" aria-hidden="true">
          <span class={`w-${stats.active && stats.requests ? Math.round(Math.min(100, (stats.active / Math.max(stats.requests, 1)) * 100)) : 0}`}></span>
        </div>
        <p class="hint store">{storeLabel ? `存储：${storeLabel}` : '存储状态：未提供'}</p>
      </div>
      <dl class="hero-grid">
        <div>
          <dt>累计请求</dt>
          <dd>{fmtInt(stats.requests)}</dd>
          <p>成功 {fmtInt(stats.succeeded)} · 取消 {fmtInt(stats.canceled)} · 完成 {fmtInt(stats.completed)}</p>
        </div>
        <div>
          <dt>失败率</dt>
          <dd class:bad={stats.successRate !== null && stats.successRate < 0.95}>
            {stats.completed && stats.completed > 0 ? fmtPercent((stats.failed ?? 0) + (stats.canceled ?? 0), stats.completed, 2) : '—'}
          </dd>
          <p>失败 {fmtInt(stats.failed)} / 完成 {fmtInt(stats.completed)}</p>
        </div>
        <div>
          <dt>平均耗时</dt>
          <dd>{stats.averageMs === null ? '—' : fmtDuration(stats.averageMs)}</dd>
          <p>p50 ≈ {stats.percentiles ? fmtDuration(stats.percentiles.p50) : '—'} · p95 ≈ {stats.percentiles ? fmtDuration(stats.percentiles.p95) : '—'}</p>
        </div>
        <div>
          <dt>流量</dt>
          <dd>{fmtBytes(stats.requestBytes)}</dd>
          <p>下行 {fmtBytes(stats.responseBytes)}</p>
        </div>
      </dl>
    </section>

    <section class="card distribution" aria-label="全站构成">
      <div class="card-head">
        <div>
          <h2>全站构成</h2>
          <p>所有用户的状态码、延迟与响应头等待合并在一起，不必展开单行。</p>
        </div>
      </div>
      <div class="distribution-grid">
        <div class="dist-block wide">
          <h3>结果构成</h3>
          {#if stats.statusBuckets}
            {@const known = stats.statusBuckets.filter((part) => part.count !== null)}
            {@const total = known.reduce((n, part) => n + (part.count ?? 0), 0)}
            <div class="stackbar tall" role="img" aria-label="全站状态码构成">
              {#each known as part}
                {#if part.count > 0}
                  <span class={`w-${Math.round((part.count / Math.max(total, 1)) * 100)} tone-${part.key}`} title={`${STATUS_LABELS[part.key]}：${fmtInt(part.count)}`}></span>
                {/if}
              {/each}
            </div>
            <ul class="status-list inline">
              {#each stats.statusBuckets as part}
                <li><i class={`tone-${part.key}`}></i>{STATUS_LABELS[part.key]}<b>{fmtInt(part.count)}</b></li>
              {/each}
            </ul>
          {:else}
            <p class="absent">服务端尚未提供状态码分桶。“—” 不代表 0。</p>
          {/if}
        </div>
        <div class="dist-block">
          <h3>延迟分布</h3>
          {#if stats.latency}
            {@const top = Math.max(1, ...stats.latency.map((bucket) => bucket.count ?? 0))}
            <ul class="histogram">
              {#each stats.latency as bucket}
                <li>
                  <span class="hist-label">{bucket.label}</span>
                  <span class="hist-track"><span class={`w-${bucket.count > 0 ? Math.max(2, Math.round(((bucket.count ?? 0) / top) * 100)) : 0}`}></span></span>
                  <span class="hist-value">{fmtInt(bucket.count)}</span>
                </li>
              {/each}
            </ul>
            <p class="note">{fmtInt(stats.percentiles?.samples ?? 0)} 个样本；p50/p95 由桶中点估算。</p>
          {:else}
            <p class="absent">服务端尚未提供延迟直方图。</p>
          {/if}
        </div>
        <div class="dist-block">
          <h3>响应头等待</h3>
          {#if stats.headersLatency}
            {@const top = Math.max(1, ...stats.headersLatency.map((bucket) => bucket.count ?? 0))}
            <ul class="histogram">
              {#each stats.headersLatency as bucket}
                <li>
                  <span class="hist-label">{bucket.label}</span>
                  <span class="hist-track"><span class={`w-${bucket.count > 0 ? Math.max(2, Math.round(((bucket.count ?? 0) / top) * 100)) : 0}`}></span></span>
                  <span class="hist-value">{fmtInt(bucket.count)}</span>
                </li>
              {/each}
            </ul>
            <p class="note">正文开始前的等待；未收到响应头的请求不计入，不能当作 0 毫秒。</p>
          {:else}
            <p class="absent">服务端尚未提供响应头等待直方图。</p>
          {/if}
        </div>
      </div>
    </section>

    <section class="card" aria-label="小时走势">
      <div class="card-head">
        <div>
          <h2>小时走势</h2>
          <p>{activeView.hint}；最近 {windowHours || '—'} 个小时桶。</p>
        </div>
        <div class="segmented" role="group" aria-label="图表指标">
          {#each VIEWS as option}
            <button type="button" class:on={view === option.key} aria-pressed={view === option.key} onclick={() => { view = option.key }}>{option.label}</button>
          {/each}
        </div>
      </div>
      {#if !anySeries}
        <p class="absent">服务端尚未提供小时序列。累计值仍然准确；时间维度需要统计存储记录滚动小时桶。</p>
      {:else if points.length === 0}
        <p class="absent">此窗口内还没有小时记录。早于本统计版本的请求只计入累计值，没有被分到小时桶，因此这里保持空白而不是补零。</p>
      {:else}
        <div class="chart">
          <svg viewBox="0 0 720 216" role="group" aria-label={`${activeView.label}，按小时`}>
            {#each ticks as tick}
              <line class="grid" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={yOf(tick)} y2={yOf(tick)} />
              <text class="tick-label" x={PLOT_LEFT - 8} y={yOf(tick) + 4} text-anchor="end">{tickLabel(tick)}</text>
            {/each}
            {#each points as point, index}
              {@const active = (selected ?? points.length - 1) === index}
              <g tabindex="0" role="button" aria-label={labelOf(point)} aria-pressed={active}
                 onfocus={() => { selected = index }} onmouseenter={() => { selected = index }}>
                <rect class="hit" x={PLOT_LEFT + index * slotWidth()} y={PLOT_TOP} width={Math.max(1, slotWidth())} height={PLOT_BOTTOM - PLOT_TOP} />
                {#if view === 'results'}
                  {@const ok = (point.succeeded / planeMax) * (PLOT_BOTTOM - PLOT_TOP)}
                  {@const bad = (point.failed / planeMax) * (PLOT_BOTTOM - PLOT_TOP)}
                  {@const off = (point.canceled / planeMax) * (PLOT_BOTTOM - PLOT_TOP)}
                  <rect class="bar-ok" x={barX(index)} y={PLOT_BOTTOM - ok} width={barWidth()} height={Math.max(0, ok)} />
                  <rect class="bar-bad" x={barX(index)} y={PLOT_BOTTOM - ok - bad} width={barWidth()} height={Math.max(0, bad)} />
                  <rect class="bar-off" x={barX(index)} y={PLOT_BOTTOM - ok - bad - off} width={barWidth()} height={Math.max(0, off)} />
                {:else if view === 'traffic'}
                  {@const up = (point.requestBytes / planeMax) * (PLOT_BOTTOM - PLOT_TOP)}
                  {@const down = (point.responseBytes / planeMax) * (PLOT_BOTTOM - PLOT_TOP)}
                  <rect class="bar-up" x={barX(index)} y={PLOT_BOTTOM - up} width={barWidth()} height={Math.max(0, up)} />
                  <rect class="bar-down" x={barX(index)} y={PLOT_BOTTOM - up - down} width={barWidth()} height={Math.max(0, down)} />
                {:else}
                  <rect class="bar-latency" x={barX(index)} y={yOf(point.averageMs ?? 0)} width={barWidth()} height={Math.max(0, PLOT_BOTTOM - yOf(point.averageMs ?? 0))} />
                {/if}
                {#if active}
                  <line class="marker" x1={PLOT_LEFT + index * slotWidth() + slotWidth() / 2} x2={PLOT_LEFT + index * slotWidth() + slotWidth() / 2} y1={PLOT_TOP - 4} y2={PLOT_BOTTOM} />
                {/if}
              </g>
            {/each}
            <line class="axis" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} />
          </svg>
        </div>
        <p class="legend">
          {#if view === 'results'}<i class="ok"></i>成功 <i class="bad"></i>失败 <i class="off"></i>取消
          {:else if view === 'traffic'}<i class="up"></i>上行 <i class="down"></i>下行
          {:else}<i class="lat"></i>平均耗时{/if}
          <span class="peak">峰值 {tickLabel(planeMax)} / 小时</span>
        </p>
        <div class="readout" role="group" aria-label="所选小时的读数">
          {#if focusPoint}
            <span class="readout-hour">{fmtHour(focusPoint.hour)}</span>
            <span>请求 <b>{fmtInt(focusPoint.completed)}</b></span>
            <span>成功 <b>{fmtInt(focusPoint.succeeded)}</b></span>
            <span>失败 <b>{fmtInt(focusPoint.failed)}</b></span>
            <span>成功率 <b>{focusPoint.completed > 0 ? fmtPercent(focusPoint.succeeded, focusPoint.completed, 1) : '—'}</b></span>
            <span>流量 <b>{fmtBytes(focusPoint.traffic)}</b></span>
            <span>均耗时 <b>{focusPoint.averageMs === null ? '—' : fmtDuration(focusPoint.averageMs)}</b></span>
          {:else}
            <span>还没有可读的小时桶。</span>
          {/if}
        </div>
      {/if}
    </section>

    <section class="card users" aria-label="按用户">
      <div class="card-head">
        <div>
          <h2>用户用量</h2>
          <p>点表头排序，按昵称筛选。展开一行可看双直方图与状态构成。</p>
        </div>
        <p class="card-total">{fmtInt(visibleUsers.length)}<span>/ {fmtInt(data?.users.length ?? 0)} 位用户</span></p>
      </div>

      <div class="table-tools">
        <label class="search">
          <span class="sr">按昵称筛选</span>
          <input type="search" bind:value={query} placeholder="筛选昵称…" autocomplete="off" />
        </label>
        <div class="segmented" role="group" aria-label="行筛选">
          {#each FILTER_MODES as option}
            <button type="button" class:on={mode === option.key} aria-pressed={mode === option.key} onclick={() => { mode = option.key }}>{option.label}</button>
          {/each}
        </div>
        <button type="button" class="ghost" onclick={toggleAll} disabled={visibleUsers.length === 0}>{allExpanded ? '全部收起' : '全部展开'}</button>
      </div>

      {#if data && data.users.length > 0}
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col"><button type="button" class="sort" onclick={() => orderBy('nickname')} aria-label="按昵称排序">昵称 <i>{sortMark('nickname')}</i></button></th>
                <th scope="col" class="num"><button type="button" class="sort" onclick={() => orderBy('requests')} aria-label="按请求数排序">请求 <i>{sortMark('requests')}</i></button></th>
                <th scope="col" class="num">成功</th>
                <th scope="col" class="num"><button type="button" class="sort" onclick={() => orderBy('failed')} aria-label="按失败数排序">失败 <i>{sortMark('failed')}</i></button></th>
                <th scope="col" class="num col-opt">取消</th>
                <th scope="col" class="num col-opt">进行中</th>
                <th scope="col" class="num"><button type="button" class="sort" onclick={() => orderBy('traffic')} aria-label="按总流量排序">流量 <i>{sortMark('traffic')}</i></button></th>
                <th scope="col" class="num"><button type="button" class="sort" onclick={() => orderBy('averageMs')} aria-label="按平均耗时排序">平均 <i>{sortMark('averageMs')}</i></button></th>
                <th scope="col" class="num col-opt"><button type="button" class="sort" onclick={() => orderBy('p95')} aria-label="按 p95 排序">p50 / p95 <i>{sortMark('p95')}</i></button></th>
                <th scope="col" class="num col-opt"><button type="button" class="sort" onclick={() => orderBy('lastSeen')} aria-label="按最近活动排序">最近 <i>{sortMark('lastSeen')}</i></button></th>
                <th scope="col"><span class="sr">展开</span></th>
              </tr>
            </thead>
            <tbody>
              {#each visibleUsers as user (user.nickname)}
                <tr class:open={expanded.has(user.nickname)}>
                  <th scope="row">
                    <button type="button" class="row-toggle" onclick={() => toggle(user.nickname)} aria-expanded={expanded.has(user.nickname)}>
                      {user.nickname}
                    </button>
                  </th>
                  <td class="num">{fmtInt(user.requests)}</td>
                  <td class="num">{fmtInt(user.succeeded)}</td>
                  <td class="num" class:bad={user.failed}>{fmtInt(user.failed)}</td>
                  <td class="num col-opt">{fmtInt(user.canceled)}</td>
                  <td class="num col-opt">{fmtInt(user.active)}</td>
                  <td class="num">{fmtBytes((user.requestBytes ?? 0) + (user.responseBytes ?? 0))}</td>
                  <td class="num">{user.averageMs === null ? '—' : fmtDuration(user.averageMs)}</td>
                  <td class="num col-opt">{user.percentiles ? `${fmtDuration(user.percentiles.p50)} / ${fmtDuration(user.percentiles.p95)}` : '—'}</td>
                  <td class="num col-opt">{user.lastSeen ? fmtTime(user.lastSeen) : '—'}</td>
                  <td class="chev"><span aria-hidden="true">{expanded.has(user.nickname) ? '▾' : '▸'}</span></td>
                </tr>
                {#if expanded.has(user.nickname)}
                  <tr class="detail-row">
                    <td colspan="11">
                      <div class="detail">
                        <div class="detail-block">
                          <h3>延迟分布</h3>
                          {#if user.latency}
                            {@const top = Math.max(1, ...user.latency.map((bucket) => bucket.count ?? 0))}
                            <ul class="histogram">
                              {#each user.latency as bucket}
                                <li>
                                  <span class="hist-label">{bucket.label}</span>
                                  <span class="hist-track"><span class={`w-${bucket.count > 0 ? Math.max(2, Math.round((bucket.count / top) * 100)) : 0}`}></span></span>
                                  <span class="hist-value">{fmtInt(bucket.count)}</span>
                                </li>
                              {/each}
                            </ul>
                            <p class="note">p50 ≈ {user.percentiles ? fmtDuration(user.percentiles.p50) : '—'}，p95 ≈ {user.percentiles ? fmtDuration(user.percentiles.p95) : '—'}（{fmtInt(user.percentiles?.samples ?? 0)} 个样本，按桶中点估算）。{#if user.completed && user.percentiles?.samples > 0}覆盖率 {fmtPercent(user.percentiles.samples, user.completed, 1)}。{:else if user.completed}还没有可用的耗时样本：{fmtInt(user.completed)} 个完成请求都在延迟统计上线前结束，不能当作 0 延迟。{:else}尚无完成请求，因此没有延迟样本。{/if}</p>
                          {:else}
                            <p class="absent">服务端尚未提供该用户的延迟直方图。</p>
                          {/if}
                        </div>
                        <div class="detail-block">
                          <h3>结果构成</h3>
                          {#if user.statusBuckets}
                            {@const known = user.statusBuckets.filter((part) => part.count !== null)}
                            {@const total = known.reduce((n, part) => n + (part.count ?? 0), 0)}
                            <div class="stackbar" role="img" aria-label="状态码构成">
                              {#each known as part}
                                {#if part.count > 0}
                                  <span class={`w-${Math.round((part.count / Math.max(total, 1)) * 100)} tone-${part.key}`} title={`${STATUS_LABELS[part.key]}：${fmtInt(part.count)}`}></span>
                                {/if}
                              {/each}
                            </div>
                            <ul class="status-list">
                              {#each user.statusBuckets as part}
                                <li><i class={`tone-${part.key}`}></i>{STATUS_LABELS[part.key]}<b>{fmtInt(part.count)}</b></li>
                              {/each}
                            </ul>
                            {#if known.length < user.statusBuckets.length}
                              <p class="note">“—” 表示服务端没有上报该状态类别，不能视为 0。</p>
                            {/if}
                          {:else}
                            <p class="absent">服务端尚未提供状态码分桶。</p>
                          {/if}
                          <dl class="facts">
                            <div><dt>完成请求</dt><dd>{fmtInt(user.completed)}</dd></div>
                            <div><dt>成功率</dt><dd>{user.successRate === null ? '—' : fmtPercent(user.succeeded, user.completed, 1)}</dd></div>
                            <div><dt>累计耗时</dt><dd>{user.durationMs === null ? '—' : fmtDuration(user.durationMs)}</dd></div>
                            <div><dt>并发峰值</dt><dd>{fmtInt(user.peakActive)}</dd></div>
                          </dl>
                        </div>
                        <div class="detail-block">
                          <h3>响应形态</h3>
                          {#if user.streamed !== null || user.buffered !== null}
                            {@const responses = (user.streamed ?? 0) + (user.buffered ?? 0)}
                            <div class="stackbar pair" role="img" aria-label="流式与缓冲的构成">
                              {#if user.streamed > 0}<span class={`seg-stream w-${Math.round((user.streamed / Math.max(responses, 1)) * 100)}`} title={`流式：${fmtInt(user.streamed)}`}></span>{/if}
                              {#if user.buffered > 0}<span class={`seg-buffer w-${Math.round((user.buffered / Math.max(responses, 1)) * 100)}`} title={`缓冲：${fmtInt(user.buffered)}`}></span>{/if}
                            </div>
                            <ul class="status-list">
                              <li><i class="seg-stream"></i>流式响应<b>{fmtInt(user.streamed)}</b></li>
                              <li><i class="seg-buffer"></i>缓冲响应<b>{fmtInt(user.buffered)}</b></li>
                            </ul>
                            <p class="note">未收到响应头的失败请求两者都不计入。</p>
                          {:else}
                            <p class="absent">服务端尚未提供响应形态计数。</p>
                          {/if}
                          {#if user.kinds}
                            {@const kindTotal = user.kinds.filter((kind) => kind.count !== null).reduce((n, kind) => n + (kind.count ?? 0), 0)}
                            <ul class="status-list">
                              {#each user.kinds as kind}
                                <li>{kind.label}<b>{fmtInt(kind.count)}</b>{#if kind.count !== null && kindTotal > 0}<em>{fmtPercent(kind.count, kindTotal, 1)}</em>{/if}</li>
                              {/each}
                            </ul>
                          {/if}
                          {#if user.headersLatency}
                            {@const headerTop = Math.max(1, ...user.headersLatency.map((bucket) => bucket.count ?? 0))}
                            <h3 class="sub">响应头等待</h3>
                            <ul class="histogram">
                              {#each user.headersLatency as bucket}
                                <li>
                                  <span class="hist-label">{bucket.label}</span>
                                  <span class="hist-track"><span class={`w-${bucket.count > 0 ? Math.max(2, Math.round((bucket.count / headerTop) * 100)) : 0}`}></span></span>
                                  <span class="hist-value">{fmtInt(bucket.count)}</span>
                                </li>
                              {/each}
                            </ul>
                            {#if user.completed && user.headersCovered !== null}
                              <p class="note">
                                覆盖 {fmtInt(user.headersCovered)} / {fmtInt(user.completed)} 个完成请求。
                                {#if user.headersGap > 0}差额 {fmtInt(user.headersGap)} 个没有可测的等待值（未收到响应头或升级前的历史请求），不能当作 0 毫秒。{:else}全部完成请求都有可测的等待值。{/if}
                              </p>
                            {/if}
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
                            {@const miniTop = Math.max(1, ...user.series.map((point) => point.succeeded + point.failed + point.canceled))}
                            <ul class="mini-series">
                              {#each user.series.slice(-12) as point}
                                <li title={`${fmtHour(point.hour)}：${fmtInt(point.succeeded + point.failed + point.canceled)} 请求`}>
                                  <span class={`mini-bar mh-${Math.max(2, Math.round(((point.succeeded + point.failed + point.canceled) / miniTop) * 100))}`}></span>
                                  <span class="mini-hour">{fmtHour(point.hour)}</span>
                                </li>
                              {/each}
                            </ul>
                          {/if}
                          <dl class="facts">
                            <div><dt>流量</dt><dd>{fmtBytes((user.requestBytes ?? 0) + (user.responseBytes ?? 0))}</dd></div>
                            <div><dt>最近活动</dt><dd>{user.lastSeen ? fmtTime(user.lastSeen) : '—'}</dd></div>
                          </dl>
                        </div>
                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        {#if visibleUsers.length === 0}
          <p class="absent">没有符合当前筛选的用户。{query ? `筛选词「${query}」没有命中任何昵称。` : '切换到「全部」可看到所有用户。'}</p>
        {/if}
      {:else if data}
        <p class="absent">还没有用户统计。</p>
      {:else}
        <p class="absent">正在读取统计…</p>
      {/if}
    </section>

    <section class="card withheld" aria-label="不可获得的数据">
      <div class="card-head">
        <div>
          <h2>未在此页展示的数据</h2>
          <p>下列数据没有采集或不能公开，因此页面留空并说明原因，而不是补零。</p>
        </div>
      </div>
      <ul class="withheld-list">
        <li>
          <b>上游路由、token 与账号健康</b>
          <span>渠道路由、账号容量和 token 台账由远端共享池持有，无法归属到单个昵称，也属于运维信息。它们只在需要登录的 <a href="/admin/reports">路由统计</a> 页面展示，不进入这个公开页面。</span>
        </li>
        <li>
          <b>按昵称的模型维度</b>
          <span>渠道路由由远端共享池持有，无法归属到单个昵称。代理核心也不解析模型内容，因此没有「某用户的某模型用量」这一维度。</span>
        </li>
        <li>
          <b>计费账单</b>
          <span>官方价等效值只是按公开标价的估算，不是账单；本页不展示任何账户凭据、密钥或账号标识。</span>
        </li>
      </ul>
    </section>

    <details class="card notes">
      <summary>口径与快照</summary>
      <div class="notes-body">
        <p>请求、结果与耗时由服务器在流式读写时计数；流量是原始正文字节，不做编码解码。平均耗时 = 累计耗时 ÷ 完成请求数（成功 + 失败 + 取消）。</p>
        <p>缺失字段显示为 “—”，不按 0 处理。p50/p95 由延迟桶中点估算，不是精确分位。</p>
        <dl class="meta">
          <div><dt>快照生成</dt><dd>{fmtTime(generatedAt) ?? '未提供'}</dd></div>
          <div><dt>本页读取</dt><dd>{fmtTime(receivedAt) ?? '—'}{ageSeconds !== null ? `（${ageSeconds} 秒前）` : ''}</dd></div>
          <div><dt>存储</dt><dd>{storeLabel ?? '未提供'}</dd></div>
          <div><dt>刷新</dt><dd>{paused ? '已暂停' : '每 15 秒，页面隐藏时暂停'}</dd></div>
        </dl>
      </div>
    </details>
  </main>
  <footer class="foot">公开统计只包含昵称与计数 · <a href="/admin">用户管理</a></footer>
</div>

<p class="sr" role="status" aria-live="polite">{announce}</p>
