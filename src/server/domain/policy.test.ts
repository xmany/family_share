import { describe, expect, it } from 'vitest'
import type { Item, Member } from '../../shared/types'
import { HOUR, MINUTE, zonedToUtc } from '../time'
import type { PolicyEnv } from './policy'
import {
  dedupeKeys,
  isTimingKey,
  isUrgentRequest,
  planAssigned,
  planExplicitReminder,
  planRequestAnswered,
  planRequestSent,
  planTiming,
  requestFollowupAt,
  requestNoreplyAt,
  timingKeys,
} from './policy'

const TZ = 'Australia/Sydney'
const at = (date: string, time: string) => zonedToUtc(date, time, TZ)
const iso = (date: string, time: string) => at(date, time).toISOString()
// Wed 2026-10-21 12:00 Sydney (UTC+11)
const NOW = at('2026-10-21', '12:00')

const member = (id: string, name: string): Member => ({
  id,
  name,
  aliases: [],
  role: 'adult',
  language: 'zh-CN',
  quietStart: '22:00',
  quietEnd: '07:30',
  digestTime: '07:30',
  color: '#000',
  createdAt: NOW.toISOString(),
})
const HUSBAND = member('m_h', '老公')
const WIFE = member('m_w', '老婆')

function env(over: Partial<PolicyEnv> = {}): PolicyEnv {
  return {
    now: NOW,
    timezone: TZ,
    scheduler: { requestFollowupMin: 120, requestNoreplyMin: 360 },
    members: [HUSBAND, WIFE],
    actorMemberId: HUSBAND.id,
    utteranceId: 'u_1',
    ...over,
  }
}

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i_1',
    kind: 'task',
    title: '买地毯',
    details: null,
    status: 'open',
    ownerId: WIFE.id,
    createdBy: HUSBAND.id,
    requestedBy: null,
    dueAt: null,
    dueDate: null,
    remindAt: null,
    snoozedUntil: null,
    snoozeCount: 0,
    priority: 'normal',
    parentId: null,
    tags: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: null,
    respondedAt: null,
    lastActivityAt: NOW.toISOString(),
    ...over,
  }
}

const request = (over: Partial<Item> = {}) =>
  item({ kind: 'request', status: 'pending', title: '带孩子出去', requestedBy: HUSBAND.id, ownerId: WIFE.id, ...over })

const byKind = (rows: ReturnType<typeof planTiming>) => rows.map(r => [r.kind, r.dedupeKey, new Date(r.fireAt!).toISOString(), r.respectQuietHours])

describe('due timing (dueAt)', () => {
  it('plans 60 min before plus 20:00 the evening before for an early morning due > 12 h away', () => {
    const dueAt = iso('2026-10-24', '08:30')
    const rows = planTiming(item({ dueAt }), env())
    expect(byKind(rows)).toEqual([
      ['due', `due:i_1:${dueAt}`, iso('2026-10-24', '07:30'), false],
      ['due', `due_eve:i_1:${dueAt}`, iso('2026-10-23', '20:00'), true],
    ])
    expect(rows.every(r => r.memberId === WIFE.id && r.itemId === 'i_1' && r.utteranceId === 'u_1')).toBe(true)
    expect(rows[0]!.actions?.map(a => a.action)).toEqual(['done', 'snooze_tonight'])
    expect(rows[0]!.title).toBe('快到时间：买地毯')
    expect(rows[0]!.body).toContain('今天 08:30')
    expect(rows[1]!.title).toBe('明早：买地毯')
    expect(rows[1]!.body).toContain('明天 08:30')
  })

  it('no evening reminder when due is at/after 10:00', () => {
    const dueAt = iso('2026-10-24', '10:00')
    expect(byKind(planTiming(item({ dueAt }), env()))).toEqual([['due', `due:i_1:${dueAt}`, iso('2026-10-24', '09:00'), false]])
  })

  it('no evening reminder when the early due is 12 h or less away, or the evening already passed', () => {
    const dueAt = iso('2026-10-22', '09:00')
    // Wed 21:30 -> 11.5 h away
    expect(planTiming(item({ dueAt }), env({ now: at('2026-10-21', '21:30') })).map(r => r.dedupeKey)).toEqual([`due:i_1:${dueAt}`])
    // Wed 20:30 -> 12.5 h away but 20:00 already passed
    expect(planTiming(item({ dueAt }), env({ now: at('2026-10-21', '20:30') })).map(r => r.dedupeKey)).toEqual([`due:i_1:${dueAt}`])
    // Wed 19:00 -> 14 h away, 20:00 still ahead
    expect(planTiming(item({ dueAt }), env({ now: at('2026-10-21', '19:00') })).map(r => r.dedupeKey)).toEqual([
      `due:i_1:${dueAt}`,
      `due_eve:i_1:${dueAt}`,
    ])
  })

  it('skips the 60-min reminder when it is already past', () => {
    expect(planTiming(item({ dueAt: iso('2026-10-21', '12:30') }), env())).toEqual([])
    expect(planTiming(item({ dueAt: iso('2026-10-20', '12:30') }), env())).toEqual([])
  })

  it('applies to accepted/pending requests but not declined ones, ideas, closed or unowned items', () => {
    const dueAt = iso('2026-10-21', '15:00')
    expect(planTiming(request({ dueAt }), env())).toHaveLength(1)
    expect(planTiming(request({ dueAt, status: 'accepted' }), env())).toHaveLength(1)
    expect(planTiming(request({ dueAt, status: 'declined' }), env())).toEqual([])
    expect(planTiming(item({ dueAt, status: 'done' }), env())).toEqual([])
    expect(planTiming(item({ dueAt, status: 'dropped' }), env())).toEqual([])
    expect(planTiming(item({ kind: 'idea', dueAt }), env())).toEqual([])
    expect(planTiming(item({ kind: 'idea', ownerId: null }), env())).toEqual([])
  })
})

