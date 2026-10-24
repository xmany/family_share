import { describe, expect, it, vi } from 'vitest'
import type { Member, ScheduledNotification, WechatMode } from '../../shared/types'
import { testConfig } from '../config'
import { DomainError } from '../domain/types'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { DAY } from '../time'
import { createWechatClient } from '../wechat/client'
import { bindWechatOpenid, readWechatBinding } from '../wechat/store'
import { createNotifier } from './notifier'
import type { DeliveryResult, NotificationChannel } from './types'
import { createWechatChannel } from './wechat'
import { upsertPushSubscription } from './webpush'

const WECHAT = { appId: 'wxapp', appSecret: 'wxsecret', token: 'tok', templateId: 'tpl_1', followQrUrl: null }
const VAPID = { publicKey: 'BPub', privateKey: 'priv', subject: 'mailto:ops@family.test' }

function fakeChannel(name: string, results: () => DeliveryResult[]): NotificationChannel & { calls: Array<{ member: Member; n: ScheduledNotification }> } {
  const calls: Array<{ member: Member; n: ScheduledNotification }> = []
  return {
    name,
    calls,
    isConfigured: () => true,
    async deliver(member, n) {
      calls.push({ member, n })
      return results()
    },
  }
}

function setup(opts: { push?: () => DeliveryResult[]; wechat?: () => DeliveryResult[] } = {}) {
  const t = createTestContext()
  const config = testConfig({ webPush: VAPID, wechat: WECHAT, familyTimezone: 'Australia/Sydney' })
  const push = fakeChannel('webpush', opts.push ?? (() => [{ channel: 'webpush', ok: true }]))
  const wechat = fakeChannel('wechat', opts.wechat ?? (() => [{ channel: 'wechat', ok: true }]))
  const notifier = createNotifier({
    config,
    db: t.db,
    clock: t.clock,
    domain: t.domain,
    outbox: t.outbox,
    appSecret: 'secret',
    channels: [push, wechat],
    log: { warn: vi.fn(), error: vi.fn() },
  })
  const row = t.outbox.enqueue({ memberId: t.wife.id, kind: 'explicit', title: '提醒：交水费', body: '今天 15:00', dedupeKey: 'x:1' })!
  return { t, notifier, push, wechat, row }
}

function bind(t: TestContext, mode: WechatMode) {
  bindWechatOpenid(t.db, t.wife.id, 'oWife', t.clock.now())
  t.db.prepare(`UPDATE member_channels SET config = json_set(config, '$.mode', ?) WHERE member_id = ?`).run(mode, t.wife.id)
}
function healthyPush(t: TestContext, daysAgo = 1) {
  upsertPushSubscription(t.db, t.wife.id, { endpoint: 'https://push.test/1', keys: { p256dh: 'p', auth: 'a' } }, null, t.clock.now())
  t.db.prepare('UPDATE push_subscriptions SET last_success_at = ?').run(new Date(t.clock.now().getTime() - daysAgo * DAY).toISOString())
}

