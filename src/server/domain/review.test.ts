// Regression tests for bugs found in review of the domain layer.
import { describe, expect, it } from 'vitest'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { HOUR, MINUTE, zonedToUtc } from '../time'
import { DomainError } from './types'

const TZ = 'Australia/Sydney'
const iso = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString()

function say(t: TestContext, who: 'husband' | 'wife', text: string) {
  const m = t[who]
  const u = t.domain.createUtterance(m.id, 'text', text)
  return { u, actor: t.asAi(m, u.id) }
}
function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.code
    throw e
  }
  return 'ok'
}
function statusOfKey(t: TestContext, key: string): string | undefined {
  return (t.db.prepare('SELECT status FROM notifications WHERE dedupe_key = ?').get(key) as { status: string } | undefined)?.status
}

describe('review: explicit reminders', () => {
  it('two members reminded about the same item at the same time each keep their own row', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '出发去机场', dueAt: iso('2026-10-24', '10:00') })
    const fire = iso('2026-10-24', '08:00')
    const a = t.domain.setReminder(t.as(t.husband), { itemId: item.id, memberId: t.husband.id, fireAt: fire, message: '出发' })
    const b = t.domain.setReminder(t.as(t.husband), { itemId: item.id, memberId: t.wife.id, fireAt: fire, message: '出发' })
    expect(b.id).not.toBe(a.id)
    expect(t.outbox.get(a.id)!.memberId).toBe(t.husband.id)
    expect(t.outbox.get(b.id)!.memberId).toBe(t.wife.id)
    const explicit = t.outbox.scheduledForItem(item.id).filter(n => n.kind === 'explicit')
    expect(explicit.map(n => n.memberId).sort()).toEqual([t.husband.id, t.wife.id].sort())
    // setting the same reminder again is still deduped
    const again = t.domain.setReminder(t.as(t.wife), { itemId: item.id, memberId: t.wife.id, fireAt: fire, message: '出发' })
    expect(again.id).toBe(b.id)
  })

  it('a reminder item created with remindAt equal to its own time pings once', () => {
    const t = createTestContext()
    const at = iso('2026-10-21', '15:00')
    const r = t.domain.createItem(t.as(t.wife), { kind: 'reminder', title: '交水费', dueAt: at, remindAt: at })
    const rows = t.outbox.scheduledForItem(r.id)
    expect(rows.map(n => [n.kind, n.fireAt, n.memberId])).toEqual([['explicit', at, t.wife.id]])
  })
})

describe('review: time parsing', () => {
  it('rejects non-ISO instants instead of reading them in the server timezone, and impossible dates', () => {
    const t = createTestContext()
    const a = t.as(t.husband)
    expect(code(() => t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: '2026/10/24 08:30' }))).toBe('invalid')
    expect(code(() => t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: 'Oct 24 2026 08:30' }))).toBe('invalid')
    expect(code(() => t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: '2026-02-30T08:00:00Z' }))).toBe('invalid')
    expect(code(() => t.domain.setReminder(a, { memberId: t.wife.id, fireAt: '24 October 2026', message: 'x' }))).toBe('invalid')
    // still accepted: UTC, offsets, local without offset
    expect(t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: '2026-10-24T08:30:00+11:00' }).dueAt).toBe(iso('2026-10-24', '08:30'))
    expect(t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: '2026-10-23T21:30:00.000Z' }).dueAt).toBe(iso('2026-10-24', '08:30'))
    expect(t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: '2026-10-24 08:30' }).dueAt).toBe(iso('2026-10-24', '08:30'))
  })
})

