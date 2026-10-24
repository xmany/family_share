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
function statusOfKey(t: TestContext, key: string): string | undefined {
  return (t.db.prepare('SELECT status FROM notifications WHERE dedupe_key = ?').get(key) as { status: string } | undefined)?.status
}
function count(t: TestContext, sql: string, ...params: unknown[]): number {
  return (t.db.prepare(sql).get(...params) as { n: number }).n
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

describe('undoUtterance: creation', () => {
  it('deletes an item nobody else touched, with its notes and notifications', () => {
    const t = createTestContext()
    const { u, actor } = say(t, 'husband', '周六早上你能带孩子出去吗？')
    const req = t.domain.sendRequest(actor, { toMemberId: t.wife.id, title: '带孩子出去', dueAt: iso('2026-10-24', '08:30') })
    t.domain.addNote(actor, req.id, '记得带水')
    t.domain.finishUtterance(u.id, { status: 'done', reply: '好的，已经问老婆了' })
    // a delivered notification with a delivery record must not block deletion
    const neu = t.outbox.listForItem(req.id).find(n => n.kind === 'request_new')!
    t.outbox.markSent(neu.id)
    t.outbox.recordDelivery(neu.id, 'webpush', true)
    t.events.length = 0

    const res = t.domain.undoUtterance(t.as(t.husband), u.id)
    expect(res.utterance.status).toBe('undone')
    expect(res.items).toEqual([])
    expect(t.domain.getItem(req.id)).toBeNull()
    expect(count(t, 'SELECT COUNT(*) AS n FROM notes WHERE item_id = ?', req.id)).toBe(0)
    expect(count(t, 'SELECT COUNT(*) AS n FROM notifications WHERE item_id = ?', req.id)).toBe(0)
    // the utterance still lists what it did (now with itemId null but the title kept)
    expect(res.utterance.changes.map(c => [c.type, c.itemId, c.itemTitle])).toEqual([
      ['request_sent', null, '带孩子出去'],
      ['note_added', null, '带孩子出去'],
    ])
    const undone = t.domain.recentEvents(1)[0]!
    expect(undone).toMatchObject({ type: 'undone', utteranceId: null, memberId: t.husband.id, summary: '撤销：周六早上你能带孩子出去吗？' })
    expect(undone.payload).toMatchObject({ deletedItemIds: [req.id], droppedItemIds: [] })
    expect(count(t, 'SELECT COUNT(*) AS n FROM events WHERE utterance_id = ? AND undone = 1', u.id)).toBe(2)
    expect(t.events).toContainEqual({ type: 'board_changed', itemIds: [req.id], utteranceId: u.id, byMemberId: t.husband.id })
    expect(t.events.some(e => e.type === 'utterance' && e.utterance.status === 'undone')).toBe(true)
  })

  it('drops (not deletes) an item someone else has acted on since, cancelling its scheduled rows', () => {
    const t = createTestContext()
    const { u, actor } = say(t, 'husband', '你周六能带孩子出去吗')
    const req = t.domain.sendRequest(actor, { toMemberId: t.wife.id, title: '带孩子出去', dueAt: iso('2026-10-24', '08:30') })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    const res = t.domain.undoUtterance(t.as(t.husband), u.id)
    expect(res.items.map(i => [i.id, i.status])).toEqual([[req.id, 'dropped']])
    expect(t.outbox.scheduledForItem(req.id)).toEqual([])
    expect(t.domain.recentEvents(1)[0]!.payload).toMatchObject({ deletedItemIds: [], droppedItemIds: [req.id] })
    expect(t.domain.recentEvents(1)[0]!.itemId).toBe(req.id)
  })

  it('an item that later got a child from another utterance is dropped, not deleted', () => {
    const t = createTestContext()
    const a = say(t, 'husband', '搬家')
    const parent = t.domain.createItem(a.actor, { kind: 'task', title: '搬家' })
    const b = say(t, 'wife', '搬家要先订搬家公司')
    const child = t.domain.createItem(b.actor, { kind: 'task', title: '订搬家公司', parentId: parent.id })
    t.domain.undoUtterance(t.as(t.husband), a.u.id)
    expect(t.domain.getItem(parent.id)!.status).toBe('dropped')
    expect(t.domain.getItem(child.id)!.status).toBe('open')
  })

  it('changes by a later utterance that was itself undone do not prevent deletion', () => {
    const t = createTestContext()
    const a = say(t, 'husband', '买地毯')
    const item = t.domain.createItem(a.actor, { kind: 'task', title: '买地毯' })
    const b = say(t, 'wife', '地毯周六买')
    t.domain.updateItem(b.actor, item.id, { dueDate: '2026-10-24' })
    t.domain.undoUtterance(t.as(t.wife), b.u.id)
    t.domain.undoUtterance(t.as(t.husband), a.u.id)
    expect(t.domain.getItem(item.id)).toBeNull()
    expect(t.domain.getUtterance(b.u.id)!.changes.map(c => [c.itemId, c.itemTitle])).toEqual([[null, '买地毯']])
  })

  it('a reminder set with the creation is cancelled/deleted too', () => {
    const t = createTestContext()
    const { u, actor } = say(t, 'wife', '下午五点提醒我取快递')
    const task = t.domain.createItem(actor, { kind: 'task', title: '取快递', remindAt: iso('2026-10-21', '17:00') })
    const free = t.domain.setReminder(actor, { memberId: t.husband.id, fireAt: iso('2026-10-21', '18:00'), message: '买牛奶' })
    t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(t.domain.getItem(task.id)).toBeNull()
    expect(t.outbox.get(free.id)!.status).toBe('cancelled')
  })
})

describe('undoUtterance: changes', () => {
  it('restores the before-state and the old due rows, cancelling the new ones', () => {
    const t = createTestContext()
    const t1 = iso('2026-10-22', '15:00')
    const t2 = iso('2026-10-23', '15:00')
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修水管', dueAt: t1 })
    const { u, actor } = say(t, 'husband', '修水管改到周五，交给老婆')
    t.domain.updateItem(actor, item.id, { dueAt: t2, ownerId: t.wife.id, priority: 'high' })
    expect(statusOfKey(t, `due:${item.id}:${t2}`)).toBe('scheduled')
    expect(t.outbox.listForItem(item.id).some(n => n.kind === 'assigned' && n.status === 'scheduled')).toBe(true)

    t.clock.advance(10 * MINUTE)
    const res = t.domain.undoUtterance(t.as(t.husband), u.id)
    const back = res.items[0]!
    expect([back.dueAt, back.ownerId, back.priority]).toEqual([t1, t.husband.id, 'normal'])
    expect(back.lastActivityAt).toBe('2026-10-21T01:10:00.000Z')
    expect(statusOfKey(t, `due:${item.id}:${t2}`)).toBe('cancelled')
    expect(t.outbox.scheduledForItem(item.id).map(n => [n.dedupeKey, n.memberId])).toEqual([[`due:${item.id}:${t1}`, t.husband.id]])
    expect(t.outbox.listForItem(item.id).find(n => n.kind === 'assigned')!.status).toBe('cancelled')
  })

  it('only reverts fields that still have the value the utterance set', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '卖柜子', dueDate: '2026-10-25' })
    const { u, actor } = say(t, 'husband', '卖柜子改名叫卖旧柜子，周六之前')
    t.domain.updateItem(actor, item.id, { title: '卖旧柜子', dueDate: '2026-10-24' })
    // the wife renames it afterwards
    t.domain.updateItem(t.as(t.wife), item.id, { title: '卖旧衣柜' })
    const res = t.domain.undoUtterance(t.as(t.husband), u.id)
    expect(res.items[0]).toMatchObject({ title: '卖旧衣柜', dueDate: '2026-10-25' })
    const payload = t.domain.recentEvents(1)[0]!.payload as { reverted: { fields: string[] }[]; skipped: { fields: string[] }[] }
    expect(payload.reverted[0]!.fields).toEqual(['dueDate'])
    expect(payload.skipped[0]!.fields).toEqual(['title'])
    expect(t.outbox.scheduledForItem(item.id).map(n => n.dedupeKey)).toEqual([`due:${item.id}:2026-10-25`])
  })

  it('undoing a completion re-opens the item and brings back its reminders', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '交水费', dueAt: iso('2026-10-22', '15:00') })
    const rem = t.domain.setReminder(t.as(t.wife), { itemId: item.id, memberId: t.wife.id, fireAt: iso('2026-10-22', '10:00'), message: '交水费' })
    const { u, actor } = say(t, 'wife', '水费交了')
    t.domain.completeItem(actor, item.id, '网上交的')
    expect(t.outbox.scheduledForItem(item.id)).toEqual([])
    const res = t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(res.items[0]).toMatchObject({ status: 'open', completedAt: null })
    expect(t.domain.listNotes(item.id)).toEqual([])
    expect(t.outbox.get(rem.id)!.status).toBe('scheduled')
    expect(t.outbox.scheduledForItem(item.id).map(n => n.dedupeKey).sort()).toEqual(
      [`due:${item.id}:${iso('2026-10-22', '15:00')}`, `explicit:${item.id}:${t.wife.id}:${iso('2026-10-22', '10:00')}`].sort(),
    )
  })

  it('undoing an AI accept puts the request back to pending with its follow-ups', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    const { u, actor } = say(t, 'wife', '好的我带')
    t.domain.respondToRequest(actor, req.id, 'accept')
    const answered = t.outbox.listForItem(req.id).find(n => n.kind === 'request_answered')!
    const res = t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(res.items[0]).toMatchObject({ status: 'pending', respondedAt: null })
    expect(t.outbox.get(answered.id)!.status).toBe('cancelled')
    expect(statusOfKey(t, `request_followup:${req.id}:1`)).toBe('scheduled')
    expect(statusOfKey(t, `request_noreply:${req.id}:1`)).toBe('scheduled')
    // and the owner can answer again
    expect(t.domain.respondToRequest(t.as(t.wife), req.id, 'decline').status).toBe('declined')
  })

  it('does not restore follow-ups whose time has passed', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    const { u, actor } = say(t, 'wife', '好的')
    t.domain.respondToRequest(actor, req.id, 'accept')
    t.clock.advance(3 * HOUR) // past the 120-min follow-up, before the 360-min no-reply
    t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(statusOfKey(t, `request_followup:${req.id}:1`)).toBe('cancelled')
    expect(statusOfKey(t, `request_noreply:${req.id}:1`)).toBe('scheduled')
  })

  it('undo of a re-send returns the request to declined and cancels round 2', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'decline')
    const { u, actor } = say(t, 'husband', '再问问她')
    t.domain.updateItem(actor, req.id, { status: 'pending' })
    expect(statusOfKey(t, `request_new:${req.id}:2`)).toBe('scheduled')
    const res = t.domain.undoUtterance(t.as(t.husband), u.id)
    expect(res.items[0]!.status).toBe('declined')
    expect(statusOfKey(t, `request_new:${req.id}:2`)).toBe('cancelled')
    // the re-send cancelled the undelivered "declined" notice; the requester who re-sent already knew
    expect(t.outbox.scheduledForItem(req.id)).toEqual([])
  })

  it('undo of a snooze restores snoozedUntil/snoozeCount and cancels the snooze ping', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '卖旧柜子' })
    const { u, actor } = say(t, 'husband', '柜子明天再说')
    const until = zonedToUtc('2026-10-22', '09:00', TZ)
    t.domain.snoozeItem(actor, item.id, until)
    const res = t.domain.undoUtterance(t.as(t.husband), u.id)
    expect(res.items[0]).toMatchObject({ snoozedUntil: null, snoozeCount: 0 })
    expect(t.outbox.scheduledForItem(item.id)).toEqual([])
  })

  it('undo of cancelReminder re-schedules the reminder', () => {
    const t = createTestContext()
    const rem = t.domain.setReminder(t.as(t.wife), { memberId: t.wife.id, fireAt: iso('2026-10-22', '10:00'), message: '吃药' })
    const { u, actor } = say(t, 'wife', '不用提醒我吃药了')
    t.domain.cancelReminder(actor, rem.id)
    expect(t.outbox.get(rem.id)!.status).toBe('cancelled')
    t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(t.outbox.get(rem.id)!.status).toBe('scheduled')
  })

  it('an utterance that changed nothing can still be marked undone', () => {
    const t = createTestContext()
    const { u } = say(t, 'wife', '你好')
    const res = t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(res).toMatchObject({ utterance: { status: 'undone', changes: [] }, items: [] })
  })
})

