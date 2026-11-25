<script>
  // The routing view is a whole-site, shared-pool report produced by the remote
  // OMP plugin. It needs an admin session, so it lives on its own page instead of
  // the public statistics document: capacity and health counts are account state.
  import { onMount } from 'svelte'
  import Routing from './components/Routing.svelte'
  import './components/routing.css'
  import { normalizeRouting, fmtTime } from './lib/data.js'

  let routing = $state(null)
  let state = $state('loading') // loading | ready | denied | failed
  let message = $state('')
  let receivedAt = $state(null)
  let loading = $state(false)

  // The shell classes are shared with the public page, so the two documents
  // cannot drift apart: `live` and `degraded` are the only link states the
  // stylesheet colours, and `refresh` is the only button it shapes.
  const link = $derived(
    state === 'ready' ? 'live' : state === 'denied' || state === 'failed' ? 'degraded' : '',
  )
  const linkText = $derived(
    state === 'ready' ? '实时' : state === 'denied' ? '需要登录' : state === 'failed' ? '读取失败' : '读取中',
  )

  async function load() {
    if (loading) return
    loading = true
    try {
      const response = await fetch('/admin/api/routing', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
      if (response.status === 401 || response.status === 403) {
        state = 'denied'
        return
      }
      if (!response.ok) {
        state = 'failed'
        message = `服务端返回 ${response.status}。`
        return
      }
      const body = await response.json()
      // The endpoint always answers with `available`. A document without it is a
      // read failure, not a report of zero traffic.
      if (typeof body?.available !== 'boolean') {
        state = 'failed'
        message = '响应不是路由快照。'
        return
      }
      routing = normalizeRouting({ routing: body })
      receivedAt = new Date()
      state = 'ready'
    } catch (error) {
      state = 'failed'
      message = error?.message ?? '读取失败。'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    load()
    const timer = setInterval(() => {
      if (!document.hidden) load()
    }, 15_000)
    return () => clearInterval(timer)
  })
</script>

<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <div>
        <h1>路由统计</h1>
        <p>全站共享池 · 需要管理员会话</p>
      </div>
    </div>
    <div class="controls">
      <span class="link-state {link}"><i aria-hidden="true"></i>{linkText}</span>
      <button class="refresh" type="button" onclick={load} disabled={loading} aria-label="立即刷新路由统计">{loading ? '刷新中…' : '刷新'}</button>
      <a class="link" href="/">公开统计</a>
    </div>
  </header>

  <main class="wrap">
    {#if state === 'denied'}
      <section class="card" aria-label="需要管理员会话">
        <div class="card-head">
          <div>
            <h2>需要管理员会话</h2>
            <p>这一页读取上游账号容量、健康与 token 台账，属于运维信息，所以只对已登录的管理员开放。</p>
          </div>
        </div>
        <p class="hint">先登录管理页，再回到这里；公开用量统计不受影响。</p>
        <p><a class="link" href="/admin">前往用户管理登录</a></p>
      </section>
    {:else if state === 'failed'}
      <section class="card" aria-label="读取失败">
        <div class="card-head">
          <div>
            <h2>读取失败</h2>
            <p>{message}</p>
          </div>
        </div>
        <p class="hint">失败时不会显示上一份数值冒充当前状态。重新加载会再读一次。</p>
        <p><button class="refresh" type="button" onclick={load}>重试</button></p>
      </section>
    {:else if routing === null}
      <section class="card"><p class="absent" aria-busy="true">正在读取路由统计…</p></section>
    {/if}

    {#if routing}
      <Routing {routing} />
      <section class="card notes" aria-label="口径与来源">
        <div class="notes-body">
          <p>数值由远端 OMP 插件在共享池上聚合，本地进程只读取投影后的计数：不含账号标识、密钥、模型名或主机名。缺失显示为 “—”，不按 0 处理。</p>
          <dl class="meta">
            <div><dt>快照生成</dt><dd>{fmtTime(routing.generatedAt) ?? '未提供'}</dd></div>
            <div><dt>本页读取</dt><dd>{fmtTime(receivedAt) ?? '—'}</dd></div>
            <div><dt>存储</dt><dd>{routing.storeLabel ?? '未提供'}</dd></div>
          </dl>
        </div>
      </section>
    {/if}
  </main>

  <footer class="foot">需要管理员会话 · <a href="/">公开使用统计</a> · <a href="/admin">用户管理</a></footer>
</div>
