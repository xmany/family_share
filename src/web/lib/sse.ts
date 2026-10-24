// Live updates over SSE (GET /api/stream). Reconnects with exponential backoff + jitter, closes
// while the page is hidden (mobile browsers freeze it anyway) and refetches on return, and uses a
// watchdog because the server pings every 25 s: silence for 70 s means a dead connection.

import type { ServerEvent } from '../../shared/api'

export interface LiveHandlers {
  onEvent(event: ServerEvent): void
  /** We may have missed events (reconnect, came back to the foreground): refetch. */
  onResync(): void
  onConnectionChange?(connected: boolean): void
}

const WATCHDOG_MS = 70_000
const MAX_BACKOFF_MS = 30_000

export function startLiveUpdates(h: LiveHandlers): () => void {
  let es: EventSource | null = null
  let stopped = false
  let attempt = 0
  let everConnected = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const clearTimers = () => {
    if (retryTimer) clearTimeout(retryTimer)
    if (watchdog) clearTimeout(watchdog)
    retryTimer = null
    watchdog = null
  }

  const close = () => {
    if (es) {
      es.onmessage = null
      es.onerror = null
      es.close()
      es = null
      h.onConnectionChange?.(false)
    }
  }

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      close()
      scheduleReconnect()
    }, WATCHDOG_MS)
  }

  const scheduleReconnect = () => {
    if (stopped || document.visibilityState === 'hidden') return
    if (retryTimer) clearTimeout(retryTimer)
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt)
    const delay = base * (0.75 + Math.random() * 0.5)
    attempt++
    // EventSource hides the status code: after a few failures, refetch once so a lost session
    // (401 → sign-in screen) or a missed change shows up instead of silently retrying forever.
    if (attempt === 3) h.onResync()
    retryTimer = setTimeout(connect, delay)
  }

  function connect() {
    retryTimer = null
    if (stopped || es || document.visibilityState === 'hidden') return
    if (typeof EventSource === 'undefined') return
    es = new EventSource('/api/stream')
    armWatchdog()
    es.onmessage = ev => {
      armWatchdog()
      let data: ServerEvent
      try {
        data = JSON.parse(ev.data as string) as ServerEvent
      } catch {
        return
      }
      if (data.type === 'hello') {
        attempt = 0
        h.onConnectionChange?.(true)
        if (everConnected) h.onResync()
        everConnected = true
      }
      h.onEvent(data)
    }
    es.onerror = () => {
      // Take over from the browser's fixed retry so failures back off (1 s, 2 s, 4 s … 30 s).
      close()
      scheduleReconnect()
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      h.onResync()
      if (!es) {
        attempt = 0
        clearTimers()
        connect()
      }
    } else {
      clearTimers()
      close()
    }
  }

  const onOnline = () => {
    if (!es) {
      attempt = 0
      clearTimers()
      connect()
    }
    h.onResync()
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
  connect()

  return () => {
    stopped = true
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
    clearTimers()
    close()
  }
}
