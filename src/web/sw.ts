/// <reference lib="webworker" />
// Service worker (vite-plugin-pwa injectManifest). SPEC §7, docs/research/pwa.md §6.
// - precache the app shell; SPA navigation fallback to index.html (never for /api, /wechat, /healthz)
// - push: ALWAYS show a notification (Chrome requires it; Safari revokes permission otherwise).
//   iOS 18.4+ renders our Declarative Web Push payloads itself and never calls this handler.
// - notificationclick: a button → POST /api/notifications/:id/action with the cookie session,
//   then tell open windows to refetch; a body tap (or a failed action) → focus a window and
//   postMessage {type:'navigate'} (avoids WindowClient.navigate bugs on iOS), else openWindow.

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { clientsClaim } from 'workbox-core'
import type { NotificationAction, NotificationKind, PushPayload } from '../shared/types'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>
}

const APP_NAME = '家庭同步'
const ICON = '/icons/icon-192.png'
const BADGE = '/icons/badge-96.png'
/** Actions the server's POST /api/notifications/:id/action understands ('open' is a plain tap). */
const SERVER_ACTIONS = new Set<string>(['accept', 'decline', 'done', 'snooze_tonight', 'snooze_tomorrow'])

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

try {
  // Throws when index.html is not precached (dev mode); Vite serves the SPA fallback there.
  const handler = createHandlerBoundToURL('index.html')
  registerRoute(
    new NavigationRoute(handler, {
      denylist: [/^\/api(\/|$)/, /^\/wechat(\/|$)/, /^\/healthz(\/|$)/],
    }),
  )
} catch {
  // no precached index.html
}

// ---- push

interface NotificationData {
  notificationId: string | null
  itemId: string | null
  kind: NotificationKind | null
  actions: NotificationAction[]
  /** absolute URL to open */
  navigate: string
}

/** NotificationOptions fields that TypeScript's DOM lib leaves out but Chrome supports. */
type FullNotificationOptions = NotificationOptions & {
  actions?: Array<{ action: string; title: string }>
  renotify?: boolean
}

/**
 * Absolute URL on our own origin. A web URL on another host (PUBLIC_URL not matching the address the
 * app was installed from) keeps its path; anything else (javascript:, data: …) becomes the app root.
 */
function absoluteUrl(url: string | undefined | null): string {
  const origin = self.location.origin
  const root = `${origin}/`
  try {
    const u = new URL(url || '/', origin)
    if (u.origin === origin) return u.href
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return root
    return new URL(u.pathname + u.search + u.hash, origin).href
  } catch {
    return root
  }
}

function maxActions(): number {
  const n = (self as unknown as { Notification?: { maxActions?: number } }).Notification?.maxActions
  return typeof n === 'number' && n >= 0 ? n : 2
}

function parsePayload(data: PushMessageData | null): Partial<PushPayload> | null {
  if (!data) return null
  try {
    const p = data.json() as unknown
    return p && typeof p === 'object' ? (p as Partial<PushPayload>) : null
  } catch {
    return null
  }
}

function textOf(data: PushMessageData | null): string {
  try {
    return data?.text() ?? ''
  } catch {
    return ''
  }
}

