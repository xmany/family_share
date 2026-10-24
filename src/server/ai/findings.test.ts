// Regression tests for the second interpreter review (AI-1, AI-2, AI-5, AI-8); each failed before its fix.
import { describe, expect, it } from 'vitest'
import type { Member } from '../../shared/types'
import { testConfig } from '../config'
import { skipReason } from '../scheduler/relevance'
import { createTestContext } from '../testing'
import { zonedToUtc } from '../time'
import { CASES, WECHAT_REPLY } from './eval/cases'
import { runCase } from './eval/harness'
import { executeCall, type ExecContext, type ToolOutcome } from './executor'
import { SYSTEM_PROMPT } from './prompt'
import { gatherSnapshot, renderTurnInput } from './snapshot'
import { msg, ScriptedApi, text, toolUse } from './testing'
import { type BoardCall, parseToolCall, TOOLS } from './tools'

function exec(opts: { timezone?: string } = {}) {
  const t = createTestContext(opts)
  const ctxFor = (speaker: Member): ExecContext => {
    const u = t.domain.createUtterance(speaker.id, 'text', '…')
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
  const rows = (itemId: string) =>
    t.db.prepare('SELECT id, member_id, kind, fire_at, dedupe_key, status FROM notifications WHERE item_id = ? ORDER BY fire_at, dedupe_key').all(itemId) as Array<{
      id: string
      member_id: string
      kind: string
      fire_at: string
      dedupe_key: string
      status: string
    }>
  const local = (date: string, time: string) => zonedToUtc(date, time, t.family.timezone).toISOString()
  return { t, ctxFor, call, ok, rows, local }
}

const anthropic = testConfig().anthropic
const caseById = (id: string) => {
  const c = CASES.find(x => x.id === id)
  if (!c) throw new Error(`no eval case ${id}`)
  return c
}

describe('AI-1: backing out of a request', () => {
  // Dropping a request created no notification for the other side, and the tool result did not say so: the reply
  // 「好，已标记为不做了」 left 老公 thinking the kids were covered.
  it('dropping an accepted request (owner backs out) notifies the requester, quoting the note', () => {
    const { t, ctxFor, call, ok } = exec()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去', dueAt: '2026-10-23T21:00:00.000Z' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    const r = ok(call(ctxFor(t.wife), 'complete_item', { item_id: req.id, resolution: 'dropped', note: '去不了了' }))
    expect(t.domain.getItem(req.id)!.status).toBe('dropped')
    expect(r.notified).toBe('老公')
    expect(r.not_notified).toBeUndefined()
    const notice = t.outbox.listForItem(req.id).find(n => n.dedupeKey === `request_answered:${req.id}:dropped:1`)
    expect(notice).toMatchObject({ memberId: t.husband.id, status: 'scheduled', title: '老婆不做了：带孩子出去', body: '去不了了' })
    // the note is still a note on the item
    expect(t.domain.listNotes(req.id).map(n => n.text)).toEqual(['去不了了'])
  })

  it('taking back an accepted request (requester) notifies the owner', () => {
    const { t, ctxFor, call, ok } = exec()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '买牛奶', dueDate: '2026-10-22' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    const r = ok(call(ctxFor(t.husband), 'complete_item', { item_id: req.id, resolution: 'dropped' }))
    expect(r.notified).toBe('老婆')
    expect(r.not_notified).toBeUndefined()
  })

  it('taking back a pending request the owner has not received yet withdraws it without a notice', () => {
    const { t, ctxFor, call, ok } = exec()
    // request_new is still in the outbox (the scheduler has not sent it)
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '买菜', dueDate: '2026-10-23' })
    const r = ok(call(ctxFor(t.husband), 'complete_item', { item_id: req.id, resolution: 'dropped' }))
    expect(r).toMatchObject({ withdrawn_before_delivery: '老婆' })
    expect(String(r.message)).toContain('还没收到')
    expect(r.notified).toBeUndefined()
    expect(r.not_notified).toBeUndefined()
    expect(t.outbox.scheduledForItem(req.id)).toEqual([])
  })

  it('a second drop in the same round (after re-opening) sends nothing new and says so', () => {
    const { t, ctxFor, call, ok } = exec()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    t.domain.updateItem(t.as(t.wife), req.id, { status: 'dropped' })
    const notice = t.outbox.listForItem(req.id).find(n => n.dedupeKey === `request_answered:${req.id}:dropped:1`)!
    t.outbox.markSent(notice.id)
    t.domain.updateItem(t.as(t.wife), req.id, { status: 'accepted' })
    const r = ok(call(ctxFor(t.wife), 'complete_item', { item_id: req.id, resolution: 'dropped' }))
    expect(r.not_notified).toBe('老公')
    expect(String(r.message)).toContain('说一声')
  })

  it('a declined request needs no notice when it is dropped', () => {
    const { t, ctxFor, call, ok } = exec()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '修车' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'decline')
    const r = ok(call(ctxFor(t.husband), 'complete_item', { item_id: req.id, resolution: 'dropped' }))
    expect(r.notified).toBeUndefined()
    expect(r.not_notified).toBeUndefined()
  })

  it('a pending request addressed to the speaker is declined, never silently dropped', () => {
    const { t, ctxFor, call } = exec()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去', dueAt: '2026-10-23T21:00:00.000Z' })
    const r = call(ctxFor(t.wife), 'complete_item', { item_id: req.id, resolution: 'dropped', note: '去不了' })
    expect(r).toMatchObject({ ok: false, code: 'use_respond_to_request' })
    expect(!r.ok && r.message).toContain('respond_to_request')
    expect(t.domain.getItem(req.id)!.status).toBe('pending')
  })

  it('declining an already accepted request points at complete_item dropped', () => {
    const { t, ctxFor, call } = exec()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    t.domain.respondToRequest(t.as(t.wife), req.id, 'accept')
    const r = call(ctxFor(t.wife), 'respond_to_request', { item_id: req.id, response: 'decline', message: '去不了了' })
    expect(r).toMatchObject({ ok: false, code: 'already_accepted' })
    expect(!r.ok && r.message).toContain('complete_item')
    expect(t.domain.getItem(req.id)!.status).toBe('accepted')
  })

  it('the prompt sends 算了/去不了 on a pending request to decline and asks to tell an uninformed person', () => {
    expect(SYSTEM_PROMPT).toContain('is respond_to_request "decline" with the reason as the message, never complete_item')
    expect(SYSTEM_PROMPT).toContain('If they already accepted it and now can\'t, use complete_item "dropped" with the reason as the note.')
    expect(SYSTEM_PROMPT).toContain('not_notified')
    for (const id of ['owner-backs-out-pending', 'owner-backs-out-accepted', 'requester-takes-back-accepted']) expect(caseById(id).id).toBe(id)
  })
})

