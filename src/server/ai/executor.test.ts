// Tool → Domain mapping against a real in-memory domain (createTestContext: Wed 2026-10-21 12:00 Sydney).
import { describe, expect, it } from 'vitest'
import type { Member } from '../../shared/types'
import { createTestContext, type TestContext } from '../testing'
import { executeCall, type ExecContext, type ToolOutcome } from './executor'
import { parseToolCall, type BoardCall } from './tools'

function setup(opts: { now?: string } = {}) {
  const t = createTestContext(opts)
  /** An executor context for an utterance by `speaker` (the AI actor needs a real utterance). */
  const ctxFor = (speaker: Member, text = '…'): ExecContext => {
    const u = t.domain.createUtterance(speaker.id, 'text', text)
    return { domain: t.domain, clock: t.clock, speaker, utteranceId: u.id, tz: t.family.timezone, members: t.domain.listMembers(), touched: new Set() }
  }
  const call = (ctx: ExecContext, name: string, input: Record<string, unknown>): ToolOutcome => {
    const parsed = parseToolCall(name, input)
    if (!parsed.ok) throw new Error(`test input invalid: ${parsed.message}`)
    return executeCall(parsed.call as BoardCall, ctx)
  }
  const ok = (o: ToolOutcome) => {
    if (!o.ok) throw new Error(`expected ok, got ${o.code}: ${o.message}`)
    return o.result as Record<string, unknown> & { item: { id: string } }
  }
  const notifications = (itemId: string) =>
    t.db.prepare('SELECT member_id, kind, fire_at, dedupe_key, status FROM notifications WHERE item_id = ? ORDER BY fire_at, dedupe_key').all(itemId) as Array<{
      member_id: string
      kind: string
      fire_at: string
      dedupe_key: string
      status: string
    }>
  return { t, ctxFor, call, ok, notifications }
}

const task = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'task',
  title,
  explicit_assignment: false,
  priority: 'normal',
  allow_duplicate: false,
  ...extra,
})

function eventUtterances(t: TestContext, itemId: string): Array<string | null> {
  return (t.db.prepare('SELECT utterance_id FROM events WHERE item_id = ? ORDER BY id').all(itemId) as { utterance_id: string | null }[]).map(r => r.utterance_id)
}

