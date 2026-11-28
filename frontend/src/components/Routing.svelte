<script>
  // Upstream routing is a whole-site, shared-pool view. It is rendered in its own
  // sections because it cannot be attributed to a nickname: per-route strategy,
  // per-model channels, and per-account units belong to the pool, not to a user.
  import { fmtInt } from '../lib/data.js'

  let { routing, nowMs = Date.now() } = $props()

  const PERF_ORDER = ['M13', 'M14', 'M15', 'M16', 'M17', 'M18', 'M19']
  const PRIMARY_LABELS = { period: '时段', inFlight: '在途请求', channels: '通道', tokens: 'Token 账本' }
  const STATE_LABELS = { alive: '可用', cooling: '冷却', busy: '繁忙', loading: '载入中', empty: '无通道', unknown: '待检查' }
  const FILTERS = [{ key: 'all', label: '全部路由' }, { key: 'attention', label: '需关注' }]

  let filter = $state('all')

  const metrics = $derived(routing?.metrics ?? [])
  const byId = $derived(new Map(metrics.map((metric) => [metric.id, metric])))
  const routes = $derived(routing?.routes ?? null)
  const windows = $derived(groupWindows(metrics))
  const tiles = $derived(
    (routing?.overview?.primary ?? []).map((tile) => ({
      key: tile.key,
      label: PRIMARY_LABELS[tile.key] ?? tile.key,
      items: (tile.metricIds ?? []).map((id) => byId.get(id)).filter(Boolean),
      detail: (tile.detailMetricIds ?? []).map((id) => byId.get(id)).filter(Boolean),
    })),
  )
  const attentionCount = $derived((routes ?? []).filter(needsAttention).length)
  const visibleRoutes = $derived((routes ?? []).filter((route) => filter === 'all' || needsAttention(route)))

  function needsAttention(route) {
    if (route.state !== 'alive') return true
    return route.channels.some((channel) => channel.units.some((unit) => unit.stale || unit.health !== 'alive'))
  }

  function groupWindows(list) {
    const groups = new Map()
    for (const metric of list) {
      if (!groups.has(metric.window)) groups.set(metric.window, [])
      groups.get(metric.window).push(metric)
    }
    return [...groups.entries()].map(([label, items]) => ({ label, items }))
  }

  // The strategy graph renders as a flat list with a depth class: depth is all the
  // stylesheet needs to draw the indent guides, and it avoids a recursive snippet.
  function flatten(node, depth = 0, out = []) {
    if (!node) return out
    out.push({ ...node, depth: Math.min(depth, 6) })
    for (const child of node.children ?? []) flatten(child, depth + 1, out)
    return out
  }

  function past(iso) {
    if (typeof iso !== 'string') return null
    const at = new Date(iso).getTime()
    if (Number.isNaN(at)) return null
    const seconds = Math.max(0, Math.round((nowMs - at) / 1000))
    if (seconds < 60) return `${seconds} 秒前`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    return `${Math.floor(hours / 24)} 天前`
  }

  function ahead(iso) {
    if (typeof iso !== 'string') return null
    const at = new Date(iso).getTime()
    if (Number.isNaN(at)) return null
    const seconds = Math.round((at - nowMs) / 1000)
    if (seconds <= 0) return '即将'
    if (seconds < 60) return `${seconds} 秒后`
    const minutes = Math.ceil(seconds / 60)
    if (minutes < 60) return `${minutes} 分钟后`
    return `${Math.round(minutes / 60)} 小时后`
  }

  function loadText(capacity) {
    if (capacity === null) return null
    if (capacity.max === 0) return `${fmtInt(capacity.held ?? 0)}/不限`
    return `${fmtInt(capacity.held ?? 0)}/${fmtInt(capacity.max)}`
  }
</script>

