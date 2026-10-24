import { describe, expect, it, vi } from 'vitest'
import type { ScheduledNotification } from '../../shared/types'
import { testConfig } from '../config'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { DAY } from '../time'
import type { PushSendOptions, PushSender, PushTarget } from './webpush'
import {
  PUSH_PAYLOAD_MAX_BYTES,
  buildPushPayload,
  createWebPushChannel,
  isPushHealthy,
  listPushSubscriptions,
  pushNavigateUrl,
  pushOptionsFor,
  upsertPushSubscription,
} from './webpush'

const VAPID = { publicKey: 'BPub', privateKey: 'priv', subject: 'mailto:ops@family.test' }

function notification(over: Partial<ScheduledNotification> = {}): ScheduledNotification {
  return {
    id: 'nt_abc',
    memberId: 'm_wife',
    itemId: 'i_abc123',
    kind: 'request_new',
    fireAt: '2026-10-21T01:00:00.000Z',
    title: '老公请你：带孩子出去',
    body: '周六 10/24 08:30 · 他九点有个会',
    url: '/item/i_abc123',
    actions: [
      { action: 'accept', title: '接受' },
      { action: 'decline', title: '做不了' },
    ],
    dedupeKey: 'request_new:i_abc123:1',
    respectQuietHours: false,
    status: 'scheduled',
    attempts: 0,
    sentAt: null,
    lastError: null,
    createdAt: '2026-10-21T01:00:00.000Z',
    ...over,
  }
}

const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/abc${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } })

describe('push payload', () => {
  it('is the Declarative Web Push shape from shared/types', () => {
    const p = buildPushPayload(notification(), { publicUrl: 'https://family.test', badge: 2 })
    expect(p).toEqual({
      web_push: 8030,
      notification: {
        title: '老公请你：带孩子出去',
        body: '周六 10/24 08:30 · 他九点有个会',
        navigate: 'https://family.test/item/i_abc123?src=push',
        lang: 'zh-CN',
        tag: 'item-i_abc123',
        data: {
          notificationId: 'nt_abc',
          itemId: 'i_abc123',
          kind: 'request_new',
          actions: [
            { action: 'accept', title: '接受' },
            { action: 'decline', title: '做不了' },
          ],
        },
      },
      app_badge: '2',
    })
  })

  it('appends src=push with & when the url already has a query, and keeps a hash last', () => {
    expect(pushNavigateUrl('https://family.test', '/weekly?w=2026-43')).toBe('https://family.test/weekly?w=2026-43&src=push')
    expect(pushNavigateUrl('https://family.test', '/item/i_1#notes')).toBe('https://family.test/item/i_1?src=push#notes')
    expect(pushNavigateUrl('https://family.test', 'https://family.test/t/x')).toBe('https://family.test/t/x?src=push')
  })

  it('has no item tag for item-less notifications (digest gets a coalescing tag)', () => {
    const p = buildPushPayload(notification({ itemId: null, kind: 'explicit', url: '/' }), { publicUrl: 'https://family.test' })
    expect(p.notification.tag).toBeUndefined()
    expect(p.notification.navigate).toBe('https://family.test/?src=push')
    expect(p.app_badge).toBeUndefined()
    expect(buildPushPayload(notification({ itemId: null, kind: 'digest', url: '/board' }), { publicUrl: 'https://x.test' }).notification.tag).toBe(
      'digest',
    )
  })

  it('stays under 3000 bytes by shortening the body', () => {
    const p = buildPushPayload(notification({ body: '很长的说明'.repeat(400), title: '标题'.repeat(10) }), { publicUrl: 'https://family.test' })
    const size = Buffer.byteLength(JSON.stringify(p))
    expect(size).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES)
    expect(size).toBeGreaterThan(PUSH_PAYLOAD_MAX_BYTES - 40)
    expect(p.notification.body.endsWith('…')).toBe(true)
    expect(p.notification.title).toBe('标题'.repeat(10))
    expect(p.notification.data.actions).toHaveLength(2)
  })
})

