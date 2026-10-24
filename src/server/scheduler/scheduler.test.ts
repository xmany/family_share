import { describe, expect, it } from 'vitest'
import type { ChannelSetting } from '../../shared/api'
import type { ScheduledNotification } from '../../shared/types'
import type { DeliveryResult, Notifier } from '../notify/types'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { HOUR, MINUTE, zonedToUtc } from '../time'
import { LATE_PREFIX } from './relevance'
import { createScheduler, LAST_TICK_KEY } from './scheduler'

const TZ = 'Australia/Sydney'
const at = (date: string, time: string) => zonedToUtc(date, time, TZ)
const iso = (date: string, time: string) => at(date, time).toISOString()

type Responder = (n: ScheduledNotification, call: number) => DeliveryResult[] | Promise<DeliveryResult[]>

interface FakeNotifier extends Notifier {
  calls: ScheduledNotification[]
  respond: Responder
}

const OK: DeliveryResult[] = [{ channel: 'fake', ok: true }]

function fakeNotifier(respond: Responder = () => OK): FakeNotifier {
  const f: FakeNotifier = {
    calls: [],
    respond,
    channels: () => ['fake'],
    async deliver(n) {
      f.calls.push(n)
      return f.respond(n, f.calls.length)
    },
    vapidPublicKey: () => null,
    savePushSubscription() {},
    removePushSubscription() {},
    pushSubscriptionCount: () => 0,
    getMemberChannels: (): ChannelSetting[] => [],
    setMemberChannels: (): ChannelSetting[] => [],
  }
  return f
}

function setup(opts: { now?: string; respond?: Responder } = {}) {
  const t = createTestContext(opts.now ? { now: opts.now } : {})
  const notifier = fakeNotifier(opts.respond)
  const scheduler = createScheduler({
    config: t.config,
    db: t.db,
    clock: t.clock,
    bus: t.bus,
    outbox: t.outbox,
    domain: t.domain,
    notifier,
  })
  return { t, notifier, scheduler }
}

/** A reminder row (no item) for a member, firing at `fireAt`. */
function enqueueRow(t: TestContext, fireAt: Date, opts: { quiet?: boolean; key?: string; kind?: ScheduledNotification['kind'] } = {}) {
  return t.outbox.enqueue({
    memberId: t.wife.id,
    kind: opts.kind ?? 'explicit',
    fireAt,
    title: '提醒：交水费',
    body: '今天 23:00',
    dedupeKey: opts.key ?? `test:${fireAt.toISOString()}:${opts.kind ?? 'explicit'}`,
    respectQuietHours: opts.quiet ?? true,
  })!
}

const status = (t: TestContext, id: string) => t.outbox.get(id)!

describe('quiet hours', () => {
  it('defers a row that respects quiet hours to quiet end, then delivers it', async () => {
    const { t, notifier, scheduler } = setup({ now: iso('2026-10-21', '23:00') })
    const row = enqueueRow(t, at('2026-10-21', '23:00'))
    const r1 = await scheduler.tick()
    expect(r1).toMatchObject({ deferred: 1, delivered: 0 })
    expect(notifier.calls).toHaveLength(0)
    expect(status(t, row.id)).toMatchObject({ status: 'scheduled', fireAt: iso('2026-10-22', '07:30') })

    t.clock.set(at('2026-10-22', '07:00'))
    await scheduler.tick()
    expect(notifier.calls).toHaveLength(0)

    t.clock.set(at('2026-10-22', '07:30'))
    const r2 = await scheduler.tick()
    expect(r2.delivered).toBe(1)
    expect(notifier.calls[0]!.title).toBe('提醒：交水费') // deferred, not late
    expect(status(t, row.id).status).toBe('sent')
  })

  it('delivers rows that ignore quiet hours during quiet hours', async () => {
    const { t, notifier, scheduler } = setup({ now: iso('2026-10-21', '23:00') })
    const row = enqueueRow(t, at('2026-10-21', '23:00'), { quiet: false })
    await scheduler.tick()
    expect(notifier.calls.map(c => c.id)).toEqual([row.id])
    expect(status(t, row.id).status).toBe('sent')
  })

  it('uses the recipient’s own quiet hours', async () => {
    const { t, notifier, scheduler } = setup({ now: iso('2026-10-21', '21:30') })
    t.domain.updateMember(t.wife.id, { quietStart: '21:00', quietEnd: '06:00' })
    const row = enqueueRow(t, at('2026-10-21', '21:30'))
    await scheduler.tick()
    expect(notifier.calls).toHaveLength(0)
    expect(status(t, row.id).fireAt).toBe(iso('2026-10-22', '06:00'))
  })
})