describe('due timing (dueDate)', () => {
  it('09:00 on the day, respecting quiet hours', () => {
    const rows = planTiming(item({ dueDate: '2026-10-23' }), env())
    expect(byKind(rows)).toEqual([['due', 'due:i_1:2026-10-23', iso('2026-10-23', '09:00'), true]])
    expect(rows[0]!.actions?.map(a => a.action)).toEqual(['done', 'snooze_tomorrow'])
    expect(rows[0]!.title).toBe('今天要做：买地毯')
  })
  it('skips when 09:00 already passed', () => {
    expect(planTiming(item({ dueDate: '2026-10-21' }), env())).toEqual([])
  })
})

describe('reminder items and snooze', () => {
  it('kind reminder fires exactly at dueAt, ignoring quiet hours', () => {
    const dueAt = iso('2026-10-21', '23:15')
    const rows = planTiming(item({ kind: 'reminder', title: '交水费', dueAt }), env())
    expect(byKind(rows)).toEqual([['explicit', `reminder:i_1:${dueAt}`, dueAt, false]])
    expect(rows[0]!.title).toBe('提醒：交水费')
    expect(rows[0]!.actions?.map(a => a.action)).toEqual(['done'])
  })
  it('kind reminder with only a date fires 09:00 that day', () => {
    expect(byKind(planTiming(item({ kind: 'reminder', dueDate: '2026-10-22' }), env()))).toEqual([
      ['explicit', 'reminder:i_1:2026-10-22', iso('2026-10-22', '09:00'), true],
    ])
  })
  it('snoozedUntil plans a due row to the owner (or the creator of an unowned idea)', () => {
    const until = iso('2026-10-22', '09:00')
    const rows = planTiming(item({ snoozedUntil: until, snoozeCount: 2 }), env())
    expect(byKind(rows)).toEqual([['due', `snooze:i_1:${until}`, until, true]])
    expect(rows[0]!.memberId).toBe(WIFE.id)
    expect(rows[0]!.body).toContain('已推迟 2 次')
    const idea = planTiming(item({ kind: 'idea', ownerId: null, snoozedUntil: until }), env())
    expect(idea[0]!.memberId).toBe(HUSBAND.id)
    expect(planTiming(item({ snoozedUntil: iso('2026-10-21', '11:00') }), env())).toEqual([])
  })
})

describe('timingKeys', () => {
  it('lists the keys valid for the current state regardless of now', () => {
    const dueAt = iso('2026-10-21', '12:30') // too close to plan anything, but still valid
    expect(timingKeys(item({ dueAt }))).toEqual([`due:i_1:${dueAt}`, `due_eve:i_1:${dueAt}`])
    expect(timingKeys(item({ dueDate: '2026-10-22' }))).toEqual(['due:i_1:2026-10-22'])
    expect(timingKeys(item({ kind: 'reminder', dueAt }))).toEqual([`reminder:i_1:${dueAt}`])
    expect(timingKeys(item({ dueAt, status: 'done' }))).toEqual([])
    expect(timingKeys(request({ dueAt, status: 'declined' }))).toEqual([])
    expect(timingKeys(item({ snoozedUntil: dueAt }))).toEqual([`snooze:i_1:${dueAt}`])
  })
  it('isTimingKey recognises only timing-derived rows', () => {
    expect(isTimingKey('due:i_1:x')).toBe(true)
    expect(isTimingKey('due_eve:i_1:x')).toBe(true)
    expect(isTimingKey('reminder:i_1:x')).toBe(true)
    expect(isTimingKey('snooze:i_1:x')).toBe(true)
    expect(isTimingKey('explicit:i_1:x')).toBe(false)
    expect(isTimingKey('request_new:i_1:1')).toBe(false)
    expect(isTimingKey('assigned:i_1:m:1')).toBe(false)
  })
})

