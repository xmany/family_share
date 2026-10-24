// Regression tests for the reminder-chain review (R2, R3, R4, R5, R9, R10): the real domain + outbox + scheduler with
// a fake notifier that records what each member would see, family timezone Pacific/Auckland, default quiet hours
// 22:00–07:30. Each test failed before its fix.
import { describe, expect, it } from 'vitest'
import type { ChannelSetting } from '../../shared/api'
import type { ScheduledNotification } from '../../shared/types'
import type { DeliveryResult, Notifier } from '../notify/types'
import { createTestContext } from '../testing'
import { MINUTE, localDate, localTime, resolveSnoozePreset, zonedToUtc } from '../time'
import { skipReason } from './relevance'
import { createScheduler } from './scheduler'

const TZ = 'Pacific/Auckland'
const at = (date: string, time: string) => zonedToUtc(date, time, TZ)
const iso = (date: string, time: string) => at(date, time).toISOString()
const local = (d: Date) => `${localDate(d, TZ)} ${localTime(d, TZ)}`

interface Sent {
  id: string
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
      sent.push({ id: n.id, at: local(t.clock.now()), kind: n.kind, memberId: n.memberId, itemId: n.itemId, title: n.title, body: n.body })
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
  return {
    t,
    sent,
    scheduler,
    /** advances the clock to `target` one step at a time, ticking at every step */
    async runUntil(target: Date, step = MINUTE) {
      while (t.clock.now().getTime() < target.getTime()) {
        t.clock.set(new Date(Math.min(target.getTime(), t.clock.now().getTime() + step)))
        await scheduler.tick()
      }
    },
    of(kind: ScheduledNotification['kind']) {
      return sent.filter(s => s.kind === kind)
    },
  }
}