describe('create_item', () => {
  it('creates a task owned by the speaker, linked to the utterance, with a date-only due', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife, '明天买地毯')
    const r = ok(call(ctx, 'create_item', task('买地毯', { due_date: '2026-10-22' })))
    const item = t.domain.getItem(r.item.id)!
    expect(item).toMatchObject({ kind: 'task', title: '买地毯', ownerId: t.wife.id, createdBy: t.wife.id, dueDate: '2026-10-22', dueAt: null, status: 'open' })
    expect(r.item).toMatchObject({ owner: '老婆', due: '明天', status: 'open' })
    expect(eventUtterances(t, item.id)).toEqual([ctx.utteranceId])
    expect(ctx.touched.has(item.id)).toBe(true)
    expect(t.domain.getUtterance(ctx.utteranceId)!.changes).toEqual([expect.objectContaining({ type: 'item_created', itemId: item.id })])
  })

  it('converts a local date + time to the UTC instant in the family timezone', () => {
    const { t, ctxFor, call, ok } = setup()
    const r = ok(call(ctxFor(t.wife), 'create_item', task('取快递', { due_date: '2026-10-22', due_time: '18:30' })))
    // Sydney is UTC+11 (daylight time) in October
    expect(t.domain.getItem(r.item.id)!.dueAt).toBe('2026-10-22T07:30:00.000Z')
    expect(r.item).toMatchObject({ due: '明天 18:30' })
  })

  it('handles the April 2027 DST change (+11 → +10 on 2027-04-04)', () => {
    const { t, ctxFor, call, ok } = setup({ now: '2027-03-30T01:00:00.000Z' })
    const ctx = ctxFor(t.husband)
    const before = ok(call(ctx, 'create_item', task('交水费', { due_date: '2027-04-03', due_time: '10:00' })))
    const after = ok(call(ctx, 'create_item', task('看牙', { due_date: '2027-04-05', due_time: '10:00' })))
    expect(t.domain.getItem(before.item.id)!.dueAt).toBe('2027-04-02T23:00:00.000Z')
    expect(t.domain.getItem(after.item.id)!.dueAt).toBe('2027-04-05T00:00:00.000Z')
  })

  it('creates an unassigned idea when no owner is given', () => {
    const { t, ctxFor, call, ok } = setup()
    const r = ok(call(ctxFor(t.husband), 'create_item', task('去露营', { kind: 'idea' })))
    expect(t.domain.getItem(r.item.id)).toMatchObject({ kind: 'idea', ownerId: null })
  })

  it('enforces the owner rule: someone else only with explicit_assignment', () => {
    const { t, ctxFor, call, ok, notifications } = setup()
    const ctx = ctxFor(t.wife)
    const refused = call(ctx, 'create_item', task('修自行车', { owner_id: t.husband.id }))
    expect(refused).toMatchObject({ ok: false, code: 'use_send_request' })
    expect(t.domain.listActiveItems()).toHaveLength(0)

    const r = ok(call(ctx, 'create_item', task('修自行车', { owner_id: t.husband.id, explicit_assignment: true })))
    expect(t.domain.getItem(r.item.id)!.ownerId).toBe(t.husband.id)
    expect(notifications(r.item.id)).toEqual([expect.objectContaining({ member_id: t.husband.id, kind: 'assigned' })])
  })

  it('rejects reminders in the past and ideas with dates', () => {
    const { t, ctxFor, call } = setup()
    const ctx = ctxFor(t.wife)
    expect(call(ctx, 'create_item', task('吃药', { kind: 'reminder', due_date: '2026-10-21', due_time: '08:00' }))).toMatchObject({ ok: false, code: 'past_time' })
    // date-only reminders ping at 09:00, which already passed today
    expect(call(ctx, 'create_item', task('吃药', { kind: 'reminder', due_date: '2026-10-21' }))).toMatchObject({ ok: false, code: 'past_time' })
    expect(call(ctx, 'create_item', task('吃药', { kind: 'reminder' }))).toMatchObject({ ok: false, code: 'invalid' })
    expect(call(ctx, 'create_item', task('去日本', { kind: 'idea', due_date: '2026-12-01' }))).toMatchObject({ ok: false, code: 'invalid' })
    expect(call(ctx, 'create_item', task('取快递', { due_time: '18:00' }))).toMatchObject({ ok: false, code: 'invalid' })
    expect(t.domain.listActiveItems()).toHaveLength(0)
  })

  it('creates a reminder item that pings at the exact local time', () => {
    const { t, ctxFor, call, ok, notifications } = setup()
    const r = ok(call(ctxFor(t.wife), 'create_item', task('给外婆打电话', { kind: 'reminder', due_date: '2026-10-21', due_time: '20:00' })))
    expect(notifications(r.item.id)).toEqual([expect.objectContaining({ member_id: t.wife.id, kind: 'explicit', fire_at: '2026-10-21T09:00:00.000Z' })])
  })

  it('flags a past due time on a task but still creates it', () => {
    const { t, ctxFor, call, ok } = setup()
    const r = ok(call(ctxFor(t.wife), 'create_item', task('交表', { due_date: '2026-10-21', due_time: '09:00' })))
    expect(r.warning).toMatch(/已经过了/)
  })

  it('detects duplicates across Traditional/Simplified and punctuation unless allow_duplicate', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const first = ok(call(ctx, 'create_item', task('买牛奶')))
    const dup = call(ctx, 'create_item', task('買 牛奶！'))
    expect(dup).toMatchObject({ ok: false, code: 'possible_duplicate', extra: { candidates: [expect.objectContaining({ id: first.item.id })] } })
    ok(call(ctx, 'create_item', task('买牛奶', { allow_duplicate: true })))
    expect(t.domain.listActiveItems()).toHaveLength(2)
  })
})

