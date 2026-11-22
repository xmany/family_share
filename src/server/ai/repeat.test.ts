// Repeating items through the AI tools: the `repeat` RRULE string, complete_item on a repeating item, the snapshot.
// createTestContext: Wed 2026-10-21 12:00 Sydney; Sunday is 2026-10-25.
import { describe, expect, it } from 'vitest'
import type { Member } from '../../shared/types'
import { createTestContext } from '../testing'
import { zonedToUtc } from '../time'
import { executeCall, type ExecContext, type ToolOutcome } from './executor'
import { gatherSnapshot, renderTurnInput } from './snapshot'
import { SYSTEM_PROMPT } from './prompt'
import { parseRepeatText, parseToolCall, type BoardCall } from './tools'

const iso = (date: string, time: string) => zonedToUtc(date, time, 'Australia/Sydney').toISOString()

function setup() {
  const t = createTestContext()
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
    return o.result as Record<string, unknown> & { item: Record<string, unknown> & { id: string } }
  }
  return { t, ctxFor, call, ok }
}

const task = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'task',
  title,
  explicit_assignment: false,
  priority: 'normal',
  allow_duplicate: false,
  ...extra,
})

describe('parseRepeatText (the tools\' RRULE subset)', () => {
  it('reads the forms the tool description lists', () => {
    expect(parseRepeatText('FREQ=DAILY')).toEqual({ ok: true, value: { freq: 'daily' } })
    expect(parseRepeatText('FREQ=WEEKLY')).toEqual({ ok: true, value: { freq: 'weekly' } })
    expect(parseRepeatText('RRULE:FREQ=WEEKLY;BYDAY=TU,FR')).toEqual({ ok: true, value: { freq: 'weekly', weekdays: [2, 5] } })
    expect(parseRepeatText(' freq=weekly; interval=2 ')).toEqual({ ok: true, value: { freq: 'weekly', interval: 2 } })
    expect(parseRepeatText('FREQ=MONTHLY;BYMONTHDAY=15')).toEqual({ ok: true, value: { freq: 'monthly', monthDay: 15 } })
    expect(parseRepeatText('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8')).toEqual({ ok: true, value: { freq: 'yearly', month: 3, monthDay: 8 } })
    // the common "workdays" idiom DAILY + BYDAY is weekly on those days
    expect(parseRepeatText('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR')).toEqual({ ok: true, value: { freq: 'weekly', weekdays: [1, 2, 3, 4, 5] } })
    expect(parseRepeatText('NONE')).toEqual({ ok: true, value: null })
  })

  it('refuses what a repeat here cannot do, saying what can', () => {
    const msg = (s: string) => {
      const r = parseRepeatText(s)
      if (r.ok) throw new Error(`expected a refusal for ${s}`)
      return r.message
    }
    expect(msg('FREQ=HOURLY')).toMatch(/FREQ 只能是/)
    expect(msg('FREQ=MONTHLY;BYDAY=1SA')).toMatch(/每月第几个星期几/)
    expect(msg('FREQ=WEEKLY;COUNT=4')).toMatch(/不支持 COUNT/)
    expect(msg('FREQ=WEEKLY;INTERVAL=0')).toMatch(/INTERVAL/)
    expect(msg('FREQ=MONTHLY;BYDAY=MO')).toMatch(/BYDAY 只能和 FREQ=WEEKLY/)
    expect(msg('every sunday')).toMatch(/RRULE/)
    // a bad rule is an is_error result for the whole call
    const r = parseToolCall('create_item', { ...task('倒垃圾'), due_date: '2026-10-25', repeat: 'FREQ=WEEKLY;UNTIL=20261231' })
    expect(r.ok).toBe(false)
  })
})

