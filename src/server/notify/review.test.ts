// Reviewer regression tests for the notifier (each failed before its fix).
import { describe, expect, it, vi } from 'vitest'
import type { Member, ScheduledNotification, WechatMode } from '../../shared/types'
import { testConfig } from '../config'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { DAY } from '../time'
import { bindWechatOpenid, readWechatBinding, unbindWechat } from '../wechat/store'
import { createNotifier } from './notifier'
import type { DeliveryResult, NotificationChannel } from './types'
import { upsertPushSubscription } from './webpush'

const WECHAT = { appId: 'wxapp', appSecret: 'wxsecret', token: 'tok', templateId: 'tpl_1', followQrUrl: null }
const VAPID = { publicKey: 'BPub', privateKey: 'priv', subject: 'mailto:ops@family.test' }

type Impl = (member: Member, n: ScheduledNotification) => DeliveryResult[] | Promise<DeliveryResult[]>

function channel(name: string, impl: Impl): NotificationChannel & { calls: number } {
  const c = {
    name,
    calls: 0,
    isConfigured: () => true,
    async deliver(member: Member, n: ScheduledNotification) {
      c.calls++
      return impl(member, n)
    },
  }
  return c
}

function setup(push: Impl, wechat: Impl) {
  const t = createTestContext()
  const config = testConfig({ webPush: VAPID, wechat: WECHAT })
  const p = channel('webpush', push)
  const w = channel('wechat', wechat)
  const make = () =>
    createNotifier({
      config,
      db: t.db,
      clock: t.clock,
      domain: t.domain,
      outbox: t.outbox,
      appSecret: 'secret',
      channels: [p, w],
      log: { warn: vi.fn(), error: vi.fn() },
    })
  const row = t.outbox.enqueue({ memberId: t.wife.id, kind: 'explicit', title: '提醒：交水费', body: '今天 15:00', dedupeKey: 'x:1' })!
  return { t, push: p, wechat: w, make, row }
}

function bind(t: TestContext, mode: WechatMode) {
  bindWechatOpenid(t.db, t.wife.id, 'oWife', t.clock.now())
  t.db.prepare(`UPDATE member_channels SET config = json_set(config, '$.mode', ?) WHERE member_id = ?`).run(mode, t.wife.id)
}
function healthyPush(t: TestContext) {
  upsertPushSubscription(t.db, t.wife.id, { endpoint: 'https://push.test/1', keys: { p256dh: 'p', auth: 'a' } }, null, t.clock.now())
  t.db.prepare('UPDATE push_subscriptions SET last_success_at = ?').run(new Date(t.clock.now().getTime() - DAY).toISOString())
}
const deliveries = (t: TestContext, id: string) =>
  t.db.prepare('SELECT channel, ok FROM deliveries WHERE notification_id = ? ORDER BY id').all(id) as { channel: string; ok: number }[]

describe('notifier review', () => {
  it('a retry never resends on a channel that already succeeded for that notification', async () => {
    let wechatCall = 0
    const s = setup(
      () => [{ channel: 'webpush', ok: true }],
      () => (++wechatCall === 1 ? [{ channel: 'wechat', ok: false, permanent: false, error: '45009 busy' }] : [{ channel: 'wechat', ok: true }]),
    )
    bind(s.t, 'both')
    healthyPush(s.t)
    const notifier = s.make()
    await notifier.deliver(s.row)
    expect([s.push.calls, s.wechat.calls]).toEqual([1, 1])
    const again = await notifier.deliver(s.row)
    expect(s.push.calls).toBe(1) // not pushed twice
    expect(s.wechat.calls).toBe(2) // the failed channel is retried
    expect(again.some(r => r.ok)).toBe(true)
    expect(deliveries(s.t, s.row.id)).toEqual([
      { channel: 'webpush', ok: 1 },
      { channel: 'wechat', ok: 0 },
      { channel: 'wechat', ok: 1 },
    ])
  })

  it('records each channel as soon as it is done, so a send cut short (restart) does not repeat it', async () => {
    let release!: () => void
    const hang = new Promise<void>(r => (release = r))
    const s = setup(
      () => [{ channel: 'webpush', ok: true }],
      async () => {
        await hang
        return [{ channel: 'wechat', ok: true }]
      },
    )
    bind(s.t, 'both')
    healthyPush(s.t)
    const first = s.make().deliver(s.row)
    await new Promise(r => setImmediate(r))
    expect(deliveries(s.t, s.row.id)).toEqual([{ channel: 'webpush', ok: 1 }]) // already on record while WeChat hangs
    // the process restarts; the scheduler retries the row
    const p0 = s.push.calls
    const w0 = s.wechat.calls
    void s.make().deliver(s.row)
    await new Promise(r => setImmediate(r))
    expect(s.push.calls).toBe(p0)
    expect(s.wechat.calls).toBe(w0 + 1)
    release()
    await first
  })

  it("'only': when WeChat says the openid is gone (43004) the notification still goes out by push", async () => {
    const s = setup(
      () => [{ channel: 'webpush', ok: true }],
      (member: Member) => {
        unbindWechat(s.t.db, member.id, s.t.clock.now()) // what the real channel does on 43004 / 40003
        return [{ channel: 'wechat', ok: false, permanent: true, error: '43004 require subscribe' }]
      },
    )
    bind(s.t, 'only')
    healthyPush(s.t)
    const res = await s.make().deliver(s.row)
    expect(readWechatBinding(s.t.db, s.t.wife.id).openid).toBeNull()
    expect(s.push.calls).toBe(1)
    expect(res.some(r => r.channel === 'webpush' && r.ok)).toBe(true)
  })

  it("'only': a transient WeChat failure does not fall back to push (retried on WeChat)", async () => {
    const s = setup(
      () => [{ channel: 'webpush', ok: true }],
      () => [{ channel: 'wechat', ok: false, permanent: false, error: '-1 busy' }],
    )
    bind(s.t, 'only')
    healthyPush(s.t)
    const res = await s.make().deliver(s.row)
    expect(s.push.calls).toBe(0)
    expect(res.every(r => !r.ok)).toBe(true)
  })
})