describe('undoUtterance: permissions', () => {
  it('the speaker or any adult may undo; others may not; twice is a conflict', () => {
    const t = createTestContext()
    const kid = t.domain.createMember({ name: '小宝', role: 'kid' })
    const { u, actor } = say(t, 'husband', '买地毯')
    t.domain.createItem(actor, { kind: 'task', title: '买地毯' })
    expect(code(() => t.domain.undoUtterance(t.as(kid), u.id))).toBe('forbidden')
    expect(code(() => t.domain.undoUtterance({ type: 'system', memberId: null }, u.id))).toBe('forbidden')
    expect(code(() => t.domain.undoUtterance(t.as(t.wife), 'u_missing'))).toBe('not_found')
    expect(t.domain.undoUtterance(t.as(t.wife), u.id).utterance.status).toBe('undone')
    expect(code(() => t.domain.undoUtterance(t.as(t.husband), u.id))).toBe('conflict')

    const kidU = t.domain.createUtterance(kid.id, 'text', '我要吃冰淇淋')
    t.domain.createItem(t.asAi(kid, kidU.id), { kind: 'idea', title: '吃冰淇淋' })
    expect(t.domain.undoUtterance(t.as(kid), kidU.id).utterance.status).toBe('undone')
  })

  it('finishing an utterance that was undone mid-flight keeps it undone', () => {
    const t = createTestContext()
    const { u } = say(t, 'wife', '买菜')
    t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(t.domain.finishUtterance(u.id, { status: 'done', reply: '好的' }).status).toBe('undone')
  })
})
