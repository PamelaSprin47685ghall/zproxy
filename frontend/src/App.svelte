<script>
  import { onMount } from 'svelte'
  import {
    normalize, totalOf, mergedSeries, fmtInt, fmtBytes, fmtPercent,
    fmtDuration, fmtTime, fmtHour, LATENCY_LABELS,
  } from './lib/data.js'

  const POLL_MS = 15_000
  const CACHE_KEY = 'zproxy-status-v1'

  let data = $state(null)
  let generatedAt = $state(null)
  let receivedAt = $state(null)
  let error = $state('')
  let loading = $state(false)
  let expanded = $state('')
  let clock = $state(0)

  const requests = $derived(totalOf(data, 'requests'))
  const succeeded = $derived(totalOf(data, 'succeeded'))
  const failed = $derived(totalOf(data, 'failed'))
  const canceled = $derived(totalOf(data, 'canceled'))
  const active = $derived(totalOf(data, 'active'))
  const requestBytes = $derived(totalOf(data, 'requestBytes'))
  const responseBytes = $derived(totalOf(data, 'responseBytes'))
  const durationMs = $derived(totalOf(data, 'durationMs'))
  const completed = $derived(
    succeeded === null && failed === null && canceled === null ? null : (succeeded ?? 0) + (failed ?? 0) + (canceled ?? 0),
  )
  const averageMs = $derived(completed && completed > 0 && durationMs !== null ? durationMs / completed : null)
  const failureRate = $derived(completed && completed > 0 ? ((failed ?? 0) + (canceled ?? 0)) / completed : null)
  const series = $derived(mergedSeries(data))
  const peak = $derived(series ? Math.max(1, ...series.map((p) => p.succeeded + p.failed + p.canceled)) : 1)
  const seriesTotal = $derived(series ? series.reduce((n, p) => n + p.succeeded + p.failed + p.canceled, 0) : null)
  const windowHours = $derived(series ? series.length : 0)
  const storeLabel = $derived(
    data?.store ? (data.store.available ? (data.store.mode === 'file' ? '已持久化' : '内存中') : '存储不可用') : null,
  )

  function restore() {
    try {
      const saved = sessionStorage.getItem(CACHE_KEY)
      if (!saved) return
      const parsed = JSON.parse(saved)
      data = normalize(parsed.payload)
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
      error = data ? `刷新失败：${reason}。以下为 ${fmtTime(generatedAt) ?? '更早'} 的最后成功快照。` : `无法读取统计：${reason}。`
    } finally {
      clearTimeout(timer)
      loading = false
    }
  }

  onMount(() => {
    restore()
    load()
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, POLL_MS)
    const tick = setInterval(() => { clock = Date.now() }, 1000)
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

  const statusColors = { '2xx': 'var(--ok)', '3xx': 'var(--info)', '4xx': 'var(--warn)', '5xx': 'var(--bad)', noResponse: 'var(--muted)', other: 'var(--muted)' }
  const statusLabels = {
    '2xx': '2xx 成功', '3xx': '3xx 重定向', '4xx': '4xx 客户端错误', '5xx': '5xx 服务端错误',
    noResponse: '未收到响应头', other: '其他',
  }
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
      <span class="link-state {link}"><i aria-hidden="true"></i>{link === 'live' ? '实时' : link === 'degraded' ? '快照' : '连接中'}</span>
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

  <main class="wrap">
    <section class="hero" aria-label="全站概览">
      <div class="hero-main">
        <p class="eyebrow">进行中</p>
        <p class="huge">{fmtInt(active)}</p>
        <p class="hint">已认证且尚未结束的请求</p>
        <div class="hero-meter" aria-hidden="true">
          <span style:width="{active && requests ? Math.min(100, (active / Math.max(requests, 1)) * 100) : 0}%"></span>
        </div>
      </div>
      <dl class="hero-grid">
        <div>
          <dt>累计请求</dt>
          <dd>{fmtInt(requests)}</dd>
          <p>成功 {fmtInt(succeeded)} · 取消 {fmtInt(canceled)}</p>
        </div>
        <div>
          <dt>失败率</dt>
          <dd class:bad={failureRate !== null && failureRate > 0.05}>{failureRate === null ? '—' : fmtPercent((failed ?? 0) + (canceled ?? 0), completed, 2)}</dd>
          <p>失败 {fmtInt(failed)} / 完成 {fmtInt(completed)}</p>
        </div>
        <div>
          <dt>平均耗时</dt>
          <dd>{averageMs === null ? '—' : fmtDuration(averageMs)}</dd>
          <p>累计 {durationMs === null ? '—' : fmtDuration(durationMs)}</p>
        </div>
        <div>
          <dt>上行流量</dt>
          <dd>{fmtBytes(requestBytes)}</dd>
          <p>下行 {fmtBytes(responseBytes)}</p>
        </div>
      </dl>
    </section>

    <section class="card" aria-label="小时吞吐">
      <div class="card-head">
        <div>
          <h2>小时吞吐</h2>
          <p>最近 {windowHours || '—'} 个小时桶；柱高为完成请求数，颜色区分结果。</p>
        </div>
        {#if seriesTotal !== null}
          <p class="card-total">{fmtInt(seriesTotal)} <span>请求 / 窗口</span></p>
        {/if}
      </div>
      {#if series === null}
        <p class="absent">服务端尚未提供小时序列。累计值仍然准确；时间维度需要在统计存储中记录滚动小时桶。</p>
      {:else if series.length === 0}
        <p class="absent">此窗口内还没有小时记录。早于本次统计版本的请求只计入累计值，没有被分到小时桶，因此这里保持空白而不是补零。</p>
      {:else}
        <div class="chart" role="img" aria-label="按小时堆叠的请求结果柱状图">
          <svg viewBox="0 0 720 200" preserveAspectRatio="none">
            {#each [0, 0.25, 0.5, 0.75, 1] as line}
              <line x1="0" x2="720" y1={180 - line * 160} y2={180 - line * 160} class="grid" />
            {/each}
            {#each series as point, index}
              {@const slot = 720 / series.length}
              {@const width = Math.max(2, slot * 0.62)}
              {@const ok = (point.succeeded / peak) * 160}
              {@const bad = (point.failed / peak) * 160}
              {@const off = (point.canceled / peak) * 160}
              {@const x = index * slot + (slot - width) / 2}
              <rect x={x} y={180 - ok} width={width} height={ok} class="bar-ok" />
              <rect x={x} y={180 - ok - bad} width={width} height={bad} class="bar-bad" />
              <rect x={x} y={180 - ok - bad - off} width={width} height={off} class="bar-off" />
            {/each}
            <line x1="0" x2="720" y1="180" y2="180" class="axis" />
          </svg>
          <div class="axis-labels">
            <span>{fmtHour(series[0].hour)}</span>
            <span>{fmtHour(series[Math.floor(series.length / 2)].hour)}</span>
            <span>{fmtHour(series[series.length - 1].hour)}</span>
          </div>
        </div>
        <p class="legend"><i class="ok"></i>成功 <i class="bad"></i>失败 <i class="off"></i>取消<span class="peak">峰值 {fmtInt(peak)} / 小时</span></p>
      {/if}
    </section>

    <section class="card users" aria-label="按用户">
      <div class="card-head">
        <div>
          <h2>用户用量</h2>
          <p>按昵称汇总。展开一行可看延迟分布与状态码构成。</p>
        </div>
        <p class="card-total">{fmtInt(data?.users.length ?? 0)} <span>位用户</span></p>
      </div>
      {#if data && data.users.length > 0}
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">昵称</th>
                <th scope="col" class="num">请求</th>
                <th scope="col" class="num">成功</th>
                <th scope="col" class="num">失败</th>
                <th scope="col" class="num col-opt">取消</th>
                <th scope="col" class="num col-opt">进行中</th>
                <th scope="col" class="num col-opt">上行</th>
                <th scope="col" class="num col-opt">下行</th>
                <th scope="col" class="num">平均耗时</th>
                <th scope="col" class="num col-opt">p50 / p95</th>
                <th scope="col"><span class="sr">展开</span></th>
              </tr>
            </thead>
            <tbody>
              {#each data.users as user (user.nickname)}
                <tr class:open={expanded === user.nickname}>
                  <th scope="row">
                    <button type="button" class="row-toggle" onclick={() => toggle(user.nickname)} aria-expanded={expanded === user.nickname}>
                      {user.nickname}
                    </button>
                  </th>
                  <td class="num">{fmtInt(user.requests)}</td>
                  <td class="num">{fmtInt(user.succeeded)}</td>
                  <td class="num" class:bad={user.failed}>{fmtInt(user.failed)}</td>
                  <td class="num col-opt">{fmtInt(user.canceled)}</td>
                  <td class="num col-opt">{fmtInt(user.active)}</td>
                  <td class="num col-opt">{fmtBytes(user.requestBytes)}</td>
                  <td class="num col-opt">{fmtBytes(user.responseBytes)}</td>
                  <td class="num">{user.averageMs === null ? '—' : fmtDuration(user.averageMs)}</td>
                  <td class="num col-opt">{user.percentiles ? `${fmtDuration(user.percentiles.p50)} / ${fmtDuration(user.percentiles.p95)}` : '—'}</td>
                  <td class="chev"><span aria-hidden="true">{expanded === user.nickname ? '▾' : '▸'}</span></td>
                </tr>
                {#if expanded === user.nickname}
                  <tr class="detail-row">
                    <td colspan="11">
                      <div class="detail">
                        <div class="detail-block">
                          <h3>延迟分布</h3>
                          {#if user.latency}
                            {@const covered = user.percentiles?.samples ?? 0}
                            <ul class="histogram">
                              {#each user.latency as bucket}
                                {@const top = Math.max(1, ...user.latency.map((b) => b.count))}
                                <li>
                                  <span class="hist-label">{bucket.label}</span>
                                  <span class="hist-track"><span style:width="{bucket.count > 0 ? Math.max(2, (bucket.count / top) * 100) : 0}%"></span></span>
                                  <span class="hist-value">{fmtInt(bucket.count)}</span>
                                </li>
                              {/each}
                            </ul>
                            <p class="note">来自完成请求的直方图；p50 ≈ {user.percentiles ? fmtDuration(user.percentiles.p50) : '—'}，p95 ≈ {user.percentiles ? fmtDuration(user.percentiles.p95) : '—'}（{fmtInt(user.percentiles?.samples ?? 0)} 个样本，按桶中点估算）。{#if user.completed && covered > 0}覆盖率 {fmtPercent(covered, user.completed, 1)}（{fmtInt(covered)} / {fmtInt(user.completed)} 个完成请求有耗时样本）。{:else if user.completed}还没有可用的耗时样本：{fmtInt(user.completed)} 个完成请求都在延迟统计上线前结束，不能当作 0 延迟。{:else}尚无完成请求，因此没有延迟样本。{/if}</p>
                          {:else}
                            <p class="absent">服务端尚未提供该用户的延迟直方图。</p>
                          {/if}
                        </div>
                        <div class="detail-block">
                          <h3>结果构成</h3>
                          {#if user.statusBuckets}
                            {@const known = user.statusBuckets.filter((part) => part.count !== null)}
                            {@const total = known.reduce((n, part) => n + part.count, 0)}
                            <div class="stackbar" role="img" aria-label="状态码构成">
                              {#each known as part}
                                {#if part.count > 0}
                                  <span style:width="{(part.count / Math.max(total, 1)) * 100}%" style:background={statusColors[part.key]} title="{statusLabels[part.key]}：{fmtInt(part.count)}"></span>
                                {/if}
                              {/each}
                            </div>
                            <ul class="status-list">
                              {#each user.statusBuckets as part}
                                <li><i style:background={statusColors[part.key]}></i>{statusLabels[part.key]}<b>{fmtInt(part.count)}</b></li>
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
                            <p class="note">流式/缓冲按响应是否带流式元数据分组，不解析正文；未收到响应头的失败请求两者都不计入。并发峰值是历史最高同时进行数，不随时间下降。</p>
                          {:else}
                            <p class="absent">服务端尚未提供响应形态与并发计数。</p>
                          {/if}
                          {#if user.headersLatency}
                            {@const headerTop = Math.max(1, ...user.headersLatency.map((b) => b.count))}
                            <h3 class="sub">响应头等待</h3>
                            <ul class="histogram">
                              {#each user.headersLatency as bucket}
                                <li>
                                  <span class="hist-label">{bucket.label}</span>
                                  <span class="hist-track"><span style:width="{bucket.count > 0 ? Math.max(2, (bucket.count / headerTop) * 100) : 0}%"></span></span>
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
                                  覆盖 {fmtInt(user.headersCovered)} / {fmtInt(user.completed)} 个完成请求。差额 {fmtInt(user.headersGap)} 个没有可测的等待值：{fmtInt(user.noResponseCount)} 个在本版本记录为未收到响应头（传输在响应头之前就结束了）{#if legacy > 0}，另有 {fmtInt(legacy)} 个是响应头统计上线前完成的历史请求，没有留下样本{/if}。两类都不能当作 0 毫秒。
                                {:else}
                                  覆盖 {fmtInt(user.headersCovered)} / {fmtInt(user.completed)} 个完成请求。差额 {fmtInt(user.headersGap)} 个没有可测的等待值，既包括未收到响应头的请求，也包括升级前的历史请求；服务端没有提供状态分桶，因此无法在这里区分两者。都不能当作 0 毫秒。
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
                            <ul class="mini-series">
                              {#each user.series.slice(-12) as point}
                                {@const top = Math.max(1, ...user.series.map((p) => p.succeeded + p.failed + p.canceled))}
                                <li title="{fmtHour(point.hour)}：{fmtInt(point.succeeded + point.failed + point.canceled)} 请求">
                                  <span class="mini-bar" style:height="{Math.max(2, ((point.succeeded + point.failed + point.canceled) / top) * 100)}%"></span>
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
          <div><dt>刷新</dt><dd>每 15 秒，页面隐藏时暂停</dd></div>
        </dl>
      </div>
    </details>
  </main>
  <footer class="foot">公开统计只包含昵称与计数 · <a href="/admin">用户管理</a></footer>
</div>
