<script>
  import { onMount } from 'svelte'
  import {
    normalize, fmtInt, fmtBytes, fmtPercent, fmtDuration, fmtTime, fmtHour,
    aggregateReportStats, sortUsers, FILTER_MODES, filterUsers,
    buildHourlySeries, reportToCsv,
  } from './lib/data.js'

  const POLL_MS = 15_000
  const CACHE_KEY = 'zproxy-status-v2'
  const THEME_KEY = 'zproxy-status-theme'

  let data = $state(null)
  let rawPayload = $state(null)
  let generatedAt = $state(null)
  let receivedAt = $state(null)
  let error = $state('')
  let loading = $state(false)
  let clock = $state(Date.now())
  let expanded = $state([])
  let query = $state('')
  let filterMode = $state('all')
  let sortKey = $state('requests')
  let sortDir = $state('desc')
  let theme = $state('auto')
  let chartMode = $state('results')
  let focusIndex = $state(-1)
  let note = $state('')

  const site = $derived(aggregateReportStats(data))
  const series = $derived(buildHourlySeries(data?.users ?? []))
  const rows = $derived(filterUsers(sortUsers(data?.users ?? [], sortKey, sortDir), { query, mode: filterMode }))
  const totalUsers = $derived(data?.users?.length ?? 0)

  const CHART_MODES = [
    { key: 'results', label: '请求结果' },
    { key: 'traffic', label: '吞吐流量' },
    { key: 'latency', label: '平均耗时' },
  ]
  const THEMES = [
    { key: 'auto', label: '跟随系统' },
    { key: 'light', label: '浅色' },
    { key: 'dark', label: '深色' },
  ]
  const STATUS_LABELS = {
    '2xx': '2xx 成功', '3xx': '3xx 重定向', '4xx': '4xx 客户端错误', '5xx': '5xx 服务端错误',
    noResponse: '未收到响应头', other: '其他',
  }

  const ageSeconds = $derived(
    receivedAt ? Math.max(0, Math.round((clock - new Date(receivedAt).getTime()) / 1000)) : null,
  )
  const countdown = $derived(
    ageSeconds === null ? POLL_MS / 1000 : Math.max(0, POLL_MS / 1000 - ageSeconds),
  )
  const countdownPct = $derived(Math.round((1 - countdown / (POLL_MS / 1000)) * 100))
  const link = $derived(error ? 'degraded' : loading && !data ? 'connecting' : 'live')
  const storeLabel = $derived(
    rawPayload?.store
      ? rawPayload.store.available
        ? rawPayload.store.mode === 'file' ? '已持久化' : '内存中'
        : '存储不可用'
      : null,
  )

  /// Percentages travel as class names, never as a style attribute: the page ships
  /// under `style-src 'self'` with no unsafe-inline, so an inline width is dropped.
  function pct(value, max) {
    const top = Number.isFinite(max) && max > 0 ? max : 1
    const raw = Number.isFinite(value) ? value : 0
    return Math.max(0, Math.min(100, Math.round((raw / top) * 100)))
  }

  const chart = $derived.by(() => {
    const points = series ?? []
    if (points.length === 0) return null
    const metric = (point) => {
      if (chartMode === 'traffic') return point.traffic
      if (chartMode === 'latency') return point.averageMs ?? 0
      return point.completed
    }
    const max = Math.max(1, ...points.map(metric))
    const format = chartMode === 'traffic' ? fmtBytes : chartMode === 'latency' ? (value) => fmtDuration(value) : fmtInt
    const ticks = [1, 0.75, 0.5, 0.25, 0].map((fraction) => ({
      key: fraction,
      label: fraction === 0 ? '0' : format(max * fraction),
    }))
    return { points, max, metric, ticks }
  })

  const activePoint = $derived(
    chart && focusIndex >= 0 && focusIndex < chart.points.length ? chart.points[focusIndex] : null,
  )

  function applyTheme(next) {
    theme = next
    const root = document.documentElement
    if (next === 'auto') delete root.dataset.theme
    else root.dataset.theme = next
    try { localStorage.setItem(THEME_KEY, next) } catch { /* a blocked store only costs persistence */ }
  }

  function restore() {
    try {
      const saved = sessionStorage.getItem(CACHE_KEY)
      if (!saved) return
      const cached = JSON.parse(saved)
      data = normalize(cached.payload)
      rawPayload = cached.payload
      generatedAt = cached.generatedAt ?? null
      receivedAt = cached.receivedAt ?? null
      if ((data.users?.length ?? 0) > 0) error = '正在刷新，先显示上次成功读取的快照。'
    } catch {
      sessionStorage.removeItem(CACHE_KEY)
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
      data = next
      rawPayload = payload
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
    } catch { /* the default follows the system */ }
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

  function toggleRow(nickname) {
    expanded = expanded.includes(nickname)
      ? expanded.filter((name) => name !== nickname)
      : [...expanded, nickname]
  }

  function toggleAll() {
    const all = (data?.users ?? []).map((user) => user.nickname)
    expanded = expanded.length >= all.length && all.length > 0 ? [] : all
  }

  function sortBy(key) {
    if (sortKey === key) sortDir = sortDir === 'desc' ? 'asc' : 'desc'
    else { sortKey = key; sortDir = 'desc' }
  }

  function downloadCsv() {
    if (!data) return
    const blob = new Blob([reportToCsv(data)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `zproxy-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function copySnapshot() {
    if (!rawPayload) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(rawPayload, null, 2))
      note = '快照 JSON 已复制到剪贴板。'
    } catch {
      note = '剪贴板不可用：浏览器拒绝写入。'
    }
    setTimeout(() => { note = '' }, 4_000)
  }

  function segmentClass(key, active) {
    return active === key ? 'active' : ''
  }
</script>

<svelte:head>
  <title>zproxy · 用量统计</title>
</svelte:head>

<a class="skip-link" href="#main-content">跳到主要内容</a>

<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <div>
        <h1>zproxy</h1>
        <p>流式补全代理 · 用量统计</p>
      </div>
    </div>
    <div class="controls">
      <span class="link-state {link}">
        <i aria-hidden="true"></i>{link === 'live' ? '实时' : link === 'degraded' ? '快照' : '连接中'}
        {#if ageSeconds !== null}<em>{ageSeconds}s 前</em>{/if}
      </span>
      <div class="seg" role="group" aria-label="主题">
        {#each THEMES as option}
          <button
            type="button"
            class={segmentClass(option.key, theme)}
            aria-pressed={theme === option.key}
            onclick={() => applyTheme(option.key)}
          >{option.label}</button>
        {/each}
      </div>
      <button class="tool" type="button" onclick={downloadCsv} disabled={!data} title="按当前昵称与计数导出 CSV">导出 CSV</button>
      <button class="tool" type="button" onclick={copySnapshot} disabled={!rawPayload} title="复制服务端原始快照">复制 JSON</button>
      <button class="refresh" type="button" onclick={load} disabled={loading} aria-label="立即刷新统计">
        {loading ? '刷新中…' : '刷新'}
      </button>
    </div>
    <div class="countdown" aria-hidden="true"><span class={`w-${countdownPct}`}></span></div>
  </header>

  {#if note}
    <p class="toast" role="status">{note}</p>
  {/if}

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
        <p class="huge">{fmtInt(site.active)}</p>
        <p class="hint">已认证且尚未结束的请求</p>
        <div class="hero-meter" aria-hidden="true">
          <span class={`w-${pct(site.active, site.requests)}`}></span>
        </div>
        <p class="hero-foot">
          存储 <b>{storeLabel ?? '未提供'}</b>
          {#if rawPayload?.store?.keepHours}<span>· 保留 {rawPayload.store.keepHours} 小时</span>{/if}
        </p>
      </div>
      <dl class="hero-grid">
        <div>
          <dt>累计请求</dt>
          <dd>{fmtInt(site.requests)}</dd>
          <p>成功 {fmtInt(site.succeeded)} · 取消 {fmtInt(site.canceled)}</p>
        </div>
        <div>
          <dt>成功率</dt>
          <dd class:bad={site.successRate !== null && site.successRate < 0.95}>
            {site.successRate === null ? '—' : fmtPercent(site.succeeded, site.completed, 2)}
          </dd>
          <p>失败 {fmtInt(site.failed)} / 完成 {fmtInt(site.completed)}</p>
        </div>
        <div>
          <dt>平均耗时</dt>
          <dd>{site.averageMs === null ? '—' : fmtDuration(site.averageMs)}</dd>
          <p>p50 ≈ {site.percentiles ? fmtDuration(site.percentiles.p50) : '—'} · p95 ≈ {site.percentiles ? fmtDuration(site.percentiles.p95) : '—'}</p>
        </div>
        <div>
          <dt>流量</dt>
          <dd>{fmtBytes((site.requestBytes ?? 0) + (site.responseBytes ?? 0))}</dd>
          <p>上行 {fmtBytes(site.requestBytes)} · 下行 {fmtBytes(site.responseBytes)}</p>
        </div>
      </dl>
    </section>

    <section class="card" aria-label="全站构成">
      <div class="card-head">
        <div>
          <h2>全站构成</h2>
          <p>无需展开任何用户即可看到全站健康度。分桶逐项相加，服务端未上报的类别显示 “—”，不按 0 处理。</p>
        </div>
        <p class="card-total">{fmtInt(site.users)} <span>位用户</span></p>
      </div>
      <div class="site-grid">
        <div class="site-block">
          <h3>状态码</h3>
          {#if site.statusBuckets}
            {@const known = site.statusBuckets.filter((part) => part.count !== null)}
            {@const statusTotal = known.reduce((n, part) => n + part.count, 0)}
            <div class="stackbar" role="img" aria-label="全站状态码构成">
              {#each known as part}
                {#if part.count > 0}
                  <span class={`tone-${part.key} w-${pct(part.count, Math.max(statusTotal, 1))}`} title={`${STATUS_LABELS[part.key] ?? part.label}：${fmtInt(part.count)}`}></span>
                {/if}
              {/each}
            </div>
            <ul class="status-list">
              {#each site.statusBuckets as part}
                <li>
                  <i class={`tone-${part.key}`} aria-hidden="true"></i>
                  {STATUS_LABELS[part.key] ?? part.label}
                  <b>{part.count === null ? '—' : fmtInt(part.count)}</b>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="absent">服务端尚未上报状态码分桶。</p>
          {/if}
        </div>
        <div class="site-block">
          <h3>延迟分布</h3>
          {#if site.latency}
            {@const latencyTop = Math.max(1, ...site.latency.map((bucket) => bucket.count ?? 0))}
            <ul class="histogram">
              {#each site.latency as bucket}
                <li>
                  <span class="hist-label">{bucket.label}</span>
                  <span class="hist-track"><span class={`w-${bucket.count > 0 ? Math.max(2, pct(bucket.count, latencyTop)) : 0}`}></span></span>
                  <span class="hist-value">{bucket.count === null ? '—' : fmtInt(bucket.count)}</span>
                </li>
              {/each}
            </ul>
            <p class="note">全站 p50 ≈ {site.percentiles ? fmtDuration(site.percentiles.p50) : '—'}，p95 ≈ {site.percentiles ? fmtDuration(site.percentiles.p95) : '—'}（{fmtInt(site.percentiles?.samples ?? 0)} 个样本，按桶中点估算）。</p>
          {:else}
            <p class="absent">服务端尚未上报延迟直方图。</p>
          {/if}
        </div>
        <div class="site-block">
          <h3>响应头等待</h3>
          {#if site.headersLatency}
            {@const headerTop = Math.max(1, ...site.headersLatency.map((bucket) => bucket.count ?? 0))}
            <ul class="histogram">
              {#each site.headersLatency as bucket}
                <li>
                  <span class="hist-label">{bucket.label}</span>
                  <span class="hist-track"><span class={`w-${bucket.count > 0 ? Math.max(2, pct(bucket.count, headerTop)) : 0}`}></span></span>
                  <span class="hist-value">{bucket.count === null ? '—' : fmtInt(bucket.count)}</span>
                </li>
              {/each}
            </ul>
            <p class="note">从请求开始到响应头到达的时间，正文传输前的那一段等待。</p>
          {:else}
            <p class="absent">服务端尚未上报响应头等待直方图。</p>
          {/if}
        </div>
        <div class="site-block">
          <h3>请求形态</h3>
          {#if site.kinds || site.streamed !== null || site.buffered !== null}
            <dl class="facts compact">
              <div><dt>流式响应</dt><dd>{fmtInt(site.streamed)}</dd></div>
              <div><dt>缓冲响应</dt><dd>{fmtInt(site.buffered)}</dd></div>
              <div><dt>并发峰值</dt><dd>{fmtInt(site.peakActive)}</dd></div>
              <div><dt>最近活动</dt><dd>{site.lastSeen ? fmtTime(site.lastSeen) : '—'}</dd></div>
            </dl>
            {#if site.kinds}
              <ul class="status-list tight">
                {#each site.kinds as kind}
                  <li>{kind.label}<b>{kind.count === null ? '—' : fmtInt(kind.count)}</b></li>
                {/each}
              </ul>
            {/if}
            <p class="note">并发峰值取单个用户的最高同时进行数，不把不同用户的峰值相加。</p>
          {:else}
            <p class="absent">服务端尚未上报响应形态计数。</p>
          {/if}
        </div>
      </div>
    </section>

    <section class="card" aria-label="24 小时趋势">
      <div class="card-head">
        <div>
          <h2>24 小时趋势</h2>
          <p>最近 {series?.length ?? 0} 个小时桶。切换指标查看结果堆叠、吞吐流量或平均耗时。</p>
        </div>
        <div class="pills" role="group" aria-label="图表指标">
          {#each CHART_MODES as option}
            <button
              type="button"
              class={segmentClass(option.key, chartMode)}
              aria-pressed={chartMode === option.key}
              onclick={() => { chartMode = option.key; focusIndex = -1 }}
            >{option.label}</button>
          {/each}
        </div>
      </div>
      {#if chart === null}
        <p class="absent">
          {series === null
            ? '服务端尚未提供小时序列。累计值仍然准确；时间维度需要在统计存储中记录滚动小时桶。'
            : '此窗口内还没有小时记录。早于本次统计版本的请求只计入累计值，没有被分到小时桶，因此这里保持空白而不是补零。'}
        </p>
      {:else}
        <div class="plot">
          <div class="ticks" aria-hidden="true">
            {#each chart.ticks as tick}
              <span>{tick.label}</span>
            {/each}
          </div>
          <div class="bars" role="group" aria-label={`按小时${CHART_MODES.find((m) => m.key === chartMode)?.label ?? ''}`}>
            {#each chart.points as point, index}
              {@const okHeight = chartMode === 'results' ? pct(point.succeeded, chart.max) : 0}
              {@const badHeight = chartMode === 'results' ? pct(point.failed, chart.max) : 0}
              {@const offHeight = chartMode === 'results' ? pct(point.canceled, chart.max) : 0}
              {@const upHeight = chartMode === 'traffic' ? pct(point.requestBytes, chart.max) : 0}
              {@const downHeight = chartMode === 'traffic' ? pct(point.responseBytes, chart.max) : 0}
              {@const valueHeight = chartMode === 'latency' ? pct(point.averageMs ?? 0, chart.max) : 0}
              <!-- A bar is a focus stop: keyboard users get the same readout as hover. -->
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                class="bar-col"
                class:active={focusIndex === index}
                tabindex="0"
                role="button"
                aria-label={`${fmtHour(point.hour)}，${fmtInt(point.completed)} 个完成请求`}
                onmouseenter={() => { focusIndex = index }}
                onmouseleave={() => { focusIndex = -1 }}
                onfocus={() => { focusIndex = index }}
                onblur={() => { focusIndex = -1 }}
              >
                {#if chartMode === 'results'}
                  <span class={`seg-failed mh-${badHeight}`}></span>
                  <span class={`seg-canceled mh-${offHeight}`}></span>
                  <span class={`seg-ok mh-${okHeight}`}></span>
                {:else if chartMode === 'traffic'}
                  <span class={`seg-down mh-${downHeight}`}></span>
                  <span class={`seg-up mh-${upHeight}`}></span>
                {:else}
                  <span class={`seg-latency mh-${valueHeight}`}></span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
        <div class="readout" role="status" aria-live="polite">
          {#if activePoint}
            <strong>{fmtHour(activePoint.hour)}</strong>
            <span>完成 {fmtInt(activePoint.completed)}</span>
            <span>成功 {fmtInt(activePoint.succeeded)}</span>
            <span>失败 {fmtInt(activePoint.failed)}</span>
            <span>取消 {fmtInt(activePoint.canceled)}</span>
            <span>上行 {fmtBytes(activePoint.requestBytes)}</span>
            <span>下行 {fmtBytes(activePoint.responseBytes)}</span>
            <span>平均 {(activePoint.averageMs === null ? '—' : fmtDuration(activePoint.averageMs))}</span>
          {:else if chart.points.length > 0}
            {@const last = chart.points[chart.points.length - 1]}
            <strong>{fmtHour(last.hour)}</strong>
            <span>完成 {fmtInt(last.completed)}</span>
            <span>成功 {fmtInt(last.succeeded)}</span>
            <span>失败 {fmtInt(last.failed)}</span>
            <span>平均 {(last.averageMs === null ? '—' : fmtDuration(last.averageMs))}</span>
            <span class="hintline">悬停或聚焦任意柱查看该小时</span>
          {/if}
        </div>
        <p class="legend">
          {#if chartMode === 'results'}
            <i class="seg-ok" aria-hidden="true"></i>成功 <i class="seg-failed" aria-hidden="true"></i>失败 <i class="seg-canceled" aria-hidden="true"></i>取消
          {:else if chartMode === 'traffic'}
            <i class="seg-up" aria-hidden="true"></i>上行 <i class="seg-down" aria-hidden="true"></i>下行
          {:else}
            <i class="seg-latency" aria-hidden="true"></i>平均耗时（完成请求的累计耗时 ÷ 完成数）
          {/if}
          <span class="peak">{fmtHour(chart.points[0].hour)} — {fmtHour(chart.points[chart.points.length - 1].hour)}</span>
        </p>
      {/if}
    </section>

    <section class="card users" aria-label="按用户">
      <div class="card-head">
        <div>
          <h2>用户用量</h2>
          <p>按昵称汇总。点击表头排序，展开一行可看延迟分布、状态码构成与响应形态。</p>
        </div>
        <div class="table-tools">
          <label class="search">
            <span class="sr">按昵称过滤</span>
            <input type="search" bind:value={query} placeholder="过滤昵称" />
          </label>
          <div class="pills" role="group" aria-label="筛选">
            {#each FILTER_MODES as mode}
              <button
                type="button"
                class={segmentClass(mode.key, filterMode)}
                aria-pressed={filterMode === mode.key}
                onclick={() => { filterMode = mode.key }}
              >{mode.label}</button>
            {/each}
          </div>
          <button class="tool" type="button" onclick={toggleAll} disabled={totalUsers === 0}>
            {expanded.length >= totalUsers && totalUsers > 0 ? '全部收起' : '全部展开'}
          </button>
        </div>
      </div>
      {#if totalUsers > 0}
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <button type="button" class="sortable" onclick={() => sortBy('nickname')} aria-sort={sortKey === 'nickname' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                    昵称{#if sortKey === 'nickname'}<i aria-hidden="true">{sortDir === 'desc' ? '▾' : '▴'}</i>{/if}
                  </button>
                </th>
                <th scope="col" class="num">
                  <button type="button" class="sortable" onclick={() => sortBy('requests')} aria-sort={sortKey === 'requests' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                    请求{#if sortKey === 'requests'}<i aria-hidden="true">{sortDir === 'desc' ? '▾' : '▴'}</i>{/if}
                  </button>
                </th>
                <th scope="col" class="num col-opt">成功</th>
                <th scope="col" class="num">
                  <button type="button" class="sortable" onclick={() => sortBy('failed')} aria-sort={sortKey === 'failed' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                    失败{#if sortKey === 'failed'}<i aria-hidden="true">{sortDir === 'desc' ? '▾' : '▴'}</i>{/if}
                  </button>
                </th>
                <th scope="col" class="num col-opt">取消</th>
                <th scope="col" class="num col-opt">进行中</th>
                <th scope="col" class="num">
                  <button type="button" class="sortable" onclick={() => sortBy('averageMs')} aria-sort={sortKey === 'averageMs' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                    平均耗时{#if sortKey === 'averageMs'}<i aria-hidden="true">{sortDir === 'desc' ? '▾' : '▴'}</i>{/if}
                  </button>
                </th>
                <th scope="col" class="num col-opt">
                  <button type="button" class="sortable" onclick={() => sortBy('p95')} aria-sort={sortKey === 'p95' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                    p95{#if sortKey === 'p95'}<i aria-hidden="true">{sortDir === 'desc' ? '▾' : '▴'}</i>{/if}
                  </button>
                </th>
                <th scope="col" class="num col-opt">
                  <button type="button" class="sortable" onclick={() => sortBy('traffic')} aria-sort={sortKey === 'traffic' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                    流量{#if sortKey === 'traffic'}<i aria-hidden="true">{sortDir === 'desc' ? '▾' : '▴'}</i>{/if}
                  </button>
                </th>
                <th scope="col" class="num col-opt">
                  <button type="button" class="sortable" onclick={() => sortBy('lastSeen')} aria-sort={sortKey === 'lastSeen' ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                    最近活动{#if sortKey === 'lastSeen'}<i aria-hidden="true">{sortDir === 'desc' ? '▾' : '▴'}</i>{/if}
                  </button>
                </th>
                <th scope="col"><span class="sr">展开</span></th>
              </tr>
            </thead>
            <tbody>
              {#each rows as user (user.nickname)}
                {@const open = expanded.includes(user.nickname)}
                <tr class:open>
                  <th scope="row">
                    <button type="button" class="row-toggle" onclick={() => toggleRow(user.nickname)} aria-expanded={open}>
                      {user.nickname}
                    </button>
                  </th>
                  <td class="num">{fmtInt(user.requests)}</td>
                  <td class="num col-opt">{fmtInt(user.succeeded)}</td>
                  <td class="num" class:bad={user.failed}>{fmtInt(user.failed)}</td>
                  <td class="num col-opt">{fmtInt(user.canceled)}</td>
                  <td class="num col-opt">{fmtInt(user.active)}</td>
                  <td class="num">{user.averageMs === null ? '—' : fmtDuration(user.averageMs)}</td>
                  <td class="num col-opt">{user.percentiles ? fmtDuration(user.percentiles.p95) : '—'}</td>
                  <td class="num col-opt">{fmtBytes((user.requestBytes ?? 0) + (user.responseBytes ?? 0))}</td>
                  <td class="num col-opt">{user.lastSeen ? fmtTime(user.lastSeen) : '—'}</td>
                  <td class="chev"><span aria-hidden="true">{open ? '▾' : '▸'}</span></td>
                </tr>
                {#if open}
                  <tr class="detail-row">
                    <td colspan="11">
                      <div class="detail">
                        <div class="detail-block">
                          <h3>延迟分布</h3>
                          {#if user.latency}
                            {@const top = Math.max(1, ...user.latency.map((bucket) => bucket.count))}
                            <ul class="histogram">
                              {#each user.latency as bucket}
                                <li>
                                  <span class="hist-label">{bucket.label}</span>
                                  <span class="hist-track"><span class={`w-${bucket.count > 0 ? Math.max(2, pct(bucket.count, top)) : 0}`}></span></span>
                                  <span class="hist-value">{fmtInt(bucket.count)}</span>
                                </li>
                              {/each}
                            </ul>
                            <p class="note">来自完成请求的直方图；p50 ≈ {user.percentiles ? fmtDuration(user.percentiles.p50) : '—'}，p95 ≈ {user.percentiles ? fmtDuration(user.percentiles.p95) : '—'}（{fmtInt(user.percentiles?.samples ?? 0)} 个样本，按桶中点估算）。{#if user.completed && (user.percentiles?.samples ?? 0) > 0}覆盖率 {fmtPercent(user.percentiles.samples, user.completed, 1)}。{:else if user.completed}还没有可用的耗时样本：{fmtInt(user.completed)} 个完成请求都在延迟统计上线前结束，不能当作 0 延迟。{:else}尚无完成请求，因此没有延迟样本。{/if}</p>
                          {:else}
                            <p class="absent">服务端尚未提供该用户的延迟直方图。</p>
                          {/if}
                          {#if user.headersLatency}
                            {@const headerTop = Math.max(1, ...user.headersLatency.map((bucket) => bucket.count))}
                            <h3 class="sub">响应头等待</h3>
                            <ul class="histogram">
                              {#each user.headersLatency as bucket}
                                <li>
                                  <span class="hist-label">{bucket.label}</span>
                                  <span class="hist-track"><span class={`w-${bucket.count > 0 ? Math.max(2, pct(bucket.count, headerTop)) : 0}`}></span></span>
                                  <span class="hist-value">{fmtInt(bucket.count)}</span>
                                </li>
                              {/each}
                            </ul>
                            <p class="note">
                              从请求开始到收到响应头的时间，即正文开始前的等待。
                              {#if user.completed && user.headersCovered !== null}
                                {#if user.headersGap === 0}
                                  全部 {fmtInt(user.completed)} 个完成请求都有可测的等待值。
                                {:else if user.noResponseCount !== null}
                                  {@const legacy = Math.max(0, user.headersGap - user.noResponseCount)}
                                  覆盖 {fmtInt(user.headersCovered)} / {fmtInt(user.completed)} 个完成请求。差额 {fmtInt(user.headersGap)} 个没有可测的等待值：{fmtInt(user.noResponseCount)} 个记录为未收到响应头{#if legacy > 0}，另有 {fmtInt(legacy)} 个是统计上线前完成的历史请求{/if}。两类都不能当作 0 毫秒。
                                {:else}
                                  覆盖 {fmtInt(user.headersCovered)} / {fmtInt(user.completed)} 个完成请求。差额 {fmtInt(user.headersGap)} 个既包括未收到响应头的请求，也包括升级前的历史请求；服务端没有提供状态分桶，无法在这里区分。都不能当作 0 毫秒。
                                {/if}
                              {/if}
                            </p>
                          {:else}
                            <p class="absent">服务端尚未提供响应头等待直方图。</p>
                          {/if}
                        </div>
                        <div class="detail-block">
                          <h3>结果构成</h3>
                          {#if user.statusBuckets}
                            {@const known = user.statusBuckets.filter((part) => part.count !== null)}
                            {@const total = known.reduce((n, part) => n + part.count, 0)}
                            <div class="stackbar" role="img" aria-label={`${user.nickname} 的状态码构成`}>
                              {#each known as part}
                                {#if part.count > 0}
                                  <span class={`tone-${part.key} w-${pct(part.count, Math.max(total, 1))}`} title={`${STATUS_LABELS[part.key] ?? part.label}：${fmtInt(part.count)}`}></span>
                                {/if}
                              {/each}
                            </div>
                            <ul class="status-list">
                              {#each user.statusBuckets as part}
                                <li><i class={`tone-${part.key}`} aria-hidden="true"></i>{STATUS_LABELS[part.key] ?? part.label}<b>{fmtInt(part.count)}</b></li>
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
                            <div><dt>流量</dt><dd>{fmtBytes((user.requestBytes ?? 0) + (user.responseBytes ?? 0))}</dd></div>
                          </dl>
                        </div>
                        <div class="detail-block">
                          <h3>响应与并发</h3>
                          {#if user.kinds}
                            {@const kindTotal = user.kinds.filter((k) => k.count !== null).reduce((n, k) => n + k.count, 0)}
                            <ul class="status-list">
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
                            {#if (user.streamed ?? 0) + (user.buffered ?? 0) > 0}
                              <div class="segbar" role="img" aria-label="流式与缓冲占比">
                                <span class={`seg-up w-${pct(user.streamed ?? 0, (user.streamed ?? 0) + (user.buffered ?? 0))}`}></span>
                                <span class={`seg-down w-${pct(user.buffered ?? 0, (user.streamed ?? 0) + (user.buffered ?? 0))}`}></span>
                              </div>
                              <p class="note">流式/缓冲按响应是否带流式元数据分组，不解析正文；未收到响应头的失败请求两者都不计入。</p>
                            {:else}
                              <p class="note">还没有带响应形态的完成请求。</p>
                            {/if}
                          {:else}
                            <p class="absent">服务端尚未提供响应形态与并发计数。</p>
                          {/if}
                          <h3 class="sub">最近小时</h3>
                          {#if user.series === null}
                            <p class="absent">服务端尚未提供该用户的小时序列。</p>
                          {:else if user.series.length === 0}
                            <p class="absent">该用户在此窗口内还没有小时记录；更早的请求只计入累计值。</p>
                          {:else}
                            {@const miniTop = Math.max(1, ...user.series.map((p) => p.succeeded + p.failed + p.canceled))}
                            <ul class="mini-series">
                              {#each user.series.slice(-12) as point}
                                <li title={`${fmtHour(point.hour)}：${fmtInt(point.succeeded + point.failed + point.canceled)} 请求`}>
                                  <span class={`mini-bar mh-${Math.max(2, pct(point.succeeded + point.failed + point.canceled, miniTop))}`}></span>
                                  <span class="mini-hour">{fmtHour(point.hour)}</span>
                                </li>
                              {/each}
                            </ul>
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
          <p class="absent">没有符合当前筛选条件的用户。</p>
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
        <p>缺失字段显示为 “—”，不按 0 处理。p50/p95 由延迟桶中点估算，不是精确分位。全站直方图逐桶相加，任何用户都未上报的桶保持 “—”。</p>
        <p>并发峰值取单个用户的最高同时进行数，不把不同用户的峰值相加。</p>
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