describe('review: undo keeps invariants', () => {
  it('dueAt and dueDate stay mutually exclusive when a later edit changed the time', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修水管', dueDate: '2026-10-23' })
    const { u, actor } = say(t, 'husband', '修水管改到周五下午三点')
    t.domain.updateItem(actor, item.id, { dueAt: iso('2026-10-23', '15:00') })
    // the wife moves it to 16:00 by hand
    t.domain.updateItem(t.as(t.wife), item.id, { dueAt: iso('2026-10-23', '16:00') })
    const back = t.domain.undoUtterance(t.as(t.husband), u.id).items[0]!
    expect([back.dueAt, back.dueDate]).toEqual([iso('2026-10-23', '16:00'), null])
    expect(t.outbox.scheduledForItem(item.id).map(n => n.dedupeKey)).toEqual([`due:${item.id}:${iso('2026-10-23', '16:00')}`])
  })

  it('status-coupled fields are not reverted when a later change moved the status on', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    const { u, actor } = say(t, 'wife', '好的我带')
    t.domain.respondToRequest(actor, req.id, 'accept')
    t.clock.advance(HOUR)
    t.domain.completeItem(t.as(t.wife), req.id)
    const back = t.domain.undoUtterance(t.as(t.wife), u.id).items[0]!
    expect(back.status).toBe('done')
    expect(back.respondedAt).not.toBeNull()
  })

  it('a task never ends up without an owner', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'idea', title: '装修厨房' })
    const { u, actor } = say(t, 'husband', '装修厨房我来做')
    t.domain.updateItem(actor, item.id, { kind: 'task' }) // owner becomes the speaker
    t.domain.updateItem(t.as(t.wife), item.id, { kind: 'reminder' })
    const back = t.domain.undoUtterance(t.as(t.husband), u.id).items[0]!
    expect(back.kind).toBe('reminder')
    expect(back.ownerId).not.toBeNull()
  })

  it('an undo leaves a later completion notice to the requester alone', () => {
    const t = createTestContext({ now: iso('2026-10-21', '21:00') })
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    const { u, actor } = say(t, 'wife', '好的我带')
    t.domain.respondToRequest(actor, req.id, 'accept')
    t.domain.completeItem(t.as(t.wife), req.id)
    expect(statusOfKey(t, `request_answered:${req.id}:done:1`)).toBe('scheduled')
    t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(statusOfKey(t, `request_answered:${req.id}:done:1`)).toBe('scheduled')
  })
})

describe('review: utterances', () => {
  it('writes for an utterance that was already undone are refused', () => {
    const t = createTestContext()
    const { u, actor } = say(t, 'husband', '买地毯，再买个灯')
    t.domain.createItem(actor, { kind: 'task', title: '买地毯' })
    t.domain.undoUtterance(t.as(t.husband), u.id)
    // the interpreter is still running and tries another tool call
    expect(code(() => t.domain.createItem(actor, { kind: 'task', title: '买灯' }))).toBe('conflict')
    expect(t.domain.listActiveItems()).toEqual([])
  })

  it('finishUtterance cannot mark an utterance undone without reverting it', () => {
    const t = createTestContext()
    const { u, actor } = say(t, 'husband', '买地毯')
    t.domain.createItem(actor, { kind: 'task', title: '买地毯' })
    expect(code(() => t.domain.finishUtterance(u.id, { status: 'undone', reply: null }))).toBe('invalid')
    expect(t.domain.getUtterance(u.id)!.status).toBe('processing')
  })

  it('an AI actor must speak for the member who said the utterance', () => {
    const t = createTestContext()
    const u = t.domain.createUtterance(t.husband.id, 'text', '买地毯')
    expect(code(() => t.domain.createItem(t.asAi(t.wife, u.id), { kind: 'task', title: '买地毯' }))).toBe('invalid')
  })
})

describe('review: requests', () => {
  it('re-sending a declined request cancels the undelivered "declined" notice', () => {
    const t = createTestContext({ now: iso('2026-10-21', '21:30') })
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    t.clock.advance(45 * MINUTE) // 22:15, the decline notice waits for quiet hours to end
    t.domain.respondToRequest(t.as(t.wife), req.id, 'decline')
    expect(statusOfKey(t, `request_answered:${req.id}:decline:1`)).toBe('scheduled')
    t.domain.updateItem(t.as(t.husband), req.id, { status: 'pending' })
    expect(statusOfKey(t, `request_answered:${req.id}:decline:1`)).toBe('cancelled')
    expect(statusOfKey(t, `request_new:${req.id}:2`)).toBe('scheduled')
  })

  it('accepting and handing over in one update tells the new owner', () => {
    const t = createTestContext()
    const grandma = t.domain.createMember({ name: '外婆', role: 'relative' })
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    t.domain.updateItem(t.as(t.wife), req.id, { status: 'accepted', ownerId: grandma.id })
    const assigned = t.outbox.listForItem(req.id).filter(n => n.kind === 'assigned')
    expect(assigned.map(n => n.memberId)).toEqual([grandma.id])
  })
})