describe('routing', () => {
  it('fallback: push only while push is healthy and succeeds', async () => {
    const { t, notifier, push, wechat, row } = setup()
    bind(t, 'fallback')
    healthyPush(t)
    const res = await notifier.deliver(row)
    expect(res).toEqual([{ channel: 'webpush', ok: true }])
    expect(push.calls).toHaveLength(1)
    expect(wechat.calls).toHaveLength(0)
  })

  it('fallback: WeChat when every push attempt for this notification failed', async () => {
    const { t, notifier, wechat, row } = setup({
      push: () => [
        { channel: 'webpush', ok: false, permanent: true, error: '410' },
        { channel: 'webpush', ok: false, permanent: false, error: '503' },
      ],
    })
    bind(t, 'fallback')
    healthyPush(t)
    const res = await notifier.deliver(row)
    expect(res.map(r => [r.channel, r.ok])).toEqual([
      ['webpush', false],
      ['webpush', false],
      ['wechat', true],
    ])
    expect(wechat.calls[0]!.member.id).toBe(t.wife.id)
  })

  it('fallback: WeChat when the member has no push subscription', async () => {
    const { t, notifier, push, wechat, row } = setup({ push: () => [] })
    bind(t, 'fallback')
    await notifier.deliver(row)
    expect(push.calls).toHaveLength(1)
    expect(wechat.calls).toHaveLength(1)
  })

  it('fallback: WeChat too when push has not succeeded in 7 days, even if this push went through', async () => {
    const { t, notifier, wechat, row } = setup()
    bind(t, 'fallback')
    healthyPush(t, 8)
    const res = await notifier.deliver(row)
    expect(res.map(r => r.channel)).toEqual(['webpush', 'wechat'])
    expect(wechat.calls).toHaveLength(1)
  })

  it('both: push and WeChat', async () => {
    const { t, notifier, push, wechat, row } = setup()
    bind(t, 'both')
    healthyPush(t)
    await notifier.deliver(row)
    expect(push.calls).toHaveLength(1)
    expect(wechat.calls).toHaveLength(1)
  })

  it('only: WeChat, push skipped', async () => {
    const { t, notifier, push, wechat, row } = setup()
    bind(t, 'only')
    healthyPush(t)
    const res = await notifier.deliver(row)
    expect(res).toEqual([{ channel: 'wechat', ok: true }])
    expect(push.calls).toHaveLength(0)
    expect(wechat.calls).toHaveLength(1)
  })

  it('only, but not bound: still uses push', async () => {
    const { t, notifier, push, wechat, row } = setup()
    t.db
      .prepare(`INSERT INTO member_channels (member_id, channel, enabled, config, updated_at) VALUES (?, 'wechat', 1, '{"mode":"only"}', ?)`)
      .run(t.wife.id, t.clock.now().toISOString())
    await notifier.deliver(row)
    expect(push.calls).toHaveLength(1)
    expect(wechat.calls).toHaveLength(0)
  })

  it('off: never WeChat, even when push fails', async () => {
    const { t, notifier, wechat, row } = setup({ push: () => [{ channel: 'webpush', ok: false, permanent: false }] })
    bind(t, 'off')
    await notifier.deliver(row)
    expect(wechat.calls).toHaveLength(0)
  })

  it('unbound member without push: no results (the scheduler skips with no_channels)', async () => {
    const { notifier, row } = setup({ push: () => [] })
    expect(await notifier.deliver(row)).toEqual([])
  })

  it('records one delivery row per result', async () => {
    const { t, notifier, row } = setup({ push: () => [{ channel: 'webpush', ok: false, error: '503' }] })
    bind(t, 'fallback')
    await notifier.deliver(row)
    const rows = t.db.prepare('SELECT channel, ok, error FROM deliveries WHERE notification_id = ? ORDER BY id').all(row.id)
    expect(rows).toEqual([
      { channel: 'webpush', ok: 0, error: '503' },
      { channel: 'wechat', ok: 1, error: null },
    ])
  })

  it('a throwing channel becomes a transient failure', async () => {
    const { t, notifier, row } = setup({
      push: () => {
        throw new Error('kaput')
      },
    })
    bind(t, 'fallback')
    const res = await notifier.deliver(row)
    expect(res[0]).toMatchObject({ channel: 'webpush', ok: false, permanent: false })
    expect(res[1]).toMatchObject({ channel: 'wechat', ok: true })
  })

  it('a disabled push channel counts as no push', async () => {
    const { t, notifier, push, wechat, row } = setup()
    bind(t, 'fallback')
    healthyPush(t)
    notifier.setMemberChannels(t.wife.id, [{ channel: 'webpush', enabled: false, config: {} }])
    await notifier.deliver(row)
    expect(push.calls).toHaveLength(0)
    expect(wechat.calls).toHaveLength(1)
  })
})

