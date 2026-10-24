// Service worker registration + web push subscription (SPEC §6/§7, docs/research/pwa.md §1 and §6).
// - The SW registration is obtained at launch, so a tap can call requestPermission()/subscribe()
//   as its first await (iOS requires the prompt to come straight from a user gesture).
// - syncSubscription() runs on every launch: iOS never fires pushsubscriptionchange, and the
//   server needs to know the endpoint is still alive.
// - The SW posts {type:'navigate', url} (notification tap with the app already open) and
//   {type:'board_changed'} (a notification button changed something).

import { registerSW } from 'virtual:pwa-register'
import type { PushSubscribeBody } from '../../shared/api'
import { api } from './api'
import { isAndroid, isIOS, isStandalone, isWeChat, sameBytes, urlBase64ToUint8Array } from './platform'

export { isAndroid, isIOS, isStandalone, isWeChat, urlBase64ToUint8Array }

export interface SwHandlers {
  onNavigate(url: string): void
  onBoardChanged(): void
}

let registration: ServiceWorkerRegistration | null = null
let initialized = false
let hadController = false
let reloadWhenHidden = false

export function swSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

export function pushSupported(): boolean {
  return swSupported() && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window
}

/** Registers the service worker and wires its messages. Call once at startup. */
export function initServiceWorker(handlers: SwHandlers): void {
  if (initialized || !swSupported()) return
  initialized = true
  const sw = navigator.serviceWorker
  hadController = !!sw.controller

  sw.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: unknown } | null
    if (!data || typeof data !== 'object') return
    if (data.type === 'navigate' && typeof data.url === 'string') handlers.onNavigate(data.url)
    else if (data.type === 'board_changed') handlers.onBoardChanged()
  })
  // deliver messages queued before the listener existed
  sw.startMessages?.()

  // A new SW version took over (it calls skipWaiting + clientsClaim). Reload quietly the next
  // time the app goes to the background, never in the middle of something.
  sw.addEventListener('controllerchange', () => {
    if (hadController) reloadWhenHidden = true
    hadController = true
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && reloadWhenHidden) {
      reloadWhenHidden = false
      window.location.reload()
    }
  })

  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      if (reg) registration = reg
    },
    onRegisterError(err) {
      console.warn('[sw] registration failed', err)
    },
  })
  sw.ready.then(reg => {
    registration = reg
  }).catch(() => {})
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (registration) return registration
  if (!swSupported()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (reg) registration = reg
    return reg ?? null
  } catch {
    return null
  }
}

/**
 * A registration with an ACTIVE worker (subscribe() rejects with InvalidStateError before that, e.g.
 * on the first launch while the new service worker is still installing). null after `timeoutMs`.
 */
async function activeRegistration(timeoutMs: number): Promise<ServiceWorkerRegistration | null> {
  const known = await getRegistration()
  if (known?.active) return known
  if (!swSupported()) return null
  const reg = await Promise.race([
    navigator.serviceWorker.ready.catch(() => null),
    new Promise<null>(res => setTimeout(() => res(null), timeoutMs)),
  ])
  if (reg) registration = reg
  return reg
}

export class PushSetupError extends Error {
  readonly code: 'unsupported' | 'needs_install' | 'denied' | 'not_ready' | 'not_configured' | 'retry' | 'failed'
  constructor(code: PushSetupError['code'], message: string) {
    super(message)
    this.name = 'PushSetupError'
    this.code = code
  }
}

function subscriptionBody(sub: PushSubscription): PushSubscribeBody {
  const j = sub.toJSON()
  return {
    subscription: {
      endpoint: j.endpoint ?? sub.endpoint,
      expirationTime: j.expirationTime ?? null,
      keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' },
    },
  }
}

function keyMatches(sub: PushSubscription, key: Uint8Array): boolean {
  const current = sub.options?.applicationServerKey
  return current ? sameBytes(current, key) : true // unknown → assume it matches
}

/**
 * Turns on notifications for this device. MUST be called directly from a tap handler:
 * Notification.requestPermission() (or subscribe() when already granted) is the first await.
 */
