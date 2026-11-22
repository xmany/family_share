// Repeating items in the domain: one item that moves on to its next occurrence (occurrences.ts).
import { describe, expect, it } from 'vitest'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { DAY, HOUR, MINUTE, localDate, localTime, zonedToUtc } from '../time'
import { DomainError } from './types'

// The test clock starts on Wednesday 2026-10-21 12:00 in Sydney (UTC+11).
const TZ = 'Australia/Sydney'
const iso = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString()
const SUN = '2026-10-25'
const NEXT_SUN = '2026-11-01'

function scheduled(t: TestContext, itemId: string): string[] {
  return t.outbox
    .scheduledForItem(itemId)
    .map(n => n.dedupeKey)
    .sort()
}
function expectDomainError(fn: () => unknown, code: string, message?: RegExp): void {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError)
    expect((e as DomainError).code).toBe(code)
    if (message) expect((e as DomainError).message).toMatch(message)
    return
  }
  throw new Error('expected a DomainError')
}
function trash(t: TestContext) {
  return t.domain.createItem(t.as(t.husband), { kind: 'task', title: '倒垃圾', dueAt: iso(SUN, '21:00'), repeat: { freq: 'weekly' } })
}
const lastEvent = (t: TestContext, itemId: string) => t.domain.getItemDetail(itemId)!.events.at(-1)!