describe('create_item / send_request with repeat', () => {
  it('每周日晚上九点倒垃圾 → one repeating task; the result says how it repeats', () => {
    const { t, ctxFor, call, ok } = setup()
    const ctx = ctxFor(t.husband, '每周日晚上九点倒垃圾')
    const r = ok(call(ctx, 'create_item', task('倒垃圾', { due_date: '2026-10-25', due_time: '21:00', repeat: 'FREQ=WEEKLY' })))
    expect(r.item).toMatchObject({ due: '周日 10/25 21:00', repeat: '每周日' })
    expect(t.domain.getItem(r.item.id)!.repeat).toMatchObject({ freq: 'weekly', weekdays: [0], anchor: '2026-10-25' })
    expect(t.domain.getUtterance(ctx.utteranceId)!.changes[0]!.summary).toBe('新建待办：倒垃圾（周日 10/25 21:00，每周日）')
  })

  it('a first occurrence that is already over starts at the next one, and the result says so', () => {
    const { t, ctxFor, call, ok } = setup()
    const r = ok(call(ctxFor(t.wife), 'create_item', task('浇花', { due_date: '2026-10-21', due_time: '08:00', repeat: 'FREQ=DAILY' })))
    expect(r.item.due).toBe('明天 08:00')
    expect(r.first_occurrence_moved).toMatch(/2026-10-21 08:00 已经过了，从下一次 明天 08:00 开始/)
  })

  it('needs a date, and never on an idea', () => {
    const { t, ctxFor, call } = setup()
    expect(call(ctxFor(t.wife), 'create_item', task('倒垃圾', { repeat: 'FREQ=WEEKLY' }))).toMatchObject({ ok: false, message: expect.stringMatching(/due_date/) })
    expect(call(ctxFor(t.wife), 'create_item', task('露营', { kind: 'idea', repeat: 'FREQ=YEARLY' }))).toMatchObject({ ok: false, message: expect.stringMatching(/想法/) })
  })

  it('让老公每周二和周五倒垃圾 → a repeating request', () => {
    const { t, ctxFor, call, ok } = setup()
    const r = ok(
      call(ctxFor(t.wife), 'send_request', {
        to_member_id: t.husband.id,
        title: '倒垃圾',
        due_date: '2026-10-23',
        due_time: '20:00',
        priority: 'normal',
        allow_duplicate: false,
        repeat: 'FREQ=WEEKLY;BYDAY=TU,FR',
      }),
    )
    expect(r.item).toMatchObject({ kind: 'request', repeat: '每周二、周五' })
  })
})

describe('complete_item on a repeating item', () => {
  it('"done" finishes this time and moves on; "skipped" skips it; "dropped" ends the series', () => {
    const { t, ctxFor, call, ok } = setup()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '倒垃圾', dueAt: iso('2026-10-25', '21:00'), repeat: { freq: 'weekly' } })
    t.clock.set(new Date(iso('2026-10-25', '21:05')))
    const done = ok(call(ctxFor(t.husband, '倒好了'), 'complete_item', { item_id: item.id, resolution: 'done' }))
    expect(done.item).toMatchObject({ status: 'open', due: '11/1 周日 21:00', repeat: '每周日' })
    expect(done.repeating).toBe('这次完成了；这是重复的事项（每周日），没有关闭，下次是 11/1 周日 21:00。')

    const skipped = ok(call(ctxFor(t.husband, '下周不用倒'), 'complete_item', { item_id: item.id, resolution: 'skipped' }))
    expect(skipped.item.due).toBe('11/8 周日 21:00')
    expect(skipped.repeating).toMatch(/这次跳过了/)

    const dropped = ok(call(ctxFor(t.husband, '以后都不用倒了'), 'complete_item', { item_id: item.id, resolution: 'dropped' }))
    expect(dropped.item).toMatchObject({ status: 'dropped', closed: true })
    expect(call(ctxFor(t.husband), 'complete_item', { item_id: item.id, resolution: 'skipped' })).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('"skipped" on a one-off item is refused with what to do instead', () => {
    const { t, ctxFor, call } = setup()
    const once = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '买地毯', dueDate: '2026-10-25' })
    expect(call(ctxFor(t.wife), 'complete_item', { item_id: once.id, resolution: 'skipped' })).toMatchObject({
      ok: false,
      code: 'not_repeating',
      message: expect.stringMatching(/dropped/),
    })
    expect(t.domain.getItem(once.id)!.status).toBe('open')
  })
})