describe('request follow-up / no-reply times', () => {
  const cfg = { requestFollowupMin: 120, requestNoreplyMin: 360 }
  const sent = NOW
  const plus = (ms: number) => new Date(sent.getTime() + ms).toISOString()
  it('defaults to created + 120 / 360 min', () => {
    expect(requestFollowupAt(sent, null, cfg).toISOString()).toBe(plus(120 * MINUTE))
    expect(requestNoreplyAt(sent, null, cfg).toISOString()).toBe(plus(360 * MINUTE))
  })
  it('uses 3 h / 1 h before dueAt when sooner', () => {
    const due = plus(4 * HOUR)
    expect(requestFollowupAt(sent, due, cfg).toISOString()).toBe(plus(60 * MINUTE))
    expect(requestNoreplyAt(sent, due, cfg).toISOString()).toBe(plus(180 * MINUTE))
  })
  it('never sooner than 30 min after creation', () => {
    const due = plus(2 * HOUR)
    expect(requestFollowupAt(sent, due, cfg).toISOString()).toBe(plus(30 * MINUTE))
    expect(requestNoreplyAt(sent, due, cfg).toISOString()).toBe(plus(60 * MINUTE))
    const soon = plus(20 * MINUTE)
    expect(requestFollowupAt(sent, soon, cfg).toISOString()).toBe(plus(30 * MINUTE))
    expect(requestNoreplyAt(sent, soon, cfg).toISOString()).toBe(plus(30 * MINUTE))
  })
  it('a far due date does not change the defaults', () => {
    const due = plus(3 * 24 * HOUR)
    expect(requestFollowupAt(sent, due, cfg).toISOString()).toBe(plus(120 * MINUTE))
    expect(requestNoreplyAt(sent, due, cfg).toISOString()).toBe(plus(360 * MINUTE))
  })
  it('honours config', () => {
    expect(requestFollowupAt(sent, null, { requestFollowupMin: 45, requestNoreplyMin: 90 }).toISOString()).toBe(plus(45 * MINUTE))
  })
})

describe('planRequestSent', () => {
  it('request_new now + follow-up to the owner, no-reply to the requester', () => {
    const rows = planRequestSent(request({ details: '他九点有个会', dueAt: iso('2026-10-24', '08:30') }), 1, env())
    expect(rows.map(r => [r.kind, r.memberId, r.dedupeKey])).toEqual([
      ['request_new', WIFE.id, 'request_new:i_1:1'],
      ['request_followup', WIFE.id, 'request_followup:i_1:1'],
      ['request_noreply', HUSBAND.id, 'request_noreply:i_1:1'],
    ])
    const [neu, follow, noreply] = rows
    expect(new Date(neu!.fireAt!).toISOString()).toBe(NOW.toISOString())
    expect(neu!.respectQuietHours).toBe(true) // due is > 12 h away
    expect(neu!.title).toBe('老公请你：带孩子出去')
    expect(neu!.body).toBe('周六 10/24 08:30 · 他九点有个会')
    expect(neu!.actions?.map(a => a.action)).toEqual(['accept', 'decline'])
    expect(follow!.actions?.map(a => a.action)).toEqual(['accept', 'decline'])
    expect(follow!.respectQuietHours).toBe(true)
    expect(new Date(follow!.fireAt!).getTime() - NOW.getTime()).toBe(120 * MINUTE)
    expect(noreply!.title).toBe('老婆还没回复：带孩子出去')
    expect(noreply!.actions?.map(a => a.action)).toEqual(['open'])
    expect(new Date(noreply!.fireAt!).getTime() - NOW.getTime()).toBe(360 * MINUTE)
  })

  it('request_new ignores quiet hours when due within 12 h, high priority or dated today', () => {
    const neu = (over: Partial<Item>) => planRequestSent(request(over), 1, env())[0]!
    expect(neu({ dueAt: iso('2026-10-21', '23:00') }).respectQuietHours).toBe(false)
    expect(neu({ dueAt: iso('2026-10-22', '01:00') }).respectQuietHours).toBe(true) // 13 h away
    expect(neu({ dueAt: iso('2026-10-22', '00:00') }).respectQuietHours).toBe(false) // 12 h
    expect(neu({ dueAt: iso('2026-10-22', '00:01') }).respectQuietHours).toBe(true)
    expect(neu({ priority: 'high' }).respectQuietHours).toBe(false)
    expect(neu({ dueDate: '2026-10-21' }).respectQuietHours).toBe(false)
    expect(neu({ dueDate: '2026-10-22' }).respectQuietHours).toBe(true)
    expect(neu({}).respectQuietHours).toBe(true)
  })

  it('uses the round number in every key', () => {
    expect(planRequestSent(request(), 3, env()).map(r => r.dedupeKey)).toEqual([
      'request_new:i_1:3',
      'request_followup:i_1:3',
      'request_noreply:i_1:3',
    ])
  })

  it('plans nothing for non-pending requests', () => {
    expect(planRequestSent(request({ status: 'accepted' }), 1, env())).toEqual([])
    expect(planRequestSent(item(), 1, env())).toEqual([])
  })
})

