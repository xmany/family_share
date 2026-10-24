// Regression tests for the consistency fixes after the final review: a dropped request tells the other side (AI-1),
// and a new due time (or re-opening) ends an earlier snooze, which the scheduler would otherwise let silence the new
// time (R10). Real domain + outbox + scheduler with a fake notifier, family timezone Pacific/Auckland, default quiet
// hours 22:00–07:30.
import { describe, expect, it } from 'vitest'
import type { ChannelSetting } from '../../shared/api'
import type { ScheduledNotification } from '../../shared/types'
import type { DeliveryResult, Notifier } from '../notify/types'
import { skipReason } from '../scheduler/relevance'
import { createScheduler } from '../scheduler/scheduler'
import { createTestContext } from '../testing'
import { MINUTE, localDate, localTime, zonedToUtc } from '../time'
import { textAtDelivery } from './policy'

const TZ = 'Pacific/Auckland'
const at = (date: string, time: string) => zonedToUtc(date, time, TZ)
const iso = (date: string, time: string) => at(date, time).toISOString()
const local = (d: Date) => `${localDate(d, TZ)} ${localTime(d, TZ)}`

interface Sent {
  at: string
  kind: ScheduledNotification['kind']
  memberId: string
  itemId: string | null
  title: string
  body: string
}

function sim(now: string) {
  const t = createTestContext({ now, timezone: TZ })
  const sent: Sent[] = []
  const notifier: Notifier = {
    channels: () => ['fake'],
    async deliver(n): Promise<DeliveryResult[]> {
      sent.push({ at: local(t.clock.now()), kind: n.kind, memberId: n.memberId, itemId: n.itemId, title: n.title, body: n.body })
      return [{ channel: 'fake', ok: true }]
    },
    vapidPublicKey: () => null,
    savePushSubscription() {},
    removePushSubscription() {},
    pushSubscriptionCount: () => 0,
    getMemberChannels: (): ChannelSetting[] => [],
    setMemberChannels: (): ChannelSetting[] => [],
  }
  const scheduler = createScheduler({ config: t.config, db: t.db, clock: t.clock, bus: t.bus, outbox: t.outbox, domain: t.domain, notifier })
  const rows = (itemId: string) => t.outbox.listForItem(itemId)
  return {
    t,
    sent,
    rows,
    /** the item's dropped notices (request_answered:<id>:dropped:<n>[:<memberId>]) */
    dropRows: (itemId: string) => rows(itemId).filter(n => n.dedupeKey.startsWith(`request_answered:${itemId}:dropped:`)),
    row: (itemId: string, key: string) => rows(itemId).find(n => n.dedupeKey === key),
    /** advances the clock to `target` one minute at a time, ticking at every step */
    async runUntil(target: Date) {
      while (t.clock.now().getTime() < target.getTime()) {
        t.clock.set(new Date(Math.min(target.getTime(), t.clock.now().getTime() + MINUTE)))
        await scheduler.tick()
      }
    },
  }
}