describe('AI-2: cancelling a reminder', () => {
  // Extra pings were invisible in the snapshot and no tool cancelled one, so 取消明天的提醒 could only drop the task.
  function passportWithPing() {
    const x = exec()
    const task = x.t.domain.createItem(x.t.as(x.t.husband), { kind: 'task', title: '带护照', dueDate: '2026-10-22' })
    x.t.domain.setReminder(x.t.as(x.t.husband), { itemId: task.id, memberId: x.t.husband.id, fireAt: x.local('2026-10-22', '07:00'), message: '带护照' })
    return { ...x, task }
  }

  it('the snapshot lists an item\'s extra pings with their local date and time', () => {
    const { t, task } = passportWithPing()
    const input = renderTurnInput(
      gatherSnapshot(t.domain, { now: t.clock.now(), speaker: t.husband, text: '取消明天的提醒', source: 'text', currentUtteranceId: 'u_none' }),
    )
    const line = input.split('\n').find(l => l.includes(task.id))!
    expect(line).toContain('另有提醒 明天 07:00（2026-10-22 07:00）→ 老公')
    // the due-time ping is not an extra ping
    expect(line.match(/另有提醒/g)).toHaveLength(1)
  })

  it('cancel_reminder cancels only that ping: the task, its due date and its due ping stay', () => {
    const { t, ctxFor, call, ok, rows, task } = passportWithPing()
    const ctx = ctxFor(t.husband)
    const r = ok(call(ctx, 'cancel_reminder', { item_id: task.id, remind_date: '2026-10-22', remind_time: '07:00' }))
    expect(r.cancelled).toEqual({ at: '明天 07:00', for: ['老公'] })
    expect(t.domain.getItem(task.id)).toMatchObject({ status: 'open', dueDate: '2026-10-22' })
    const byKey = Object.fromEntries(rows(task.id).map(n => [n.dedupe_key.split(':')[0], n.status]))
    expect(byKey).toEqual({ due: 'scheduled', explicit: 'cancelled' })
    expect(t.domain.getUtterance(ctx.utteranceId)!.changes).toEqual([expect.objectContaining({ type: 'reminder_cancelled', itemId: task.id })])
    // undoable like every other AI change
    t.domain.undoUtterance(t.as(t.husband), ctx.utteranceId)
    expect(rows(task.id).find(n => n.dedupe_key.startsWith('explicit:'))!.status).toBe('scheduled')
  })

  it('a time with no extra ping is rejected with the pings that exist and how to handle the due ping', () => {
    const { t, ctxFor, call, rows, task } = passportWithPing()
    const r = call(ctxFor(t.husband), 'cancel_reminder', { item_id: task.id, remind_date: '2026-10-22', remind_time: '09:00' })
    expect(r).toMatchObject({ ok: false, code: 'not_found' })
    expect(!r.ok && r.message).toContain('明天 07:00（2026-10-22 07:00）→ 老公')
    expect(!r.ok && r.message).toContain('due_change "clear"')
    expect(rows(task.id).every(n => n.status === 'scheduled')).toBe(true)
  })

  it('a kind reminder item points at complete_item dropped', () => {
    const { t, ctxFor, call, local } = exec()
    const rem = t.domain.createItem(t.as(t.wife), { kind: 'reminder', title: '给外婆打电话', dueAt: local('2026-10-22', '20:00') })
    const r = call(ctxFor(t.wife), 'cancel_reminder', { item_id: rem.id, remind_date: '2026-10-22', remind_time: '20:00' })
    expect(r).toMatchObject({ ok: false, code: 'not_found' })
    expect(!r.ok && r.message).toContain('complete_item "dropped"')
    expect(t.domain.getItem(rem.id)!.status).toBe('open')
  })

  it('is a tool, the prompt routes 取消提醒 to it, and the eval seeds extra pings', async () => {
    expect(TOOLS.map(x => x.name)).toContain('cancel_reminder')
    expect(SYSTEM_PROMPT).toContain('取消提醒 / 别提醒我了 cancels a ping, not the thing')
    const api = new ScriptedApi([
      body => {
        const s = JSON.stringify(body.messages)
        const id = /- (i_\w+) \| task \| open \| 带护照 [^"]*另有提醒 明天 07:00（2026-10-22 07:00）/.exec(s)![1]
        return msg('tool_use', [toolUse('t1', 'cancel_reminder', { item_id: id, remind_date: '2026-10-22', remind_time: '07:00' })])
      },
      msg('end_turn', [text('好，明天 07:00 的提醒取消了，护照的事还在。')]),
    ])
    const run = await runCase(caseById('cancel-extra-ping'), api, anthropic)
    expect(run.failures).toEqual([])
    expect(run.calls).toEqual([expect.objectContaining({ name: 'cancel_reminder', result: 'ok' })])
    expect(caseById('cancel-reminder-item').expect).toEqual([{ tool: 'complete_item', item: 'call', resolution: 'dropped' }])
  })
})

describe('AI-5: a snooze silences the item until the snooze time', () => {
  // The scheduler now holds back an item's due / reminder pings while it is snoozed (scheduler/relevance.ts), so the
  // result, the tool and the prompt say so; a thing that itself moved gets a new due date (which ends the snooze).
  it('says the item is silent until then; when the due date comes first, it stays and update_item is the way to move it', () => {
    const { t, ctxFor, call, ok, rows } = exec({ timezone: 'Pacific/Auckland' })
    const bill = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '交水费', dueDate: '2026-10-22' })
    const r = ok(call(ctxFor(t.wife), 'snooze_item', { item_id: bill.id, preset: 'next_week' }))
    expect(r.earlier_pings).toBeUndefined()
    expect(String(r.effect)).toContain(`${r.until} 之前不再提醒这件事`)
    expect(String(r.warning)).toContain('截止时间还是明天')
    expect(String(r.warning)).toContain('update_item（due_change "set"）')
    expect(String(r.warning)).toContain('取消推迟')
    expect(String(r.warning)).not.toContain('照常提醒')
    // the 09:00 due ping tomorrow stays in the outbox, and the scheduler skips it as snoozed when it comes up
    const due = t.outbox.listForItem(bill.id).find(n => n.dedupeKey === `due:${bill.id}:2026-10-22`)!
    expect(rows(bill.id).find(n => n.id === due.id)).toMatchObject({ status: 'scheduled', fire_at: '2026-10-21T20:00:00.000Z' })
    expect(skipReason(due, t.domain.getItem(bill.id), new Date(due.fireAt), 'Pacific/Auckland')).toBe('snoozed')
  })

  it('extra pings from set_reminder before the snooze time still fire, and the result lists them', () => {
    const { t, ctxFor, call, ok, local } = exec()
    const photos = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '整理照片' })
    t.domain.setReminder(t.as(t.wife), { itemId: photos.id, memberId: t.wife.id, fireAt: local('2026-10-22', '20:00'), message: '整理照片' })
    const r = ok(call(ctxFor(t.wife), 'snooze_item', { item_id: photos.id, preset: 'next_week' }))
    expect(r.extra_pings_still_fire).toEqual(['明天 20:00'])
    expect(String(r.warning)).toContain('cancel_reminder')
    expect(String(r.warning)).not.toContain('截止时间')
  })

  it('no warning for an undated item without extra pings', () => {
    const { t, ctxFor, call, ok } = exec()
    const photos = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '整理照片' })
    const r = ok(call(ctxFor(t.wife), 'snooze_item', { item_id: photos.id, preset: 'tomorrow' }))
    expect(r.warning).toBeUndefined()
    expect(r.extra_pings_still_fire).toBeUndefined()
    expect(String(r.effect)).toContain('明天 09:00 之前不再提醒这件事')
  })

  it('moving the due date of a snoozed item clears the snooze and says so', () => {
    const { t, ctxFor, call, ok } = exec()
    const bill = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '交水费', dueDate: '2026-10-22' })
    const ctx = ctxFor(t.wife)
    ok(call(ctx, 'snooze_item', { item_id: bill.id, preset: 'next_week' }))
    const r = ok(call(ctx, 'update_item', { item_id: bill.id, due_change: 'set', due_date: '2026-10-27', explicit_handover: false }))
    expect(t.domain.getItem(bill.id)).toMatchObject({ dueDate: '2026-10-27', snoozedUntil: null })
    expect(String(r.snooze_cleared)).toContain('取消了推迟')
    // a later edit that does not move the date says nothing about a snooze
    expect(ok(call(ctx, 'update_item', { item_id: bill.id, due_change: 'keep', priority: 'high', explicit_handover: false })).snooze_cleared).toBeUndefined()
  })

  it('the tool and the prompt say a snooze silences the item; postpone-dated-bill accepts either way', () => {
    const snooze = TOOLS.find(x => x.name === 'snooze_item')!
    expect(snooze.description).not.toContain('does not stop pings already planned for it')
    expect(snooze.description).toContain('it is silenced until the snooze time')
    expect(snooze.description).toContain('use update_item due_change "set" instead; that also clears the snooze')
    expect(SYSTEM_PROMPT).not.toContain('snooze_item only adds one more ping later')
    expect(SYSTEM_PROMPT).toContain('snooze_item silences the item until the snooze time and pings once then')
    expect(SYSTEM_PROMPT).toContain('that also clears an earlier snooze')
    expect(caseById('postpone-dated-bill').expect).toEqual([{ tool: ['update_item', 'snooze_item'], item: 'bill' }])
    expect(caseById('postpone-dated-bill').forbid).toContain('complete_item')
  })
})