describe('member channel settings', () => {
  it('lists configured channels and never exposes the openid', () => {
    const { t, notifier } = setup()
    expect(notifier.channels()).toEqual(['webpush', 'wechat'])
    expect(notifier.getMemberChannels(t.wife.id)).toEqual([
      { channel: 'webpush', enabled: true, config: { devices: '0' } },
      { channel: 'wechat', enabled: true, config: { mode: 'fallback', bound: 'no' } },
    ])
    bindWechatOpenid(t.db, t.wife.id, 'oSECRET', t.clock.now())
    const s = notifier.getMemberChannels(t.wife.id)
    expect(s[1]).toEqual({ channel: 'wechat', enabled: true, config: { mode: 'fallback', bound: 'yes' } })
    expect(JSON.stringify(s)).not.toContain('oSECRET')
  })

  it('setMemberChannels changes only mode / enabled for WeChat', () => {
    const { t, notifier } = setup()
    bindWechatOpenid(t.db, t.wife.id, 'oWife', t.clock.now())
    const out = notifier.setMemberChannels(t.wife.id, [{ channel: 'wechat', enabled: true, config: { mode: 'both', openid: 'oEvil', bound: 'yes' } }])
    expect(out.find(c => c.channel === 'wechat')).toEqual({ channel: 'wechat', enabled: true, config: { mode: 'both', bound: 'yes' } })
    expect(readWechatBinding(t.db, t.wife.id)).toEqual({ openid: 'oWife', mode: 'both', enabled: true })
    expect(() => notifier.setMemberChannels(t.wife.id, [{ channel: 'wechat', enabled: true, config: { mode: 'loud' } }])).toThrow(DomainError)
    // unbinding is allowed from settings
    notifier.setMemberChannels(t.wife.id, [{ channel: 'wechat', enabled: true, config: { bound: 'no' } }])
    expect(readWechatBinding(t.db, t.wife.id)).toEqual({ openid: null, mode: 'both', enabled: true })
  })

  it('ignores unknown channels, rejects unknown members', () => {
    const { t, notifier } = setup()
    expect(notifier.setMemberChannels(t.wife.id, [{ channel: 'wxpusher', enabled: true, config: { uid: 'x' } }])).toHaveLength(2)
    expect(() => notifier.getMemberChannels('m_nobody')).toThrow(DomainError)
  })

  it('without WeChat configured the channel is not listed', () => {
    const t = createTestContext()
    const notifier = createNotifier({
      config: testConfig({ webPush: VAPID }),
      db: t.db,
      clock: t.clock,
      domain: t.domain,
      outbox: t.outbox,
      appSecret: 's',
    })
    expect(notifier.channels()).toEqual(['webpush'])
    expect(notifier.vapidPublicKey()).toBe('BPub')
    expect(notifier.getMemberChannels(t.wife.id).map(c => c.channel)).toEqual(['webpush'])
  })

  it('push subscriptions: save (upsert, re-assign), count, remove, validation', () => {
    const { t, notifier } = setup()
    const s = { endpoint: 'https://push.test/abc', keys: { p256dh: 'p', auth: 'a' } }
    notifier.savePushSubscription(t.husband.id, s, 'UA')
    notifier.savePushSubscription(t.wife.id, s, 'UA')
    expect(notifier.pushSubscriptionCount(t.husband.id)).toBe(0)
    expect(notifier.pushSubscriptionCount(t.wife.id)).toBe(1)
    expect(() => notifier.savePushSubscription(t.wife.id, { endpoint: 'nope', keys: { p256dh: 'p', auth: 'a' } })).toThrow(DomainError)
    notifier.removePushSubscription(s.endpoint)
    expect(notifier.pushSubscriptionCount(t.wife.id)).toBe(0)
  })
})

describe('wechat channel adapter', () => {
  it('sends a template to the bound openid and unbinds on 43004', async () => {
    const t = createTestContext()
    const config = testConfig({ wechat: WECHAT })
    const bodies: Record<string, unknown>[] = []
    let errcode = 0
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/cgi-bin/token')) return Response.json({ access_token: 'TOKEN', expires_in: 7200 })
      bodies.push(JSON.parse(String(init!.body)))
      return Response.json({ errcode, errmsg: errcode ? 'require subscribe' : 'ok', msgid: 1 })
    }) as unknown as typeof fetch
    const client = createWechatClient({ config: config.wechat!, clock: t.clock, fetch: fetchFn })
    const channel = createWechatChannel({ config, db: t.db, clock: t.clock, domain: t.domain, appSecret: 'secret', client, log: { warn: vi.fn(), error: vi.fn() } })
    const item = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去', dueAt: '2026-10-24T08:30+11:00' })
    const n = t.outbox.listForItem(item.id).find(x => x.kind === 'request_new')!

    expect(await channel.deliver(t.wife, n)).toEqual([]) // not bound
    bindWechatOpenid(t.db, t.wife.id, 'oWife', t.clock.now())
    expect(await channel.deliver(t.wife, n)).toEqual([{ channel: 'wechat', ok: true }])
    expect(bodies[0]).toMatchObject({
      touser: 'oWife',
      template_id: 'tpl_1',
      client_msg_id: n.id,
      data: {
        task: { value: '老公请你：带孩子出去' },
        from: { value: '老公' },
        when: { value: '周六 10/24 08:30' },
        note: { value: '周六 10/24 08:30' },
      },
    })
    expect(String(bodies[0]!.url)).toMatch(/^https:\/\/family\.test\/t\/[\w-]+\.[\w-]+$/)

    errcode = 43004
    const res = await channel.deliver(t.wife, n)
    expect(res).toEqual([{ channel: 'wechat', ok: false, permanent: true, error: '43004 require subscribe' }])
    expect(readWechatBinding(t.db, t.wife.id).openid).toBeNull()
  })
})
