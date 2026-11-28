<script>
  // The routing view is a whole-site, shared-pool report produced by the remote OMP
  // plugin. It needs an admin session, so it lives on its own page: capacity and
  // health counts are account state and never belong to the public report.
  import { onMount } from 'svelte'
  import Routing from './components/Routing.svelte'
  import './components/routing.css'
  import { normalizeRouting } from './lib/data.js'

  const POLL_MS = 15_000
  const THEME_KEY = 'zproxy-theme'

  let routing = $state(null)
  let state = $state('loading') // loading | ready | stale | denied | failed
  let message = $state('')
  let receivedAt = $state(null)
  let loading = $state(false)
  let autoRefresh = $state(true)
  let nowMs = $state(Date.now())
  let theme = $state('auto')
  let announcement = $state('')

  const link = $derived(
    state === 'ready' ? 'live'
      : state === 'stale' || state === 'denied' ? 'stale'
        : state === 'failed' ? 'degraded' : '',
  )
  const linkText = $derived(
    state === 'ready' ? '实时'
      : state === 'stale' ? '保留上次快照'
        : state === 'denied' ? '需要登录'
          : state === 'failed' ? '读取失败' : '读取中',
  )
  const ageText = $derived(receivedAt === null ? '—' : past(nowMs - receivedAt.getTime()))

  function past(ms) {
    if (ms === null || !Number.isFinite(ms)) return '—'
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 5) return '刚刚'
    if (seconds < 60) return `${seconds} 秒前`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    return `${Math.floor(hours / 24)} 天前`
  }

  // A snapshot is any document carrying routing data. `available` alone is not a
  // safe test: the full snapshot has no such flag while the public projection does.
  // Accepting every known marker means a producer change cannot blank the page.
  function looksLikeSnapshot(body) {
    if (body === null || typeof body !== 'object') return false
    return typeof body.available === 'boolean'
      || Array.isArray(body.routes)
      || typeof body.schemaVersion === 'number'
      || body.tokenTotals !== undefined
      || body.metrics !== undefined
      || body.aggregate !== undefined
  }

  function applyTheme(next) {
    theme = next
    try { globalThis.localStorage?.setItem(THEME_KEY, next) } catch {}
    const root = document.documentElement
    if (next === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', next)
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
        announcement = '需要管理员登录'
        return
      }
      if (!response.ok) {
        // Keep the last good snapshot on screen; only the reading changes.
        state = routing === null ? 'failed' : 'stale'
        message = `服务端返回 ${response.status}。`
        announcement = '读取失败，保留上一次快照'
        return
      }
      const body = await response.json()
      if (!looksLikeSnapshot(body)) {
        state = routing === null ? 'failed' : 'stale'
        message = '响应不是路由快照。'
        announcement = '响应不是路由快照'
        return
      }
      routing = normalizeRouting(body)
      receivedAt = new Date()
      message = ''
      state = 'ready'
      announcement = '路由快照已更新'
    } catch (error) {
      state = routing === null ? 'failed' : 'stale'
      message = error?.message ?? '读取失败。'
      announcement = '读取失败，保留上一次快照'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    try {
      const saved = globalThis.localStorage?.getItem(THEME_KEY)
      if (saved === 'light' || saved === 'dark' || saved === 'auto') applyTheme(saved)
    } catch {}
    load()
    const poll = setInterval(() => {
      if (!document.hidden && autoRefresh) load()
    }, POLL_MS)
    const tick = setInterval(() => { nowMs = Date.now() }, 1_000)
    return () => { clearInterval(poll); clearInterval(tick) }
  })
</script>

<a class="skip-link" href="#main-content">跳到主要内容</a>

<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <div><h1>路由观测</h1><p>全站共享池 · 需要管理员会话</p></div>
    </div>
    <div class="controls">
      <span class="link-state {link}"><i aria-hidden="true"></i>{linkText}</span>
      <span class="read-age" title="上次成功读取">{ageText}</span>
      <button class="refresh" type="button" onclick={load} disabled={loading} aria-label="立即刷新路由统计">{loading ? '刷新中…' : '刷新'}</button>
      <label class="auto-refresh"><input type="checkbox" checked={autoRefresh} onchange={(event) => { autoRefresh = event.currentTarget.checked }} />自动</label>
      <div class="theme-switch" role="group" aria-label="配色">
        <button type="button" class:active={theme === 'auto'} aria-pressed={theme === 'auto'} onclick={() => applyTheme('auto')}>跟随系统</button>
        <button type="button" class:active={theme === 'light'} aria-pressed={theme === 'light'} onclick={() => applyTheme('light')}>浅色</button>
        <button type="button" class:active={theme === 'dark'} aria-pressed={theme === 'dark'} onclick={() => applyTheme('dark')}>深色</button>
      </div>
      <a class="link" href="/">公开统计</a>
    </div>
  </header>

  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>

  <main class="wrap" id="main-content" tabindex="-1">
    {#if state === 'stale' && message}
      <div class="banner" role="status">
        <strong>刷新暂时失败</strong>
        <span>页面保留上一次成功的快照；{message}</span>
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
          <div><h2>读取失败</h2><p>{message}</p></div>
        </div>
        <p class="hint">失败时不会显示上一份数值冒充当前状态。重新加载会再读一次。</p>
        <p><button class="refresh" type="button" onclick={load}>重试</button></p>
      </section>
    {:else if routing === null}
      <section class="card"><p class="absent" aria-busy="true">正在读取路由统计…</p></section>
    {/if}

    {#if routing}
      <Routing {routing} {nowMs} />

      <section class="card notes" aria-label="口径与来源">
        <div class="notes-body">
          <p>数值由远端 OMP 插件在共享池上聚合，本地进程只读取该插件产出的快照：不含密钥、账号标识或主机名。缺失显示为 “—”，不按 0 处理。</p>
          <dl class="meta">
            <div><dt>快照生成</dt><dd>{routing.generatedAt ? new Date(routing.generatedAt).toLocaleString('zh-CN') : '未提供'}</dd></div>
            <div><dt>本页读取</dt><dd>{receivedAt ? receivedAt.toLocaleTimeString('zh-CN') : '—'}</dd></div>
            <div><dt>快照标识</dt><dd>{routing.snapshotId ?? '未提供'}</dd></div>
            <div><dt>构建版本</dt><dd>{routing.buildVersion ?? '未提供'}</dd></div>
          </dl>
        </div>
      </section>
    {/if}
  </main>

  <footer class="foot">需要管理员会话 · <a href="/">公开使用统计</a> · <a href="/admin">用户管理</a></footer>
</div>