describe('relevance check at delivery', () => {
  function sendRequest(t: TestContext) {
    return t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去', dueAt: iso('2026-10-24', '08:30') })
  }
  const rowOf = (t: TestContext, itemId: string, prefix: string) => t.outbox.listForItem(itemId).find(n => n.dedupeKey.startsWith(prefix))!

  it('skips request_new once the request is no longer pending', async () => {
    const { t, notifier, scheduler } = setup()
    const item = sendRequest(t)
    t.domain.respondToRequest(t.as(t.wife), item.id, 'accept')
    const neu = rowOf(t, item.id, 'request_new:')
    // the domain cancels it; simulate a row that slipped through (e.g. written before the answer)
    t.outbox.reschedule(neu.id)
    await scheduler.tick()
    expect(status(t, neu.id)).toMatchObject({ status: 'skipped', lastError: 'not_pending' })
    expect(notifier.calls.some(c => c.id === neu.id)).toBe(false)
  })

  it('delivers request_answered although the request is no longer pending', async () => {
    const { t, notifier, scheduler } = setup()
    const item = sendRequest(t)
    await scheduler.tick() // request_new to the wife
    t.domain.respondToRequest(t.as(t.wife), item.id, 'accept', '没问题')
    await scheduler.tick()
    const answered = rowOf(t, item.id, 'request_answered:')
    expect(answered.memberId).toBe(t.husband.id)
    expect(status(t, answered.id).status).toBe('sent')
    expect(notifier.calls.map(c => c.kind)).toEqual(['request_new', 'request_answered'])
  })

  it('delivers request_answered (done) for a closed request', async () => {
    const { t, notifier, scheduler } = setup()
    const item = sendRequest(t)
    t.domain.respondToRequest(t.as(t.wife), item.id, 'accept')
    t.domain.completeItem(t.as(t.wife), item.id)
    await scheduler.tick()
    const done = rowOf(t, item.id, `request_answered:${item.id}:done`)
    expect(status(t, done.id).status).toBe('sent')
    expect(notifier.calls.map(c => c.dedupeKey)).toContain(done.dedupeKey)
  })

  it('skips a due row whose dedupe key no longer matches the item timing', async () => {
    const { t, notifier, scheduler } = setup()
    const item = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '交水费', dueAt: iso('2026-10-21', '16:00') })
    const due = rowOf(t, item.id, 'due:')
    expect(due.fireAt).toBe(iso('2026-10-21', '15:00'))
    t.domain.updateItem(t.as(t.wife), item.id, { dueAt: iso('2026-10-22', '16:00') })
    t.outbox.reschedule(due.id) // stale row the domain did not cancel
    t.clock.set(at('2026-10-21', '15:00'))
    await scheduler.tick()
    expect(status(t, due.id)).toMatchObject({ status: 'skipped', lastError: 'timing_changed' })
    expect(notifier.calls).toHaveLength(0)
  })

  it('skips item-bound rows of a closed item', async () => {
    const { t, notifier, scheduler } = setup()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯', ownerId: t.wife.id })
    const assigned = rowOf(t, item.id, 'assigned:')
    t.domain.completeItem(t.as(t.wife), item.id)
    t.outbox.reschedule(assigned.id)
    await scheduler.tick()
    expect(status(t, assigned.id)).toMatchObject({ status: 'skipped', lastError: 'item_closed' })
    expect(notifier.calls).toHaveLength(0)
  })

  it('delivers rows that are still relevant', async () => {
    const { t, notifier, scheduler } = setup()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯', ownerId: t.wife.id })
    await scheduler.tick()
    expect(notifier.calls.map(c => [c.kind, c.memberId, c.itemId])).toEqual([['assigned', t.wife.id, item.id]])
  })
})

