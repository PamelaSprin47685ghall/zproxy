<script>
  // Upstream routing is a whole-site, shared-pool view. It is rendered in its own
  // section because it cannot be attributed to a nickname, so merging it into the
  // per-user table would state something false.
  import { fmtInt, fmtDuration } from '../lib/data.js'

  let { routing } = $props()
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

    {#if routing.meta.length > 0}
      <dl class="route-meta">
        {#each routing.meta as item}
          <div><dt>{item.label}</dt><dd>{item.value}</dd></div>
        {/each}
      </dl>
    {/if}

    {#if routing.aggregate.length > 0}
      <div class="aggregate">
        {#each routing.aggregate as group}
          <div class="agg-group">
            <h3>{group.label}{#if group.scope}<span class="agg-scope">{group.scope}</span>{/if}</h3>
            <dl>
              {#each group.items as item}
                <div>
                  <dt>{item.label}</dt>
                  <dd>{item.text}</dd>
                  {#if item.ratio !== null}
                    <span class="agg-bar" aria-hidden="true"><span style:width="{Math.round(item.ratio * 100)}%"></span></span>
                  {/if}
                </div>
              {/each}
            </dl>
          </div>
        {/each}
      </div>
    {/if}

    {#if routing.groups.length > 0}
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
    {/if}
  {/if}
</section>