describe('creating a repeating item', () => {
  it('stores the rule anchored on the first occurrence and says how it repeats', () => {
    const t = createTestContext()
    const item = trash(t)
    expect(item.repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [0], monthDay: null, month: null, anchor: SUN })
    expect(lastEvent(t, item.id).summary).toBe('新建待办：倒垃圾（周日 10/25 21:00，每周日）')
    expect(lastEvent(t, item.id).payload.after).toMatchObject({ repeat: item.repeat })
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${iso(SUN, '21:00')}`])
    // it survives a round trip through the database
    expect(t.domain.getItem(item.id)!.repeat).toEqual(item.repeat)
  })

  it('needs a date and is never an idea', () => {
    const t = createTestContext()
    expectDomainError(() => t.domain.createItem(t.as(t.husband), { kind: 'task', title: '倒垃圾', repeat: { freq: 'weekly' } }), 'invalid', /日期/)
    expectDomainError(() => t.domain.createItem(t.as(t.husband), { kind: 'idea', title: '露营', repeat: { freq: 'yearly' } }), 'invalid', /想法/)
    expectDomainError(
      () => t.domain.createItem(t.as(t.husband), { kind: 'task', title: 'x', dueDate: SUN, repeat: { freq: 'weekly', weekdays: [9] } }),
      'invalid',
      /星期/,
    )
  })

  it('starts on the next occurrence when the first one is already over', () => {
    const t = createTestContext()
    // Wednesday 12:00: "每周三 08:00" said too late for today
    const item = t.domain.createItem(t.as(t.husband), { kind: 'reminder', title: '吃药', dueAt: iso('2026-10-21', '08:00'), repeat: { freq: 'weekly' } })
    expect(item.dueAt).toBe(iso('2026-10-28', '08:00'))
    expect(item.repeat!.anchor).toBe('2026-10-28')
    // a date-only daily task for today is not over yet
    const today = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '浇花', dueDate: '2026-10-21', repeat: { freq: 'daily' } })
    expect(today.dueDate).toBe('2026-10-21')
  })

  it('a repeating request names the rule too', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '倒垃圾', dueAt: iso(SUN, '21:00'), repeat: { freq: 'weekly' } })
    expect(req.repeat?.weekdays).toEqual([0])
    expect(lastEvent(t, req.id).summary).toBe('请求 → 老公：倒垃圾（周日 10/25 21:00，每周日）')
  })
})

describe('completing a repeating item', () => {
  it('moves it to the next occurrence instead of closing it, and re-plans its ping', () => {
    const t = createTestContext()
    const item = trash(t)
    t.clock.set(new Date(iso(SUN, '20:30')))
    const done = t.domain.completeItem(t.as(t.husband), item.id, '倒好了')
    expect(done).toMatchObject({ status: 'open', completedAt: null, dueAt: iso(NEXT_SUN, '21:00') })
    expect(done.repeat!.anchor).toBe(NEXT_SUN)
    const ev = lastEvent(t, item.id)
    expect(ev).toMatchObject({ type: 'item_completed', summary: '完成一次：倒垃圾 · 下次 11/1 周日 21:00' })
    expect(ev.payload).toMatchObject({
      before: { dueAt: iso(SUN, '21:00') },
      after: { dueAt: iso(NEXT_SUN, '21:00') },
      occurrence: 'done',
      occurrenceDate: SUN,
      message: '倒好了',
    })
    expect(t.domain.listNotes(item.id).map(n => n.text)).toEqual(['倒好了'])
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${iso(NEXT_SUN, '21:00')}`])
  })

  it('completing early does not bring the same occurrence back the next day', () => {
    const t = createTestContext()
    const item = trash(t)
    t.clock.set(new Date(iso('2026-10-24', '10:00'))) // Saturday
    expect(t.domain.completeItem(t.as(t.husband), item.id).dueAt).toBe(iso(NEXT_SUN, '21:00'))
  })

  it('a late completion skips occurrences that are already over', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '浇花', dueAt: iso('2026-10-21', '18:00'), repeat: { freq: 'daily' } })
    t.clock.set(new Date(iso('2026-10-24', '19:00'))) // three days later, after 18:00
    expect(t.domain.completeItem(t.as(t.husband), item.id).dueAt).toBe(iso('2026-10-25', '18:00'))
  })

  it('keeps the wall-clock time across a DST change', () => {
    // Sydney daylight saving ends on Sunday 2027-04-04
    const t = createTestContext({ now: iso('2027-03-25', '12:00') })
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '倒垃圾', dueAt: iso('2027-03-28', '21:00'), repeat: { freq: 'weekly' } })
    t.clock.set(new Date(iso('2027-03-28', '21:30')))
    let cur = t.domain.completeItem(t.as(t.husband), item.id)
    t.clock.set(new Date(iso('2027-04-04', '21:30')))
    cur = t.domain.completeItem(t.as(t.husband), item.id)
    expect(localDate(new Date(cur.dueAt!), TZ)).toBe('2027-04-11')
    expect(localTime(new Date(cur.dueAt!), TZ)).toBe('21:00')
  })

  it('a moved occurrence is followed by the series, not by the move', () => {
    const t = createTestContext()
    const item = trash(t)
    // 这周改到周一
    const moved = t.domain.updateItem(t.as(t.husband), item.id, { dueAt: iso('2026-10-26', '21:00') })
    expect(moved.repeat).toMatchObject({ weekdays: [0], anchor: SUN })
    expect(lastEvent(t, item.id).summary).toBe('倒垃圾：时间 → 周一 10/26 21:00')
    t.clock.set(new Date(iso('2026-10-26', '21:30')))
    expect(t.domain.completeItem(t.as(t.husband), item.id).dueAt).toBe(iso(NEXT_SUN, '21:00'))
  })

  it('updateItem status done completes the occurrence too; dropped ends the series', () => {
    const t = createTestContext()
    const item = trash(t)
    const done = t.domain.updateItem(t.as(t.husband), item.id, { status: 'done' })
    expect(done).toMatchObject({ status: 'open', dueAt: iso(NEXT_SUN, '21:00') })
    const dropped = t.domain.updateItem(t.as(t.husband), item.id, { status: 'dropped' })
    expect(dropped.status).toBe('dropped')
    expect(scheduled(t, item.id)).toEqual([])
  })

  it('the next occurrence starts fresh: progress status and a snooze are about this one', () => {
    const t = createTestContext()
    const item = trash(t)
    t.domain.updateItem(t.as(t.husband), item.id, { status: 'in_progress' })
    t.domain.snoozeItem(t.as(t.husband), item.id, new Date(iso(SUN, '22:00')))
    const done = t.domain.completeItem(t.as(t.husband), item.id)
    expect(done).toMatchObject({ status: 'open', snoozedUntil: null })
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${iso(NEXT_SUN, '21:00')}`])
  })

  it('cancels extra pings set for the occurrence that is over, and undo brings them back', () => {
    const t = createTestContext()
    const item = trash(t)
    const u = t.domain.createUtterance(t.husband.id, 'text', '倒好了')
    t.domain.setReminder(t.as(t.husband), { itemId: item.id, memberId: t.husband.id, fireAt: iso(SUN, '18:00'), message: '记得倒垃圾' })
    t.domain.setReminder(t.as(t.husband), { itemId: item.id, memberId: t.husband.id, fireAt: iso(NEXT_SUN, '18:00'), message: '下周也要倒' })
    t.domain.completeItem(t.asAi(t.husband, u.id), item.id)
    const keys = scheduled(t, item.id)
    expect(keys).not.toContain(`explicit:${item.id}:${t.husband.id}:${iso(SUN, '18:00')}`)
    expect(keys).toContain(`explicit:${item.id}:${t.husband.id}:${iso(NEXT_SUN, '18:00')}`)

    const res = t.domain.undoUtterance(t.as(t.husband), u.id)
    expect(res.items[0]).toMatchObject({ dueAt: iso(SUN, '21:00'), repeat: { anchor: SUN } })
    expect(scheduled(t, item.id)).toEqual(
      [
        `due:${item.id}:${iso(SUN, '21:00')}`,
        `explicit:${item.id}:${t.husband.id}:${iso(NEXT_SUN, '18:00')}`,
        `explicit:${item.id}:${t.husband.id}:${iso(SUN, '18:00')}`,
      ].sort(),
    )
  })
})

describe('skipping an occurrence', () => {
  it('moves on without counting as done', () => {
    const t = createTestContext()
    const item = trash(t)
    const skipped = t.domain.skipOccurrence(t.as(t.husband), item.id, '这周出门')
    expect(skipped).toMatchObject({ status: 'open', dueAt: iso(NEXT_SUN, '21:00') })
    expect(lastEvent(t, item.id)).toMatchObject({ type: 'item_updated', summary: '跳过一次：倒垃圾 · 下次 11/1 周日 21:00' })
    expect(lastEvent(t, item.id).payload).toMatchObject({ occurrence: 'skipped', message: '这周出门' })
  })

  it('is only for repeating, open items', () => {
    const t = createTestContext()
    const once = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯', dueDate: SUN })
    expectDomainError(() => t.domain.skipOccurrence(t.as(t.husband), once.id), 'invalid', /重复/)
    const item = trash(t)
    t.domain.updateItem(t.as(t.husband), item.id, { status: 'dropped' })
    expectDomainError(() => t.domain.skipOccurrence(t.as(t.husband), item.id), 'invalid', /不做了/)
  })
})

describe('changing or stopping the rule', () => {
  it('a new rule re-anchors on the due date; null or clearing the date stops it', () => {
    const t = createTestContext()
    const item = trash(t)
    // 以后改成每周一
    const monday = t.domain.updateItem(t.as(t.husband), item.id, { dueAt: iso('2026-10-26', '21:00'), repeat: { freq: 'weekly' } })
    expect(monday.repeat).toMatchObject({ weekdays: [1], anchor: '2026-10-26' })
    expect(lastEvent(t, item.id).summary).toBe('倒垃圾：时间 → 周一 10/26 21:00，重复 → 每周一')
    const stopped = t.domain.updateItem(t.as(t.husband), item.id, { repeat: null })
    expect(stopped.repeat).toBeNull()
    expect(lastEvent(t, item.id).summary).toBe('倒垃圾：不再重复')
    // completing it now closes it
    expect(t.domain.completeItem(t.as(t.husband), item.id).status).toBe('done')

    const other = trash(t)
    expect(t.domain.updateItem(t.as(t.husband), other.id, { dueAt: null, dueDate: null }).repeat).toBeNull()
    const third = trash(t)
    expect(t.domain.updateItem(t.as(t.husband), third.id, { kind: 'idea' }).repeat).toBeNull()
  })

  it('adding a rule to a dated task makes it repeat from its date', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '交房租', dueDate: '2026-11-01' })
    const monthly = t.domain.updateItem(t.as(t.husband), item.id, { repeat: { freq: 'monthly' } })
    expect(monthly.repeat).toMatchObject({ freq: 'monthly', monthDay: 1, anchor: '2026-11-01' })
    expect(lastEvent(t, item.id).summary).toBe('交房租：重复 → 每月1号')
    expectDomainError(() => t.domain.updateItem(t.as(t.husband), t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修门' }).id, { repeat: { freq: 'daily' } }), 'invalid', /日期/)
  })

  it('undo of an AI change to the rule restores the old rule', () => {
    const t = createTestContext()
    const item = trash(t)
    const u = t.domain.createUtterance(t.husband.id, 'text', '以后不用重复了')
    t.domain.updateItem(t.asAi(t.husband, u.id), item.id, { repeat: null })
    expect(t.domain.undoUtterance(t.as(t.husband), u.id).items[0]!.repeat).toEqual(item.repeat)
  })
})

describe('rollover (scheduler): an occurrence nobody completed moves on by itself', () => {
  it('a task stays overdue until the day before the next occurrence', () => {
    const t = createTestContext()
    const item = trash(t)
    t.clock.set(new Date(iso('2026-10-26', '09:00'))) // Monday: last night's trash is overdue
    expect(t.domain.rollOverRepeats()).toBe(0)
    expect(t.domain.getItem(item.id)!.dueAt).toBe(iso(SUN, '21:00'))
    t.clock.set(new Date(iso('2026-10-30', '23:59'))) // Friday night
    expect(t.domain.rollOverRepeats()).toBe(0)
    t.clock.set(new Date(iso('2026-10-31', '00:00'))) // Saturday
    expect(t.domain.rollOverRepeats()).toBe(1)
    const moved = t.domain.getItem(item.id)!
    expect(moved).toMatchObject({ status: 'open', dueAt: iso(NEXT_SUN, '21:00'), repeat: { anchor: NEXT_SUN } })
    expect(lastEvent(t, item.id)).toMatchObject({
      type: 'item_updated',
      actorType: 'system',
      memberId: null,
      summary: '倒垃圾：10/25 周日 21:00 没标完成 · 下次 明天 21:00',
      payload: { occurrence: 'missed' },
    })
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${iso(NEXT_SUN, '21:00')}`])
    expect(t.domain.rollOverRepeats()).toBe(0) // idempotent
  })

  it('a reminder moves on soon after its ping', () => {
    const t = createTestContext()
    const pill = t.domain.createItem(t.as(t.wife), { kind: 'reminder', title: '吃药', dueAt: iso('2026-10-22', '08:00'), repeat: { freq: 'daily' } })
    expect(scheduled(t, pill.id)).toEqual([`reminder:${pill.id}:${iso('2026-10-22', '08:00')}`])
    t.clock.set(new Date(iso('2026-10-22', '09:59')))
    expect(t.domain.rollOverRepeats()).toBe(0) // the ping may still be retrying
    t.clock.set(new Date(iso('2026-10-22', '10:00')))
    expect(t.domain.rollOverRepeats()).toBe(1)
    expect(t.domain.getItem(pill.id)!.dueAt).toBe(iso('2026-10-23', '08:00'))
    expect(lastEvent(t, pill.id).summary).toBe('吃药：下次提醒 → 明天 08:00')
    expect(scheduled(t, pill.id)).toEqual([`reminder:${pill.id}:${iso('2026-10-23', '08:00')}`])
  })

  it('after a long downtime it moves straight to the next occurrence that is still ahead', () => {
    const t = createTestContext()
    const pill = t.domain.createItem(t.as(t.wife), { kind: 'reminder', title: '吃药', dueAt: iso('2026-10-22', '08:00'), repeat: { freq: 'daily' } })
    t.clock.set(new Date(iso('2026-10-30', '12:00')))
    expect(t.domain.rollOverRepeats()).toBe(1)
    expect(t.domain.getItem(pill.id)!.dueAt).toBe(iso('2026-10-31', '08:00'))
    expect(t.domain.getItemDetail(pill.id)!.events.filter(e => e.payload.occurrence === 'missed')).toHaveLength(1)
  })

  it('leaves snoozed, declined and closed items alone', () => {
    const t = createTestContext()
    const snoozed = trash(t)
    t.domain.snoozeItem(t.as(t.husband), snoozed.id, new Date(iso('2026-11-05', '09:00')))
    const declined = t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '遛狗', dueDate: SUN, repeat: { freq: 'weekly' } })
    t.domain.respondToRequest(t.as(t.husband), declined.id, 'decline')
    const closed = trash(t)
    t.domain.updateItem(t.as(t.husband), closed.id, { status: 'dropped' })
    t.clock.set(new Date(iso('2026-11-01', '00:00')))
    expect(t.domain.rollOverRepeats()).toBe(0)
    t.clock.set(new Date(iso('2026-11-05', '09:01'))) // the snooze is over
    expect(t.domain.rollOverRepeats()).toBe(1)
    // to the occurrence it would have stood at: 11-01, overdue until Saturday like any missed one
    expect(t.domain.getItem(snoozed.id)!.dueAt).toBe(iso(NEXT_SUN, '21:00'))
  })
})