describe('retries', () => {
  it('backs off 1, 5, 15, 60 minutes and fails after 5 attempts', async () => {
    const { t, notifier, scheduler } = setup({ respond: () => [{ channel: 'fake', ok: false, error: '503', permanent: false }] })
    const start = t.clock.now().getTime()
    const row = enqueueRow(t, t.clock.now(), { quiet: false })
    const fireTimes: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = await scheduler.tick()
      expect(r.failed).toBe(1)
      const cur = status(t, row.id)
      expect(cur.attempts).toBe(i + 1)
      if (i < 4) {
        expect(cur.status).toBe('scheduled')
        fireTimes.push((new Date(cur.fireAt).getTime() - t.clock.now().getTime()) / MINUTE)
        t.clock.set(cur.fireAt)
      } else {
        expect(cur.status).toBe('failed')
        expect(cur.lastError).toContain('fake: 503')
      }
    }
    expect(fireTimes).toEqual([1, 5, 15, 60])
    expect(notifier.calls).toHaveLength(5)
    // a retry is not "late": no prefix on the retried title
    expect(notifier.calls.every(c => !c.title.startsWith(LATE_PREFIX))).toBe(true)
    expect(t.clock.now().getTime() - start).toBe(81 * MINUTE)
  })

  it('marks a permanent failure failed at once', async () => {
    const { t, scheduler } = setup({ respond: () => [{ channel: 'fake', ok: false, error: '410', permanent: true }] })
    const row = enqueueRow(t, t.clock.now(), { quiet: false })
    await scheduler.tick()
    expect(status(t, row.id)).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('retries when only some channels failed transiently and none succeeded', async () => {
    const { t, scheduler } = setup({
      respond: () => [
        { channel: 'webpush', ok: false, error: '410', permanent: true },
        { channel: 'wechat', ok: false, error: '-1', permanent: false },
      ],
    })
    const row = enqueueRow(t, t.clock.now(), { quiet: false })
    await scheduler.tick()
    expect(status(t, row.id)).toMatchObject({ status: 'scheduled', attempts: 1 })
  })

  it('counts as sent when any channel succeeded', async () => {
    const { t, scheduler } = setup({
      respond: () => [
        { channel: 'webpush', ok: false, error: '500', permanent: false },
        { channel: 'wechat', ok: true },
      ],
    })
    const row = enqueueRow(t, t.clock.now(), { quiet: false })
    const r = await scheduler.tick()
    expect(r.delivered).toBe(1)
    expect(status(t, row.id).status).toBe('sent')
  })

  it('treats a throwing notifier as a transient failure', async () => {
    const { t, scheduler } = setup({
      respond: () => {
        throw new Error('boom')
      },
    })
    const row = enqueueRow(t, t.clock.now(), { quiet: false })
    await scheduler.tick()
    expect(status(t, row.id)).toMatchObject({ status: 'scheduled', attempts: 1 })
    expect(status(t, row.id).lastError).toContain('boom')
  })

  it('skips with no_channels when the member is unreachable', async () => {
    const { t, scheduler } = setup({ respond: () => [] })
    const row = enqueueRow(t, t.clock.now(), { quiet: false })
    await scheduler.tick()
    expect(status(t, row.id)).toMatchObject({ status: 'skipped', lastError: 'no_channels' })
  })
})

describe('catch-up after downtime', () => {
  it('prefixes rows more than 15 minutes late with （迟到）', async () => {
    const { t, notifier, scheduler } = setup()
    enqueueRow(t, new Date(t.clock.now().getTime() - 10 * MINUTE), { key: 'a', quiet: false })
    enqueueRow(t, new Date(t.clock.now().getTime() - 20 * MINUTE), { key: 'b', quiet: false })
    await scheduler.tick()
    const byKey = Object.fromEntries(notifier.calls.map(c => [c.dedupeKey, c.title]))
    expect(byKey.a).toBe('提醒：交水费')
    expect(byKey.b).toBe('（迟到）提醒：交水费')
    // the stored title stays clean
    expect(t.outbox.get(notifier.calls.find(c => c.dedupeKey === 'b')!.id)!.title).toBe('提醒：交水费')
  })

  it('skips due / digest / weekly / stale / request_followup rows more than 12 h late, delivers others late', async () => {
    const { t, notifier, scheduler } = setup()
    const old = new Date(t.clock.now().getTime() - 13 * HOUR)
    const due = enqueueRow(t, old, { key: 'k-due', kind: 'due', quiet: false })
    const digest = enqueueRow(t, old, { key: 'k-digest', kind: 'digest', quiet: false })
    const explicit = enqueueRow(t, old, { key: 'k-explicit', kind: 'explicit', quiet: false })
    await scheduler.tick()
    expect(status(t, due.id)).toMatchObject({ status: 'skipped', lastError: 'too_late' })
    expect(status(t, digest.id)).toMatchObject({ status: 'skipped', lastError: 'too_late' })
    expect(status(t, explicit.id).status).toBe('sent')
    expect(notifier.calls.map(c => c.title)).toEqual(['（迟到）提醒：交水费'])
  })

  it('delivers a request_new created before a long outage, marked late', async () => {
    const { t, notifier, scheduler } = setup()
    const item = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    t.clock.advance(3 * HOUR) // server was down
    await scheduler.tick()
    const neu = notifier.calls.find(c => c.kind === 'request_new')!
    expect(neu.itemId).toBe(item.id)
    expect(neu.title).toBe('（迟到）老公请你：带孩子出去')
  })
})

describe('daily digest', () => {
  function seed(t: TestContext) {
    // the wife asks the husband (pending, waiting for his answer; she waits on him)
    t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '修水龙头' })
    // a task of his due tomorrow (Thu) and one overdue by tomorrow morning
    t.domain.createItem(t.as(t.husband), { kind: 'task', title: '交水费', dueDate: '2026-10-22' })
    t.domain.createItem(t.as(t.husband), { kind: 'task', title: '取快递', dueAt: iso('2026-10-21', '18:00') })
  }
  const digests = (t: TestContext) =>
    (t.db.prepare(`SELECT id FROM notifications WHERE kind = 'digest' ORDER BY dedupe_key`).all() as { id: string }[]).map(
      r => t.outbox.get(r.id)!,
    )

  it('is generated at the member’s digest time, once, with counts, names and top titles', async () => {
    const { t, notifier, scheduler } = setup()
    seed(t)
    await scheduler.tick() // Wed 12:00, first tick: nothing to catch up
    expect(digests(t)).toHaveLength(0)

    t.clock.set(at('2026-10-22', '07:29'))
    await scheduler.tick()
    expect(digests(t)).toHaveLength(0)

    t.clock.set(at('2026-10-22', '07:30'))
    notifier.calls.length = 0
    const r = await scheduler.tick()
    expect(r.generated).toBe(2)
    const rows = digests(t)
    const his = rows.find(n => n.memberId === t.husband.id)!
    expect(his).toMatchObject({
      dedupeKey: `digest:${t.husband.id}:2026-10-22`,
      fireAt: iso('2026-10-22', '07:30'),
      title: '今日摘要 · 10/22 周四',
      url: '/board',
      status: 'sent',
    })
    expect(his.body).toBe('今天要做 1 件，已过期 1 件，老婆在等你回复 1 件。修水龙头、取快递、交水费')
    const hers = rows.find(n => n.memberId === t.wife.id)!
    expect(hers.body).toBe('你在等老公 1 件。修水龙头')
    expect(notifier.calls.filter(c => c.kind === 'digest')).toHaveLength(2)

    // idempotent across ticks …
    for (let i = 0; i < 3; i++) {
      t.clock.advance(30_000)
      expect((await scheduler.tick()).generated).toBe(0)
    }
    // … and restarts
    const again = createScheduler({ config: t.config, db: t.db, clock: t.clock, bus: t.bus, outbox: t.outbox, domain: t.domain, notifier })
    expect((await again.tick()).generated).toBe(0)
    expect(digests(t)).toHaveLength(2)
  })

  it('skips a member with nothing to say and members without a digest time', async () => {
    const { t, scheduler } = setup()
    t.domain.updateMember(t.husband.id, { digestTime: null })
    t.domain.createItem(t.as(t.husband), { kind: 'task', title: '交水费', dueDate: '2026-10-22' })
    await scheduler.tick()
    t.clock.set(at('2026-10-22', '07:30'))
    const r = await scheduler.tick()
    expect(r.generated).toBe(0)
    expect(digests(t)).toHaveLength(0)
  })

  it('catches up on the first tick after downtime the same day, marked late', async () => {
    const { t, notifier, scheduler } = setup()
    seed(t)
    t.clock.set(at('2026-10-22', '06:00'))
    await scheduler.tick()
    t.clock.set(at('2026-10-22', '09:00')) // down from 06:00 to 09:00
    notifier.calls.length = 0
    const r = await scheduler.tick()
    expect(r.generated).toBe(2)
    const his = notifier.calls.find(c => c.memberId === t.husband.id && c.kind === 'digest')!
    expect(his.fireAt).toBe(iso('2026-10-22', '07:30'))
    expect(his.title).toBe('（迟到）今日摘要 · 10/22 周四')
  })

  it('does not catch up a missed digest on a later day', async () => {
    const { t, scheduler } = setup()
    seed(t)
    await scheduler.tick() // Wed 12:00
    t.clock.set(at('2026-10-23', '06:00')) // down over Thursday 07:30
    expect((await scheduler.tick()).generated).toBe(0)
    expect(digests(t)).toHaveLength(0)
  })

  it('does not send a late digest to a member whose digest time already passed when they joined', async () => {
    const { t, scheduler } = setup({ now: iso('2026-10-22', '10:00') })
    seed(t)
    await scheduler.tick()
    t.clock.advance(30_000)
    await scheduler.tick()
    expect(digests(t)).toHaveLength(0)
    expect(t.db.prepare('SELECT value FROM kv WHERE key = ?').get(LAST_TICK_KEY)).toBeTruthy()
  })
})

