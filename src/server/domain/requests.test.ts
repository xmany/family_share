import { describe, expect, it } from 'vitest'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { HOUR, MINUTE, zonedToUtc } from '../time'
import { DomainError } from './types'

const TZ = 'Australia/Sydney'
const iso = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString()

function byKey(t: TestContext, itemId: string): Record<string, { status: string; memberId: string; fireAt: string; kind: string }> {
  const out: Record<string, { status: string; memberId: string; fireAt: string; kind: string }> = {}
  for (const n of t.outbox.listForItem(itemId)) out[n.dedupeKey] = { status: n.status, memberId: n.memberId, fireAt: n.fireAt, kind: n.kind }
  return out
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

function sendSaturdayRequest(t: TestContext) {
  const u = t.domain.createUtterance(t.husband.id, 'text', '周六早上你能带孩子出去吗？我九点有个会')
  const item = t.domain.sendRequest(t.asAi(t.husband, u.id), {
    toMemberId: t.wife.id,
    title: '带孩子出去',
    details: '他九点有个会',
    dueAt: iso('2026-10-24', '08:30'),
  })
  return { u, item }
}

describe('sendRequest', () => {
  it('creates a pending request with request_new / follow-up / no-reply rows and one request_sent event', () => {
    const t = createTestContext()
    const { u, item } = sendSaturdayRequest(t)
    expect(item).toMatchObject({ kind: 'request', status: 'pending', ownerId: t.wife.id, requestedBy: t.husband.id, createdBy: t.husband.id })
    const rows = byKey(t, item.id)
    const now = '2026-10-21T01:00:00.000Z'
    expect(rows[`request_new:${item.id}:1`]).toEqual({ status: 'scheduled', memberId: t.wife.id, fireAt: now, kind: 'request_new' })
    expect(rows[`request_followup:${item.id}:1`]).toMatchObject({ memberId: t.wife.id, fireAt: '2026-10-21T03:00:00.000Z' })
    expect(rows[`request_noreply:${item.id}:1`]).toMatchObject({ memberId: t.husband.id, fireAt: '2026-10-21T07:00:00.000Z' })
    // due rows for the owner too (Sat 08:30 -> 07:30, and Fri 20:00)
    expect(rows[`due:${item.id}:${item.dueAt}`]).toMatchObject({ memberId: t.wife.id, fireAt: iso('2026-10-24', '07:30') })
    expect(rows[`due_eve:${item.id}:${item.dueAt}`]).toMatchObject({ memberId: t.wife.id, fireAt: iso('2026-10-23', '20:00') })
    const neu = t.outbox.listForItem(item.id).find(n => n.kind === 'request_new')!
    expect(neu.title).toBe('老公请你：带孩子出去')
    expect(neu.body).toBe('周六 10/24 08:30 · 他九点有个会')
    expect(neu.actions).toEqual([
      { action: 'accept', title: '接受' },
      { action: 'decline', title: '做不了' },
    ])
    const changes = t.domain.getUtterance(u.id)!.changes
    expect(changes).toEqual([
      { eventId: expect.any(Number), type: 'request_sent', itemId: item.id, itemTitle: '带孩子出去', summary: '请求 → 老婆：带孩子出去（周六 10/24 08:30）' },
    ])
    // every row is linked to the utterance (so undo can cancel it)
    const linked = t.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE utterance_id = ?').get(u.id) as { n: number }
    expect(linked.n).toBe(5)
  })

  it('follow-up / no-reply move earlier for a request due soon', () => {
    const t = createTestContext()
    const item = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '接孩子', dueAt: '2026-10-21T05:00:00.000Z' }) // in 4 h
    const rows = byKey(t, item.id)
    expect(rows[`request_followup:${item.id}:1`]!.fireAt).toBe('2026-10-21T02:00:00.000Z') // due - 3 h
    expect(rows[`request_noreply:${item.id}:1`]!.fireAt).toBe('2026-10-21T04:00:00.000Z') // due - 1 h
    expect(t.outbox.listForItem(item.id).find(n => n.kind === 'request_new')!.respectQuietHours).toBe(false)
    const rush = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '买酱油', dueAt: '2026-10-21T02:00:00.000Z' }) // in 1 h
    expect(byKey(t, rush.id)[`request_followup:${rush.id}:1`]!.fireAt).toBe('2026-10-21T01:30:00.000Z') // clamped to +30 min
  })

  it('sending a request to yourself is invalid', () => {
    const t = createTestContext()
    expect(code(() => t.domain.sendRequest(t.as(t.husband), { toMemberId: t.husband.id, title: 'x' }))).toBe('invalid')
    expect(code(() => t.domain.sendRequest(t.as(t.husband), { toMemberId: 'm_nobody', title: 'x' }))).toBe('invalid')
    expect(code(() => t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '' }))).toBe('invalid')
  })

  it('request_new respects quiet hours unless due within 12 h or high priority', () => {
    const t = createTestContext({ now: iso('2026-10-21', '23:00') })
    const relaxed = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '周末买菜', dueDate: '2026-10-24' })
    const soon = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '明早送孩子', dueAt: iso('2026-10-22', '08:00') })
    const urgent = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '回电话', priority: 'high' })
    const respect = (id: string) => t.outbox.listForItem(id).find(n => n.kind === 'request_new')!.respectQuietHours
    expect([respect(relaxed.id), respect(soon.id), respect(urgent.id)]).toEqual([true, false, false])
  })
})