describe('dropping a request tells the other side', () => {
  it('the owner backs out of an accepted request: the requester is told (with the reason), the owner is not', async () => {
    const s = sim(iso('2026-11-02', '12:00'))
    const { t } = s
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去', dueAt: iso('2026-11-07', '08:00') })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    await s.runUntil(at('2026-11-02', '12:05'))
    t.domain.updateItem(t.as(t.wife), req.id, { status: 'dropped' }, '去不了了')
    expect(s.dropRows(req.id)).toEqual([
      expect.objectContaining({
        dedupeKey: `request_answered:${req.id}:dropped:1`,
        kind: 'request_answered',
        memberId: t.husband.id,
        status: 'scheduled',
        title: '老婆不做了：带孩子出去',
        body: '去不了了',
        actions: [{ action: 'open', title: '查看' }],
      }),
    ])
    // the scheduler delivers it although the item is closed, and keeps its text (nothing in it goes stale)
    const n = s.dropRows(req.id)[0]!
    expect(skipReason(n, t.domain.getItem(req.id), t.clock.now(), TZ)).toBeNull()
    expect(textAtDelivery(n, t.domain.getItem(req.id)!, { now: t.clock.now(), timezone: TZ, members: t.domain.listMembers() })).toBeNull()
    await s.runUntil(at('2026-11-02', '12:10'))
    expect(s.sent.filter(x => x.title.includes('不做了'))).toEqual([
      expect.objectContaining({ at: '2026-11-02 12:06', kind: 'request_answered', memberId: t.husband.id, title: '老婆不做了：带孩子出去', body: '去不了了' }),
    ])
  })

  it('the requester takes back an accepted request: the owner is told; without a reason the body says 不用做了', () => {
    const { t, dropRows } = sim(iso('2026-11-02', '12:00'))
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '买牛奶', dueDate: '2026-11-03' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    t.domain.updateItem(t.as(t.husband), req.id, { status: 'dropped' })
    expect(dropRows(req.id)).toEqual([
      expect.objectContaining({ dedupeKey: `request_answered:${req.id}:dropped:1`, memberId: t.wife.id, title: '老公取消了：买牛奶', body: '不用做了' }),
    ])
  })

  it('a pending request: the owner is told once the request reached them; withdrawn silently while it is still held back', async () => {
    // daytime: request_new went out at 12:01, so taking it back at 12:30 tells her
    const day = sim(iso('2026-11-02', '12:00'))
    const milk = day.t.domain.sendRequest(day.t.as(day.t.husband), { toMemberId: day.t.wife.id, title: '买牛奶', dueDate: '2026-11-04' })
    await day.runUntil(at('2026-11-02', '12:30'))
    day.t.domain.updateItem(day.t.as(day.t.husband), milk.id, { status: 'dropped' }, '我自己买吧')
    expect(day.dropRows(milk.id)).toEqual([expect.objectContaining({ memberId: day.t.wife.id, title: '老公取消了：买牛奶', body: '我自己买吧' })])

    // 23:15: request_new waits for her quiet hours to end; taken back at 23:20 she never hears about it at all
    const night = sim(iso('2026-11-02', '23:10'))
    const veg = night.t.domain.sendRequest(night.t.as(night.t.husband), { toMemberId: night.t.wife.id, title: '买菜', dueDate: '2026-11-04' })
    await night.runUntil(at('2026-11-02', '23:20'))
    expect(night.row(veg.id, `request_new:${veg.id}:1`)).toMatchObject({ status: 'scheduled', fireAt: iso('2026-11-03', '07:30') })
    night.t.domain.updateItem(night.t.as(night.t.husband), veg.id, { status: 'dropped' })
    expect(night.dropRows(veg.id)).toEqual([])
    await night.runUntil(at('2026-11-03', '09:00'))
    expect(night.sent.filter(x => x.itemId === veg.id)).toEqual([])
  })

  it('nothing after a decline, for an already closed request, or to the actor', () => {
    const { t, dropRows } = sim(iso('2026-11-02', '12:00'))
    const fix = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '修车' })
    t.domain.respondToRequest(t.as(t.wife), fix.id, 'decline')
    t.domain.updateItem(t.as(t.husband), fix.id, { status: 'dropped' })
    expect(dropRows(fix.id)).toEqual([])

    const done = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '取快递' })
    t.domain.respondToRequest(t.as(t.wife), done.id, 'accept')
    t.domain.completeItem(t.as(t.wife), done.id)
    t.domain.updateItem(t.as(t.husband), done.id, { status: 'dropped' })
    expect(dropRows(done.id)).toEqual([])
  })

  it('a third member dropping it tells both sides, each on its own row', () => {
    const { t, dropRows } = sim(iso('2026-11-02', '12:00'))
    const grandma = t.domain.createMember({ name: '外婆', role: 'relative' })
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    t.domain.updateItem(t.as(grandma), req.id, { status: 'dropped' }, '我来带')
    expect(dropRows(req.id).map(n => [n.dedupeKey, n.memberId, n.title, n.body])).toEqual(
      expect.arrayContaining([
        [`request_answered:${req.id}:dropped:1`, t.husband.id, '外婆取消了：带孩子出去', '我来带'],
        [`request_answered:${req.id}:dropped:1:${t.wife.id}`, t.wife.id, '外婆取消了：带孩子出去', '我来带'],
      ]),
    )
    expect(dropRows(req.id)).toHaveLength(2)
  })

  it('undoing the drop cancels its notice; re-opening before delivery cancels it too', async () => {
    const s = sim(iso('2026-11-02', '12:00'))
    const { t } = s
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去', dueAt: iso('2026-11-07', '08:00') })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    const u = t.domain.createUtterance(t.wife.id, 'text', '周六那个算了，我去不了了')
    t.domain.updateItem(t.asAi(t.wife, u.id), req.id, { status: 'dropped' }, '去不了了')
    const [notice] = s.dropRows(req.id)
    expect(notice).toMatchObject({ status: 'scheduled', memberId: t.husband.id })
    // linked to the utterance, so undoing it cancels the notice
    expect(t.db.prepare('SELECT utterance_id FROM notifications WHERE id = ?').get(notice!.id)).toEqual({ utterance_id: u.id })
    t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(t.domain.getItem(req.id)!.status).toBe('accepted')
    expect(s.dropRows(req.id).map(n => n.status)).toEqual(['cancelled'])
    expect(s.row(req.id, `due:${req.id}:${iso('2026-11-07', '08:00')}`)!.status).toBe('scheduled')

    // dropped at 23:00 (held back for his quiet hours), then she takes it on again before he gets it
    await s.runUntil(at('2026-11-02', '23:00'))
    t.domain.updateItem(t.as(t.wife), req.id, { status: 'dropped' })
    await s.runUntil(at('2026-11-02', '23:05'))
    expect(s.dropRows(req.id).find(n => n.status === 'scheduled')).toMatchObject({ fireAt: iso('2026-11-03', '07:30') })
    t.domain.updateItem(t.as(t.wife), req.id, { status: 'accepted' })
    expect(s.dropRows(req.id).every(n => n.status === 'cancelled')).toBe(true)
    await s.runUntil(at('2026-11-03', '08:00'))
    expect(s.sent.filter(x => x.kind === 'request_answered' && x.title.includes('不做了'))).toEqual([])
  })
})

