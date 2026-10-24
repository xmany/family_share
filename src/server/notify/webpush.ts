// Web push channel (VAPID, web-push 3.6.7). Payload = Declarative Web Push (PushPayload in shared/types.ts):
// iOS 18.4+ renders it without the service worker; Chrome/Android hand it to sw.ts, which adds data.actions buttons.
// docs/research/pwa.md §1 and §6, SPEC §7.

import webpush from 'web-push'
import type { Config } from '../config'
import type { Db } from '../db/db'
import { newId } from '../ids'
import type { Member, NotificationKind, PushPayload, ScheduledNotification } from '../../shared/types'
import type { Clock } from '../time'
import { DAY } from '../time'
import type { DeliveryResult, NotificationChannel } from './types'

export const WEBPUSH_CHANNEL = 'webpush'
/** Serialized payload budget (push services accept 4 KB; Chinese text is 3 bytes per character). */
export const PUSH_PAYLOAD_MAX_BYTES = 3000
export const PUSH_TIMEOUT_MS = 10_000
/** A subscription is healthy with a success (or a fresh subscribe) in this window. */
export const PUSH_HEALTHY_WINDOW_MS = 7 * DAY

const HIGH_URGENCY: readonly NotificationKind[] = [
  'request_new',
  'request_followup',
  'request_noreply',
  'request_answered',
  'due',
  'explicit',
  'assigned',
]

export interface PushSendOptions {
  TTL: number
  urgency: 'high' | 'normal'
  topic?: string
  timeout: number
  vapidDetails: { subject: string; publicKey: string; privateKey: string }
}

