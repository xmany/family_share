// The Notifier: fans one outbox row out to the member's channels, and owns per-member channel settings and push
// subscriptions. Routing (SPEC §7):
//   webpush  — every subscription of the member (unless their WeChat mode is 'only' and WeChat is usable)
//   wechat   — per member mode: fallback (default) = only when push is not healthy (no subscription, none succeeded
//              in the last 7 days) or every push attempt for THIS notification failed; both; only; off
//   others   — any extra configured channel passed in deps.channels is always tried
// Each channel's results go to the deliveries log as soon as that channel is done, and a channel that already
// delivered a notification successfully is never used for it again (retries, a restart that cut a send short).

import type { ChannelSetting, PushSubscribeBody } from '../../shared/api'
import type { Config } from '../config'
import type { Db } from '../db/db'
import type { Domain } from '../domain/types'
import { DomainError } from '../domain/types'
import type { Member, ScheduledNotification, WechatMode } from '../../shared/types'
import type { Clock } from '../time'
import { WECHAT_CHANNEL, isWechatMode, readWechatBinding, setWechatPreferences, unbindWechat } from '../wechat/store'
import { isChannelEnabled, readMemberChannel, writeMemberChannel } from './memberChannels'
import type { Outbox } from './outbox'
import type { DeliveryResult, NotificationChannel, Notifier } from './types'
import {
  InvalidSubscriptionError,
  WEBPUSH_CHANNEL,
  countPushSubscriptions,
  createWebPushChannel,
  deletePushSubscription,
  isPushHealthy,
  upsertPushSubscription,
} from './webpush'
import { createWechatChannel } from './wechat'

export interface NotifierDeps {
  config: Config
  db: Db
  clock: Clock
  domain: Domain
  outbox: Outbox
  appSecret: string
  /** Replaces the default channels (webpush + wechat), e.g. fakes in tests. */
  channels?: NotificationChannel[]
  log?: Pick<Console, 'warn' | 'error'>
}