describe('stale nudge', () => {
  const stale = (t: TestContext) =>
    (t.db.prepare(`SELECT id FROM notifications WHERE kind = 'stale' ORDER BY fire_at`).all() as { id: string }[]).map(r => t.outbox.get(r.id)!)

  it('nudges the owner at 19:00 at most every 4 days', async () => {
    // created a week before "today"
    const { t, notifier, scheduler } = setup({ now: iso('2026-10-14', '12:00') })
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修柜门' })
    t.domain.createItem(t.as(t.husband), { kind: 'task', title: '有日期的', dueDate: '2026-11-30' })
    const idea = t.domain.createItem(t.as(t.wife), { kind: 'idea', title: '去日本玩' })
    t.clock.set(at('2026-10-21', '18:00'))
    await scheduler.tick()
    expect(stale(t)).toHaveLength(0)

    t.clock.set(at('2026-10-21', '19:00'))
    const r = await scheduler.tick()
    expect(r.generated).toBe(1)
    const [row] = stale(t)
    expect(row).toMatchObject({
      memberId: t.husband.id,
      itemId: item.id,
      dedupeKey: `stale:${item.id}:1`,
      fireAt: iso('2026-10-21', '19:00'),
      title: '好几天没动静了：修柜门',
      body: '已经 7 天没更新了。定个时间、拆成小步，还是不做了？',
      status: 'sent',
    })
    expect(row!.actions.map(a => a.action)).toEqual(['snooze_tomorrow', 'done', 'open'])
    expect(notifier.calls.filter(c => c.kind === 'stale')).toHaveLength(1)
    expect(stale(t).some(n => n.itemId === idea.id)).toBe(false)

    // repeated ticks: nothing new
    t.clock.advance(MINUTE)
    expect((await scheduler.tick()).generated).toBe(0)
    // next day the bucket changes (8 days → 2) but the 4-day gap holds
    t.clock.set(at('2026-10-22', '19:00'))
    expect((await scheduler.tick()).generated).toBe(0)
    // four days later: next nudge
    t.clock.set(at('2026-10-25', '19:00'))
    expect((await scheduler.tick()).generated).toBeGreaterThanOrEqual(1)
    expect(stale(t).map(n => n.dedupeKey)).toContain(`stale:${item.id}:2`)
  })

  it('leaves snoozed and recently touched tasks alone', async () => {
    const { t, scheduler } = setup({ now: iso('2026-10-14', '12:00') })
    const a = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修柜门' })
    const b = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '换灯泡' })
    t.clock.set(at('2026-10-20', '12:00'))
    t.domain.addNote(t.as(t.husband), a.id, '买了合页')
    t.domain.snoozeItem(t.as(t.husband), b.id, at('2026-10-28', '09:00'))
    t.clock.set(at('2026-10-21', '18:59'))
    await scheduler.tick()
    t.clock.set(at('2026-10-21', '19:00'))
    expect((await scheduler.tick()).generated).toBe(0)
  })

  it('does not deliver a stale nudge for an item touched after it was queued', async () => {
    const { t, notifier, scheduler } = setup({ now: iso('2026-10-14', '12:00') })
    t.domain.updateMember(t.husband.id, { quietStart: '18:30', quietEnd: '07:30' })
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修柜门' })
    t.clock.set(at('2026-10-21', '18:00'))
    await scheduler.tick()
    t.clock.set(at('2026-10-21', '19:00'))
    await scheduler.tick() // generated, deferred to 07:30 (quiet hours)
    const [row] = stale(t)
    expect(row!.fireAt).toBe(iso('2026-10-22', '07:30'))
    t.domain.addNote(t.as(t.husband), item.id, '周末弄')
    t.clock.set(at('2026-10-22', '07:30'))
    await scheduler.tick()
    expect(t.outbox.get(row!.id)).toMatchObject({ status: 'skipped', lastError: 'not_stale' })
    expect(notifier.calls.filter(c => c.kind === 'stale')).toHaveLength(0)
  })
})