export async function enablePush(vapidPublicKey: string | null): Promise<PushSubscription> {
  if (isWeChat()) throw new PushSetupError('unsupported', '微信里无法开启通知，请点右上角 ··· → 在浏览器打开')
  // iOS: web push exists only for Home Screen apps (16.4+), whatever a Safari tab happens to expose
  if (isIOS() && !isStandalone())
    throw new PushSetupError('needs_install', 'iPhone 需要先把应用添加到主屏幕，再从主屏幕打开后开启通知')
  if (!pushSupported()) {
    if (isIOS()) throw new PushSetupError('unsupported', '这台 iPhone 的系统太旧了，升级到 iOS 16.4 或更新版本后才能开启通知')
    throw new PushSetupError('unsupported', '这个浏览器不支持通知')
  }
  if (!vapidPublicKey) throw new PushSetupError('not_configured', '服务器还没有配置推送（VAPID），请联系管理员')
  const key = urlBase64ToUint8Array(vapidPublicKey)
  const reg = registration // captured synchronously: nothing may be awaited before the prompt
  const options: PushSubscriptionOptionsInit = { userVisibleOnly: true, applicationServerKey: key }

  let permission: NotificationPermission = Notification.permission
  if (permission === 'default') permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new PushSetupError(
      'denied',
      isIOS()
        ? '通知被关闭了。请到 iPhone 设置 → 通知 → 家庭同步，打开「允许通知」'
        : '通知被拒绝了。请在浏览器的网站设置里允许本站发送通知',
    )
  }

  // Permission is granted from here on, so waiting no longer risks losing the tap.
  const r = reg?.active ? reg : await activeRegistration(15_000)
  if (!r) throw new PushSetupError('not_ready', '通知服务还在准备，请过几秒再点一次')

  const notReady = new PushSetupError('not_ready', '通知服务还在准备，请过几秒再点一次')
  const failed = new PushSetupError('failed', '开启通知失败了。安卓手机需要 Chrome 和 Google 服务；也可以改用微信提醒')
  const subscribe = async (): Promise<PushSubscription> => {
    try {
      return await r.pushManager.subscribe(options)
    } catch (e) {
      const name = (e as { name?: string } | null)?.name
      if (name === 'NotAllowedError') throw new PushSetupError('retry', '请再点一次「开启通知」')
      if (name === 'InvalidStateError') throw notReady
      throw failed
    }
  }

  let sub: PushSubscription
  try {
    sub = await subscribe()
  } catch (e) {
    // InvalidStateError also means "already subscribed with a different server key": replace it
    const old = e === notReady ? await r.pushManager.getSubscription().catch(() => null) : null
    if (!old) throw e
    await old.unsubscribe().catch(() => false)
    sub = await subscribe()
  }
  if (!keyMatches(sub, key)) {
    await sub.unsubscribe().catch(() => false)
    sub = await subscribe()
  }
  await api.subscribePush(subscriptionBody(sub))
  return sub
}

export type SyncResult = 'synced' | 'missing' | 'skipped'

/**
 * On every launch: if permission is granted, make sure this device's subscription exists, uses the
 * server's current key, and is registered with the server. 'missing' = needs a tap to re-enable.
 */
export async function syncSubscription(vapidPublicKey: string | null): Promise<SyncResult> {
  if (!pushSupported() || !vapidPublicKey || Notification.permission !== 'granted') return 'skipped'
  const reg = await activeRegistration(8000)
  if (!reg) return 'skipped'
  const key = urlBase64ToUint8Array(vapidPublicKey)
  try {
    let sub = await reg.pushManager.getSubscription()
    if (sub && !keyMatches(sub, key)) {
      await sub.unsubscribe().catch(() => false)
      sub = null
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      } catch {
        return 'missing'
      }
    }
    await api.subscribePush(subscriptionBody(sub))
    return 'synced'
  } catch {
    return 'skipped'
  }
}

/** Turns notifications off for this device (server row deleted, browser subscription dropped). */
export async function disablePush(): Promise<void> {
  const reg = await getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await api.unsubscribePush(sub.endpoint).catch(() => undefined)
  await sub.unsubscribe().catch(() => false)
}

export type PushState =
  | 'wechat' // WeChat in-app browser: open in a real browser first
  | 'needs_install' // iOS Safari tab: add to Home Screen first
  | 'ios_too_old' // Home Screen app on iOS < 16.4
  | 'unsupported'
  | 'not_configured' // server has no VAPID key
  | 'denied'
  | 'off' // can be turned on with a tap
  | 'on'

export async function getPushState(vapidPublicKey: string | null): Promise<PushState> {
  if (isWeChat()) return 'wechat'
  if (isIOS() && !isStandalone()) return 'needs_install'
  if (!pushSupported()) return isIOS() ? 'ios_too_old' : 'unsupported'
  if (!vapidPublicKey) return 'not_configured'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  const reg = await getRegistration()
  const sub = await reg?.pushManager.getSubscription().catch(() => null)
  return sub ? 'on' : 'off'
}
