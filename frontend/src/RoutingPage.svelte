<script>
  // The routing view is a whole-site report from the remote OMP plugin. It needs an
  // admin session, so it lives on its own page: capacity and health counts are
  // account state, while the public statistics document never carries them.
  import { onMount } from 'svelte'
  import Routing from './components/Routing.svelte'
  import './components/routing.css'
  import { normalizeRouting, fmtTime } from './lib/data.js'

  const REFRESH_MS = 15_000
  const THEME_KEY = 'zproxy-theme'

  let routing = $state(null)
  let state = $state('loading') // loading | ready | stale | denied | failed
  let message = $state('')
  let receivedAt = $state(null)
  let loading = $state(false)
  let paused = $state(false)
  let theme = $state('auto') // auto | light | dark
  let now = $state(Date.now())
  let announce = $state('')

  const link = $derived(
    state === 'ready' ? 'live' : state === 'stale' ? 'stale' : state === 'denied' || state === 'failed' ? 'bad' : '',
  )
  const linkText = $derived(
    state === 'ready' ? '实时'
      : state === 'stale' ? '数据过期'
      : state === 'denied' ? '需要登录'
      : state === 'failed' ? '读取失败'
      : '读取中',
  )
  const age = $derived(receivedAt === null ? null : Math.max(0, Math.round((now - receivedAt.getTime()) / 1000)))
  const ageText = $derived(age === null ? '—' : age < 2 ? '刚刚' : age < 60 ? `${age} 秒前` : `${Math.round(age / 60)} 分钟前`)

  function applyTheme(next) {
    theme = next
    try { localStorage.setItem(THEME_KEY, next) } catch { /* a blocked storage is not a failure */ }
    if (next === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.dataset.theme = next
  }

  function looksLikeSnapshot(body) {
    if (body === null || typeof body !== 'object') return false
    if (typeof body.available === 'boolean') return true
    return body.schemaVersion !== undefined || Array.isArray(body.routes) || typeof body.metrics === 'object'
  }

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
        routing = null
        announce = '需要管理员会话'
        return
      }
      if (!response.ok) {
        fail(`服务端返回 ${response.status}。`)
        return
      }
      const body = await response.json()
      // A document that is not a routing report is a read failure, never a report
      // of zero traffic. The old shell required a top-level `available` flag, which
      // a real snapshot does not carry: it has `schemaVersion`, `routes` and
      // `metrics` instead. Both shapes are accepted.
      if (!looksLikeSnapshot(body)) {
        fail('响应不是路由快照。')
        return
      }
      const next = normalizeRouting(body)
      if (next === null) {
        fail('响应无法解析为路由快照。')
        return
      }
      const wasStale = state === 'stale'
      routing = next
      receivedAt = new Date()
      state = 'ready'
      message = ''
      announce = wasStale ? '连接已恢复' : '路由统计已更新'
    } catch (error) {
      fail(error?.message ?? '读取失败。')
    } finally {
      loading = false
    }
  }

  function fail(reason) {
    message = reason
    // A failed refresh keeps the last good snapshot on screen and says so. It never
    // pretends the old numbers are current, and never renders zeros instead.
    state = routing === null ? 'failed' : 'stale'
    announce = `刷新失败，${reason}`
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY)
      if (saved === 'light' || saved === 'dark') applyTheme(saved)
    } catch { /* keep the system preference */ }
    load()
    const poll = setInterval(() => { if (!document.hidden && !paused) load() }, REFRESH_MS)
    const tick = setInterval(() => { now = Date.now() }, 1000)
    return () => { clearInterval(poll); clearInterval(tick) }
  })
</script>

<a class="skip-link" href="#main-content">跳到主要内容</a>

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
      <span class="age" title="页面上一份成功快照的读取时间">{ageText}</span>
      <div class="theme" role="group" aria-label="配色">
        <button type="button" aria-pressed={theme === 'auto'} onclick={() => applyTheme('auto')}>跟随系统</button>
        <button type="button" aria-pressed={theme === 'light'} onclick={() => applyTheme('light')}>浅色</button>
        <button type="button" aria-pressed={theme === 'dark'} onclick={() => applyTheme('dark')}>深色</button>
      </div>
      <button class="refresh" type="button" aria-pressed={paused} onclick={() => { paused = !paused }}>{paused ? '继续刷新' : '暂停刷新'}</button>
      <button class="refresh" type="button" onclick={load} disabled={loading} aria-label="立即刷新路由统计">{loading ? '刷新中…' : '刷新'}</button>
      <a class="link" href="/">公开统计</a>
    </div>
  </header>

  <p class="sr-only" role="status" aria-live="polite">{announce}</p>

  <main class="wrap" id="main-content" tabindex="-1">
    {#if state === 'stale'}
      <div class="banner" role="status">
        <strong>刷新失败</strong>
        <span>页面保留上一次成功的快照；{message} 恢复后会自动覆盖。</span>
      </div>
    {/if}

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
      <Routing {routing} {now} />
      <section class="card notes" aria-label="口径与来源">
        <div class="notes-body">
          <p>数值由远端 OMP 插件在共享池上聚合，本地进程只读取投影后的计数：不含账号标识、密钥或内部 id。缺失显示为 “—”，不按 0 处理。</p>
          <dl class="meta">
            <div><dt>快照生成</dt><dd>{fmtTime(routing.generatedAt) ?? '未提供'}</dd></div>
            <div><dt>本页读取</dt><dd>{fmtTime(receivedAt) ?? '—'}</dd></div>
            <div><dt>快照 id</dt><dd>{routing.snapshotId ?? '未提供'}</dd></div>
          </dl>
        </div>
      </section>
    {/if}
  </main>

  <footer class="foot">需要管理员会话 · <a href="/">公开使用统计</a> · <a href="/admin">用户管理</a></footer>
</div>