describe('weekly sync', () => {
  const weekly = (t: TestContext) =>
    (t.db.prepare(`SELECT id FROM notifications WHERE kind = 'weekly'`).all() as { id: string }[]).map(r => t.outbox.get(r.id)!)

  it('goes to adults on Sunday 19:00, once', async () => {
    const { t, notifier, scheduler } = setup()
    const kid = t.domain.createMember({ name: '小宝', role: 'kid' })
    const done = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯' })
    t.domain.completeItem(t.as(t.husband), done.id)
    t.domain.createItem(t.as(t.wife), { kind: 'idea', title: '去日本玩' })
    t.domain.createItem(t.as(t.wife), { kind: 'task', title: '家长会', dueDate: '2026-10-28' })
    await scheduler.tick() // Wed

    t.clock.set(at('2026-10-25', '18:59'))
    await scheduler.tick()
    expect(weekly(t)).toHaveLength(0)

    t.clock.set(at('2026-10-25', '19:00'))
    notifier.calls.length = 0
    const r = await scheduler.tick()
    expect(r.generated).toBe(2)
    const rows = weekly(t)
    expect(rows.map(n => n.memberId).sort()).toEqual([t.husband.id, t.wife.id].sort())
    expect(rows.some(n => n.memberId === kid.id)).toBe(false)
    expect(rows[0]).toMatchObject({
      dedupeKey: expect.stringMatching(/^weekly:m_\w+:2026-10-25$/),
      url: '/weekly',
      title: '本周小结 · 10/25 周日',
      body: '本周完成 1 件（老公 1），1 个想法待定，下周有 1 件安排。家长会',
      fireAt: iso('2026-10-25', '19:00'),
    })
    expect(notifier.calls.filter(c => c.kind === 'weekly')).toHaveLength(2)

    t.clock.advance(MINUTE)
    expect((await scheduler.tick()).generated).toBe(0)
    t.clock.set(at('2026-10-26', '19:00'))
    expect((await scheduler.tick()).generated).toBe(0)
    expect(weekly(t)).toHaveLength(2)
  })

  it('is not generated on other days', async () => {
    const { t, scheduler } = setup()
    t.domain.createItem(t.as(t.wife), { kind: 'idea', title: '去日本玩' })
    await scheduler.tick()
    t.clock.set(at('2026-10-24', '19:00')) // Saturday
    await scheduler.tick()
    expect(weekly(t)).toHaveLength(0)
  })
})