describe('send_request', () => {
  it('sends a pending request to the other adult with the §3 notifications', () => {
    const { t, ctxFor, call, ok, notifications } = setup()
    const ctx = ctxFor(t.wife, '让老公明天下班顺路把牛奶买了')
    const r = ok(
      call(ctx, 'send_request', { to_member_id: t.husband.id, title: '买牛奶', due_date: '2026-10-22', due_time: '18:30', priority: 'normal', allow_duplicate: false }),
    )
    const item = t.domain.getItem(r.item.id)!
    expect(item).toMatchObject({ kind: 'request', status: 'pending', ownerId: t.husband.id, requestedBy: t.wife.id, dueAt: '2026-10-22T07:30:00.000Z' })
    expect(r).toMatchObject({ waiting_for: '老公', item: { owner: '老公', requested_by: '老婆', due: '明天 18:30' } })
    const rows = notifications(item.id)
    expect(rows.map(n => [n.kind, n.member_id === t.husband.id ? 'husband' : 'wife', n.dedupe_key.split(':')[0]])).toEqual(
      expect.arrayContaining([
        ['request_new', 'husband', 'request_new'],
        ['request_followup', 'husband', 'request_followup'],
        ['request_noreply', 'wife', 'request_noreply'],
        ['due', 'husband', 'due'],
      ]),
    )
    expect(rows.find(n => n.kind === 'request_new')!.dedupe_key).toBe(`request_new:${item.id}:1`)
    expect(t.domain.getUtterance(ctx.utteranceId)!.changes).toEqual([expect.objectContaining({ type: 'request_sent', itemId: item.id })])
  })

  it('refuses a request to the speaker', () => {
    const { t, ctxFor, call } = setup()
    expect(call(ctxFor(t.wife), 'send_request', { to_member_id: t.wife.id, title: '买牛奶', priority: 'normal', allow_duplicate: false })).toMatchObject({
      ok: false,
      code: 'invalid',
    })
  })

  it('turns the speaker\'s existing task into a request (the task is closed, one item per thing)', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const milk = ok(call(ctx, 'create_item', task('买牛奶', { due_date: '2026-10-22' })))
    const r = ok(call(ctx, 'send_request', { to_member_id: t.husband.id, title: '买牛奶', existing_item_id: milk.item.id, priority: 'normal', allow_duplicate: false }))
    expect(t.domain.getItem(r.item.id)).toMatchObject({ kind: 'request', ownerId: t.husband.id, dueDate: '2026-10-22' })
    expect(t.domain.getItem(milk.item.id)!.status).toBe('dropped')
    expect(r.replaced).toMatchObject({ id: milk.item.id, status: 'dropped' })
  })

  it('does not send a new request when that person already owns the item', () => {
    const { t, ctxFor, call, ok } = setup()
    const own = ok(call(ctxFor(t.husband), 'create_item', task('修车')))
    expect(call(ctxFor(t.wife), 'send_request', { to_member_id: t.husband.id, title: '修车', existing_item_id: own.item.id, priority: 'normal', allow_duplicate: false })).toMatchObject({
      ok: false,
      code: 'already_owner',
    })
  })

  it('re-sends a declined request (new round) when the requester asks again', () => {
    const { t, ctxFor, call, ok, notifications } = setup()
    const req = ok(call(ctxFor(t.wife), 'send_request', { to_member_id: t.husband.id, title: '接孩子', due_date: '2026-10-23', priority: 'normal', allow_duplicate: false }))
    t.domain.respondToRequest(t.as(t.husband), req.item.id, 'decline', '周五加班')
    const again = ok(
      call(ctxFor(t.wife), 'send_request', { to_member_id: t.husband.id, title: '接孩子', existing_item_id: req.item.id, due_date: '2026-10-24', priority: 'normal', allow_duplicate: false }),
    )
    expect(t.domain.getItem(again.item.id)).toMatchObject({ status: 'pending', dueDate: '2026-10-24' })
    expect(notifications(req.item.id).some(n => n.dedupe_key === `request_new:${req.item.id}:2`)).toBe(true)
  })
})