describe('repeating requests', () => {
  it('are accepted once; each completed occurrence tells the requester and moves on', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.wife), { toMemberId: t.husband.id, title: '倒垃圾', dueAt: iso(SUN, '21:00'), repeat: { freq: 'weekly' } })
    t.domain.respondToRequest(t.as(t.husband), req.id, 'accept')
    t.clock.set(new Date(iso(SUN, '21:10')))
    const first = t.domain.completeItem(t.as(t.husband), req.id)
    expect(first).toMatchObject({ status: 'accepted', dueAt: iso(NEXT_SUN, '21:00') })
    t.clock.set(new Date(iso(NEXT_SUN, '21:10')))
    t.domain.updateItem(t.as(t.husband), req.id, { status: 'in_progress' })
    const second = t.domain.completeItem(t.as(t.husband), req.id)
    expect(second).toMatchObject({ status: 'accepted', dueAt: iso('2026-11-08', '21:00') })
    const answered = t.outbox
      .listForItem(req.id)
      .filter(n => n.kind === 'request_answered' && n.memberId === t.wife.id && n.dedupeKey.includes(':done:'))
      .map(n => [n.dedupeKey, n.title])
      .sort()
    expect(answered).toEqual([
      [`request_answered:${req.id}:done:1:${SUN}`, '老公完成了：倒垃圾'],
      [`request_answered:${req.id}:done:1:${NEXT_SUN}`, '老公完成了：倒垃圾'],
    ])
  })
})

describe('time constants used above', () => {
  it('the test clock starts where the comments say', () => {
    const t = createTestContext()
    expect(localDate(t.clock.now(), TZ)).toBe('2026-10-21')
    expect(DAY / HOUR).toBe(24)
    expect(HOUR / MINUTE).toBe(60)
  })
})
