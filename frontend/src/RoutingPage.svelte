<script>
  // The routing view is a whole-site, shared-pool report produced by the remote
  // OMP plugin. It needs an admin session, so it lives on its own page instead of
  // the public statistics document: capacity and health counts are account state.
  import { onMount } from 'svelte'
  import Routing from './components/Routing.svelte'
  import './components/routing.css'
  import { normalizeRouting, fmtTime } from './lib/data.js'

  const POLL_MS = 15_000
  const STALE_MS = 45_000
  const FETCH_TIMEOUT_MS = 8_000
  const THEME_KEY = 'zproxy.routing.theme'
  const AUTO_KEY = 'zproxy.routing.auto'

  // Three explicit choices, not a binary switch: a reader who set the system
  // palette must be able to follow it again without clearing site data.
  const THEMES = [
    { key: 'auto', label: '跟随系统' },
    { key: 'light', label: '浅色' },
    { key: 'dark', label: '深色' },
  ]

  let routing = $state(null)
  let phase = $state('loading')
  let failure = $state(null)
  let lastOkAt = $state(null)
  let receivedAt = $state(null)
  let busy = $state(false)
  let nowMs = $state(Date.now())
  let nextAt = $state(null)
  let theme = $state('auto')
  let auto = $state(true)
  let announcement = $state('')

  const ageMs = $derived(lastOkAt === null ? null : Math.max(0, nowMs - lastOkAt))

  // One state machine for the header capsule. `stale` is derived from age, not
  // from the last request, so a paused tab still says the numbers are old.
  const link = $derived(
    phase === 'loading'
      ? 'connecting'
      : phase === 'denied'
        ? 'denied'
        : phase === 'failed'
          ? failure?.kind === 'timeout'
            ? 'timeout'
            : failure?.kind === 'offline'
              ? 'offline'
              : 'error'
          : ageMs !== null && ageMs > STALE_MS
            ? 'stale'
            : 'live',
  )

  const countdown = $derived(nextAt === null ? null : Math.max(0, Math.ceil((nextAt - nowMs) / 1000)))
  const countdownPercent = $derived(
    nextAt === null ? 0 : Math.min(100, Math.max(0, 100 - ((nextAt - nowMs) / POLL_MS) * 100)),
  )
  const holdingOldData = $derived(routing !== null && link !== 'live')

  function linkLabel(value) {
    if (value === 'live') return '实时'
    if (value === 'stale') return '快照过期'
    if (value === 'timeout') return '请求超时'
    if (value === 'offline') return '网络离线'
    if (value === 'error') return '读取失败'
    if (value === 'denied') return '需要登录'
    return '读取中'
  }

  function ageText(ms) {
    if (ms === null) return '—'
    const seconds = Math.floor(ms / 1000)
    if (seconds < 3) return '刚刚'
    if (seconds < 60) return `${seconds} 秒前`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    return `${hours} 小时前`
  }

  function announce(text) {
    announcement = text
  }

  function describeFailure() {
    if (!failure) return '读取失败。'
    return failure.detail
  }

  async function load(options = {}) {
    if (busy) return
    busy = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch('/admin/api/routing', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (response.status === 401 || response.status === 403) {
        phase = 'denied'
        failure = null
        nextAt = null
        announce('需要管理员会话，路由统计未读取。')
        return
      }
      if (!response.ok) {
        phase = 'failed'
        failure = { kind: 'http', detail: `服务端返回 ${response.status}。` }
        announce(`路由统计读取失败：HTTP ${response.status}。`)
        return
      }
      const body = await response.json()
      // The endpoint always answers with `available`. A document without it is a
      // read failure, not a report of zero traffic.
      if (typeof body?.available !== 'boolean') {
        phase = 'failed'
        failure = { kind: 'shape', detail: '响应不是路由快照：缺少 available 字段。' }
        announce('路由统计读取失败：响应不是路由快照。')
        return
      }
      routing = normalizeRouting({ routing: body })
      receivedAt = new Date()
      lastOkAt = Date.now()
      phase = 'ready'
      failure = null
      announce(options.manual ? '路由统计已刷新。' : '路由统计已更新。')
    } catch (error) {
      const aborted = error?.name === 'AbortError'
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      phase = 'failed'
      failure = {
        kind: aborted ? 'timeout' : offline ? 'offline' : 'network',
        detail: aborted
          ? `请求超过 ${FETCH_TIMEOUT_MS / 1000} 秒未返回。`
          : offline
            ? '浏览器报告网络离线。'
            : (error?.message ?? '网络请求失败。'),
      }
      // The previous snapshot stays on screen, but it is labelled as old rather
      // than presented as the current state.
      announce('路由统计读取失败，保留上一份快照并标注过期。')
    } finally {
      clearTimeout(timer)
      busy = false
      nextAt = auto && phase !== 'denied' ? Date.now() + POLL_MS : null
    }
  }

  function setTheme(next) {
    theme = next
  }

  function toggleAuto() {
    auto = !auto
    nextAt = auto && phase !== 'denied' ? Date.now() + POLL_MS : null
    announce(auto ? '自动刷新已恢复。' : '自动刷新已暂停。')
  }

  $effect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // Private mode: the choice lasts for this document only.
    }
  })

  $effect(() => {
    try {
      localStorage.setItem(AUTO_KEY, auto ? '1' : '0')
    } catch {
      // Private mode: the choice lasts for this document only.
    }
  })

  onMount(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_KEY)
      if (THEMES.some((option) => option.key === savedTheme)) theme = savedTheme
      if (localStorage.getItem(AUTO_KEY) === '0') auto = false
    } catch {
      // Storage unavailable: keep the defaults.
    }

    const tick = setInterval(() => {
      nowMs = Date.now()
      if (!auto || busy || document.hidden || phase === 'denied') return
      if (nextAt !== null && Date.now() >= nextAt) load()
    }, 1000)

    const wake = () => {
      if (auto && phase !== 'denied') load()
    }
    const onVisible = () => {
      if (!document.hidden) wake()
    }
    const onOnline = () => {
      if (failure?.kind === 'offline') wake()
    }
    const onOffline = () => {
      if (phase === 'ready') phase = 'failed'
      failure = { kind: 'offline', detail: '浏览器报告网络离线。' }
      announce('网络离线，显示的是上一份快照。')
    }

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    load()

    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  })