describe('tick concurrency and wake-ups', () => {
  it('never runs two ticks at once and delivers each row once', async () => {
    let active = 0
    let maxActive = 0
    const { t, notifier, scheduler } = setup({
      respond: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(r => setTimeout(r, 5))
        active--
        return OK
      },
    })
    for (let i = 0; i < 3; i++) enqueueRow(t, t.clock.now(), { key: `c${i}`, quiet: false })
    const [a, b, c] = await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()])
    expect(maxActive).toBe(1)
    expect(notifier.calls).toHaveLength(3)
    expect(new Set(notifier.calls.map(n => n.id)).size).toBe(3)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(a!.delivered).toBe(3)
  })

  it('a tick requested during a tick runs once more afterwards', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    const { t, notifier, scheduler } = setup({
      respond: async n => {
        if (n.dedupeKey === 'first') await gate
        return OK
      },
    })
    enqueueRow(t, t.clock.now(), { key: 'first', quiet: false })
    const p = scheduler.tick()
    await new Promise(r => setTimeout(r, 5))
    enqueueRow(t, t.clock.now(), { key: 'second', quiet: false }) // arrives mid-tick
    void scheduler.tick()
    release()
    const report = await p
    expect(report.delivered).toBe(2)
    expect(notifier.calls.map(c => c.dedupeKey)).toEqual(['first', 'second'])
  })

  it('start() wakes on notifications_queued (deferred) and stop() detaches', async () => {
    const { t, notifier, scheduler } = setup()
    scheduler.start()
    await new Promise(r => setTimeout(r, 20)) // initial catch-up tick
    t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去', priority: 'high' })
    expect(notifier.calls).toHaveLength(0) // never synchronously inside the domain call
    await new Promise(r => setTimeout(r, 20))
    expect(notifier.calls.map(c => c.kind)).toEqual(['request_new'])
    scheduler.stop()
    t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '买菜', priority: 'high' })
    await new Promise(r => setTimeout(r, 20))
    expect(notifier.calls).toHaveLength(1)
  })

  it('reports nothing when the family is not initialised yet and does not throw', async () => {
    const { t, scheduler } = setup()
    t.db.prepare('DELETE FROM family').run()
    await expect(scheduler.tick()).resolves.toMatchObject({ generated: 0 })
  })
})

describe('DST', () => {
  it('digest time follows local time across the April DST change', async () => {
    const { t, scheduler } = setup({ now: '2027-04-03T01:00:00.000Z' }) // Sat 12:00 AEDT
    t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '修水龙头' })
    await scheduler.tick()
    t.clock.set(at('2027-04-04', '07:30')) // Sunday, now AEST (+10)
    expect(at('2027-04-04', '07:30').toISOString()).toBe('2027-04-03T21:30:00.000Z')
    const r = await scheduler.tick()
    expect(r.generated).toBeGreaterThanOrEqual(1)
    expect(t.outbox.exists(`digest:${t.husband.id}:2027-04-04`)).toBe(true)
  })
})