describe('a new due time ends an earlier snooze', () => {
  it('rescheduling a snoozed task clears the snooze and its ping, and the new time pings as usual', async () => {
    const s = sim(iso('2026-11-02', '13:00'))
    const { t } = s
    const tax = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '报税', dueAt: iso('2026-11-02', '15:00') })
    const until = at('2026-11-03', '09:00')
    t.domain.snoozeItem(t.as(t.husband), tax.id, until)
    const moved = t.domain.updateItem(t.as(t.husband), tax.id, { dueAt: iso('2026-11-02', '17:00') })
    expect(moved.snoozedUntil).toBeNull()
    expect(moved.snoozeCount).toBe(1) // the count stays: it is history ("已推迟 1 次")
    expect(s.row(tax.id, `snooze:${tax.id}:${until.toISOString()}`)!.status).toBe('cancelled')
    expect(s.row(tax.id, `due:${tax.id}:${iso('2026-11-02', '17:00')}`)).toMatchObject({ status: 'scheduled', fireAt: iso('2026-11-02', '16:00') })
    const ev = t.domain.getItemDetail(tax.id)!.events.at(-1)!
    expect(ev).toMatchObject({ type: 'item_updated' })
    expect(ev.payload).toMatchObject({
      before: { dueAt: iso('2026-11-02', '15:00'), snoozedUntil: until.toISOString() },
      after: { dueAt: iso('2026-11-02', '17:00'), snoozedUntil: null },
    })
    await s.runUntil(at('2026-11-03', '10:00'))
    expect(s.sent.filter(x => x.itemId === tax.id).map(x => [x.at, x.title])).toEqual([['2026-11-02 16:00', '快到时间：报税']])
  })

  it('undo of the reschedule restores the due time, the snooze and the snooze ping', () => {
    const { t, row } = sim(iso('2026-11-02', '13:00'))
    const bill = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '交水费', dueDate: '2026-11-03' })
    const until = at('2026-11-09', '09:00')
    t.domain.snoozeItem(t.as(t.wife), bill.id, until)
    const u = t.domain.createUtterance(t.wife.id, 'text', '水费改到周四交')
    t.domain.updateItem(t.asAi(t.wife, u.id), bill.id, { dueDate: '2026-11-05' })
    expect(t.domain.getItem(bill.id)!.snoozedUntil).toBeNull()
    expect(row(bill.id, `due:${bill.id}:2026-11-05`)!.status).toBe('scheduled')
    t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(t.domain.getItem(bill.id)).toMatchObject({ dueDate: '2026-11-03', snoozedUntil: until.toISOString(), snoozeCount: 1 })
    expect(row(bill.id, `snooze:${bill.id}:${until.toISOString()}`)!.status).toBe('scheduled')
    expect(row(bill.id, `due:${bill.id}:2026-11-05`)!.status).toBe('cancelled')
  })

  it('re-opening a closed item clears its snooze (on the status event); undo of the re-open restores it', () => {
    const { t } = sim(iso('2026-11-02', '13:00'))
    const rug = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '买地毯' })
    const until = at('2026-11-05', '09:00')
    t.domain.snoozeItem(t.as(t.wife), rug.id, until)
    t.domain.updateItem(t.as(t.wife), rug.id, { status: 'dropped' })
    const u = t.domain.createUtterance(t.wife.id, 'text', '地毯还是要买')
    const open = t.domain.updateItem(t.asAi(t.wife, u.id), rug.id, { status: 'open' })
    expect(open.snoozedUntil).toBeNull()
    expect(t.domain.getItemDetail(rug.id)!.events.at(-1)!).toMatchObject({
      type: 'status_changed',
      payload: expect.objectContaining({ before: expect.objectContaining({ snoozedUntil: until.toISOString() }), after: expect.objectContaining({ status: 'open', snoozedUntil: null }) }),
    })
    t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(t.domain.getItem(rug.id)).toMatchObject({ status: 'dropped', snoozedUntil: until.toISOString() })
  })

  it('clearing the date, other edits and an expired snooze leave snoozedUntil alone', () => {
    const { t } = sim(iso('2026-11-02', '13:00'))
    const a = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '修门', dueDate: '2026-11-03' })
    t.domain.snoozeItem(t.as(t.wife), a.id, at('2026-11-05', '09:00'))
    expect(t.domain.updateItem(t.as(t.wife), a.id, { dueDate: null, title: '修柜门' }).snoozedUntil).toBe(iso('2026-11-05', '09:00'))

    const b = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '洗车', dueDate: '2026-11-03' })
    t.domain.snoozeItem(t.as(t.wife), b.id, at('2026-11-02', '14:00'))
    t.clock.set(at('2026-11-02', '15:00'))
    t.domain.updateItem(t.as(t.wife), b.id, { dueDate: '2026-11-04' })
    const ev = t.domain.getItemDetail(b.id)!.events.at(-1)!
    expect(ev.payload.after).toEqual({ dueDate: '2026-11-04' }) // nothing to undo about a snooze that had ended
    expect(t.domain.getItem(b.id)!.snoozedUntil).toBe(iso('2026-11-02', '14:00'))
  })
})