</script>

<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <div>
        <h1>路由统计</h1>
        <p>全站共享池 · 需要管理员会话{#if ageMs !== null} · 快照 {ageText(ageMs)}{/if}</p>
      </div>
    </div>
    <div class="controls">
      <span class="link-state {link}"><i aria-hidden="true"></i>{linkLabel(link)}</span>
      <div class="theme-switch" role="group" aria-label="配色">
        {#each THEMES as option}
          <button
            type="button"
            class="theme-option"
            aria-pressed={theme === option.key}
            onclick={() => setTheme(option.key)}
          >{option.label}</button>
        {/each}
      </div>
      <button
        class="refresh"
        type="button"
        onclick={() => load({ manual: true })}
        disabled={busy}
        aria-label="立即刷新路由统计"
      >{busy ? '刷新中…' : '刷新'}</button>
      <a class="link" href="/">公开统计</a>
    </div>
  </header>

  <div class="poll-bar">
    <span class="poll-label">
      {#if !auto}自动刷新已暂停{:else if countdown === null}自动刷新{/if}
    </span>
    {#if auto && countdown !== null}
      <progress class="poll-progress" value={countdownPercent} max="100">自动刷新倒计时</progress>
      <span class="poll-count">{countdown} 秒</span>
    {/if}
    <button class="refresh ghost" type="button" aria-pressed={auto} onclick={toggleAuto}>{auto ? '暂停' : '继续'}</button>
  </div>

  {#if link === 'denied'}
    <div class="banner banner-warn" role="status">
      <strong>需要管理员会话</strong>
      <span>这一页读取上游账号容量、健康与 token 台账，只对已登录的管理员开放。先登录管理页，再回到这里。</span>
      <a class="link" href="/admin">前往用户管理登录</a>
    </div>
  {:else if holdingOldData}
    <div class="banner banner-warn" role="alert">
      <strong>{linkLabel(link)}{failure ? ` · ${describeFailure()}` : ''}</strong>
      <span>下面显示的是 {ageText(ageMs)} 的快照，不是当前状态；不会用旧数值冒充实时读数。</span>
      <button class="refresh" type="button" onclick={() => load({ manual: true })}>立即重试</button>
    </div>
  {/if}

  <main class="wrap">
    {#if phase === 'denied'}
      <section class="card" aria-label="需要管理员会话">
        <div class="card-head">
          <div>
            <h2>需要管理员会话</h2>
            <p>路由容量、账号健康与 token 台账属于运维信息，所以只对已登录的管理员开放。</p>
          </div>
        </div>
        <p class="hint">公开用量统计不受影响，仍然可以在 <a class="link" href="/">公开统计</a> 查看。</p>
        <p><a class="link" href="/admin">前往用户管理登录</a></p>
      </section>
    {:else if phase === 'failed' && routing === null}
      <section class="card" aria-label="读取失败">
        <div class="card-head">
          <div>
            <h2>读取失败</h2>
            <p>{describeFailure()}</p>
          </div>
        </div>
        <p class="hint">失败时不会显示上一份数值冒充当前状态。重新加载会再读一次。</p>
        <p><button class="refresh" type="button" onclick={() => load({ manual: true })}>重试</button></p>
      </section>
    {:else if routing === null}
      <section class="card"><p class="absent" aria-busy="true">正在读取路由统计…</p></section>
    {/if}

    {#if routing}
      <Routing {routing} />
      <section class="card notes" aria-label="口径与来源">
        <div class="notes-body">
          <p>
            数值由远端 OMP 插件在共享池上聚合，本地进程只读取投影后的计数：不含账号标识、密钥、模型名或主机名。
            缺失显示为 “—”，不按 0 处理；不可用会附原因行。
          </p>
          <dl class="meta">
            <div><dt>快照生成</dt><dd>{fmtTime(routing.generatedAt) ?? '未提供'}</dd></div>
            <div><dt>本页读取</dt><dd>{fmtTime(receivedAt) ?? '—'}</dd></div>
            <div><dt>快照年龄</dt><dd>{ageText(ageMs)}</dd></div>
            <div><dt>存储</dt><dd>{routing.store ? (routing.store.available === false ? `${routing.store.mode ?? '未知'} · 不可用` : (routing.store.mode ?? '未提供')) : (routing.storeLabel ?? '未提供')}</dd></div>
            {#if routing.epoch?.since}
              <div><dt>统计纪元</dt><dd>{fmtTime(routing.epoch.since) ?? routing.epoch.since}</dd></div>
            {/if}
          </dl>
        </div>
      </section>
    {/if}
  </main>

  <div id="status-announcer" class="sr" role="status" aria-live="polite">{announcement}</div>

  <footer class="foot">需要管理员会话 · <a href="/">公开使用统计</a> · <a href="/admin">用户管理</a></footer>
</div>