describe('push options', () => {
  it('sets TTL / urgency / topic per kind', () => {
    expect(pushOptionsFor({ kind: 'request_new', itemId: 'i_abc123' })).toEqual({ TTL: 3600, urgency: 'high', topic: 'ii_abc123' })
    expect(pushOptionsFor({ kind: 'due', itemId: 'i_x' })).toMatchObject({ TTL: 3600, urgency: 'high' })
    expect(pushOptionsFor({ kind: 'explicit', itemId: null })).toEqual({ TTL: 3600, urgency: 'high' })
    expect(pushOptionsFor({ kind: 'assigned', itemId: 'i_x' })).toMatchObject({ TTL: 6 * 3600, urgency: 'high' })
    expect(pushOptionsFor({ kind: 'stale', itemId: 'i_x' })).toMatchObject({ TTL: 6 * 3600, urgency: 'normal' })
    expect(pushOptionsFor({ kind: 'digest', itemId: null })).toEqual({ TTL: 12 * 3600, urgency: 'normal', topic: 'digest' })
    expect(pushOptionsFor({ kind: 'weekly', itemId: null })).toMatchObject({ TTL: 12 * 3600, urgency: 'normal' })
    expect(pushOptionsFor({ kind: 'test', itemId: null })).toEqual({ TTL: 6 * 3600, urgency: 'normal' })
    // topic: URL-safe base64 alphabet only, <= 32 chars
    const long = pushOptionsFor({ kind: 'due', itemId: 'i_' + 'x.y/z'.repeat(20) })
    expect(long.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })
})

describe('webpush channel', () => {
  function setup(sender: PushSender) {
    const t = createTestContext()
    const config = testConfig({ webPush: VAPID })
    const channel = createWebPushChannel({ config, db: t.db, clock: t.clock, sender, log: { warn: vi.fn(), error: vi.fn() } })
    return { t, channel }
  }
  const row = (t: TestContext, endpoint: string) => listPushSubscriptions(t.db, t.wife.id).find(s => s.endpoint === endpoint)

  it('sends to every subscription with the payload and options, recording success', async () => {
    const calls: { target: PushTarget; payload: string; options: PushSendOptions }[] = []
    const { t, channel } = setup(async (target, payload, options) => {
      calls.push({ target, payload, options })
      return { statusCode: 201 }
    })
    upsertPushSubscription(t.db, t.wife.id, sub(1), 'iPhone', t.clock.now())
    upsertPushSubscription(t.db, t.wife.id, sub(2), 'Android', t.clock.now())
    const item = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    const n = t.outbox.listForItem(item.id).find(x => x.kind === 'request_new')!
    const results = await channel.deliver(t.wife, n)
    expect(results).toEqual([
      { channel: 'webpush', ok: true },
      { channel: 'webpush', ok: true },
    ])
    expect(calls.map(c => c.target.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint])
    expect(calls[0]!.target.keys).toEqual({ p256dh: 'p1', auth: 'a1' })
    expect(calls[0]!.options).toEqual({
      TTL: 3600,
      urgency: 'high',
      topic: `i${item.id}`,
      timeout: 10_000,
      vapidDetails: { subject: VAPID.subject, publicKey: VAPID.publicKey, privateKey: VAPID.privateKey },
    })
    const payload = JSON.parse(calls[0]!.payload)
    expect(payload.notification.navigate).toBe(`https://family.test/item/${item.id}?src=push`)
    expect(payload.notification.data).toEqual({ notificationId: n.id, itemId: item.id, kind: 'request_new', actions: n.actions })
    expect(payload.app_badge).toBe('1') // one pending request waiting for her
    expect(row(t, sub(1).endpoint)!.last_success_at).toBe(t.clock.now().toISOString())
  })

  it('deletes the subscription on 404/410, counts failures on 4xx, retries on 429/5xx/network', async () => {
    const statusByEndpoint: Record<string, number | null> = {
      [sub(1).endpoint]: 410,
      [sub(2).endpoint]: 404,
      [sub(3).endpoint]: 503,
      [sub(4).endpoint]: 429,
      [sub(5).endpoint]: 403,
      [sub(6).endpoint]: null,
    }
    const { t, channel } = setup(async target => {
      const s = statusByEndpoint[target.endpoint]
      if (s === null) throw new Error('ECONNRESET')
      throw Object.assign(new Error('push failed'), { statusCode: s, body: 'BadJwtToken' })
    })
    for (let i = 1; i <= 6; i++) upsertPushSubscription(t.db, t.wife.id, sub(i), null, t.clock.now())
    const results = await channel.deliver(t.wife, notification({ memberId: t.wife.id, itemId: null, url: '/' }))
    expect(results.map(r => [r.ok, r.permanent])).toEqual([
      [false, true],
      [false, true],
      [false, false],
      [false, false],
      [false, true],
      [false, false],
    ])
    expect(results[5]!.error).toContain('ECONNRESET')
    const left = listPushSubscriptions(t.db, t.wife.id).map(s => s.endpoint)
    expect(left).not.toContain(sub(1).endpoint)
    expect(left).not.toContain(sub(2).endpoint)
    expect(left).toHaveLength(4)
    expect(row(t, sub(3).endpoint)!.failure_count).toBe(1)
    expect(row(t, sub(5).endpoint)!.failure_count).toBe(1)
  })

  it('resets the failure count after a success', async () => {
    let fail = true
    const { t, channel } = setup(async () => {
      if (fail) throw Object.assign(new Error('x'), { statusCode: 500 })
    })
    upsertPushSubscription(t.db, t.wife.id, sub(1), null, t.clock.now())
    await channel.deliver(t.wife, notification())
    await channel.deliver(t.wife, notification())
    expect(row(t, sub(1).endpoint)!.failure_count).toBe(2)
    fail = false
    await channel.deliver(t.wife, notification())
    expect(row(t, sub(1).endpoint)!.failure_count).toBe(0)
  })

  it('returns no results without subscriptions or without VAPID keys', async () => {
    const sender = vi.fn(async () => ({}))
    const { t, channel } = setup(sender)
    expect(await channel.deliver(t.wife, notification())).toEqual([])
    const unconfigured = createWebPushChannel({ config: testConfig(), db: t.db, clock: t.clock, sender })
    upsertPushSubscription(t.db, t.wife.id, sub(1), null, t.clock.now())
    expect(unconfigured.isConfigured()).toBe(false)
    expect(await unconfigured.deliver(t.wife, notification())).toEqual([])
    expect(sender).not.toHaveBeenCalled()
  })
})

describe('subscriptions', () => {
  it('upserts on endpoint and re-assigns it to the member saving it', () => {
    const t = createTestContext()
    upsertPushSubscription(t.db, t.husband.id, sub(1), 'Safari', t.clock.now())
    upsertPushSubscription(t.db, t.husband.id, sub(1), 'Safari', t.clock.now())
    expect(listPushSubscriptions(t.db, t.husband.id)).toHaveLength(1)
    // same phone, now signed in as the wife
    upsertPushSubscription(t.db, t.wife.id, { ...sub(1), keys: { p256dh: 'new', auth: 'new' } }, 'Safari', t.clock.now())
    expect(listPushSubscriptions(t.db, t.husband.id)).toHaveLength(0)
    expect(listPushSubscriptions(t.db, t.wife.id)[0]).toMatchObject({ endpoint: sub(1).endpoint, p256dh: 'new', auth: 'new' })
  })

  it('rejects bad subscriptions', () => {
    const t = createTestContext()
    expect(() => upsertPushSubscription(t.db, t.wife.id, { endpoint: 'http://insecure', keys: { p256dh: 'p', auth: 'a' } }, null, t.clock.now())).toThrow()
    expect(() => upsertPushSubscription(t.db, t.wife.id, { endpoint: 'https://ok.test/x', keys: { p256dh: '', auth: 'a' } }, null, t.clock.now())).toThrow()
  })

  it('health: a success in the last 7 days, or a fresh untried subscription', () => {
    const t = createTestContext()
    expect(isPushHealthy(t.db, t.wife.id, t.clock.now())).toBe(false)
    upsertPushSubscription(t.db, t.wife.id, sub(1), null, t.clock.now())
    expect(isPushHealthy(t.db, t.wife.id, t.clock.now())).toBe(true)
    t.db.prepare('UPDATE push_subscriptions SET last_success_at = ?').run(new Date(t.clock.now().getTime() - 8 * DAY).toISOString())
    expect(isPushHealthy(t.db, t.wife.id, t.clock.now())).toBe(false)
    t.db.prepare('UPDATE push_subscriptions SET last_success_at = ?').run(new Date(t.clock.now().getTime() - 6 * DAY).toISOString())
    expect(isPushHealthy(t.db, t.wife.id, t.clock.now())).toBe(true)
    t.clock.advance(8 * DAY)
    expect(isPushHealthy(t.db, t.wife.id, t.clock.now())).toBe(false)
  })
})
