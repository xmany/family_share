import { describe, expect, it } from 'vitest'
import type { ScheduledNotification } from '../../shared/types'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { DAY, HOUR, MINUTE, zonedToUtc } from '../time'
import { DomainError } from './types'

const TZ = 'Australia/Sydney'
const iso = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString()

function rows(t: TestContext, itemId: string): ScheduledNotification[] {
  return t.outbox.listForItem(itemId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.dedupeKey.localeCompare(b.dedupeKey))
}
function scheduled(t: TestContext, itemId: string): string[] {
  return t.outbox
    .scheduledForItem(itemId)
    .map(n => n.dedupeKey)
    .sort()
}
function statusOf(t: TestContext, key: string): string | undefined {
  const r = t.db.prepare('SELECT status FROM notifications WHERE dedupe_key = ?').get(key) as { status: string } | undefined
  return r?.status
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

describe('createItem', () => {
  it('creates an open task owned by the actor with an item_created event', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '  买地毯  ', details: '客厅用' })
    expect(item).toMatchObject({
      kind: 'task',
      title: '买地毯',
      details: '客厅用',
      status: 'open',
      ownerId: t.husband.id,
      createdBy: t.husband.id,
      requestedBy: null,
      priority: 'normal',
      tags: [],
      snoozeCount: 0,
      createdAt: '2026-10-21T01:00:00.000Z',
      lastActivityAt: '2026-10-21T01:00:00.000Z',
      remindAt: null,
    })
    const detail = t.domain.getItemDetail(item.id)!
    expect(detail.events).toHaveLength(1)
    expect(detail.events[0]).toMatchObject({ type: 'item_created', summary: '新建待办：买地毯', actorType: 'member', memberId: t.husband.id })
    expect(detail.events[0]!.payload).toMatchObject({ before: null, created: true, after: { title: '买地毯', status: 'open' } })
    // no notification for your own undated task
    expect(rows(t, item.id)).toEqual([])
    expect(t.events).toEqual([{ type: 'board_changed', itemIds: [item.id], byMemberId: t.husband.id }])
  })

  it('ideas default to unowned; tasks for someone else notify them (assigned)', () => {
    const t = createTestContext()
    const idea = t.domain.createItem(t.as(t.husband), { kind: 'idea', title: '去日本玩' })
    expect(idea.ownerId).toBeNull()
    const task = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯', ownerId: t.wife.id, dueDate: '2026-10-23' })
    const [assigned, due] = [rows(t, task.id).find(n => n.kind === 'assigned')!, rows(t, task.id).find(n => n.kind === 'due')!]
    const ev = t.domain.getItemDetail(task.id)!.events[0]!
    expect(ev.summary).toBe('新建待办 → 老婆：买地毯（后天）')
    expect(assigned).toMatchObject({
      memberId: t.wife.id,
      title: '老公交给你：买地毯',
      dedupeKey: `assigned:${task.id}:${t.wife.id}:${ev.id}`,
      fireAt: '2026-10-21T01:00:00.000Z',
      respectQuietHours: true,
      url: `/item/${task.id}`,
    })
    expect(due).toMatchObject({ memberId: t.wife.id, dedupeKey: `due:${task.id}:2026-10-23`, fireAt: iso('2026-10-23', '09:00') })
  })

  it('plans due rows for a timed task and exposes the earliest as remindAt', () => {
    const t = createTestContext()
    const dueAt = iso('2026-10-24', '08:30')
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '带孩子游泳', dueAt: '2026-10-24T08:30:00+11:00' })
    expect(item.dueAt).toBe(dueAt)
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${dueAt}`, `due_eve:${item.id}:${dueAt}`].sort())
    expect(item.remindAt).toBe(iso('2026-10-23', '20:00'))
  })

  it('reads a local datetime without offset in the family timezone', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: 'x', dueAt: '2026-10-24T08:30' })
    expect(item.dueAt).toBe(iso('2026-10-24', '08:30'))
  })

  it('kind reminder pings exactly at dueAt; remindAt adds an explicit reminder', () => {
    const t = createTestContext()
    const r = t.domain.createItem(t.as(t.wife), { kind: 'reminder', title: '交水费', dueAt: iso('2026-10-21', '23:00') })
    expect(rows(t, r.id).map(n => [n.kind, n.dedupeKey, n.fireAt, n.respectQuietHours])).toEqual([
      ['explicit', `reminder:${r.id}:${iso('2026-10-21', '23:00')}`, iso('2026-10-21', '23:00'), false],
    ])
    const task = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '取快递', remindAt: iso('2026-10-21', '17:00') })
    const ex = rows(t, task.id)
    expect(ex.map(n => [n.kind, n.dedupeKey, n.memberId])).toEqual([['explicit', `explicit:${task.id}:${t.wife.id}:${iso('2026-10-21', '17:00')}`, t.wife.id]])
    expect(t.domain.getItemDetail(task.id)!.events.map(e => e.type)).toEqual(['item_created', 'reminder_set'])
    expect(task.remindAt).toBe(iso('2026-10-21', '17:00'))
  })

  it('validates input', () => {
    const t = createTestContext()
    const a = t.as(t.husband)
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: '   ' }), 'invalid', /标题/)
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: 'x'.repeat(201) }), 'invalid', /太长/)
    expect(t.domain.createItem(a, { kind: 'task', title: 'x'.repeat(200) }).title).toHaveLength(200)
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: 'x', details: 'y'.repeat(2001) }), 'invalid')
    expectDomainError(() => t.domain.createItem(a, { kind: 'request', title: 'x' }), 'invalid', /send_request/)
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: 'x', ownerId: 'm_nobody' }), 'invalid', /成员/)
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: 'x', ownerId: null }), 'invalid')
    expectDomainError(
      () => t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: iso('2026-10-22', '09:00'), dueDate: '2026-10-22' }),
      'invalid',
      /只能设一个/,
    )
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: '2026-10-22' }), 'invalid', /dueDate/)
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: 'x', dueAt: 'tomorrow' }), 'invalid')
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: 'x', dueDate: '2026-02-30' }), 'invalid')
    expectDomainError(() => t.domain.createItem(a, { kind: 'idea', title: 'x', dueDate: '2026-10-30' }), 'invalid', /想法/)
    expectDomainError(() => t.domain.createItem(a, { kind: 'task', title: 'x', remindAt: iso('2026-10-21', '11:00') }), 'invalid')
    expectDomainError(() => t.domain.createItem({ type: 'member', memberId: 'm_ghost' }, { kind: 'task', title: 'x' }), 'invalid')
    expectDomainError(() => t.domain.createItem({ type: 'system', memberId: null }, { kind: 'task', title: 'x' }), 'invalid')
    expect(t.domain.listActiveItems()).toHaveLength(1)
  })
})

describe('updateItem', () => {
  it('records only changed fields in before/after and bumps activity', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '卖旧柜子', priority: 'low' })
    t.clock.advance(10 * MINUTE)
    const u = t.domain.updateItem(t.as(t.husband), item.id, { title: '卖旧柜子', priority: 'high', details: '挂闲鱼' }, '她说要快点')
    expect(u.priority).toBe('high')
    expect(u.lastActivityAt).toBe('2026-10-21T01:10:00.000Z')
    expect(u.updatedAt).toBe('2026-10-21T01:10:00.000Z')
    const ev = t.domain.getItemDetail(item.id)!.events[1]!
    expect(ev.type).toBe('item_updated')
    expect(ev.payload).toEqual({
      before: { details: null, priority: 'low' },
      after: { details: '挂闲鱼', priority: 'high' },
      reason: '她说要快点',
    })
    expect(ev.summary).toBe('卖旧柜子：更新说明，优先级 → 高')
  })

  it('is a no-op (no event, no broadcast) when nothing changes', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯' })
    t.events.length = 0
    t.domain.updateItem(t.as(t.husband), item.id, { title: '买地毯', status: 'open' })
    expect(t.domain.getItemDetail(item.id)!.events).toHaveLength(1)
    expect(t.events).toEqual([])
  })

  it('status change: "卖旧柜子：待办 → 进行中"', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '卖旧柜子' })
    t.domain.updateItem(t.asAi(t.husband, t.domain.createUtterance(t.husband.id, 'text', '柜子挂出去了').id), item.id, { status: 'in_progress' })
    const ev = t.domain.getItemDetail(item.id)!.events[1]!
    expect(ev).toMatchObject({ type: 'status_changed', summary: '卖旧柜子：待办 → 进行中', actorType: 'ai' })
    expect(ev.payload).toEqual({ before: { status: 'open' }, after: { status: 'in_progress' } })
  })

  it('dueAt and dueDate are mutually exclusive', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: 'x', dueDate: '2026-10-23' })
    const a = t.domain.updateItem(t.as(t.husband), item.id, { dueAt: iso('2026-10-23', '15:00') })
    expect([a.dueAt, a.dueDate]).toEqual([iso('2026-10-23', '15:00'), null])
    const b = t.domain.updateItem(t.as(t.husband), item.id, { dueDate: '2026-10-24' })
    expect([b.dueAt, b.dueDate]).toEqual([null, '2026-10-24'])
    expectDomainError(() => t.domain.updateItem(t.as(t.husband), item.id, { dueAt: iso('2026-10-23', '15:00'), dueDate: '2026-10-24' }), 'invalid')
    const c = t.domain.updateItem(t.as(t.husband), item.id, { dueDate: null })
    expect([c.dueAt, c.dueDate]).toEqual([null, null])
    expect(t.domain.getItemDetail(item.id)!.events.at(-1)!.summary).toBe('x：去掉时间')
  })

  it('changing timing cancels the old due rows and plans new ones; changing back revives them', () => {
    const t = createTestContext()
    const t1 = iso('2026-10-22', '15:00')
    const t2 = iso('2026-10-23', '15:00')
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修水管', dueAt: t1 })
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${t1}`])
    t.domain.updateItem(t.as(t.husband), item.id, { dueAt: t2 })
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${t2}`])
    expect(statusOf(t, `due:${item.id}:${t1}`)).toBe('cancelled')
    // re-planning the same key is harmless and brings the cancelled row back
    t.domain.updateItem(t.as(t.husband), item.id, { dueAt: t1 })
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${t1}`])
    expect(rows(t, item.id)).toHaveLength(2) // no duplicate rows
    t.domain.updateItem(t.as(t.husband), item.id, { dueDate: '2026-10-25' })
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:2026-10-25`])
  })

  it('re-enqueue with the same dedupe key never duplicates (title edits refresh the text)', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修水管', dueAt: iso('2026-10-22', '15:00') })
    t.domain.updateItem(t.as(t.husband), item.id, { title: '修厨房水管' })
    t.domain.updateItem(t.as(t.husband), item.id, { details: '找物业' })
    const r = rows(t, item.id)
    expect(r).toHaveLength(1)
    expect(r[0]!.title).toBe('快到时间：修厨房水管')
    expect(r[0]!.body).toContain('找物业')
  })

  it('reassignment notifies the new owner and moves due rows to them', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买菜', dueDate: '2026-10-22' })
    expect(t.outbox.scheduledForItem(item.id)[0]!.memberId).toBe(t.husband.id)
    const u = t.domain.updateItem(t.as(t.husband), item.id, { ownerId: t.wife.id })
    expect(u.ownerId).toBe(t.wife.id)
    const ev = t.domain.getItemDetail(item.id)!.events.at(-1)!
    expect(ev).toMatchObject({ type: 'item_reassigned', summary: '转给老婆：买菜' })
    expect(ev.payload).toEqual({ before: { ownerId: t.husband.id }, after: { ownerId: t.wife.id } })
    const sched = t.outbox.scheduledForItem(item.id)
    expect(sched.map(n => [n.kind, n.memberId]).sort()).toEqual([
      ['assigned', t.wife.id],
      ['due', t.wife.id],
    ])
    expect(sched.find(n => n.kind === 'assigned')!.dedupeKey).toBe(`assigned:${item.id}:${t.wife.id}:${ev.id}`)
    // taking it yourself: no notification to yourself
    t.domain.updateItem(t.as(t.husband), item.id, { ownerId: t.husband.id })
    expect(t.outbox.listForItem(item.id).filter(n => n.kind === 'assigned' && n.memberId === t.husband.id)).toEqual([])
  })

  it('complete == updateItem(status done): completedAt, cancels everything scheduled', () => {
    for (const via of ['complete', 'update'] as const) {
      const t = createTestContext()
      const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯', ownerId: t.wife.id, dueAt: iso('2026-10-24', '08:30') })
      t.domain.setReminder(t.as(t.husband), { itemId: item.id, memberId: t.wife.id, fireAt: iso('2026-10-22', '18:00'), message: '记得买地毯' })
      expect(scheduled(t, item.id)).toHaveLength(4)
      t.clock.advance(HOUR)
      const done =
        via === 'complete'
          ? t.domain.completeItem(t.as(t.wife), item.id, '买好了，宜家')
          : t.domain.updateItem(t.as(t.wife), item.id, { status: 'done' })
      expect(done.status).toBe('done')
      expect(done.completedAt).toBe('2026-10-21T02:00:00.000Z')
      expect(done.remindAt).toBeNull()
      expect(scheduled(t, item.id)).toEqual([])
      const ev = t.domain.getItemDetail(item.id)!.events.at(-1)!
      expect(ev.type).toBe('item_completed')
      expect(ev.summary).toBe('完成：买地毯')
      expect(ev.payload.before).toEqual({ status: 'open', completedAt: null })
      expect(ev.payload.after).toEqual({ status: 'done', completedAt: '2026-10-21T02:00:00.000Z' })
      if (via === 'complete') expect(t.domain.listNotes(item.id).map(n => n.text)).toEqual(['买好了，宜家'])
    }
  })

  it('completing twice is harmless', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯' })
    t.domain.completeItem(t.as(t.husband), item.id)
    const again = t.domain.completeItem(t.as(t.husband), item.id)
    expect(again.status).toBe('done')
    expect(t.domain.getItemDetail(item.id)!.events.map(e => e.type)).toEqual(['item_created', 'item_completed'])
  })

  it('drop cancels scheduled rows; re-opening clears completedAt and re-plans', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修水管', dueAt: iso('2026-10-22', '15:00') })
    t.domain.setReminder(t.as(t.husband), { itemId: item.id, memberId: t.husband.id, fireAt: iso('2026-10-22', '10:00'), message: '先打电话' })
    const dropped = t.domain.updateItem(t.as(t.husband), item.id, { status: 'dropped' })
    expect(dropped.completedAt).toBe('2026-10-21T01:00:00.000Z')
    expect(scheduled(t, item.id)).toEqual([])
    expect(t.domain.getItemDetail(item.id)!.events.at(-1)!.summary).toBe('不做了：修水管')
    const reopened = t.domain.updateItem(t.as(t.husband), item.id, { status: 'open' })
    expect(reopened.completedAt).toBeNull()
    expect(scheduled(t, item.id)).toEqual([`due:${item.id}:${iso('2026-10-22', '15:00')}`, `explicit:${item.id}:${t.husband.id}:${iso('2026-10-22', '10:00')}`])
  })

  it('kind conversions task <-> idea <-> reminder; never to/from request', () => {
    const t = createTestContext()
    const a = t.as(t.husband)
    const task = t.domain.createItem(a, { kind: 'task', title: '装修厨房', dueDate: '2026-11-01' })
    const idea = t.domain.updateItem(a, task.id, { kind: 'idea' })
    expect([idea.kind, idea.dueDate, idea.ownerId]).toEqual(['idea', null, t.husband.id])
    expect(scheduled(t, task.id)).toEqual([])
    expectDomainError(() => t.domain.updateItem(a, task.id, { dueDate: '2026-11-01' }), 'invalid', /想法/)
    const unowned = t.domain.updateItem(a, task.id, { ownerId: null })
    expect(unowned.ownerId).toBeNull()
    const back = t.domain.updateItem(t.as(t.wife), task.id, { kind: 'task', dueDate: '2026-11-02' })
    expect([back.kind, back.ownerId, back.dueDate]).toEqual(['task', t.wife.id, '2026-11-02'])
    const rem = t.domain.updateItem(a, task.id, { kind: 'reminder' })
    expect(rem.kind).toBe('reminder')
    expect(scheduled(t, task.id)).toEqual([`reminder:${task.id}:2026-11-02`])
    expectDomainError(() => t.domain.updateItem(a, task.id, { kind: 'request' as never }), 'invalid')
    const req = t.domain.sendRequest(a, { toMemberId: t.wife.id, title: '带孩子出去' })
    expectDomainError(() => t.domain.updateItem(a, req.id, { kind: 'task' }), 'invalid', /请求不能改/)
    expectDomainError(() => t.domain.updateItem(a, task.id, { ownerId: null }), 'invalid')
  })

  it('tasks only accept task statuses', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: 'x' })
    for (const s of ['pending', 'accepted', 'declined'] as const) {
      expectDomainError(() => t.domain.updateItem(t.as(t.husband), item.id, { status: s }), 'invalid', /没有/)
    }
    expectDomainError(() => t.domain.updateItem(t.as(t.husband), item.id, { status: 'nope' as never }), 'invalid')
    for (const s of ['in_progress', 'blocked', 'open', 'done', 'in_progress'] as const) {
      expect(t.domain.updateItem(t.as(t.husband), item.id, { status: s }).status).toBe(s)
    }
  })

  it('unknown item ids are not_found', () => {
    const t = createTestContext()
    expectDomainError(() => t.domain.updateItem(t.as(t.husband), 'i_missing', { title: 'x' }), 'not_found')
    expectDomainError(() => t.domain.completeItem(t.as(t.husband), 'i_missing'), 'not_found')
    expectDomainError(() => t.domain.addNote(t.as(t.husband), 'i_missing', 'x'), 'not_found')
    expect(t.domain.getItem('i_missing')).toBeNull()
    expect(t.domain.getItemDetail('i_missing')).toBeNull()
  })

  it('validates parentId and tags', () => {
    const t = createTestContext()
    const parent = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '搬家' })
    const child = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '订搬家公司', parentId: parent.id, tags: [' 搬家 ', '搬家', ''] })
    expect(child.parentId).toBe(parent.id)
    expect(child.tags).toEqual(['搬家'])
    expectDomainError(() => t.domain.updateItem(t.as(t.husband), child.id, { parentId: child.id }), 'invalid')
    expectDomainError(() => t.domain.updateItem(t.as(t.husband), child.id, { parentId: 'i_nope' }), 'invalid')
  })
})

describe('addNote', () => {
  it('adds a note with an event and updates lastActivityAt', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '卖旧柜子' })
    t.clock.advance(DAY)
    const note = t.domain.addNote(t.as(t.wife), item.id, ' 挂出去了，80块，周日可能有人来拿 ')
    expect(note).toMatchObject({ itemId: item.id, authorType: 'member', memberId: t.wife.id, text: '挂出去了，80块，周日可能有人来拿' })
    const detail = t.domain.getItemDetail(item.id)!
    expect(detail.item.lastActivityAt).toBe('2026-10-22T01:00:00.000Z')
    expect(detail.notes).toHaveLength(1)
    expect(detail.events.at(-1)).toMatchObject({ type: 'note_added', summary: '备注（卖旧柜子）：挂出去了，80块，周日可能有人来拿' })
    expectDomainError(() => t.domain.addNote(t.as(t.wife), item.id, '  '), 'invalid')
    expectDomainError(() => t.domain.addNote(t.as(t.wife), item.id, 'x'.repeat(2001)), 'invalid')
  })
})

describe('snoozeItem', () => {
  it('sets snoozedUntil, counts, and plans the snooze reminder (superseding the previous one)', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '卖旧柜子' })
    const until1 = zonedToUtc('2026-10-21', '20:00', TZ)
    const s1 = t.domain.snoozeItem(t.as(t.husband), item.id, until1)
    expect([s1.snoozedUntil, s1.snoozeCount]).toEqual([until1.toISOString(), 1])
    expect(rows(t, item.id).map(n => [n.kind, n.dedupeKey, n.fireAt, n.memberId, n.respectQuietHours])).toEqual([
      ['due', `snooze:${item.id}:${until1.toISOString()}`, until1.toISOString(), t.husband.id, true],
    ])
    expect(rows(t, item.id)[0]!.actions.map(a => a.action)).toEqual(['done', 'snooze_tomorrow'])
    const ev = t.domain.getItemDetail(item.id)!.events.at(-1)!
    expect(ev).toMatchObject({ type: 'item_snoozed', summary: '推迟：卖旧柜子 → 今天 20:00' })
    expect(ev.payload).toEqual({ before: { snoozedUntil: null, snoozeCount: 0 }, after: { snoozedUntil: until1.toISOString(), snoozeCount: 1 } })
    const until2 = zonedToUtc('2026-10-22', '09:00', TZ)
    const s2 = t.domain.snoozeItem(t.as(t.husband), item.id, until2)
    expect(s2.snoozeCount).toBe(2)
    expect(scheduled(t, item.id)).toEqual([`snooze:${item.id}:${until2.toISOString()}`])
    expect(statusOf(t, `snooze:${item.id}:${until1.toISOString()}`)).toBe('cancelled')
  })

  it('rejects past times and closed items', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: 'x' })
    expectDomainError(() => t.domain.snoozeItem(t.as(t.husband), item.id, t.clock.now()), 'invalid', /将来/)
    t.domain.completeItem(t.as(t.husband), item.id)
    expectDomainError(() => t.domain.snoozeItem(t.as(t.husband), item.id, new Date(t.clock.now().getTime() + HOUR)), 'invalid')
  })
})

describe('setReminder / cancelReminder', () => {
  it('explicit reminders for a member, with or without an item', () => {
    const t = createTestContext()
    const fire = iso('2026-10-21', '23:30')
    const n = t.domain.setReminder(t.as(t.husband), { memberId: t.wife.id, fireAt: fire, message: '吃药' })
    expect(n).toMatchObject({
      memberId: t.wife.id,
      itemId: null,
      kind: 'explicit',
      fireAt: fire,
      title: '提醒：吃药',
      dedupeKey: `explicit:${t.wife.id}:${fire}`,
      respectQuietHours: false,
      status: 'scheduled',
    })
    const ev = t.domain.recentEvents(1)[0]!
    expect(ev).toMatchObject({ type: 'reminder_set', itemId: null, summary: '设提醒 → 老婆：吃药（今天 23:30）' })
    t.domain.cancelReminder(t.as(t.wife), n.id)
    expect(t.outbox.get(n.id)!.status).toBe('cancelled')
    expect(t.domain.recentEvents(1)[0]).toMatchObject({ type: 'reminder_cancelled', summary: '取消提醒：吃药（今天 23:30）' })
    expectDomainError(() => t.domain.cancelReminder(t.as(t.wife), n.id), 'invalid')
    expectDomainError(() => t.domain.cancelReminder(t.as(t.wife), 'nt_nope'), 'not_found')
  })

  it('setting the same reminder twice keeps one row', () => {
    const t = createTestContext()
    const fire = iso('2026-10-22', '08:00')
    const a = t.domain.setReminder(t.as(t.wife), { memberId: t.wife.id, fireAt: fire, message: '吃药' })
    const b = t.domain.setReminder(t.as(t.wife), { memberId: t.wife.id, fireAt: fire, message: '吃药' })
    expect(b.id).toBe(a.id)
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n).toBe(1)
  })

  it('validates time, member and kind', () => {
    const t = createTestContext()
    expectDomainError(() => t.domain.setReminder(t.as(t.husband), { memberId: t.wife.id, fireAt: iso('2026-10-21', '11:00'), message: 'x' }), 'invalid')
    expectDomainError(() => t.domain.setReminder(t.as(t.husband), { memberId: 'm_x', fireAt: iso('2026-10-22', '11:00'), message: 'x' }), 'invalid')
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '修水管', dueAt: iso('2026-10-22', '15:00') })
    const due = t.outbox.scheduledForItem(item.id)[0]!
    expectDomainError(() => t.domain.cancelReminder(t.as(t.husband), due.id), 'invalid')
    const withItem = t.domain.setReminder(t.as(t.husband), { itemId: item.id, memberId: t.husband.id, fireAt: iso('2026-10-22', '10:00'), message: '' })
    expect(withItem.title).toBe('提醒：修水管')
    expect(withItem.actions.map(a => a.action)).toEqual(['done', 'open'])
  })
})

describe('bus', () => {
  it('broadcasts board_changed after commit with utterance and member', () => {
    const t = createTestContext()
    const u = t.domain.createUtterance(t.husband.id, 'text', '买地毯')
    t.events.length = 0
    const item = t.domain.createItem(t.asAi(t.husband, u.id), { kind: 'task', title: '买地毯' })
    expect(t.events).toEqual([{ type: 'board_changed', itemIds: [item.id], utteranceId: u.id, byMemberId: t.husband.id }])
    t.events.length = 0
    expect(() => t.domain.createItem(t.as(t.husband), { kind: 'task', title: '' })).toThrow()
    expect(t.events).toEqual([])
  })

  it('a failed write rolls back completely', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯' })
    expect(() => t.domain.updateItem(t.as(t.husband), item.id, { title: '新', status: 'pending' })).toThrow(DomainError)
    expect(t.domain.getItem(item.id)!.title).toBe('买地毯')
    expect(t.domain.getItemDetail(item.id)!.events).toHaveLength(1)
  })
})