describe('respondToRequest', () => {
  it('only the owner may respond', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    try {
      t.domain.respondToRequest(t.as(t.husband), item.id, 'accept')
      throw new Error('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError)
      expect((e as DomainError).code).toBe('forbidden')
      expect((e as DomainError).message).toBe('只有老婆可以回复这个请求')
    }
    expect(code(() => t.domain.updateItem(t.as(t.husband), item.id, { status: 'accepted' }))).toBe('forbidden')
    expect(t.domain.getItem(item.id)!.status).toBe('pending')
  })

  it('accept: status, respondedAt, cancels follow-up/no-reply, tells the requester', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    t.clock.advance(30 * MINUTE)
    const acc = t.domain.respondToRequest(t.as(t.wife), item.id, 'accept')
    expect(acc.status).toBe('accepted')
    expect(acc.respondedAt).toBe('2026-10-21T01:30:00.000Z')
    const rows = byKey(t, item.id)
    expect(rows[`request_followup:${item.id}:1`]!.status).toBe('cancelled')
    expect(rows[`request_noreply:${item.id}:1`]!.status).toBe('cancelled')
    expect(rows[`request_answered:${item.id}:accept:1`]).toMatchObject({ status: 'scheduled', memberId: t.husband.id })
    expect(rows[`due:${item.id}:${item.dueAt}`]!.status).toBe('scheduled')
    const answered = t.outbox.listForItem(item.id).find(n => n.kind === 'request_answered')!
    expect(answered.title).toBe('老婆接受了：带孩子出去')
    const ev = t.domain.getItemDetail(item.id)!.events.at(-1)!
    expect(ev).toMatchObject({ type: 'request_responded', summary: '老婆接受了：带孩子出去' })
    expect(ev.payload).toMatchObject({
      before: { status: 'pending', respondedAt: null },
      after: { status: 'accepted', respondedAt: '2026-10-21T01:30:00.000Z' },
      response: 'accept',
      n: 1,
    })
    expect(code(() => t.domain.respondToRequest(t.as(t.wife), item.id, 'decline'))).toBe('invalid')
  })

  it('decline with a message: note, due rows cancelled, requester told', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    const dec = t.domain.respondToRequest(t.as(t.wife), item.id, 'decline', '周六我要加班')
    expect(dec.status).toBe('declined')
    expect(t.outbox.scheduledForItem(item.id).map(n => n.kind)).toEqual(['request_answered'])
    const answered = t.outbox.scheduledForItem(item.id)[0]!
    expect(answered.title).toBe('老婆做不了：带孩子出去')
    expect(answered.body).toContain('周六我要加班')
    expect(t.domain.listNotes(item.id).map(n => n.text)).toEqual(['周六我要加班'])
    expect(t.domain.getItemDetail(item.id)!.events.at(-1)!.summary).toBe('老婆做不了：带孩子出去（周六我要加班）')
  })

  it('updateItem(status accepted) by the owner behaves like respondToRequest', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    const acc = t.domain.updateItem(t.as(t.wife), item.id, { status: 'accepted' })
    expect(acc.status).toBe('accepted')
    expect(acc.respondedAt).not.toBeNull()
    expect(byKey(t, item.id)[`request_answered:${item.id}:accept:1`]).toBeDefined()
  })

  it('cannot respond to something that is not a request', () => {
    const t = createTestContext()
    const task = t.domain.createItem(t.as(t.husband), { kind: 'task', title: 'x' })
    expect(code(() => t.domain.respondToRequest(t.as(t.husband), task.id, 'accept'))).toBe('invalid')
  })
})