async function setBadge(appBadge: string | number | undefined) {
  if (appBadge === undefined || appBadge === null) return
  const n = Number(appBadge)
  if (!Number.isFinite(n)) return
  const nav = self.navigator as WorkerNavigator & {
    setAppBadge?: (n?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (n > 0) await nav.setAppBadge?.(n)
    else await nav.clearAppBadge?.()
  } catch {
    // badging unsupported or not permitted
  }
}

async function windowClients(): Promise<readonly WindowClient[]> {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
}

async function broadcast(message: { type: string; [k: string]: unknown }) {
  for (const c of await windowClients()) c.postMessage(message)
}

async function handlePush(event: PushEvent) {
  const payload = parsePayload(event.data)
  const n = payload?.notification
  const data: NotificationData = {
    notificationId: n?.data?.notificationId ?? null,
    itemId: n?.data?.itemId ?? null,
    kind: n?.data?.kind ?? null,
    actions: Array.isArray(n?.data?.actions) ? n.data.actions : [],
    navigate: absoluteUrl(n?.navigate),
  }
  const title = n?.title || APP_NAME
  const options: FullNotificationOptions = {
    body: n?.body ?? (payload ? '' : textOf(event.data)),
    lang: n?.lang || 'zh-CN',
    icon: ICON,
    badge: BADGE,
    data,
    actions: data.actions.slice(0, maxActions()).map(a => ({ action: a.action, title: a.title })),
  }
  if (n?.tag) {
    options.tag = n.tag
    options.renotify = true // renotify without a tag throws in Chrome
  }
  try {
    await self.registration.showNotification(title, options)
  } catch {
    // never leave a push without a visible notification
    await self.registration.showNotification(title, { body: options.body, icon: ICON, data })
  }
  await setBadge(payload?.app_badge)
  await broadcast({ type: 'board_changed' })
}

self.addEventListener('push', event => {
  event.waitUntil(handlePush(event))
})

// ---- notification taps

/**
 * Chrome only lets a service worker open/focus a window for ~10 s after the click, so the button
 * request gets a shorter deadline: when it is slow or fails we can still open the item instead.
 */
const ACTION_TIMEOUT_MS = 6000

async function postAction(notificationId: string, action: string): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ACTION_TIMEOUT_MS)
  try {
    const res = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/action`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Family-Share': '1' },
      body: JSON.stringify({ action }),
      signal: ctrl.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function focusOrOpen(url: string) {
  const clients = await windowClients()
  const sameOrigin = clients.filter(c => {
    try {
      return new URL(c.url).origin === self.location.origin
    } catch {
      return false
    }
  })
  const win = sameOrigin.find(c => c.focused) ?? sameOrigin.find(c => c.visibilityState === 'visible') ?? sameOrigin[0]
  if (win) {
    try {
      const focused = await win.focus()
      focused.postMessage({ type: 'navigate', url })
      return
    } catch {
      // focus can fail without a user activation; fall back to a new window
    }
  }
  await self.clients.openWindow(url)
}

async function handleClick(action: string, data: Partial<NotificationData>) {
  const url = absoluteUrl(data.navigate)
  if (action && SERVER_ACTIONS.has(action) && data.notificationId) {
    const ok = await postAction(data.notificationId, action)
    await broadcast({ type: 'board_changed' })
    if (ok) return
  }
  await focusOrOpen(url)
}

self.addEventListener('notificationclick', event => {
  const notification = event.notification
  const data = (notification.data ?? {}) as Partial<NotificationData>
  notification.close()
  event.waitUntil(handleClick(event.action, data))
})

// Chrome 138+: the push service rotated our subscription. iOS never fires this; the page
// re-syncs on every launch instead.
interface PushSubscriptionChangeEventLike extends ExtendableEvent {
  readonly oldSubscription?: PushSubscription | null
  readonly newSubscription?: PushSubscription | null
}

async function resubscribe(event: PushSubscriptionChangeEventLike) {
  let sub = event.newSubscription ?? null
  if (!sub) {
    const key = event.oldSubscription?.options?.applicationServerKey
    if (!key) return
    sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  }
  const j = sub.toJSON()
  await fetch('/api/push/subscriptions', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Family-Share': '1' },
    body: JSON.stringify({
      subscription: {
        endpoint: j.endpoint ?? sub.endpoint,
        expirationTime: j.expirationTime ?? null,
        keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' },
      },
    }),
  }).catch(() => undefined)
}

self.addEventListener('pushsubscriptionchange', (event: Event) => {
  const e = event as PushSubscriptionChangeEventLike
  e.waitUntil(resubscribe(e).catch(() => undefined))
})
