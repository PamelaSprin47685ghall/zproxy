<script>
  // Upstream routing is a whole-site, shared-pool view. It is rendered in its own
  // section because it cannot be attributed to a nickname: account capacity and
  // health belong to the router, not to a user row.
  import { fmtInt, fmtTime } from '../lib/data.js'

  let { routing, now = Date.now() } = $props()

  const TILE_TITLES = { period: '时段', inFlight: '在途请求', channels: '通道', tokens: 'Token 账本' }
  const STATE_TEXT = { loading: '目录加载中', empty: '无可用通道', alive: '可用', cooling: '冷却中' }
  const ATTENTION = [{ key: 'all', label: '全部路由' }, { key: 'attention', label: '需关注' }]
  // The router hands each model its own M13..M19 block and each account its
  // M20..M23 block. Rendering the ids in a fixed order keeps the columns
  // comparable between models instead of shuffling with object order.
  const CHANNEL_METRICS = ['M13', 'M14', 'M15', 'M16', 'M17', 'M18', 'M19']
  const UNIT_METRICS = ['M20', 'M21', 'M22', 'M23']

  let filter = $state('all')

  function needsAttention(route) {
    if (route.state !== 'alive' && route.state !== 'loading') return true
    return route.channels.some((channel) => channel.units.some((unit) => unit.health !== 'alive' || unit.stale))
  }

  const allRoutes = $derived(routing.routes ?? [])
  const attentionCount = $derived(allRoutes.filter(needsAttention).length)
  const routes = $derived(filter === 'all' ? allRoutes : allRoutes.filter(needsAttention))

  const byId = $derived.by(() => {
    const map = new Map()
    for (const item of routing.metrics ?? []) map.set(item.id, item)
    return map
  })

  /// `overview.primary` names the four headline tiles and the metrics inside
  /// them. Without it the page shows no tiles rather than inventing a grouping.
  const tiles = $derived.by(() => {
    const primary = routing.overview?.primary
    if (!Array.isArray(primary)) return null
    return primary.map((tile) => ({
      key: tile.key,
      title: TILE_TITLES[tile.key] ?? tile.key,
      items: (tile.metricIds ?? []).map((id) => byId.get(id)).filter(Boolean),
      details: (tile.detailMetricIds ?? []).map((id) => byId.get(id)).filter(Boolean),
    })).filter((tile) => tile.items.length > 0 || tile.details.length > 0)
  })

  /// Secondary metrics keep their own window heading; the id stays visible so a
  /// reader can match a row against the router's published definitions.
  const metricGroups = $derived.by(() => {
    const groups = new Map()
    for (const item of routing.metrics ?? []) {
      const key = item.window ?? '全局'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    return [...groups.entries()]
  })

  function rel(value) {
    if (typeof value !== 'string') return null
    const at = new Date(value).getTime()
    if (Number.isNaN(at)) return null
    const delta = Math.round((at - now) / 1000)
    const abs = Math.abs(delta)
    const text = abs < 60 ? `${abs} 秒`
      : abs < 3600 ? `${Math.round(abs / 60)} 分钟`
      : abs < 86400 ? `${Math.round(abs / 3600)} 小时`
      : `${Math.round(abs / 86400)} 天`
    return delta >= 0 ? `${text}后` : `${text}前`
  }

  function tone(metric) {
    return metric.tone ? `tone-${metric.tone}` : metric.available ? '' : 'tone-muted'
  }
</script>

{#snippet tree(node)}
  <li class="node node-{node.type}">
    {#if node.type === 'model'}
      <span class="node-model">{node.label}</span>
      {#if node.effort}<span class="node-tag">effort {node.effort}</span>{/if}
      {#if node.tier}<span class="node-tag">{node.tier}</span>{/if}
      {#if node.offPeakOnly}<span class="node-tag warn">仅闲时</span>{/if}
    {:else}
      <span class="node-op">{node.label}</span>
      <span class="node-type">{node.type}</span>
    {/if}
    {#if node.children.length > 0}
      <ul class="tree-children">
        {#each node.children as child, index (index)}
          {@render tree(child)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<section class="routing" aria-label="上游路由统计">
  {#if routing.notices && routing.notices.length > 0}
    <ul class="notices" aria-label="提示">
      {#each routing.notices as notice, index (index)}
        <li class="notice {notice.level}">
          <strong>{notice.title ?? notice.code ?? '提示'}</strong>
          {#if notice.message}<span>{notice.message}</span>{/if}
          {#if notice.action === 'retry'}<button class="refresh" type="button" onclick={() => location.reload()}>重试</button>{/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if !routing.available}
    <div class="unavailable" role="status">
      <strong>路由统计不可用</strong>
      <span>{routing.reason ?? '服务端未说明原因'}</span>
    </div>
  {/if}

  {#if routing.meta.length > 0}
    <dl class="route-meta">
      {#each routing.meta as item}
        <div><dt>{item.label}</dt><dd>{item.value}</dd></div>
      {/each}
    </dl>
  {/if}

  {#if tiles}
    <div class="tiles">
      {#each tiles as tile (tile.key)}
        <article class="tile">
          <h3>{tile.title}</h3>
          <dl>
            {#each tile.items as item (item.id)}
              <div>
                <dt title={item.reason ?? item.window ?? ''}>{item.label}</dt>
                <dd class={tone(item)}>{item.value}<span class="unit">{item.unit ?? ''}</span></dd>
              </div>
            {/each}
          </dl>
          {#if tile.details.length > 0}
            <details class="tile-details">
              <summary>明细</summary>
              <dl>
                {#each tile.details as item (item.id)}
                  <div>
                    <dt>{item.label}</dt>
                    <dd class={tone(item)}>{item.value}</dd>
                  </div>
                {/each}
              </dl>
            </details>
          {/if}
        </article>
      {/each}
    </div>
  {/if}

  <div class="section-head">
    <div>
      <h2><span class="num">01</span> 运行路由</h2>
      <p>策略图按真实组合结构展开；评级算子按速度后验带温度随机选择，后备链严格按顺序执行。每个模型单列耗时与不确定度，每个账号单列健康与并发。</p>
    </div>
    <div class="chips" role="group" aria-label="路由筛选">
      {#each ATTENTION as mode}
        <button type="button" class="chip" aria-pressed={filter === mode.key} onclick={() => { filter = mode.key }}>
          {mode.label}{#if mode.key === 'attention'}<span class="chip-count">{attentionCount}</span>{/if}
        </button>
      {/each}
    </div>
  </div>

  {#if routing.routes === null}
    <p class="absent">服务端未上报路由列表。</p>
  {:else if allRoutes.length === 0}
    <p class="absent">没有可选路由。目录加载完成前这里会保持为空，不会显示为 0 条通道。</p>
  {:else if routes.length === 0}
    <p class="absent">当前没有需要关注的路由：所有路由可用，且其账号全部健康。</p>
  {:else}
    <div class="route-cards">
      {#each routes as route (route.id)}
        <article class="route">
          <header class="route-head">
            <div class="route-title">
              <h3>{route.title}</h3>
              {#if route.title !== route.id}<span class="route-id">{route.id}</span>{/if}
            </div>
            <div class="route-facts">
              <span class="badge {route.state}">{STATE_TEXT[route.state] ?? route.state}</span>
              <span class="route-count">可用 <b>{fmtInt(route.available)}</b> / {fmtInt(route.totalUnits)} 个账号</span>
            </div>
          </header>

          <div class="route-gauge">
            <progress max={route.totalUnits > 0 ? route.totalUnits : 1} value={route.available} aria-label="可用账号 {route.available} / {route.totalUnits}"></progress>
          </div>

          <p class="route-strategy">{route.strategy}</p>

          {#if route.graph}
            <div class="strategy">
              <ul class="tree">
                {@render tree(route.graph)}
              </ul>
            </div>
          {/if}

          {#if route.channels.length === 0}
            <p class="absent">该路由尚未上报任何模型通道。</p>
          {:else}
            <div class="channels">
              {#each route.channels as channel (channel.id ?? channel.model)}
                <div class="channel">
                  <div class="channel-head">
                    <h4>{channel.model}</h4>
                    <span class="channel-effort">{channel.effort}</span>
                    <span class="channel-count">{fmtInt(channel.available)} / {fmtInt(channel.totalUnits)} 可用</span>
                  </div>

                  <dl class="channel-metrics">
                    {#each CHANNEL_METRICS as id}
                      {@const metric = channel.metrics[id]}
                      {#if metric}
                        <div class:quiet={!metric.available} title={metric.reason ?? metric.exact ?? ''}>
                          <dt>{metric.label}</dt>
                          <dd class={tone(metric)}>{metric.value}</dd>
                        </div>
                      {/if}
                    {/each}
                  </dl>

                  {#if channel.units.length === 0}
                    <p class="absent small">该模型没有在册账号。</p>
                  {:else}
                    <ul class="units" aria-label="{channel.model} 的账号">
                      {#each channel.units as unit (unit.unitRef ?? unit.displayName)}
                        <li class="unit-row {unit.health}" class:stale={unit.stale}>
                          <span class="unit-name">{unit.displayName}</span>
                          <span class="unit-health">{unit.healthLabel}</span>
                          {#if unit.capacity && unit.capacity.max !== null}
                            <span class="unit-load" title="已占用 / 并发上限">
                              {fmtInt(unit.capacity.held ?? 0)}/{fmtInt(unit.capacity.max)}
                            </span>
                          {:else if unit.metrics.M21}
                            <span class="unit-load">{unit.metrics.M21.value}</span>
                          {/if}
                          {#if unit.reason}<span class="unit-reason" title={unit.reason}>{unit.reason}</span>{/if}
                          {#if unit.nextProbeAt}<span class="unit-next" title={fmtTime(unit.nextProbeAt) ?? ''}>探测 {rel(unit.nextProbeAt)}</span>{/if}
                          {#if unit.coolingSince}<span class="unit-since">冷却 {rel(unit.coolingSince)}</span>{/if}
                          {#if unit.stale}<span class="unit-stale">心跳过期</span>{/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </article>
      {/each}
    </div>
  {/if}

  <div class="section-head">
    <div>
      <h2><span class="num">02</span> 近期诊断</h2>
      <p>滚动窗口只用于排查；完整样本与右删失样本分列，删失的请求不参与速度后验。</p>
    </div>
  </div>

  {#if routing.diagnostics === null}
    <p class="absent">服务端未上报诊断窗口。</p>
  {:else if !routing.diagnostics.available}
    <p class="absent">{routing.diagnostics.reason ?? '诊断暂不可用'}。</p>
  {:else if !routing.diagnostics.rows || routing.diagnostics.rows.length === 0}
    <p class="absent">近 {routing.diagnostics.windowMinutes ?? '—'} 分钟内没有样本。</p>
  {:else}
    <div class="table-wrap" tabindex="0" role="region" aria-label="近期诊断">
      <table class="data-table">
        <caption>近 {routing.diagnostics.windowMinutes ?? '—'} 分钟</caption>
        <thead>
          <tr>
            <th scope="col">模型</th>
            <th scope="col" class="is-numeric">完整样本</th>
            <th scope="col" class="is-numeric">删失样本</th>
            <th scope="col" class="is-numeric">升级前混合</th>
            <th scope="col" class="is-numeric">完整耗时均值</th>
            <th scope="col" class="is-numeric">TTFT 样本</th>
            <th scope="col" class="is-numeric">速度样本</th>
            <th scope="col" class="is-numeric">tokens/s</th>
          </tr>
        </thead>
        <tbody>
          {#each routing.diagnostics.rows as row (row.model)}
            <tr>
              <th scope="row">{row.model}</th>
              <td class="is-numeric">{fmtInt(row.complete)}</td>
              <td class="is-numeric">{fmtInt(row.imputed)}</td>
              <td class="is-numeric">{fmtInt(row.legacyMixed)}</td>
              <td class="is-numeric">{row.meanText ?? fmtInt(row.meanMs)}</td>
              <td class="is-numeric">{fmtInt(row.ttft)}</td>
              <td class="is-numeric">{fmtInt(row.speed)}</td>
              <td class="is-numeric">{fmtInt(row.tokensPerSecond)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="section-head">
    <div>
      <h2><span class="num">03</span> 账号与进程</h2>
      <p>并发租约、账号健康与工作进程心跳。过期心跳单独标记，不参与容量合计。</p>
    </div>
  </div>

  {#if routing.capacity === null}
    <p class="absent">服务端未上报并发租约。</p>
  {:else if !routing.capacity.available}
    <p class="absent">{routing.capacity.reason ?? '并发租约暂不可用'}。</p>
  {:else if !routing.capacity.rows || routing.capacity.rows.length === 0}
    <p class="absent">当前没有持有的并发租约。</p>
  {:else}
    <div class="table-wrap" tabindex="0" role="region" aria-label="账号并发">
      <table class="data-table">
        <caption>并发租约 · 活跃 {fmtInt(routing.capacity.liveCount)} · 过期 {fmtInt(routing.capacity.staleCount)}</caption>
        <thead>
          <tr>
            <th scope="col">账号</th><th scope="col">提供方</th><th scope="col">模型</th>
            <th scope="col">范围</th><th scope="col" class="is-numeric">已占用</th>
            <th scope="col" class="is-numeric">上限</th><th scope="col">工作进程</th>
          </tr>
        </thead>
        <tbody>
          {#each routing.capacity.rows as row, index (index)}
            <tr class:stale={row.stale}>
              <th scope="row">{row.displayName}</th>
              <td>{row.provider ?? '—'}</td>
              <td class="mono">{row.model ?? '—'}</td>
              <td>{row.scope ?? '—'}</td>
              <td class="is-numeric">{fmtInt(row.held)}</td>
              <td class="is-numeric">{fmtInt(row.max)}</td>
              <td class="mono">{row.worker ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if routing.health && routing.health.available && routing.health.rows && routing.health.rows.length > 0}
    <div class="table-wrap" tabindex="0" role="region" aria-label="账号健康">
      <table class="data-table">
        <caption>账号健康</caption>
        <thead>
          <tr>
            <th scope="col">账号</th><th scope="col">模型</th><th scope="col">健康</th>
            <th scope="col">原因</th><th scope="col">下次探测</th>
          </tr>
        </thead>
        <tbody>
          {#each routing.health.rows as row, index (index)}
            <tr>
              <th scope="row">{row.displayName}</th>
              <td class="mono">{row.model ?? '—'}</td>
              <td><span class="badge {row.health}">{row.health === 'alive' ? '可用' : row.health === 'cooling' ? '冷却' : row.health === 'busy' ? '繁忙' : '待检查'}</span></td>
              <td class="wrap">{row.reason ?? '—'}</td>
              <td>{row.nextProbeAt ? rel(row.nextProbeAt) ?? '—' : '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if routing.workers && routing.workers.length > 0}
    <div class="table-wrap" tabindex="0" role="region" aria-label="工作进程">
      <table class="data-table">
        <caption>工作进程</caption>
        <thead>
          <tr>
            <th scope="col">进程</th><th scope="col" class="is-numeric">在途</th>
            <th scope="col">目录</th><th scope="col" class="is-numeric">心跳</th><th scope="col">构建</th>
          </tr>
        </thead>
        <tbody>
          {#each routing.workers as worker, index (index)}
            <tr class:stale={worker.stale}>
              <th scope="row" class="mono">{worker.worker}{#if worker.stale}<span class="badge cooling">过期</span>{/if}</th>
              <td class="is-numeric">{fmtInt(worker.inFlight)}</td>
              <td>{worker.catalogReady ? '就绪' : '未就绪'}</td>
              <td class="is-numeric">{worker.ageMs === null ? '—' : `${Math.round(worker.ageMs / 1000)} 秒`}</td>
              <td class="mono">{worker.buildVersion ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if routing.tokenLedger}
    <div class="section-head">
      <div>
        <h2><span class="num">04</span> Token 账本</h2>
        <p>累计口径自统计纪元起；未定价的模型不估算金额，只标注「未定价」。</p>
      </div>
    </div>

    <div class="ledger">
      <dl class="ledger-totals">
        <div><dt>未缓存输入</dt><dd>{fmtInt(routing.tokenLedger.uncachedInput)}</dd></div>
        <div><dt>缓存输入</dt><dd>{fmtInt(routing.tokenLedger.cachedInput)}</dd></div>
        <div><dt>输出</dt><dd>{fmtInt(routing.tokenLedger.output)}</dd></div>
        <div>
          <dt>官方标价等效</dt>
          <dd>{routing.tokenLedger.value === null ? '未估算' : `${routing.tokenLedger.value.toFixed(2)} ${routing.tokenLedger.currency}`}</dd>
        </div>
      </dl>
      {#if routing.tokenLedger.pricedCount !== null || routing.tokenLedger.totalCount !== null}
        <p class="ledger-note">
          已定价 {fmtInt(routing.tokenLedger.pricedCount)} / {fmtInt(routing.tokenLedger.totalCount)} 个模型
          {#if routing.tokenLedger.ratesAsOf}· 费率基准 {fmtTime(routing.tokenLedger.ratesAsOf) ?? routing.tokenLedger.ratesAsOf}{/if}
        </p>
      {/if}
      {#if routing.tokenLedger.note}<p class="ledger-note">{routing.tokenLedger.note}</p>{/if}

      {#if routing.tokenLedger.priced && routing.tokenLedger.priced.length > 0}
        <div class="table-wrap" tabindex="0" role="region" aria-label="模型计价明细">
          <table class="data-table">
            <caption>模型计价明细</caption>
            <thead>
              <tr><th scope="col">模型</th><th scope="col" class="is-numeric">金额</th><th scope="col">计价依据</th></tr>
            </thead>
            <tbody>
              {#each routing.tokenLedger.priced as row, index (index)}
                <tr>
                  <th scope="row" class="mono">{row.model}</th>
                  <td class="is-numeric">{row.amount === null ? '未定价' : `${row.amount.toFixed(4)} ${row.currency}`}</td>
                  <td class="wrap">{row.basis ?? (row.priced ? '—' : '未定价，未估算')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if routing.tokenLedger.models && routing.tokenLedger.models.length > 0}
        <div class="table-wrap" tabindex="0" role="region" aria-label="模型 token 台账">
          <table class="data-table">
            <caption>模型 token 台账</caption>
            <thead>
              <tr>
                <th scope="col">模型</th><th scope="col" class="is-numeric">未缓存输入</th>
                <th scope="col" class="is-numeric">缓存输入</th><th scope="col" class="is-numeric">输出</th>
                <th scope="col" class="is-numeric">完整上报</th>
              </tr>
            </thead>
            <tbody>
              {#each routing.tokenLedger.models as row, index (index)}
                <tr>
                  <th scope="row" class="mono">{row.model}</th>
                  <td class="is-numeric">{fmtInt(row.uncachedInput)}</td>
                  <td class="is-numeric">{fmtInt(row.cachedInput)}</td>
                  <td class="is-numeric">{fmtInt(row.output)}</td>
                  <td class="is-numeric">{fmtInt(row.complete)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}

  {#if metricGroups.length > 0}
    <details class="definitions">
      <summary>指标口径 · M01–M27</summary>
      <div class="metrics">
        {#each metricGroups as [window, items] (window)}
          <table class="metric-table">
            <caption>{window}</caption>
            <tbody>
              {#each items as item (item.id)}
                <tr class:quiet={!item.available}>
                  <th scope="row">
                    <span class="m-id">{item.id}</span>
                    <span class="m-label">{item.label}</span>
                  </th>
                  <td class="m-value {tone(item)}">{item.value}</td>
                </tr>
                {#if !item.available && item.reason}
                  <tr class="mt-reason"><td colspan="2">{item.reason}</td></tr>
                {/if}
              {/each}
            </tbody>
          </table>
        {/each}
      </div>
      <p class="note">“—” 表示服务端判定该指标不可用（附原因行），不是 0。窗口列注明统计口径。</p>
    </details>
  {/if}
</section>