export interface PushTarget {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** Sends one encrypted push. Rejects with an error carrying `statusCode` (web-push's WebPushError) on HTTP errors. */
export type PushSender = (subscription: PushTarget, payload: string, options: PushSendOptions) => Promise<unknown>

export const defaultPushSender: PushSender = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options)

/** TTL / urgency / topic per SPEC §7. */
export function pushOptionsFor(n: Pick<ScheduledNotification, 'kind' | 'itemId'>): Omit<PushSendOptions, 'timeout' | 'vapidDetails'> {
  const isRequest = n.kind.startsWith('request_')
  const TTL = isRequest || n.kind === 'due' || n.kind === 'explicit' ? 3600 : n.kind === 'digest' || n.kind === 'weekly' ? 12 * 3600 : 6 * 3600
  const urgency = HIGH_URGENCY.includes(n.kind) ? 'high' : 'normal'
  const out: Omit<PushSendOptions, 'timeout' | 'vapidDetails'> = { TTL, urgency }
  const topic = n.itemId ? `i${n.itemId}` : n.kind === 'digest' || n.kind === 'weekly' ? n.kind : null
  if (topic) {
    const clean = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    if (clean) out.topic = clean
  }
  return out
}

/** `${publicUrl}${path}${?|&}src=push` (absolute URLs are kept as they are). */
export function pushNavigateUrl(publicUrl: string, url: string): string {
  const base = /^https?:\/\//.test(url) ? url : `${publicUrl}${url.startsWith('/') ? '' : '/'}${url}`
  const hashAt = base.indexOf('#')
  const head = hashAt >= 0 ? base.slice(0, hashAt) : base
  const hash = hashAt >= 0 ? base.slice(hashAt) : ''
  return `${head}${head.includes('?') ? '&' : '?'}src=push${hash}`
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** Builds the Declarative Web Push payload, shortening the body (then the title) until it fits the byte budget. */
export function buildPushPayload(n: ScheduledNotification, opts: { publicUrl: string; badge?: number | null }): PushPayload {
  const payload: PushPayload = {
    web_push: 8030,
    notification: {
      title: n.title,
      body: n.body,
      navigate: pushNavigateUrl(opts.publicUrl, n.url),
      lang: 'zh-CN',
      data: { notificationId: n.id, itemId: n.itemId, kind: n.kind, actions: n.actions },
    },
  }
  const tag = n.itemId ? `item-${n.itemId}` : n.kind === 'digest' || n.kind === 'weekly' ? n.kind : null
  if (tag) payload.notification.tag = tag
  if (typeof opts.badge === 'number' && opts.badge >= 0) payload.app_badge = String(opts.badge)
  shrinkToFit(payload)
  return payload
}

function shrinkToFit(p: PushPayload): void {
  const size = () => bytes(JSON.stringify(p))
  const cut = (s: string, over: number): string => {
    const chars = Array.from(s)
    // remove at least enough characters to cover the overflow (each char is >= 1 byte) plus room for "…"
    let keep = chars.length
    let removed = 0
    while (keep > 0 && removed < over + 3) {
      keep--
      removed += bytes(chars[keep]!)
    }
    return keep > 0 ? chars.slice(0, keep).join('') + '…' : ''
  }
  let over = size() - PUSH_PAYLOAD_MAX_BYTES
  if (over > 0) p.notification.body = cut(p.notification.body, over)
  over = size() - PUSH_PAYLOAD_MAX_BYTES
  if (over > 0) p.notification.title = cut(p.notification.title, over) || '家庭助手'
  over = size() - PUSH_PAYLOAD_MAX_BYTES
  if (over > 0) p.notification.data.actions = []
}

// ---------------------------------------------------------------------------------------------
// Subscriptions (table push_subscriptions)

export interface PushSubscriptionRow {
  id: string
  member_id: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent: string | null
  created_at: string
  last_success_at: string | null
  failure_count: number
}

export function listPushSubscriptions(db: Db, memberId: string): PushSubscriptionRow[] {
  return db.prepare('SELECT * FROM push_subscriptions WHERE member_id = ? ORDER BY created_at, rowid').all(memberId) as PushSubscriptionRow[]
}

export function countPushSubscriptions(db: Db, memberId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?').get(memberId) as { n: number }).n
}

/**
 * Healthy = at least one subscription that succeeded in the last 7 days, or was (re)subscribed in the last 7 days
 * and has not been tried yet. Used by WeChat 'fallback' routing and the settings screen.
 */
export function isPushHealthy(db: Db, memberId: string, now: Date): boolean {
  const since = new Date(now.getTime() - PUSH_HEALTHY_WINDOW_MS).toISOString()
  const r = db
    .prepare(
      `SELECT 1 FROM push_subscriptions WHERE member_id = ?
       AND (last_success_at >= ? OR (created_at >= ? AND last_success_at IS NULL AND failure_count = 0)) LIMIT 1`,
    )
    .get(memberId, since, since)
  return !!r
}

export interface SubscriptionInput {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export class InvalidSubscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSubscriptionError'
  }
}

/**
 * Upserts on endpoint, (re)assigning it to this member. Re-saving the same subscription (every app launch) keeps its
 * history; new keys for the same endpoint count as a fresh subscription.
 */
export function upsertPushSubscription(db: Db, memberId: string, sub: SubscriptionInput, userAgent: string | null, now: Date): void {
  const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint.trim() : ''
  let url: URL | null = null
  try {
    url = new URL(endpoint)
  } catch {
    url = null
  }
  if (!url || url.protocol !== 'https:' || endpoint.length > 2048) throw new InvalidSubscriptionError('推送订阅地址无效')
  const p256dh = sub.keys?.p256dh
  const auth = sub.keys?.auth
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth || p256dh.length > 512 || auth.length > 512) {
    throw new InvalidSubscriptionError('推送订阅缺少密钥')
  }
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 500) : null
  const nowIso = now.toISOString()
  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as PushSubscriptionRow | undefined
    if (!existing) {
      db.prepare(
        `INSERT INTO push_subscriptions (id, member_id, endpoint, p256dh, auth, user_agent, created_at, last_success_at, failure_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
      ).run(newId('ps'), memberId, endpoint, p256dh, auth, ua, nowIso)
      return
    }
    const sameKeys = existing.p256dh === p256dh && existing.auth === auth
    const sameMember = existing.member_id === memberId
    if (sameKeys && sameMember) {
      db.prepare('UPDATE push_subscriptions SET user_agent = COALESCE(?, user_agent) WHERE id = ?').run(ua, existing.id)
    } else {
      db.prepare(
        `UPDATE push_subscriptions SET member_id = ?, p256dh = ?, auth = ?, user_agent = COALESCE(?, user_agent),
         created_at = ?, last_success_at = NULL, failure_count = 0 WHERE id = ?`,
      ).run(memberId, p256dh, auth, ua, nowIso, existing.id)
    }
  })()
}

export function deletePushSubscription(db: Db, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
}

/** Pending requests waiting for this member's answer (shown as the iOS app badge). */
export function badgeCount(db: Db, memberId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM items WHERE kind = 'request' AND status = 'pending' AND owner_id = ?`).get(memberId) as {
      n: number
    }
  ).n
}