{#if routing.notices && routing.notices.length > 0}
  <div class="notices" role="status">
    {#each routing.notices as notice, index (notice.code ?? index)}
      <div class="notice {notice.level ?? 'info'}">
        <strong>{notice.title ?? '提示'}</strong><span>{notice.message}</span>
      </div>
    {/each}
  </div>
{/if}

{#if routing.available === false}
  <div class="unavailable" role="status">
    <strong>路由统计不可用</strong><span>{routing.reason ?? '服务端未说明原因'}</span>
  </div>
{/if}

{#if tiles.length > 0}
  <div class="tiles">
    {#each tiles as tile (tile.key)}
      <section class="tile">
        <h2>{tile.label}</h2>
        {#each tile.items as item (item.id)}
          <p class="tile-big" class:quiet={!item.available}>{item.value}</p>
          <p class="tile-label">{item.label}{#if item.reason}<span class="tile-reason">{item.reason}</span>{/if}</p>
        {/each}
        {#if tile.detail.length > 0}
          <dl class="tile-detail">
            {#each tile.detail as item (item.id)}
              <div><dt>{item.label}</dt><dd>{item.value}</dd></div>
            {/each}
          </dl>
        {/if}
      </section>
    {/each}
  </div>
{/if}

{#if routing.meta.length > 0}
  <dl class="route-meta">
    {#each routing.meta as item}
      <div><dt>{item.label}</dt><dd>{item.value}</dd></div>
    {/each}
  </dl>
{/if}

{#if routes !== null}
  <section class="section" aria-labelledby="routes-heading">
    <div class="section-head">
      <div>
        <p class="eyebrow">01 / ROUTES</p>
        <h2 id="routes-heading">运行路由</h2>
        <p>评分按总耗时后验随机选择；只有后备链按固定顺序执行。</p>
      </div>
      <div class="chips" role="group" aria-label="路由筛选">
        {#each FILTERS as option (option.key)}
          <button type="button" class="chip" class:active={filter === option.key} aria-pressed={filter === option.key} onclick={() => { filter = option.key }}>{option.label}{#if option.key === 'attention' && attentionCount > 0}<span class="chip-count">{attentionCount}</span>{/if}</button>
        {/each}
      </div>
    </div>

    {#if visibleRoutes.length === 0}
      <p class="absent">{filter === 'attention' ? '所有路由与账号都处于可用状态。' : '服务端报告了 0 条路由。'}</p>
    {:else}
      {#each visibleRoutes as route (route.id)}
        <article class="route">
          <header class="route-head">
            <div class="route-title"><h3>{route.title}</h3><code class="route-id">{route.id}</code></div>
            <div class="route-facts">
              <span class="badge {route.state}">{STATE_LABELS[route.state] ?? route.state}</span>
              <span class="route-count"><b>{fmtInt(route.available)}</b> / {fmtInt(route.totalUnits)} 个账号可用</span>
            </div>
          </header>
          <p class="route-strategy">{route.strategy}</p>

          {#if route.graph}
            <div class="strategy">
              <ol class="tree">
                {#each flatten(route.graph) as node, index (index)}
                  <li class="node depth-{node.depth}">
                    {#if node.type === 'model'}
                      <span class="node-model">{node.label}</span>
                      {#if node.effort}<span class="node-tag">{node.effort}</span>{/if}
                      {#if node.tier}<span class="node-tag">{node.tier}</span>{/if}
                      {#if node.offPeakOnly}<span class="node-tag warn">仅闲时</span>{/if}
                    {:else}
                      <span class="node-op">{node.label}</span><span class="node-type">{node.type}</span>
                    {/if}
                  </li>
                {/each}
              </ol>
            </div>
          {/if}

          <div class="channels">
            {#each route.channels as channel (channel.id ?? channel.model)}
              <section class="channel">
                <div class="channel-head">
                  <h4>{channel.model}</h4>
                  {#if channel.effort}<span class="channel-effort">{channel.effort}</span>{/if}
                  <span class="channel-count"><b>{fmtInt(channel.available)}</b> / {fmtInt(channel.totalUnits)}</span>
                </div>
                <dl class="channel-metrics">
                  {#each PERF_ORDER as id (id)}
                    {@const metric = channel.metrics[id]}
                    {#if metric}
                      <div class:quiet={!metric.available}>
                        <dt title={metric.reason ?? metric.window}>{metric.label}</dt>
                        <dd>{metric.value}</dd>
                      </div>
                    {/if}
                  {/each}
                </dl>
                {#if channel.units.length > 0}
                  <ul class="units">
                    {#each channel.units as unit (unit.unitRef ?? unit.displayName)}
                      <li class="unit {unit.health}" class:stale={unit.stale}>
                        <span class="unit-name">{unit.displayName}</span>
                        <span class="unit-health">{unit.healthLabel}</span>
                        {#if loadText(unit.capacity)}<span class="unit-load">{loadText(unit.capacity)}</span>{/if}
                        {#if unit.reason}<span class="unit-reason">{unit.reason}</span>{/if}
                        {#if past(unit.coolingSince)}<span class="unit-since">冷却 {past(unit.coolingSince)}</span>{/if}
                        {#if ahead(unit.nextProbeAt)}<span class="unit-next">探测 {ahead(unit.nextProbeAt)}</span>{/if}
                        {#if unit.stale}<span class="unit-stale">心跳过期</span>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>
            {/each}
          </div>
        </article>
      {/each}
    {/if}
  </section>
{/if}

{#if routing.diagnostics}
  <section class="section" aria-labelledby="diagnostics-heading">
    <div class="section-head">
      <div>
        <p class="eyebrow">02 / DIAGNOSTICS</p>
        <h2 id="diagnostics-heading">近期诊断</h2>
        <p>滚动窗口只用于排查；完整样本与右删失样本分列，不混为一个均值。</p>
      </div>
    </div>
    {#if routing.diagnostics.available === false}
      <p class="absent">{routing.diagnostics.reason ?? '服务端未提供诊断样本。'}</p>
    {:else if !routing.diagnostics.rows || routing.diagnostics.rows.length === 0}
      <p class="absent">窗口内没有可用样本。</p>
    {:else}
      <!-- A widened table scrolls horizontally, so keyboard users need this stop; the role names it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="table-wrap" tabindex="0" role="region" aria-label="模型耗时诊断">
        <table class="data-table">
          <caption>近 {routing.diagnostics.windowMinutes ?? '—'} 分钟 · 完整与删失样本分开</caption>
          <thead><tr>
            <th scope="col">模型</th><th scope="col" class="is-numeric">完整</th><th scope="col" class="is-numeric">删失</th>
            <th scope="col" class="is-numeric">升级前混合</th><th scope="col" class="is-numeric">完整耗时均值</th>
            <th scope="col" class="is-numeric">TTFT</th><th scope="col" class="is-numeric">速度样本</th><th scope="col" class="is-numeric">tokens/s</th>
          </tr></thead>
          <tbody>
            {#each routing.diagnostics.rows as row (row.model)}
              <tr>
                <th scope="row" class="mono">{row.model}</th>
                <td class="is-numeric">{fmtInt(row.complete)}</td>
                <td class="is-numeric">{fmtInt(row.imputed)}</td>
                <td class="is-numeric">{fmtInt(row.legacyMixed)}</td>
                <td class="is-numeric">{row.meanText ?? (row.meanMs === null ? '—' : `${fmtInt(row.meanMs)} ms`)}</td>
                <td class="is-numeric">{fmtInt(row.ttft)}</td>
                <td class="is-numeric">{fmtInt(row.speed)}</td>
                <td class="is-numeric">{row.tokensPerSecond === null ? '—' : row.tokensPerSecond.toFixed(1)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

{#if routing.workers !== null}
  <section class="section" aria-labelledby="workers-heading">
    <div class="section-head">
      <div><p class="eyebrow">03 / WORKERS</p><h2 id="workers-heading">工作进程</h2><p>每个进程自报在途请求与心跳；过期表示该进程未在窗口内上报。</p></div>
    </div>
    {#if routing.workers.length === 0}
      <p class="absent">服务端报告了 0 个工作进程。</p>
    {:else}
      <!-- A widened table scrolls horizontally, so keyboard users need this stop; the role names it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="table-wrap" tabindex="0" role="region" aria-label="工作进程明细">
        <table class="data-table">
          <caption>工作进程</caption>
          <thead><tr><th scope="col">进程</th><th scope="col">响应者</th><th scope="col" class="is-numeric">在途</th><th scope="col">目录就绪</th><th scope="col" class="is-numeric">心跳</th><th scope="col">构建</th></tr></thead>
          <tbody>
            {#each routing.workers as worker, index (worker.worker ?? index)}
              <tr class:stale={worker.stale}>
                <th scope="row" class="mono">{worker.worker}</th>
                <td class="mono">{worker.answeredBy ?? '—'}</td>
                <td class="is-numeric">{fmtInt(worker.inFlight)}</td>
                <td>{worker.catalogReady ? '已就绪' : '加载中'}</td>
                <td class="is-numeric">{worker.ageMs === null ? '—' : `${(worker.ageMs / 1000).toFixed(1)} s`}</td>
                <td class="mono">{worker.buildVersion ?? '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

{#if routing.capacity && routing.capacity.rows !== null}
  <section class="section" aria-labelledby="capacity-heading">
    <div class="section-head">
      <div><p class="eyebrow">04 / CAPACITY</p><h2 id="capacity-heading">账号并发</h2><p>已占用与上限来自共享池租约；上限为 0 表示不限。</p></div>
    </div>
    {#if routing.capacity.available === false}
      <p class="absent">{routing.capacity.reason ?? '服务端未提供并发租约。'}</p>
    {:else if routing.capacity.rows.length === 0}
      <p class="absent">当前没有并发租约。</p>
    {:else}
      <!-- A widened table scrolls horizontally, so keyboard users need this stop; the role names it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="table-wrap" tabindex="0" role="region" aria-label="账号并发租约">
        <table class="data-table">
          <caption>并发租约</caption>
          <thead><tr><th scope="col">账号</th><th scope="col">提供方</th><th scope="col">模型</th><th scope="col">范围</th><th scope="col" class="is-numeric">已占用</th><th scope="col" class="is-numeric">上限</th><th scope="col">工作进程</th></tr></thead>
          <tbody>
            {#each routing.capacity.rows as row, index (index)}
              <tr class:stale={row.stale}>
                <th scope="row" class="mono">{row.displayName}</th>
                <td>{row.provider ?? '—'}</td>
                <td class="mono">{row.model ?? '—'}</td>
                <td>{row.scope ?? '—'}</td>
                <td class="is-numeric">{fmtInt(row.held)}</td>
                <td class="is-numeric">{row.max === 0 ? '不限' : fmtInt(row.max)}</td>
                <td class="mono">{row.worker ?? '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

{#if routing.health && routing.health.rows !== null}
  <section class="section" aria-labelledby="health-heading">
    <div class="section-head">
      <div><p class="eyebrow">05 / HEALTH</p><h2 id="health-heading">账号健康</h2><p>冷却原因已脱敏：不含上游响应正文、凭据或账号标识。</p></div>
    </div>
    {#if routing.health.available === false}
      <p class="absent">{routing.health.reason ?? '服务端未提供健康视图。'}</p>
    {:else if routing.health.rows.length === 0}
      <p class="absent">当前没有账号健康记录。</p>
    {:else}
      <!-- A widened table scrolls horizontally, so keyboard users need this stop; the role names it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="table-wrap" tabindex="0" role="region" aria-label="账号健康">
        <table class="data-table">
          <caption>账号健康</caption>
          <thead><tr><th scope="col">账号</th><th scope="col">提供方</th><th scope="col">模型</th><th scope="col">健康</th><th scope="col" class="wrap">原因</th><th scope="col">下次探测</th></tr></thead>
          <tbody>
            {#each routing.health.rows as row, index (index)}
              <tr>
                <th scope="row" class="mono">{row.displayName}</th>
                <td>{row.provider ?? '—'}</td>
                <td class="mono">{row.model ?? '—'}</td>
                <td class="unit-{row.health}">{STATE_LABELS[row.health] ?? row.health}</td>
                <td class="wrap">{row.reason ?? '—'}</td>
                <td>{ahead(row.nextProbeAt) ?? '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

{#if routing.tokenTotals}
  <section class="section" aria-labelledby="ledger-heading">
    <div class="section-head">
      <div><p class="eyebrow">06 / LEDGER</p><h2 id="ledger-heading">Token 账本</h2><p>自统计纪元累计。官方标价等效值是估算，不是账单。</p></div>
    </div>
    <dl class="ledger-totals">
      {#each routing.tokenTotals.tiers as tier (tier.key)}
        <div><dt>{tier.label}</dt><dd>{fmtInt(tier.count)}</dd></div>
      {/each}
      {#if routing.tokenTotals.official}
        <div><dt>官方标价等效</dt><dd>{routing.tokenTotals.official.amount.toFixed(2)} {routing.tokenTotals.official.currency}</dd></div>
      {/if}
    </dl>
    {#if routing.tokenTotals.complete !== null}
      <p class="ledger-note">上报覆盖：{fmtInt(routing.tokenTotals.complete)}{#if routing.tokenTotals.total !== null} / {fmtInt(routing.tokenTotals.total)}{/if} 个请求。{#if routing.tokenTotals.official && routing.tokenTotals.official.priced !== null}已定价 {fmtInt(routing.tokenTotals.official.priced)} / {fmtInt(routing.tokenTotals.official.total)} 个模型。{/if}未定价的模型不估算。</p>
    {/if}
  </section>
{/if}

{#if windows.length > 0}
  <details class="definitions">
    <summary>指标口径（M01–M27）</summary>
    <div class="metrics">
      {#each windows as group (group.label)}
        <table class="metric-table">
          <caption>{group.label}</caption>
          <tbody>
            {#each group.items as item (item.id)}
              <tr class:quiet={!item.available}>
                <th scope="row"><span class="m-id">{item.id}</span><span class="m-label">{item.label}</span></th>
                <td class="m-value {item.tone}">{item.value}</td>
                <td class="m-scope">{item.scope ?? ''}</td>
              </tr>
              {#if !item.available && item.reason}
                <tr class="mt-reason"><td colspan="3">{item.reason}</td></tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/each}
    </div>
    <p class="note">“—” 表示服务端判定该指标不可用（附原因行），不是 0。</p>
  </details>
{/if}

{#if routes === null && routing.aggregate.length > 0}
  <section class="section" aria-labelledby="legacy-heading">
    <div class="section-head">
      <div><p class="eyebrow">LEGACY</p><h2 id="legacy-heading">聚合投影</h2><p>这份快照来自旧版插件，只提供聚合计数，没有逐路由与逐模型明细。</p></div>
    </div>
    <div class="aggregate">
      {#each routing.aggregate as group (group.key)}
        <div class="agg-group">
          <h3>{group.label}{#if group.scope}<span class="agg-scope">{group.scope}</span>{/if}</h3>
          <dl>
            {#each group.items as item (item.label)}
              <div><dt>{item.label}</dt><dd>{item.text}</dd></div>
            {/each}
          </dl>
        </div>
      {/each}
    </div>
  </section>
{/if}