describe('AI-8: WeChat replies fit the 20-character field', () => {
  // The reply goes into a WeChat template field cut after 19 characters + "…"; the prompt ignored source="wechat".
  it('the prompt has a WeChat length rule with examples that fit', () => {
    expect(SYSTEM_PROMPT).toContain('When the utterance source is "wechat"')
    expect(SYSTEM_PROMPT).toContain('at most 18 characters')
    for (const example of ['已请老公明天18:30买奶，待确认', '今晚20:00提醒你打电话', '还有5件，最急：明天交水费']) {
      expect(SYSTEM_PROMPT).toContain(example)
      expect(Array.from(example).length).toBeLessThanOrEqual(18)
    }
  })

  it('WeChat eval cases run with source wechat and fail a reply that would be cut', async () => {
    const script = (reply: string) =>
      new ScriptedApi([
        body => {
          const s = JSON.stringify(body.messages)
          expect(s).toContain('<utterance source=\\"wechat\\">')
          const husband = /- (m_\w+) \| 老公/.exec(s)![1]
          return msg('tool_use', [
            toolUse('t1', 'send_request', { to_member_id: husband, title: '买牛奶', due_date: '2026-10-22', due_time: '18:30', priority: 'normal', allow_duplicate: false }),
          ])
        },
        msg('end_turn', [text(reply)]),
      ])
    const c = caseById('wechat-request-short-reply')
    expect(c.source).toBe('wechat')
    const long = await runCase(c, script('好的，已请老公明天 18:30 下班顺路买牛奶，等他确认。'), anthropic)
    expect(long.failures).toEqual([expect.stringContaining('reply does not match')])
    const short = await runCase(c, script('已请老公明天18:30买奶，待确认'), anthropic)
    expect(short.failures).toEqual([])
    expect(caseById('wechat-board-question')).toMatchObject({ source: 'wechat', replyMatches: WECHAT_REPLY })
  })
})