// ---------------------------------------------------------------------------------------------
// The channel

export interface WebPushChannelDeps {
  config: Pick<Config, 'publicUrl' | 'webPush'>
  db: Db
  clock: Clock
  sender?: PushSender
  log?: Pick<Console, 'warn' | 'error'>
}

interface PushErrorLike {
  statusCode?: unknown
  body?: unknown
  message?: unknown
}

const shortEndpoint = (e: string) => {
  try {
    const u = new URL(e)
    return `${u.host}/…${e.slice(-8)}`
  } catch {
    return '…'
  }
}

export function createWebPushChannel(deps: WebPushChannelDeps): NotificationChannel {
  const { config, db, clock } = deps
  const send = deps.sender ?? defaultPushSender
  const log = deps.log ?? console

  return {
    name: WEBPUSH_CHANNEL,
    isConfigured: () => !!config.webPush,
    async deliver(member: Member, n: ScheduledNotification): Promise<DeliveryResult[]> {
      const vapid = config.webPush
      if (!vapid) return []
      const subs = listPushSubscriptions(db, member.id)
      if (subs.length === 0) return []
      const payload = JSON.stringify(buildPushPayload(n, { publicUrl: config.publicUrl, badge: badgeCount(db, member.id) }))
      const options: PushSendOptions = {
        ...pushOptionsFor(n),
        timeout: PUSH_TIMEOUT_MS,
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      }
      const results: DeliveryResult[] = []
      for (const sub of subs) {
        try {
          await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, options)
          db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?').run(clock.now().toISOString(), sub.id)
          results.push({ channel: WEBPUSH_CHANNEL, ok: true })
        } catch (e) {
          const err = (e ?? {}) as PushErrorLike
          const status = typeof err.statusCode === 'number' ? err.statusCode : null
          if (status === 404 || status === 410) {
            // expired / uninstalled: the endpoint is gone for good
            deletePushSubscription(db, sub.endpoint)
            results.push({ channel: WEBPUSH_CHANNEL, ok: false, permanent: true, error: `${status} subscription gone` })
            continue
          }
          db.prepare('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?').run(sub.id)
          if (status === null || status === 429 || status >= 500) {
            const what = status === null ? `network: ${String(err.message ?? e)}` : `${status}`
            results.push({ channel: WEBPUSH_CHANNEL, ok: false, permanent: false, error: what })
          } else {
            // 400 / 403 (VAPID) / 413 (too large) …: a bug or config problem, retrying won't help
            log.warn(`[webpush] ${status} from ${shortEndpoint(sub.endpoint)}:`, typeof err.body === 'string' ? err.body.slice(0, 300) : '')
            results.push({ channel: WEBPUSH_CHANNEL, ok: false, permanent: true, error: `${status}` })
          }
        }
      }
      return results
    },
  }
}
