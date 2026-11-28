<script>
  // Upstream routing is a whole-site, shared-pool view. It is rendered in its own
  // section because it cannot be attributed to a nickname, so merging it into the
  // per-user table would state something false.
  //
  // Two readings of the same snapshot coexist. `aggregate` and `groups` are the
  // prose-shaped projection every gateway version sends; `workers`, `capacity`,
  // `health`, `routes`, `diagnostics` and `tokenModels` are the structured tables
  // a newer gateway adds. Each block renders only when the server reported it, and
  // a missing block stays missing instead of turning into an empty shell.
  import { fmtInt, fmtDuration, fmtTime } from '../lib/data.js'

  let { routing } = $props()

  const ROUTE_FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'trouble', label: '异常' },
  ]

  let routeFilter = $state('all')

  const OK_WORDS = /alive|live|可用|正常|健康|ready|ok/i
  const WARN_WORDS = /cool|冷却|retry|重试|degrad|降级|busy|繁忙|有限/i
  const BAD_WORDS = /down|dead|错误|error|fault|bad|不可用|失败|drain/i

  function toneOf(text) {
    const value = String(text ?? '')
    if (value.length === 0) return ''
    if (BAD_WORDS.test(value)) return 'bad'
    if (WARN_WORDS.test(value)) return 'warn'
    if (OK_WORDS.test(value)) return 'ok'
    return ''
  }

  function stateCellTone(cell) {
    // Colour repeats text that is already present; it never carries the state alone.
    if (!/^(state|status|health)$/.test(cell.key)) return ''
    return toneOf(cell.text)
  }

  function channelTrouble(channel) {
    return channel.tone === 'tone-warn' || channel.tone === 'tone-bad' || toneOf(channel.state) !== '' && toneOf(channel.state) !== 'ok'
  }

  function routeTrouble(route) {
    if (route.tone === 'tone-warn' || route.tone === 'tone-bad') return true
    return (route.channels ?? []).some(channelTrouble)
  }

  const troubleCount = $derived((routing?.routes ?? []).filter(routeTrouble).length)

  const visibleRoutes = $derived.by(() => {
    const routes = routing?.routes
    if (!routes) return null
    return routeFilter === 'trouble' ? routes.filter(routeTrouble) : routes
  })

  const workerSummary = $derived.by(() => {
    const workers = routing?.workers
    if (!workers || workers.length === 0) return null
    const inFlight = workers.map((worker) => worker.inFlight).filter((value) => typeof value === 'number')
    const stale = workers.filter((worker) => worker.stale === true).length
    return {
      count: workers.length,
      inFlight: inFlight.length > 0 ? inFlight.reduce((total, value) => total + value, 0) : null,
      stale,
    }
  })

  const tokenSummary = $derived.by(() => {
    const rows = routing?.tokenModels
    if (!rows || rows.length === 0) return null
    const priced = rows.filter((row) => row.priced && row.amount !== null)
    const currency = rows.find((row) => row.currency)?.currency ?? 'USD'
    const total = priced.length === rows.length ? priced.reduce((sum, row) => sum + row.amount, 0) : null
    return { rows, pricedCount: priced.length, currency, total, allPriced: priced.length === rows.length }
  })

  const hasStructured = $derived(
    Boolean(
      routing &&
        (routing.store || routing.epoch || routing.workers || routing.capacity ||
          routing.health || routing.routes || routing.diagnostics || routing.tokenModels),
    ),
  )

  function money(amount, currency) {
    if (typeof amount !== 'number') return null
    const code = currency ?? 'USD'
    const digits = Math.abs(amount) < 1 ? 4 : 2
    if (code === 'USD') return `$${amount.toFixed(digits)}`
    if (code === 'CNY') return `¥${amount.toFixed(digits)}`
    return `${amount.toFixed(digits)} ${code}`
  }
</script>