describe('isUrgentRequest', () => {
  it('treats overdue as urgent', () => {
    expect(isUrgentRequest(request({ dueAt: iso('2026-10-20', '09:00') }), NOW, TZ)).toBe(true)
  })
})

describe('answered / assigned / explicit', () => {
  it('request_answered goes to the requester, never to the actor', () => {
    const rows = planRequestAnswered(request({ status: 'accepted' }), 'accept', 2, env({ actorMemberId: WIFE.id }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      memberId: HUSBAND.id,
      kind: 'request_answered',
      dedupeKey: 'request_answered:i_1:accept:2',
      title: '老婆接受了：带孩子出去',
      respectQuietHours: true,
    })
    expect(planRequestAnswered(request(), 'decline', 1, env({ actorMemberId: WIFE.id }))[0]!.title).toBe('老婆做不了：带孩子出去')
    expect(planRequestAnswered(request(), 'done', 1, env({ actorMemberId: WIFE.id }))[0]!.title).toBe('老婆完成了：带孩子出去')
    expect(planRequestAnswered(request(), 'done', 1, env({ actorMemberId: HUSBAND.id }))).toEqual([])
  })

  it('assigned goes to the new owner unless they made the change', () => {
    const rows = planAssigned(item({ dueDate: '2026-10-22' }), 42, env())
    expect(rows[0]).toMatchObject({
      memberId: WIFE.id,
      kind: 'assigned',
      dedupeKey: `assigned:i_1:${WIFE.id}:42`,
      title: '老公交给你：买地毯',
      body: '明天',
      respectQuietHours: true,
    })
    expect(rows[0]!.actions?.map(a => a.action)).toEqual(['done', 'open'])
    expect(planAssigned(item(), 42, env({ actorMemberId: WIFE.id }))).toEqual([])
    expect(planAssigned(item({ status: 'done' }), 42, env())).toEqual([])
  })

  it('explicit reminders ignore quiet hours and key on item or member', () => {
    const fireAt = at('2026-10-21', '23:30')
    const withItem = planExplicitReminder({ memberId: WIFE.id, fireAt, message: '吃药', item: item() }, env())
    expect(withItem).toMatchObject({
      kind: 'explicit',
      dedupeKey: `explicit:i_1:${WIFE.id}:${fireAt.toISOString()}`,
      respectQuietHours: false,
      title: '提醒：吃药',
      itemId: 'i_1',
    })
    expect(withItem.actions?.map(a => a.action)).toEqual(['done', 'open'])
    const bare = planExplicitReminder({ memberId: WIFE.id, fireAt, message: '吃药', item: null }, env())
    expect(bare.dedupeKey).toBe(`explicit:${WIFE.id}:${fireAt.toISOString()}`)
    expect(bare.itemId).toBeNull()
    expect(bare.body).toBe('今天 23:30')
  })

  it('dedupe key builders', () => {
    expect(dedupeKeys.due('i_1', '2026-10-22')).toBe('due:i_1:2026-10-22')
    expect(dedupeKeys.snooze('i_1', 'T')).toBe('snooze:i_1:T')
  })
})

describe('text limits', () => {
  it('titles <= 40 and bodies <= 120 chars, member names not ids', () => {
    const long = '很'.repeat(300)
    const it1 = request({ title: long, details: long, dueAt: iso('2026-10-24', '08:30') })
    const rows = [
      ...planRequestSent(it1, 1, env()),
      ...planTiming(it1, env()),
      ...planAssigned(it1, 1, env()),
      ...planRequestAnswered(it1, 'decline', 1, env({ actorMemberId: WIFE.id }), { message: long }),
    ]
    expect(rows.length).toBeGreaterThan(4)
    for (const r of rows) {
      expect(Array.from(r.title).length).toBeLessThanOrEqual(40)
      expect(Array.from(r.body).length).toBeLessThanOrEqual(120)
      expect(r.title + r.body).not.toContain('m_')
      expect(r.title.endsWith('…')).toBe(true)
    }
  })
})