describe('update_item', () => {
  it('sets a time, then a date only, then clears it (due_change set / set / clear)', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const id = ok(call(ctx, 'create_item', task('卖旧柜子'))).item.id
    ok(call(ctx, 'update_item', { item_id: id, due_change: 'set', explicit_handover: false, due_date: '2026-10-25', due_time: '10:00' }))
    expect(t.domain.getItem(id)).toMatchObject({ dueAt: '2026-10-24T23:00:00.000Z', dueDate: null })
    ok(call(ctx, 'update_item', { item_id: id, due_change: 'set', explicit_handover: false, due_date: '2026-10-26' }))
    expect(t.domain.getItem(id)).toMatchObject({ dueAt: null, dueDate: '2026-10-26' })
    ok(call(ctx, 'update_item', { item_id: id, due_change: 'clear', explicit_handover: false }))
    expect(t.domain.getItem(id)).toMatchObject({ dueAt: null, dueDate: null })
  })

  it('rejects inconsistent due_change input and reports no-ops', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const id = ok(call(ctx, 'create_item', task('卖旧柜子'))).item.id
    expect(call(ctx, 'update_item', { item_id: id, due_change: 'keep', explicit_handover: false, due_date: '2026-10-25' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(call(ctx, 'update_item', { item_id: id, due_change: 'set', explicit_handover: false })).toMatchObject({ ok: false, code: 'invalid' })
    expect(ok(call(ctx, 'update_item', { item_id: id, due_change: 'keep', explicit_handover: false }))).toMatchObject({ unchanged: true })
  })

  it('updates status and title, and converts an idea into a dated task', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const cab = ok(call(ctx, 'create_item', task('卖旧柜子'))).item.id
    ok(call(ctx, 'update_item', { item_id: cab, due_change: 'keep', explicit_handover: false, status: 'in_progress', title: '卖旧衣柜' }))
    expect(t.domain.getItem(cab)).toMatchObject({ status: 'in_progress', title: '卖旧衣柜' })
    const idea = ok(call(ctx, 'create_item', task('去露营', { kind: 'idea' }))).item.id
    ok(call(ctx, 'update_item', { item_id: idea, due_change: 'set', explicit_handover: false, kind: 'task', due_date: '2026-10-31' }))
    expect(t.domain.getItem(idea)).toMatchObject({ kind: 'task', dueDate: '2026-10-31', ownerId: t.wife.id })
  })

  it('hands an item over only with explicit_handover (assigned notification to the new owner)', () => {
    const { t, ctxFor, call, ok, notifications } = setup()
    const ctx = ctxFor(t.wife)
    const id = ok(call(ctx, 'create_item', task('交水费'))).item.id
    expect(call(ctx, 'update_item', { item_id: id, due_change: 'keep', explicit_handover: false, owner_id: t.husband.id })).toMatchObject({
      ok: false,
      code: 'use_send_request',
    })
    expect(t.domain.getItem(id)!.ownerId).toBe(t.wife.id)
    ok(call(ctx, 'update_item', { item_id: id, due_change: 'keep', explicit_handover: true, owner_id: t.husband.id }))
    expect(t.domain.getItem(id)!.ownerId).toBe(t.husband.id)
    expect(notifications(id)).toEqual([expect.objectContaining({ member_id: t.husband.id, kind: 'assigned' })])
  })

  it('returns not_found for an unknown item id', () => {
    const { t, ctxFor, call } = setup()
    expect(call(ctxFor(t.wife), 'update_item', { item_id: 'i_zzzzzzzzzz', due_change: 'keep', explicit_handover: false, status: 'blocked' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })
})

describe('add_note / complete_item / respond_to_request', () => {
  it('adds a note and closes as dropped (never deleted) or done', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const rug = ok(call(ctx, 'create_item', task('买地毯'))).item.id
    ok(call(ctx, 'add_note', { item_id: rug, text: '要灰色的' }))
    expect(t.domain.listNotes(rug).map(n => n.text)).toEqual(['要灰色的'])
    const r = ok(call(ctx, 'complete_item', { item_id: rug, resolution: 'dropped', note: '先不买了' }))
    expect(r.item).toMatchObject({ status: 'dropped', closed: true })
    expect(t.domain.getItem(rug)).toMatchObject({ status: 'dropped' })
    expect(t.domain.listNotes(rug).map(n => n.text)).toEqual(['要灰色的', '先不买了'])
    // closing again with the same resolution is idempotent
    expect(ok(call(ctx, 'complete_item', { item_id: rug, resolution: 'dropped' }))).toMatchObject({ already: true })

    const milk = ok(call(ctx, 'create_item', task('买牛奶'))).item.id
    ok(call(ctx, 'complete_item', { item_id: milk, resolution: 'done' }))
    expect(t.domain.getItem(milk)).toMatchObject({ status: 'done', completedAt: '2026-10-21T01:00:00.000Z' })
  })

  it('respond_to_request works only for the owner of the pending request', () => {
    const { t, ctxFor, call, ok } = setup()
    const req = ok(call(ctxFor(t.wife), 'send_request', { to_member_id: t.husband.id, title: '带孩子出去', due_date: '2026-10-22', due_time: '08:00', priority: 'normal', allow_duplicate: false }))
    expect(call(ctxFor(t.wife), 'respond_to_request', { item_id: req.item.id, response: 'accept' })).toMatchObject({ ok: false, code: 'forbidden' })
    const r = ok(call(ctxFor(t.husband), 'respond_to_request', { item_id: req.item.id, response: 'accept', message: '没问题' }))
    expect(r).toMatchObject({ item: { status: 'accepted' }, requester_notified: '老婆' })
    // declining after accepting: rejected with a pointer to complete_item "dropped" (findings.test.ts AI-1)
    expect(call(ctxFor(t.husband), 'respond_to_request', { item_id: req.item.id, response: 'decline' })).toMatchObject({ ok: false, code: 'already_accepted' })
  })
})

describe('snooze_item', () => {
  it.each([
    ['tonight', '2026-10-21T09:00:00.000Z'], // today 20:00
    ['tomorrow', '2026-10-21T22:00:00.000Z'], // Thu 09:00
    ['weekend', '2026-10-23T23:00:00.000Z'], // Sat 10:00
    ['next_week', '2026-10-25T22:00:00.000Z'], // Mon 09:00
  ])('preset %s resolves in the family timezone', (preset, expected) => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const id = ok(call(ctx, 'create_item', task('整理照片'))).item.id
    ok(call(ctx, 'snooze_item', { item_id: id, preset }))
    expect(t.domain.getItem(id)!.snoozedUntil).toBe(expected)
  })

  it('custom needs a date (time defaults to 09:00) and must be in the future', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const id = ok(call(ctx, 'create_item', task('整理照片'))).item.id
    expect(call(ctx, 'snooze_item', { item_id: id, preset: 'custom' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(call(ctx, 'snooze_item', { item_id: id, preset: 'tomorrow', until_date: '2026-10-30' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(call(ctx, 'snooze_item', { item_id: id, preset: 'custom', until_date: '2026-10-20' })).toMatchObject({ ok: false, code: 'past_time' })
    const r = ok(call(ctx, 'snooze_item', { item_id: id, preset: 'custom', until_date: '2026-10-30' }))
    expect(t.domain.getItem(id)!.snoozedUntil).toBe('2026-10-29T22:00:00.000Z')
    expect(r.until).toBe('10/30 周五 09:00')
  })
})

describe('set_reminder', () => {
  it('reminds the owner by default, or the listed members, at the local time', () => {
    const { t, ctxFor, call, ok, notifications } = setup()
    const ctx = ctxFor(t.wife)
    const id = ok(call(ctx, 'create_item', task('带护照'))).item.id
    const r = ok(call(ctx, 'set_reminder', { item_id: id, remind_date: '2026-10-22', remind_time: '07:30' }))
    expect(r).toMatchObject({ reminders: ['老婆（说话人）'], at: '明天 07:30' })
    ok(call(ctx, 'set_reminder', { item_id: id, remind_date: '2026-10-22', remind_time: '07:30', member_ids: [t.husband.id] }))
    const explicit = notifications(id).filter(n => n.kind === 'explicit')
    expect(explicit.map(n => [n.member_id, n.fire_at])).toEqual(
      expect.arrayContaining([
        [t.wife.id, '2026-10-21T20:30:00.000Z'],
        [t.husband.id, '2026-10-21T20:30:00.000Z'],
      ]),
    )
  })

  it('rejects past times, unknown members and closed items', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const id = ok(call(ctx, 'create_item', task('带护照'))).item.id
    expect(call(ctx, 'set_reminder', { item_id: id, remind_date: '2026-10-21', remind_time: '11:00' })).toMatchObject({ ok: false, code: 'past_time' })
    expect(call(ctx, 'set_reminder', { item_id: id, remind_date: '2026-10-22', remind_time: '11:00', member_ids: ['m_zzzzzzzzzz'] })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    ok(call(ctx, 'complete_item', { item_id: id, resolution: 'done' }))
    expect(call(ctx, 'set_reminder', { item_id: id, remind_date: '2026-10-22', remind_time: '11:00' })).toMatchObject({ ok: false, code: 'invalid' })
  })
})

describe('search_items', () => {
  it('matches Traditional against Simplified, unions keywords, and includes closed items on request', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    const lamp = ok(call(ctx, 'create_item', task('买台灯'))).item.id
    const sofa = ok(call(ctx, 'create_item', task('换沙发'))).item.id
    ok(call(ctx, 'complete_item', { item_id: sofa, resolution: 'done' }))
    expect(ok(call(ctx, 'search_items', { query: '檯燈', include_closed: false })).items).toEqual([expect.objectContaining({ id: lamp })])
    expect((ok(call(ctx, 'search_items', { query: '台灯 沙发', include_closed: false })).items as unknown[]).length).toBe(1)
    expect((ok(call(ctx, 'search_items', { query: '台灯 沙发', include_closed: true })).items as unknown[]).length).toBe(2)
  })
})

describe('undone utterances', () => {
  it('refuses writes for an utterance that was undone meanwhile (conflict)', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.wife)
    ok(call(ctx, 'create_item', task('买牛奶')))
    t.domain.undoUtterance(t.as(t.wife), ctx.utteranceId)
    expect(call(ctx, 'create_item', task('买面包'))).toMatchObject({ ok: false, code: 'conflict' })
  })
})