<section class="card routing" aria-label="上游路由统计">
  <div class="card-head">
    <div>
      <h2>上游路由</h2>
      <p>全站共享池视角：账号容量、健康、前缀亲和、token 台账。这些计数无法归属到单个昵称，因此不并入用户表。</p>
    </div>
    <p class="scope-tag">全站</p>
  </div>

  {#if routing === null}
    <p class="absent">服务端尚未提供路由统计。</p>
  {:else}
    {#if !routing.available}
      <div class="unavailable" role="status">
        <strong>路由统计不可用</strong>
        <span>{routing.reason ?? '服务端未说明原因'}</span>
      </div>
    {/if}

    {#if routing.notices && routing.notices.length > 0}
      <ul class="notices" aria-label="快照通知">
        {#each routing.notices as notice, index (index)}
          <li class="notice notice-{notice.level}">{notice.message}</li>
        {/each}
      </ul>
    {/if}

    {#if routing.meta && routing.meta.length > 0}
      <dl class="route-meta">
        {#each routing.meta as item}
          <div><dt>{item.label}</dt><dd>{item.value}</dd></div>
        {/each}
      </dl>
    {/if}

    {#if hasStructured}
      <div class="overview">
        <article class="tile">
          <div class="tile-head">
            <h3>系统概览</h3>
            {#if routing.store}
              <span class="badge {routing.store.available === false ? 'badge-warn' : 'badge-ok'}">
                {routing.store.available === false ? '存储不可用' : '存储正常'}
              </span>
            {/if}
          </div>
          <dl class="tile-dl">
            <div><dt>存储模式</dt><dd>{routing.store?.mode ?? '未提供'}</dd></div>
            {#if routing.store?.reason}
              <div><dt>原因</dt><dd class="tile-note">{routing.store.reason}</dd></div>
            {/if}
            <div><dt>统计纪元</dt><dd>{routing.epoch?.since ? (fmtTime(routing.epoch.since) ?? routing.epoch.since) : '未提供'}</dd></div>
            <div><dt>快照生成</dt><dd>{fmtTime(routing.generatedAt) ?? '未提供'}</dd></div>
          </dl>
        </article>

        {#if workerSummary}
          <article class="tile">
            <div class="tile-head">
              <h3>在途请求</h3>
              <span class="badge {workerSummary.stale > 0 ? 'badge-warn' : 'badge-muted'}">{workerSummary.count} 个工作进程</span>
            </div>
            <dl class="tile-dl">
              <div><dt>合计在途</dt><dd>{fmtInt(workerSummary.inFlight)}</dd></div>
              <div><dt>过期心跳</dt><dd>{workerSummary.stale > 0 ? `${workerSummary.stale} 个` : '无'}</dd></div>
            </dl>
          </article>
        {/if}

        {#each (routing.aggregate ?? []) as group}
          <article class="tile">
            <div class="tile-head">
              <h3>{group.label}</h3>
              {#if group.scope}<span class="badge badge-muted">{group.scope}</span>{/if}
            </div>
            <dl class="tile-dl">
              {#each group.items as item}
                <div class="tile-row">
                  <dt>{item.label}</dt>
                  <dd>{item.text}</dd>
                  {#if item.ratio !== null && item.ratio !== undefined}
                    <progress class="ratio" value={Math.round(item.ratio * 100)} max="100" aria-hidden="true">
                      {Math.round(item.ratio * 100)}%
                    </progress>
                  {/if}
                </div>
              {/each}
            </dl>
          </article>
        {/each}

        {#if tokenSummary}
          <article class="tile tile-ledger">
            <div class="tile-head">
              <h3>Token 账本</h3>
              <span class="badge {tokenSummary.allPriced ? 'badge-ok' : 'badge-warn'}">
                {tokenSummary.pricedCount}/{tokenSummary.rows.length} 已定价
              </span>
            </div>
            <dl class="tile-dl">
              <div>
                <dt>等效价值</dt>
                <dd>{tokenSummary.total === null ? '部分未定价，不计合计' : money(tokenSummary.total, tokenSummary.currency)}</dd>
              </div>
            </dl>
            <p class="tile-note">估算值，不是账单；未定价的模型不猜价。</p>
          </article>
        {/if}
      </div>
    {/if}

    {#if routing.workers}
      <details class="disclosure" open={workerSummary !== null && workerSummary.stale > 0}>
        <summary>工作进程明细<span class="disclosure-note">{routing.workers.length} 个 · 心跳与版本</span></summary>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="table-wrap" tabindex="0" role="region" aria-label="工作进程明细">
          <table class="grid-table">
            <caption class="sr">工作进程：在途请求、心跳年龄、过期标记与版本</caption>
            <thead>
              <tr>
                <th scope="col">进程</th>
                <th scope="col" class="is-num">在途</th>
                <th scope="col" class="is-num">心跳</th>
                <th scope="col">状态</th>
                <th scope="col">版本</th>
              </tr>
            </thead>
            <tbody>
              {#each routing.workers as worker (worker.id)}
                <tr>
                  <th scope="row" class="row-name">{worker.id}</th>
                  <td class="is-num">{fmtInt(worker.inFlight)}</td>
                  <td class="is-num">{fmtDuration(worker.heartbeatMs)}</td>
                  <td>
                    {#if worker.stale === true}<span class="badge badge-warn">心跳过期</span>
                    {:else if worker.stale === false}<span class="badge badge-ok">正常</span>
                    {:else}<span class="cell-muted">—</span>{/if}
                  </td>
                  <td class="cell-mono">{worker.version ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </details>
    {/if}

    {#if routing.capacity}
      <div class="table-block">
        <h3 class="block-title">账号并发<span class="block-note">已占用与上限，上限 0 表示不限</span></h3>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="table-wrap" tabindex="0" role="region" aria-label="账号并发">
          <table class="grid-table">
            <caption class="sr">账号并发：每行一个账号的已占用并发与上限</caption>
            <thead>
              <tr>
                <th scope="col">账号</th>
                {#each routing.capacity[0]?.cells ?? [] as cell}
                  <th scope="col" class="is-num">{cell.label}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each routing.capacity as row, index (index)}
                <tr>
                  <th scope="row" class="row-name">{row.name ?? '—'}</th>
                  {#each row.cells as cell}
                    <td class="is-num">{cell.text}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    {#if routing.health}
      <div class="table-block">
        <h3 class="block-title">账号健康<span class="block-note">下次探测与冷却原因已脱敏</span></h3>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="table-wrap" tabindex="0" role="region" aria-label="账号健康">
          <table class="grid-table">
            <caption class="sr">账号健康：状态、下次探测与冷却原因</caption>
            <thead>
              <tr>
                <th scope="col">账号</th>
                {#each routing.health[0]?.cells ?? [] as cell}
                  <th scope="col">{cell.label}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each routing.health as row, index (index)}
                <tr>
                  <th scope="row" class="row-name">{row.name ?? '—'}</th>
                  {#each row.cells as cell}
                    {@const tone = stateCellTone(cell)}
                    <td class={tone ? `cell-tone-${tone}` : 'cell-muted'}>{cell.text}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    {#if routing.routes}
      <div class="table-block">
        <h3 class="block-title">
          路由与通道
          {#if routing.routes.length > 0}
            <span class="block-note">{routing.routes.length} 条路由 · {troubleCount} 条需关注</span>
          {/if}
        </h3>
        {#if routing.routes.length === 0}
          <p class="absent">服务端报告了路由列表，但当前没有可选路由。</p>
        {:else}
          <div class="chips" role="group" aria-label="路由筛选">
            {#each ROUTE_FILTERS as filter}
              <button
                type="button"
                class="chip"
                aria-pressed={routeFilter === filter.key}
                onclick={() => (routeFilter = filter.key)}
              >{filter.label}{#if filter.key === 'trouble'}<span class="chip-count">{troubleCount}</span>{/if}</button>
            {/each}
          </div>

          {#if visibleRoutes && visibleRoutes.length === 0}
            <p class="absent">没有需要关注的路由：每个通道都处于可用状态。</p>
          {/if}

          <div class="routes">
            {#each visibleRoutes ?? [] as route (route.id)}
              <article class="route-card">
                <div class="route-head">
                  <div class="route-id">
                    <h4>{route.id}</h4>
                    {#if route.strategy}<p>{route.strategy}</p>{/if}
                  </div>
                  <div class="route-badges">
                    {#if route.status}
                      <span class="badge {route.tone === 'tone-warn' ? 'badge-warn' : route.tone === 'tone-bad' ? 'badge-bad' : 'badge-ok'}">{route.status}</span>
                    {/if}
                    {#if route.accounts !== null}
                      <span class="badge badge-muted">{fmtInt(route.accounts)} 个账号</span>
                    {/if}
                  </div>
                </div>
                {#if route.channels && route.channels.length > 0}
                  <ul class="channels">
                    {#each route.channels as channel, index (index)}
                      <li class="channel">
                        <span class="channel-model">{channel.model}</span>
                        {#if channel.state}
                          <span class="channel-state {channel.tone}">{channel.state}</span>
                        {/if}
                        {#if channel.detail}<span class="channel-detail">{channel.detail}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                {:else if route.channels}
                  <p class="absent">该路由没有活动通道。</p>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if routing.diagnostics}
      <div class="table-block">
        <h3 class="block-title">
          模型耗时诊断
          {#if routing.diagnostics.windowMinutes !== null}
            <span class="block-note">近 {fmtInt(routing.diagnostics.windowMinutes)} 分钟 · 完整与删失样本分列</span>
          {/if}
        </h3>
        {#if routing.diagnostics.available === false}
          <p class="absent">诊断窗口不可用{#if routing.diagnostics.rows}: {routing.diagnostics.rows.length} 行{/if}，没有可展示的样本。</p>
        {:else if !routing.diagnostics.rows}
          <p class="absent">服务端未报告诊断样本。</p>
        {:else}
          <!-- A horizontal scroll container needs a focus stop so keyboard users can reach the columns; the role gives that stop a name. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="table-wrap" tabindex="0" role="region" aria-label="模型耗时诊断">
            <table class="grid-table">
              <caption class="sr">模型耗时诊断：完整样本、删失样本、平均耗时、TTFT 样本、速度样本与 tokens/s</caption>
              <thead>
                <tr>
                  <th scope="col">模型</th>
                  <th scope="col" class="is-num">完整样本</th>
                  <th scope="col" class="is-num">删失样本</th>
                  <th scope="col" class="is-num">平均耗时</th>
                  <th scope="col" class="is-num">TTFT 样本</th>
                  <th scope="col" class="is-num">速度样本</th>
                  <th scope="col" class="is-num">tokens/s</th>
                </tr>
              </thead>
              <tbody>
                {#each routing.diagnostics.rows as row, index (index)}
                  <tr>
                    <th scope="row" class="row-name cell-mono">{row.model}</th>
                    <td class="is-num">{fmtInt(row.complete)}</td>
                    <td class="is-num">{fmtInt(row.censored)}</td>
                    <td class="is-num">{fmtDuration(row.durationMs)}</td>
                    <td class="is-num">{fmtInt(row.ttft)}</td>
                    <td class="is-num">{fmtInt(row.speed)}</td>
                    <td class="is-num">{row.tokensPerSecond === null ? '—' : row.tokensPerSecond.toFixed(1)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    {#if tokenSummary}
      <div class="table-block">
        <h3 class="block-title">官方标价等效<span class="block-note">估算 · 非账单 · 未定价不估算</span></h3>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="table-wrap" tabindex="0" role="region" aria-label="token 官方标价等效">
          <table class="grid-table">
            <caption class="sr">每个模型的官方标价等效价值与计价依据</caption>
            <thead>
              <tr>
                <th scope="col">模型</th>
                <th scope="col" class="is-num">等效价值</th>
                <th scope="col">计价依据</th>
              </tr>
            </thead>
            <tbody>
              {#each tokenSummary.rows as row, index (index)}
                <tr>
                  <th scope="row" class="row-name cell-mono">{row.model}</th>
                  <td class="is-num">
                    {#if row.priced && row.amount !== null}
                      {money(row.amount, row.currency)}
                    {:else}
                      <span class="badge badge-warn">未定价 · 未估算</span>
                    {/if}
                  </td>
                  <td class="cell-muted">{row.basis ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    {#if routing.groups && routing.groups.length > 0}
      <details class="disclosure">
        <summary>全部指标口径<span class="disclosure-note">{routing.groups.reduce((total, group) => total + group.items.length, 0)} 项</span></summary>
        <div class="metrics">
          {#each routing.groups as group}
            <table class="metric-table">
              <caption>{group.label}</caption>
              <tbody>
                {#each group.items as item}
                  <tr class:quiet={!item.available}>
                    <th scope="row">
                      <span class="m-id">{item.id}</span>
                      <span class="m-label">{item.label}</span>
                    </th>
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
        <p class="note">“—” 表示服务端判定该指标不可用（附原因行），不是 0。窗口列注明统计口径；scope 标注「全站」或「本进程」。</p>
      </details>
    {/if}

    {#if !hasStructured && (!routing.aggregate || routing.aggregate.length === 0) && (!routing.groups || routing.groups.length === 0)}
      <p class="absent">服务端只返回了可用状态，没有附带任何指标。不会用 0 填充空白。</p>
    {/if}
  {/if}
</section>