describe('review: search', () => {
  it('matches Traditional and Simplified spellings', () => {
    const t = createTestContext()
    const rug = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯' })
    const lamp = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '買燈' })
    expect(t.domain.searchItems({ text: '買地毯' }).map(i => i.id)).toEqual([rug.id])
    expect(t.domain.searchItems({ text: '买灯' }).map(i => i.id)).toEqual([lamp.id])
  })
})

describe('review: bus after commit', () => {
  it('wakes the scheduler only after the transaction committed', () => {
    const t = createTestContext()
    const seen: boolean[] = []
    t.bus.on('notifications_queued', () => seen.push(t.db.inTransaction))
    t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    expect(seen).toEqual([false])
    // a future-only change does not wake it
    t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修水管', dueAt: iso('2026-10-22', '15:00') })
    expect(seen).toEqual([false])
  })

  it('a throwing bus listener does not turn a committed write into an error', () => {
    const t = createTestContext()
    t.bus.on('server_event', () => {
      throw new Error('SSE client gone')
    })
    const errors: unknown[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯' })
      expect(t.domain.getItem(item.id)).not.toBeNull()
    } finally {
      console.error = orig
    }
    expect(errors).toHaveLength(1)
  })
})

describe('review: DST', () => {
  it('evening-before and 60-min reminders straddle the Sydney DST start correctly', () => {
    // DST starts Sun 2026-10-04 02:00 → 03:00 (UTC+10 → UTC+11)
    const t = createTestContext({ now: '2026-10-01T01:00:00.000Z' })
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '早班机', dueAt: '2026-10-04T08:30' })
    expect(item.dueAt).toBe('2026-10-03T21:30:00.000Z')
    const rows = Object.fromEntries(t.outbox.scheduledForItem(item.id).map(n => [n.dedupeKey.split(':')[0], n.fireAt]))
    expect(rows).toEqual({ due: '2026-10-03T20:30:00.000Z', due_eve: '2026-10-03T10:00:00.000Z' })
  })
})

describe('review: editing a pending request', () => {
  it('refreshes the undelivered round rows: text, urgency and follow-up times move with dueAt', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去', dueAt: iso('2026-10-24', '08:30') })
    const row = (kind: string) => t.outbox.listForItem(req.id).find(n => n.kind === kind && n.status === 'scheduled')!
    expect(row('request_new').body).toContain('周六')
    t.clock.advance(10 * MINUTE)
    t.domain.updateItem(t.as(t.husband), req.id, { dueAt: iso('2026-10-21', '15:00'), title: '去接孩子' })
    expect(row('request_new')).toMatchObject({ title: '老公请你：去接孩子', respectQuietHours: false, fireAt: '2026-10-21T01:00:00.000Z' })
    expect(row('request_new').body).toContain('今天 15:00')
    // sent 12:00, due 15:00: follow-up min(14:00, 12:00) floored at 12:30; no-reply min(18:00, 14:00)
    expect(row('request_followup').fireAt).toBe(iso('2026-10-21', '12:30'))
    expect(row('request_noreply').fireAt).toBe(iso('2026-10-21', '14:00'))
    expect(t.outbox.listForItem(req.id).filter(n => n.kind === 'request_new')).toHaveLength(1)
  })

  it('does not revive the rows of an answered round', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    t.domain.updateItem(t.as(t.husband), req.id, { title: '带孩子去公园' })
    expect(t.outbox.scheduledForItem(req.id).map(n => n.kind)).toEqual(['request_answered'])
  })
})