describe('request status rules', () => {
  it('pending -> in_progress needs accepting first; accepted -> in_progress / blocked / done', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    expect(code(() => t.domain.updateItem(t.as(t.wife), item.id, { status: 'in_progress' }))).toBe('invalid')
    expect(code(() => t.domain.updateItem(t.as(t.wife), item.id, { status: 'open' }))).toBe('invalid')
    t.domain.respondToRequest(t.as(t.wife), item.id, 'accept')
    expect(code(() => t.domain.updateItem(t.as(t.husband), item.id, { status: 'pending' }))).toBe('invalid')
    expect(t.domain.updateItem(t.as(t.wife), item.id, { status: 'in_progress' }).status).toBe('in_progress')
    expect(t.domain.updateItem(t.as(t.wife), item.id, { status: 'blocked' }).status).toBe('blocked')
    expect(t.domain.updateItem(t.as(t.wife), item.id, { status: 'accepted' }).status).toBe('accepted')
  })

  it('anyone may complete; the requester is told when the owner finishes', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    t.domain.respondToRequest(t.as(t.wife), item.id, 'accept')
    const done = t.domain.completeItem(t.as(t.wife), item.id, '玩得很开心')
    expect(done.status).toBe('done')
    const rows = byKey(t, item.id)
    expect(rows[`request_answered:${item.id}:done:1`]).toMatchObject({ status: 'scheduled', memberId: t.husband.id })
    expect(t.outbox.listForItem(item.id).find(n => n.dedupeKey === `request_answered:${item.id}:done:1`)!.title).toBe('老婆完成了：带孩子出去')
    // everything else is cancelled (an undelivered "accepted" row is superseded by "done")
    expect(t.outbox.scheduledForItem(item.id).map(n => n.dedupeKey)).toEqual([`request_answered:${item.id}:done:1`])
    expect(rows[`due:${item.id}:${item.dueAt}`]!.status).toBe('cancelled')
  })

  it('the requester completing it themselves is not notified', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    t.domain.completeItem(t.as(t.husband), item.id)
    expect(t.outbox.listForItem(item.id).filter(n => n.kind === 'request_answered')).toEqual([])
    expect(t.outbox.scheduledForItem(item.id)).toEqual([])
  })

  it('dropping a pending request cancels its follow-up and no-reply rows', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    t.domain.updateItem(t.as(t.husband), item.id, { status: 'dropped' })
    const rows = byKey(t, item.id)
    expect(rows[`request_followup:${item.id}:1`]!.status).toBe('cancelled')
    expect(rows[`request_noreply:${item.id}:1`]!.status).toBe('cancelled')
    expect(t.outbox.scheduledForItem(item.id)).toEqual([])
  })

  it('the requester re-opens a declined request: status pending re-sends with n+1', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    t.domain.respondToRequest(t.as(t.wife), item.id, 'decline')
    expect(code(() => t.domain.updateItem(t.as(t.wife), item.id, { status: 'pending' }))).toBe('forbidden')
    t.clock.advance(HOUR)
    const again = t.domain.updateItem(t.as(t.husband), item.id, { status: 'pending', dueAt: iso('2026-10-25', '08:30') })
    expect(again.status).toBe('pending')
    expect(again.respondedAt).toBeNull()
    const rows = byKey(t, item.id)
    expect(rows[`request_new:${item.id}:2`]).toMatchObject({ status: 'scheduled', memberId: t.wife.id, fireAt: '2026-10-21T02:00:00.000Z' })
    expect(rows[`request_followup:${item.id}:2`]!.status).toBe('scheduled')
    expect(rows[`request_noreply:${item.id}:2`]!.status).toBe('scheduled')
    expect(rows[`due:${item.id}:${iso('2026-10-25', '08:30')}`]!.status).toBe('scheduled')
    const ev = t.domain.getItemDetail(item.id)!.events.at(-1)!
    expect(ev.type).toBe('request_sent')
    expect(ev.summary).toBe('再次请求 → 老婆：带孩子出去（周日 10/25 08:30）')
    expect(ev.payload).toMatchObject({ before: { status: 'declined' }, after: { status: 'pending', respondedAt: null }, n: 2 })
    // the second answer uses round 2
    t.domain.respondToRequest(t.as(t.wife), item.id, 'accept')
    expect(byKey(t, item.id)[`request_answered:${item.id}:accept:2`]).toBeDefined()
  })

  it('declined -> in_progress is invalid; declined -> done/dropped allowed', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    t.domain.respondToRequest(t.as(t.wife), item.id, 'decline')
    expect(code(() => t.domain.updateItem(t.as(t.husband), item.id, { status: 'in_progress' }))).toBe('invalid')
    expect(code(() => t.domain.updateItem(t.as(t.wife), item.id, { status: 'accepted' }))).toBe('invalid')
    expect(t.domain.updateItem(t.as(t.husband), item.id, { status: 'dropped' }).status).toBe('dropped')
  })

  it('re-opening a closed request: owner may restart it; requester may re-send', () => {
    const t = createTestContext()
    const { item } = sendSaturdayRequest(t)
    t.domain.respondToRequest(t.as(t.wife), item.id, 'accept')
    t.domain.completeItem(t.as(t.wife), item.id)
    expect(code(() => t.domain.updateItem(t.as(t.husband), item.id, { status: 'in_progress' }))).toBe('forbidden')
    const back = t.domain.updateItem(t.as(t.wife), item.id, { status: 'in_progress' })
    expect([back.status, back.completedAt]).toEqual(['in_progress', null])
  })

  it('re-routing a pending request to someone else asks them (new round)', () => {
    const t = createTestContext()
    const grandma = t.domain.createMember({ name: '外婆', role: 'relative' })
    const { item } = sendSaturdayRequest(t)
    const moved = t.domain.updateItem(t.as(t.husband), item.id, { ownerId: grandma.id })
    expect([moved.ownerId, moved.status]).toEqual([grandma.id, 'pending'])
    const rows = byKey(t, item.id)
    expect(rows[`request_followup:${item.id}:1`]!.status).toBe('cancelled')
    expect(rows[`request_new:${item.id}:2`]).toMatchObject({ status: 'scheduled', memberId: grandma.id })
    expect(rows[`due:${item.id}:${item.dueAt}`]!.memberId).toBe(grandma.id)
    expect(code(() => t.domain.respondToRequest(t.as(t.wife), item.id, 'accept'))).toBe('forbidden')
    expect(code(() => t.domain.updateItem(t.as(t.husband), item.id, { ownerId: t.husband.id }))).toBe('invalid')
  })

  it('reassigning an accepted request sends "assigned"', () => {
    const t = createTestContext()
    const grandma = t.domain.createMember({ name: '外婆', role: 'relative' })
    const { item } = sendSaturdayRequest(t)
    t.domain.respondToRequest(t.as(t.wife), item.id, 'accept')
    t.domain.updateItem(t.as(t.wife), item.id, { ownerId: grandma.id })
    const assigned = t.outbox.listForItem(item.id).find(n => n.kind === 'assigned')!
    expect(assigned).toMatchObject({ memberId: grandma.id, title: '老婆交给你：带孩子出去' })
    expect(t.domain.getItem(item.id)!.status).toBe('accepted')
  })
})