export function defaultChannels(deps: Pick<NotifierDeps, 'config' | 'db' | 'clock' | 'domain' | 'appSecret'>): NotificationChannel[] {
  return [
    createWebPushChannel({ config: deps.config, db: deps.db, clock: deps.clock }),
    createWechatChannel({ config: deps.config, db: deps.db, clock: deps.clock, domain: deps.domain, appSecret: deps.appSecret }),
  ]
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const { config, db, clock, domain, outbox } = deps
  const log = deps.log ?? console
  const all = deps.channels ?? defaultChannels(deps)
  const configured = () => all.filter(c => c.isConfigured())
  const find = (name: string) => configured().find(c => c.name === name) ?? null

  function requireMember(memberId: string): Member {
    const m = domain.getMember(memberId)
    if (!m) throw new DomainError('not_found', `找不到这个成员（${memberId}）`)
    return m
  }

  async function safeDeliver(c: NotificationChannel, member: Member, n: ScheduledNotification): Promise<DeliveryResult[]> {
    try {
      return await c.deliver(member, n)
    } catch (e) {
      log.error(`[notify] channel ${c.name} threw`, e)
      return [{ channel: c.name, ok: false, permanent: false, error: `exception: ${(e as Error)?.message ?? String(e)}`.slice(0, 200) }]
    }
  }

  function record(n: ScheduledNotification, results: DeliveryResult[]): void {
    for (const r of results) {
      try {
        outbox.recordDelivery(n.id, r.channel, r.ok, r.error)
      } catch {
        // ad-hoc notifications that are not outbox rows (FK) are simply not logged
      }
    }
  }

  /** Channels that already delivered this notification successfully (deliveries log). */
  function deliveredChannels(notificationId: string): Set<string> {
    const rows = db.prepare('SELECT DISTINCT channel FROM deliveries WHERE notification_id = ? AND ok = 1').all(notificationId) as {
      channel: string
    }[]
    return new Set(rows.map(r => r.channel))
  }

  function getMemberChannels(memberId: string): ChannelSetting[] {
    requireMember(memberId)
    const out: ChannelSetting[] = []
    for (const c of configured()) {
      if (c.name === WEBPUSH_CHANNEL) {
        out.push({
          channel: WEBPUSH_CHANNEL,
          enabled: isChannelEnabled(db, memberId, WEBPUSH_CHANNEL),
          config: { devices: String(countPushSubscriptions(db, memberId)) },
        })
      } else if (c.name === WECHAT_CHANNEL) {
        const b = readWechatBinding(db, memberId)
        // never expose the openid
        out.push({ channel: WECHAT_CHANNEL, enabled: b.enabled, config: { mode: b.mode, bound: b.openid ? 'yes' : 'no' } })
      } else {
        out.push({ channel: c.name, enabled: isChannelEnabled(db, memberId, c.name), config: {} })
      }
    }
    return out
  }

  return {
    channels: () => configured().map(c => c.name),

    async deliver(n: ScheduledNotification): Promise<DeliveryResult[]> {
      const member = domain.getMember(n.memberId)
      if (!member) return []
      const now = clock.now()
      const push = find(WEBPUSH_CHANNEL)
      const wechat = find(WECHAT_CHANNEL)
      const wx = wechat ? readWechatBinding(db, member.id) : null
      const wechatUsable = !!wx && !!wx.openid && wx.enabled && wx.mode !== 'off'
      const wechatOnly = wechatUsable && wx!.mode === 'only'
      const pushOn = !!push && isChannelEnabled(db, member.id, WEBPUSH_CHANNEL)
      // A retry (after a failure, or after a restart cut a send short) never repeats a channel that already
      // reached the member with this notification: it counts as delivered and is not logged twice.
      const already = deliveredChannels(n.id)
      const results: DeliveryResult[] = []
      const run = async (c: NotificationChannel): Promise<DeliveryResult[]> => {
        if (already.has(c.name)) return [{ channel: c.name, ok: true }]
        const r = await safeDeliver(c, member, n)
        record(n, r) // right away, so a crash before the other channels finish keeps this one on record
        return r
      }

      // 1. web push (skipped only when the member chose WeChat-only and WeChat can actually reach them)
      let pushResults: DeliveryResult[] = []
      let pushHealthy = false
      let pushTried = false
      if (pushOn && !wechatOnly) {
        pushHealthy = isPushHealthy(db, member.id, now)
        pushResults = await run(push!)
        pushTried = true
        results.push(...pushResults)
      }

      // 2. WeChat per mode
      if (wechat && wechatUsable) {
        const allPushFailed = pushResults.length === 0 || pushResults.every(r => !r.ok)
        const send = wx!.mode === 'both' || wx!.mode === 'only' || (wx!.mode === 'fallback' && (!pushHealthy || allPushFailed))
        if (send) {
          const wr = await run(wechat)
          results.push(...wr)
          // 'only' skipped push; if WeChat just told us the openid is gone (43004 / 40003 unbinds it), this
          // notification would be lost, so fall back to push like every later one will.
          if (wechatOnly && pushOn && !pushTried && wr.every(r => !r.ok) && !readWechatBinding(db, member.id).openid) {
            results.push(...(await run(push!)))
          }
        }
      }

      // 3. any other configured channel
      for (const c of configured()) {
        if (c.name === WEBPUSH_CHANNEL || c.name === WECHAT_CHANNEL) continue
        if (!isChannelEnabled(db, member.id, c.name)) continue
        results.push(...(await run(c)))
      }

      return results
    },

    vapidPublicKey: () => config.webPush?.publicKey ?? null,

    savePushSubscription(memberId: string, sub: PushSubscribeBody['subscription'], userAgent?: string | null): void {
      requireMember(memberId)
      try {
        upsertPushSubscription(db, memberId, sub, userAgent ?? null, clock.now())
      } catch (e) {
        if (e instanceof InvalidSubscriptionError) throw new DomainError('invalid', e.message)
        throw e
      }
    },

    removePushSubscription(endpoint: string): void {
      if (typeof endpoint === 'string' && endpoint) deletePushSubscription(db, endpoint)
    },

    pushSubscriptionCount: (memberId: string) => countPushSubscriptions(db, memberId),

    getMemberChannels,

    setMemberChannels(memberId: string, settings: ChannelSetting[]): ChannelSetting[] {
      requireMember(memberId)
      const now = clock.now()
      const names = new Set(configured().map(c => c.name))
      db.transaction(() => {
        for (const s of Array.isArray(settings) ? settings : []) {
          if (!s || typeof s.channel !== 'string' || !names.has(s.channel)) continue
          const enabled = typeof s.enabled === 'boolean' ? s.enabled : undefined
          const cfg = s.config && typeof s.config === 'object' ? s.config : {}
          if (s.channel === WECHAT_CHANNEL) {
            const raw: unknown = cfg.mode
            let mode: WechatMode | undefined
            if (raw !== undefined) {
              if (!isWechatMode(raw)) throw new DomainError('invalid', '微信提醒方式只能是 fallback / both / only / off')
              mode = raw
            }
            // only mode / enabled may change here; the openid is set by the bind flow (bound: "no" unbinds)
            setWechatPreferences(db, memberId, { mode, enabled }, now)
            if (cfg.bound === 'no') unbindWechat(db, memberId, now)
          } else {
            const current = readMemberChannel(db, memberId, s.channel)
            writeMemberChannel(db, memberId, s.channel, enabled ?? current?.enabled ?? true, current?.config ?? {}, now)
          }
        }
      })()
      return getMemberChannels(memberId)
    },
  }
}