describe('reminder chain', () => {
  it('R4 deferred notifications word 今天 / 明天 as of delivery, not as of when they were written', async () => {
    const s = sim(iso('2026-11-02', '12:00'))
    const { t } = s
    const pickup = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '接孩子', dueAt: iso('2026-11-03', '15:00') })
    const parcel = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '寄快递', dueAt: iso('2026-11-03', '16:00') })
    await s.runUntil(at('2026-11-02', '23:10'))
    // 23:10, the husband's quiet hours: all of these wait for 07:30 the next morning
    t.domain.respondToRequest(t.as(t.wife), pickup.id, 'decline', '我要加班')
    t.domain.createItem(t.as(t.wife), { kind: 'task', title: '倒垃圾', ownerId: t.husband.id, dueAt: iso('2026-11-03', '18:00') })
    t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '买菜', dueDate: '2026-11-04' })
    t.domain.snoozeItem(t.as(t.husband), parcel.id, at('2026-11-02', '23:30')) // worded for 23:30: "明天 16:00"
    await s.runUntil(at('2026-11-03', '08:00'))

    const on3 = (kind: ScheduledNotification['kind']) => s.of(kind).find(d => d.at.startsWith('2026-11-03'))!
    expect(on3('request_answered')).toMatchObject({ at: '2026-11-03 07:30', title: '老婆做不了：接孩子', body: '我要加班 · 今天 15:00' })
    expect(on3('assigned')).toMatchObject({ at: '2026-11-03 07:30', title: '老婆交给你：倒垃圾', body: '今天 18:00' })
    expect(on3('request_new')).toMatchObject({ at: '2026-11-03 07:30', title: '老婆请你：买菜', body: '明天' })
    expect(on3('due')).toMatchObject({ at: '2026-11-03 07:30', title: '该处理了：寄快递', body: '之前推迟到现在 · 今天 16:00' })
    // the row keeps the text that was actually sent
    expect(t.outbox.get(on3('assigned').id)!.body).toBe('今天 18:00')
  })

  it('R2 a request sent in quiet hours: follow-up and no-reply count from when the request reaches the owner', async () => {
    const s = sim(iso('2026-11-02', '23:15'))
    const { t } = s
    const r = t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '买菜', dueDate: '2026-11-04' })
    const planned = (prefix: string) => t.outbox.listForItem(r.id).find(n => n.dedupeKey.startsWith(prefix))!.fireAt
    expect(planned('request_followup:')).toBe(iso('2026-11-03', '09:30'))
    expect(planned('request_noreply:')).toBe(iso('2026-11-03', '13:30'))
    await s.runUntil(at('2026-11-02', '23:20'))
    // an edit during the night re-words the round but must not pull the follow-ups back to the night
    t.domain.updateItem(t.as(t.wife), r.id, { title: '买菜和牛奶' })
    expect(planned('request_followup:')).toBe(iso('2026-11-03', '09:30'))
    expect(planned('request_noreply:')).toBe(iso('2026-11-03', '13:30'))
    await s.runUntil(at('2026-11-03', '16:00'))
    expect(s.of('request_new').map(d => d.at)).toEqual(['2026-11-03 07:30'])
    expect(s.of('request_followup').map(d => d.at)).toEqual(['2026-11-03 09:30'])
    expect(s.of('request_noreply').map(d => d.at)).toEqual(['2026-11-03 13:30'])
  })

  it('R2 a request that reaches the owner late (scheduler not running) pushes its follow-up and no-reply back too', async () => {
    const s = sim(iso('2026-11-02', '10:00'))
    const { t } = s
    t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '修水管', dueDate: '2026-11-06' })
    t.clock.set(at('2026-11-02', '12:30')) // no tick between 10:00 and 12:30
    await s.scheduler.tick()
    await s.runUntil(at('2026-11-02', '20:00'))
    expect(s.of('request_new').map(d => d.at)).toEqual(['2026-11-02 12:30'])
    expect(s.of('request_followup').map(d => d.at)).toEqual(['2026-11-02 14:30'])
    expect(s.of('request_noreply').map(d => d.at)).toEqual(['2026-11-02 18:30'])
  })

  it('R3 follow-up and no-reply are dropped once the request is due; a deferral that still lands before it is kept', async () => {
    const s = sim(iso('2026-11-02', '21:00'))
    const { t } = s
    // urgent (10 h away): request_new goes out at once; follow-up 23:00 and no-reply 03:00 fall into quiet hours
    const airport = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '送我去机场', dueAt: iso('2026-11-03', '07:00') })
    // due 09:00: the follow-up deferred to 07:30 still arrives before the event
    const school = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '送孩子上学', dueAt: iso('2026-11-03', '09:00') })
    await s.runUntil(at('2026-11-03', '10:00'))

    const roundRows = (itemId: string) =>
      s.sent.filter(d => d.itemId === itemId && (d.kind === 'request_followup' || d.kind === 'request_noreply'))
    expect(roundRows(airport.id)).toEqual([])
    const skipped = t.outbox.listForItem(airport.id).filter(n => n.kind === 'request_followup' || n.kind === 'request_noreply')
    expect(skipped.map(n => [n.status, n.lastError])).toEqual([
      ['skipped', 'past_due'],
      ['skipped', 'past_due'],
    ])
    expect(roundRows(school.id).map(d => `${d.at} ${d.kind} ${d.body}`)).toEqual([
      '2026-11-03 07:30 request_followup 老公在等你回复 · 今天 09:00',
      '2026-11-03 07:30 request_noreply 今天 09:00 · 要不要当面问一下，或者换个安排？',
    ])
  })

  it('R3 skipReason: a day-only request is past due from the day after its date', () => {
    const t = createTestContext({ now: iso('2026-11-03', '10:00'), timezone: TZ })
    const r = t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '买菜', dueDate: '2026-11-03' })
    const row = t.outbox.listForItem(r.id).find(n => n.kind === 'request_followup')!
    expect(skipReason(row, r, at('2026-11-03', '23:59'), TZ)).toBeNull()
    expect(skipReason(row, r, at('2026-11-04', '00:01'), TZ)).toBe('past_due')
    const noreply = t.outbox.listForItem(r.id).find(n => n.kind === 'request_noreply')!
    expect(skipReason(noreply, r, at('2026-11-04', '00:01'), TZ)).toBe('past_due')
  })

  it('R5 an edit that makes a deferred request urgent sends it right away', async () => {
    const s = sim(iso('2026-11-02', '22:30'))
    const { t } = s
    const r = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子去游泳', dueAt: iso('2026-11-05', '08:30') })
    await s.runUntil(at('2026-11-02', '22:40'))
    expect(s.of('request_new')).toEqual([]) // not urgent yet: waits for 07:30
    // correction: it is tomorrow morning, 10 h away — a fresh request like this one ignores quiet hours
    t.domain.updateItem(t.as(t.husband), r.id, { dueAt: iso('2026-11-03', '08:30') })
    await s.scheduler.tick()
    expect(s.of('request_new').map(d => `${d.at} ${d.body}`)).toEqual(['2026-11-02 22:40 明天 08:30'])
  })

  it('R9 a reminder at the same minute as the item’s own due ping reaches the member once', async () => {
    const s = sim(iso('2026-11-02', '10:00'))
    const { t } = s
    // 下午三点开会，提前一小时提醒我 → task + set_reminder 14:00 (= the 60-minute due ping)
    const meeting = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '开会', dueAt: iso('2026-11-02', '15:00') })
    t.domain.setReminder(t.as(t.husband), { itemId: meeting.id, memberId: t.husband.id, fireAt: iso('2026-11-02', '14:00'), message: '开会' })
    // the wife asked to be reminded too: that one is hers
    t.domain.setReminder(t.as(t.husband), { itemId: meeting.id, memberId: t.wife.id, fireAt: iso('2026-11-02', '14:00'), message: '开会' })
    // createItem with remindAt one hour before dueAt
    const report = t.domain.createItem(t.as(t.husband), {
      kind: 'task',
      title: '交报告',
      dueAt: iso('2026-11-02', '17:00'),
      remindAt: iso('2026-11-02', '16:00'),
    })
    // the reminder came first and the time was set later
    const call = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '打电话' })
    t.domain.setReminder(t.as(t.husband), { itemId: call.id, memberId: t.husband.id, fireAt: iso('2026-11-02', '18:00'), message: '打电话' })
    t.domain.updateItem(t.as(t.husband), call.id, { dueAt: iso('2026-11-02', '19:00') })
    await s.runUntil(at('2026-11-02', '20:00'))

    const pings = (itemId: string, memberId: string) => s.sent.filter(d => d.itemId === itemId && d.memberId === memberId).map(d => d.at)
    expect(pings(meeting.id, t.husband.id)).toEqual(['2026-11-02 14:00'])
    expect(pings(meeting.id, t.wife.id)).toEqual(['2026-11-02 14:00'])
    expect(pings(report.id, t.husband.id)).toEqual(['2026-11-02 16:00'])
    expect(pings(call.id, t.husband.id)).toEqual(['2026-11-02 18:00'])
  })

  it('R10 snoozing an item holds back its due pings until the snooze ends', async () => {
    const s = sim(iso('2026-11-02', '13:00'))
    const { t } = s
    const tax = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '报税', dueAt: iso('2026-11-02', '15:00') })
    t.domain.snoozeItem(t.as(t.husband), tax.id, resolveSnoozePreset('tomorrow', t.clock.now(), TZ))
    // snoozed only until 14:30: the 14:00 due ping is held back, the snooze ping at 14:30 takes its place
    const call = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '回电话', dueAt: iso('2026-11-02', '15:00') })
    t.domain.snoozeItem(t.as(t.husband), call.id, at('2026-11-02', '14:30'))
    // a due ping after the snooze has ended goes out as usual
    const pay = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '交水费', dueAt: iso('2026-11-02', '17:00') })
    t.domain.snoozeItem(t.as(t.husband), pay.id, at('2026-11-02', '14:30'))
    await s.runUntil(at('2026-11-03', '10:00'))

    const pings = (itemId: string) => s.sent.filter(d => d.itemId === itemId).map(d => `${d.at} ${d.title}`)
    expect(pings(tax.id)).toEqual(['2026-11-03 09:00 该处理了：报税'])
    expect(pings(call.id)).toEqual(['2026-11-02 14:30 该处理了：回电话'])
    expect(pings(pay.id)).toEqual(['2026-11-02 14:30 该处理了：交水费', '2026-11-02 16:00 快到时间：交水费'])
  })
})