describe('update_item with repeat', () => {
  it('makes an existing item repeat, changes the series, or stops it', () => {
    const { t, ctxFor, call, ok } = setup()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '倒垃圾', dueAt: iso('2026-10-25', '21:00') })
    const made = ok(call(ctxFor(t.husband, '这个以后每周都要做'), 'update_item', { item_id: item.id, due_change: 'keep', explicit_handover: false, repeat: 'FREQ=WEEKLY' }))
    expect(made).toMatchObject({ changed: ['repeat'], item: { repeat: '每周日' } })
    // the same rule again changes nothing
    const same = ok(call(ctxFor(t.husband), 'update_item', { item_id: item.id, due_change: 'keep', explicit_handover: false, repeat: 'FREQ=WEEKLY' }))
    expect(same.unchanged).toBe(true)
    // 以后改成周一
    const monday = ok(
      call(ctxFor(t.husband, '以后改成周一'), 'update_item', {
        item_id: item.id,
        due_change: 'set',
        due_date: '2026-10-26',
        due_time: '21:00',
        explicit_handover: false,
        repeat: 'FREQ=WEEKLY',
      }),
    )
    expect(monday.item).toMatchObject({ repeat: '每周一', due: '周一 10/26 21:00' })
    const stopped = ok(call(ctxFor(t.husband, '不用重复了'), 'update_item', { item_id: item.id, due_change: 'keep', explicit_handover: false, repeat: 'NONE' }))
    expect(stopped.item.repeat).toBeUndefined()
    expect(t.domain.getItem(item.id)!).toMatchObject({ repeat: null, status: 'open' })
  })

  it('a repeat for an item without a date asks for one', () => {
    const { t, ctxFor, call } = setup()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '浇花' })
    expect(call(ctxFor(t.husband), 'update_item', { item_id: item.id, due_change: 'keep', explicit_handover: false, repeat: 'FREQ=DAILY' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/due_change "set"/),
    })
  })

  it('a repeating task handed over as a request keeps repeating', () => {
    const { t, ctxFor, call, ok } = setup()
    const item = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '倒垃圾', dueAt: iso('2026-10-25', '21:00'), repeat: { freq: 'weekly' } })
    const r = ok(
      call(ctxFor(t.wife, '以后让老公倒垃圾'), 'send_request', {
        to_member_id: t.husband.id,
        title: '倒垃圾',
        existing_item_id: item.id,
        priority: 'normal',
        allow_duplicate: false,
      }),
    )
    expect(r.item).toMatchObject({ kind: 'request', repeat: '每周日', due: '周日 10/25 21:00' })
  })
})

describe('snapshot and prompt', () => {
  it('active_items mark repeating items; the prompt explains them', () => {
    const { t } = setup()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '倒垃圾', dueAt: iso('2026-10-25', '21:00'), repeat: { freq: 'weekly' } })
    const u = t.domain.createUtterance(t.husband.id, 'text', '倒好了')
    const input = renderTurnInput(
      gatherSnapshot(t.domain, { now: t.clock.now(), speaker: t.husband, text: u.text, source: 'text', currentUtteranceId: u.id }),
    )
    expect(input).toContain(`- ${item.id} | task | open | 倒垃圾 | 负责 老公 | 截止 周日 10/25 21:00（2026-10-25 21:00） | 重复 每周日（截止是这一次）`)
    expect(SYSTEM_PROMPT).toContain('complete_item "skipped"')
    expect(SYSTEM_PROMPT).not.toContain('not supported yet')
  })
})
