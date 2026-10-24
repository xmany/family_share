// Applies one validated tool call to the board through the Domain.
//
// Every call runs with actor { type: 'ai', memberId: speaker, utteranceId } so its events belong to the
// utterance (undo, the chat "改动" card). Local dates/times from the model are converted here with
// zonedToUtc in the family timezone. Rejections come back as { ok: false, code, message } and are sent
// to Claude as is_error tool results; successful results carry human labels (title, owner name, due
// label) the reply can reuse.

import type { Item, Member, ScheduledNotification } from '../../shared/types'
import { CLOSED_STATUSES } from '../../shared/types'
import { dueLabel, nameLookup, statusLabel } from '../domain/describe'
import { normalizeForSearch } from '../domain/normalize'
import type { Actor, Domain, UpdateItemInput } from '../domain/types'
import { DomainError } from '../domain/types'
import type { Clock } from '../time'
import { formatInstantZh, isLocalDate, localDate, localTime, resolveSnoozePreset, zonedToUtc } from '../time'
import type { BoardCall, CallOf } from './tools'

export interface ExecContext {
  domain: Domain
  clock: Clock
  speaker: Member
  utteranceId: string
  /** Family timezone */
  tz: string
  /** Members at the start of the utterance (names for labels, id checks) */
  members: Member[]
  /** Ids of items touched by successful calls (for UtteranceResponse.items) */
  touched: Set<string>
}

export type ToolOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string; message: string; extra?: Record<string, unknown> }

/** A rejection decided by the interpreter itself (before or instead of a domain call). */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

const isClosed = (item: Item) => CLOSED_STATUSES.includes(item.status)
/** Duplicate key: Simplified, case-folded, without spaces and punctuation ("買 牛奶！" === "买牛奶"). */
export const duplicateKey = (title: string) => normalizeForSearch(title).replace(/[\s\p{P}\p{S}]/gu, '')

export function executeCall(call: BoardCall, ctx: ExecContext): ToolOutcome {
  try {
    return { ok: true, result: run(call, ctx) }
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, code: e.code, message: e.message, ...(e.extra ? { extra: e.extra } : {}) }
    if (e instanceof DomainError) return { ok: false, code: e.code, message: e.message }
    console.error('[ai] tool call failed', call.name, e)
    return { ok: false, code: 'internal', message: `服务器内部错误：${e instanceof Error ? e.message : String(e)}` }
  }
}

function run(call: BoardCall, ctx: ExecContext): Record<string, unknown> {
  switch (call.name) {
    case 'search_items':
      return searchItems(call, ctx)
    case 'create_item':
      return createItem(call, ctx)
    case 'update_item':
      return updateItem(call, ctx)
    case 'add_note':
      return addNote(call, ctx)
    case 'send_request':
      return sendRequest(call, ctx)
    case 'respond_to_request':
      return respondToRequest(call, ctx)
    case 'complete_item':
      return completeItem(call, ctx)
    case 'snooze_item':
      return snoozeItem(call, ctx)
    case 'set_reminder':
      return setReminder(call, ctx)
    case 'cancel_reminder':
      return cancelReminder(call, ctx)
  }
}

// ---------------------------------------------------------------------------------------------
// helpers

const actorOf = (ctx: ExecContext): Actor => ({ type: 'ai', memberId: ctx.speaker.id, utteranceId: ctx.utteranceId })

export interface ItemView {
  id: string
  kind: Item['kind']
  status: Item['status']
  status_label: string
  title: string
  owner: string
  requested_by?: string
  due: string | null
  snoozed_until?: string
  closed?: boolean
}

/** What a tool result tells Claude about an item: names and labels, never raw UTC instants. */
export function itemView(item: Item, ctx: ExecContext): ItemView {
  const now = ctx.clock.now()
  const nameOf = nameLookup(ctx.members)
  const v: ItemView = {
    id: item.id,
    kind: item.kind,
    status: item.status,
    status_label: statusLabel(item.status),
    title: item.title,
    owner: item.ownerId ? nameOf(item.ownerId) : '未指定',
    due: dueLabel(item, now, ctx.tz),
  }
  if (item.requestedBy) v.requested_by = nameOf(item.requestedBy)
  if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now.getTime()) v.snoozed_until = formatInstantZh(item.snoozedUntil, now, ctx.tz)
  if (isClosed(item)) v.closed = true
  return v
}

function requireItem(ctx: ExecContext, id: string): Item {
  const item = ctx.domain.getItem(id)
  if (!item) throw new ToolError('not_found', `找不到这个事项（${id}）。请从 active_items、closed_last_7_days 或 search_items 的结果里复制 id。`)
  return item
}

function requireMember(ctx: ExecContext, id: string): Member {
  const m = ctx.members.find(x => x.id === id) ?? ctx.domain.getMember(id)
  if (!m) throw new ToolError('not_found', `找不到这个成员（${id}）。请从 members 里复制 id。`)
  return m
}

interface Due {
  dueAt: string | null
  dueDate: string | null
}

/** Local date (+ optional time) → { dueAt } (UTC instant) or { dueDate } (local date). */
function resolveDue(ctx: ExecContext, date: string | undefined, time: string | undefined, field = 'due'): Due {
  if (time !== undefined && date === undefined) throw new ToolError('invalid', `${field}_time 需要和 ${field}_date 一起给`)
  if (date === undefined) return { dueAt: null, dueDate: null }
  if (!isLocalDate(date)) throw new ToolError('invalid', `日期不存在：${date}`)
  if (time === undefined) return { dueAt: null, dueDate: date }
  return { dueAt: zonedToUtc(date, time, ctx.tz).toISOString(), dueDate: null }
}

function describeLocal(ctx: ExecContext, due: Due): string {
  if (due.dueAt) return `${localDate(new Date(due.dueAt), ctx.tz)} ${localTime(new Date(due.dueAt), ctx.tz)}`
  return due.dueDate ?? ''
}

/**
 * A past time or date is accepted (overdue) but flagged so Claude can correct a slip: AM/PM for times, the
 * year for dates beyond the 3-week calendar ("1月5日" said in October is next January).
 */
function pastWarning(ctx: ExecContext, item: Item): string | null {
  if (isClosed(item)) return null
  const now = ctx.clock.now()
  if (item.dueAt && new Date(item.dueAt).getTime() <= now.getTime()) {
    return '这个时间已经过了。如果说的是将来的时间，请用 update_item 改到正确的日期。'
  }
  if (item.dueDate && item.dueDate < localDate(now, ctx.tz)) {
    return `这个日期（${item.dueDate}）已经过了。如果说的是将来（注意年份），请用 update_item 改到正确的日期。`
  }
  return null
}

/** When a new date replaces a dated-and-timed due without a time, the time is gone: say so (改到周日 ≠ drop 08:30). */
function droppedTimeWarning(ctx: ExecContext, before: Item, givenTime: string | undefined, after: Due | null): string | null {
  if (!after || givenTime !== undefined || !before.dueAt || !after.dueDate) return null
  const time = localTime(new Date(before.dueAt), ctx.tz)
  return `原来的时间 ${time} 去掉了，现在只有日期 ${after.dueDate}。如果时间没变，请再调用一次并带上 due_time "${time}"。`
}

function warnings(...list: Array<string | null>): Record<string, string> {
  const w = list.filter((x): x is string => !!x)
  return w.length ? { warning: w.join(' ') } : {}
}

function findDuplicates(ctx: ExecContext, title: string): Item[] {
  const key = duplicateKey(title)
  if (!key) return []
  return ctx.domain
    .listActiveItems()
    .filter(i => duplicateKey(i.title) === key)
    .slice(0, 5)
}

function touch(ctx: ExecContext, item: Item): Item {
  ctx.touched.add(item.id)
  return item
}

function scheduledRows(domain: Domain, itemId: string): ScheduledNotification[] {
  return (domain.getItemDetail(itemId)?.notifications ?? []).filter(n => n.status === 'scheduled')
}

/**
 * Extra pings on an item that are still ahead, soonest first: rows from set_reminder / createItem.remindAt
 * (`explicit:` keys; what Domain.cancelReminder accepts). Not the due-time ping, and not a kind 'reminder'
 * item's own ping (`reminder:` key).
 */
export function extraPings(domain: Domain, itemId: string, now: Date): ScheduledNotification[] {
  return scheduledRows(domain, itemId)
    .filter(n => n.kind === 'explicit' && n.dedupeKey.startsWith('explicit:') && new Date(n.fireAt).getTime() > now.getTime())
    .sort((a, b) => a.fireAt.localeCompare(b.fireAt) || a.memberId.localeCompare(b.memberId))
}

// ---------------------------------------------------------------------------------------------
// tools

function searchItems(call: CallOf<'search_items'>, ctx: ExecContext) {
  const terms = [...new Set(call.input.query.split(/[\s,，、;；]+/).map(t => t.trim()).filter(Boolean))].slice(0, 5)
  const seen = new Map<string, Item>()
  for (const text of terms) {
    for (const it of ctx.domain.searchItems({ text, includeClosed: call.input.include_closed, limit: 20 })) {
      if (!seen.has(it.id)) seen.set(it.id, it)
    }
  }
  const items = [...seen.values()].slice(0, 20)
  return { count: items.length, items: items.map(it => itemView(it, ctx)) }
}

function createItem(call: CallOf<'create_item'>, ctx: ExecContext) {
  const inp = call.input
  let ownerId: string | undefined
  if (inp.owner_id !== undefined) {
    const owner = requireMember(ctx, inp.owner_id)
    if (owner.id !== ctx.speaker.id && !inp.explicit_assignment) {
      throw new ToolError(
        'use_send_request',
        `create_item 只给说话人自己的事项（或不指定负责人的想法）。要请${owner.name}做，请用 send_request（对方会收到通知并确认）；只有说话人明确说“记给他/她”时，才用 owner_id 加 explicit_assignment: true。`,
      )
    }
    ownerId = owner.id
  }
  const due = resolveDue(ctx, inp.due_date, inp.due_time)
  const now = ctx.clock.now()
  if (inp.kind === 'idea' && (due.dueAt || due.dueDate)) {
    throw new ToolError('invalid', '想法没有截止时间；有日期或时间的话请用 kind "task"（或 "reminder"）。')
  }
  if (inp.kind === 'reminder') {
    if (!due.dueAt && !due.dueDate) throw new ToolError('invalid', '提醒需要日期（due_date），通常还要时间（due_time）。')
    const fire = due.dueAt ? new Date(due.dueAt) : zonedToUtc(due.dueDate!, '09:00', ctx.tz)
    if (fire.getTime() <= now.getTime()) {
      throw new ToolError(
        'past_time',
        due.dueAt
          ? `提醒时间 ${describeLocal(ctx, due)} 已经过了，请换一个将来的时间。`
          : `只有日期的提醒会在当天 09:00 提醒，${due.dueDate} 09:00 已经过了；请给一个具体时间（due_time）。`,
      )
    }
  }
  if (!inp.allow_duplicate) {
    const dups = findDuplicates(ctx, inp.title)
    if (dups.length) {
      throw new ToolError(
        'possible_duplicate',
        '已经有同名的进行中事项了，什么都没有新建。如果说的是同一件事，请更新那一条（update_item / add_note / complete_item）；确定要另建一条，请把 allow_duplicate 设为 true。',
        { candidates: dups.map(d => itemView(d, ctx)) },
      )
    }
  }
  const item = ctx.domain.createItem(actorOf(ctx), {
    kind: inp.kind,
    title: inp.title,
    details: inp.details ?? null,
    ...(ownerId !== undefined ? { ownerId } : {}),
    dueAt: due.dueAt,
    dueDate: due.dueDate,
    priority: inp.priority,
  })
  touch(ctx, item)
  return { item: itemView(item, ctx), ...warnings(pastWarning(ctx, item)) }
}

function updateItem(call: CallOf<'update_item'>, ctx: ExecContext) {
  const inp = call.input
  const item = requireItem(ctx, inp.item_id)
  const changes: UpdateItemInput = {}
  if (inp.title !== undefined && inp.title !== item.title) changes.title = inp.title
  if (inp.kind !== undefined && inp.kind !== item.kind) {
    if (item.kind === 'request') throw new ToolError('invalid', '请求不能改成其他类型。')
    changes.kind = inp.kind
  }
  if (inp.priority !== undefined && inp.priority !== item.priority) changes.priority = inp.priority
  if (inp.status !== undefined && inp.status !== item.status) changes.status = inp.status
  if (inp.owner_id !== undefined && inp.owner_id !== item.ownerId) {
    const owner = requireMember(ctx, inp.owner_id)
    if (owner.id !== ctx.speaker.id && !inp.explicit_handover) {
      throw new ToolError(
        'use_send_request',
        `只有说话人明确说把这件事交给${owner.name}（“这个交给她”）时，才能直接改负责人（explicit_handover: true）。否则请用 send_request 请${owner.name}帮忙，对方需要确认。`,
      )
    }
    changes.ownerId = owner.id
  }
  let newDue: Due | null = null
  switch (inp.due_change) {
    case 'keep':
      if (inp.due_date !== undefined || inp.due_time !== undefined) {
        throw new ToolError('invalid', 'due_change 是 "keep" 时不要给 due_date / due_time；要改时间请用 "set"。')
      }
      break
    case 'clear':
      if (inp.due_date !== undefined || inp.due_time !== undefined) {
        throw new ToolError('invalid', 'due_change 是 "clear" 时不要给 due_date / due_time。')
      }
      if (item.dueAt || item.dueDate) {
        changes.dueAt = null
        changes.dueDate = null
      }
      break
    case 'set': {
      if (inp.due_date === undefined) throw new ToolError('invalid', 'due_change "set" 需要 due_date（还可以加 due_time）。')
      const due = resolveDue(ctx, inp.due_date, inp.due_time)
      if (due.dueAt !== item.dueAt || due.dueDate !== item.dueDate) {
        changes.dueAt = due.dueAt
        changes.dueDate = due.dueDate
        newDue = due
      }
      break
    }
  }
  if (Object.keys(changes).length === 0) {
    return { item: itemView(item, ctx), unchanged: true, message: '没有任何字段需要改动。' }
  }
  const updated = touch(ctx, ctx.domain.updateItem(actorOf(ctx), item.id, changes))
  return {
    item: itemView(updated, ctx),
    changed: Object.keys(changes),
    ...snoozeCleared(ctx, item, updated),
    ...warnings(droppedTimeWarning(ctx, item, inp.due_time, newDue), pastWarning(ctx, updated)),
  }
}

/** A new due time (or re-opening) ends an earlier snooze (domain applyUpdate): say so, the new time pings as usual. */
function snoozeCleared(ctx: ExecContext, before: Item, after: Item): Record<string, string> {
  const now = ctx.clock.now()
  const active = (i: Item) => !!i.snoozedUntil && new Date(i.snoozedUntil).getTime() > now.getTime()
  if (!active(before) || active(after)) return {}
  return { snooze_cleared: `之前推迟到 ${formatInstantZh(before.snoozedUntil!, now, ctx.tz)}，现在取消了推迟，按新的时间提醒。` }
}

function addNote(call: CallOf<'add_note'>, ctx: ExecContext) {
  const item = requireItem(ctx, call.input.item_id)
  ctx.domain.addNote(actorOf(ctx), item.id, call.input.text)
  touch(ctx, item)
  return { item: itemView(ctx.domain.getItem(item.id) ?? item, ctx), note: call.input.text }
}

function sendRequest(call: CallOf<'send_request'>, ctx: ExecContext) {
  const inp = call.input
  const to = requireMember(ctx, inp.to_member_id)
  if (to.id === ctx.speaker.id) throw new ToolError('invalid', '不能给自己发请求；说话人自己要做的话请用 create_item。')
  const hasDue = inp.due_date !== undefined
  const due = resolveDue(ctx, inp.due_date, inp.due_time)
  const actor = actorOf(ctx)

  if (inp.existing_item_id !== undefined) {
    const item = requireItem(ctx, inp.existing_item_id)
    if (item.kind === 'request') return resendRequest(ctx, item, to, inp, hasDue ? due : null)
    if (isClosed(item)) {
      throw new ToolError('invalid', `「${item.title}」已经${statusLabel(item.status)}了。要重新请人做，请不带 existing_item_id 发一个新请求。`)
    }
    if (item.ownerId === to.id) {
      throw new ToolError(
        'already_owner',
        `「${item.title}」已经是${to.name}负责的了，不需要再发请求。要提醒${to.name}请用 set_reminder（member_ids 填对方），要改时间请用 update_item。`,
      )
    }
    if (item.kind !== 'idea' && item.ownerId && item.ownerId !== ctx.speaker.id) {
      // Replacing it would close another member's own task by the speaker's utterance (owner rule, SPEC §4).
      const owner = nameLookup(ctx.members)(item.ownerId)
      throw new ToolError(
        'not_owner',
        `「${item.title}」是${owner}负责的事项，不能由说话人改成请${to.name}做的请求（那样会关掉${owner}的事项）。只有说话人明确要把它交给${to.name}时，才用 update_item（owner_id + explicit_handover: true）；不清楚的话请先问。`,
      )
    }
    // An idea stays and gets a linked request; a task/reminder is replaced by the request (one item per thing).
    const req = touch(
      ctx,
      ctx.domain.sendRequest(actor, {
        toMemberId: to.id,
        title: inp.title,
        details: inp.details ?? item.details,
        dueAt: hasDue ? due.dueAt : item.dueAt,
        dueDate: hasDue ? due.dueDate : item.dueDate,
        priority: inp.priority === 'normal' ? item.priority : inp.priority,
        parentId: item.kind === 'idea' ? item.id : item.parentId,
      }),
    )
    const warn = warnings(droppedTimeWarning(ctx, item, inp.due_time, hasDue ? due : null), pastWarning(ctx, req))
    if (item.kind === 'idea') {
      return { item: itemView(req, ctx), waiting_for: to.name, linked_idea: itemView(item, ctx), ...warn }
    }
    const replaced = touch(ctx, ctx.domain.updateItem(actor, item.id, { status: 'dropped' }, `改成请求 → ${to.name}`))
    return {
      item: itemView(req, ctx),
      waiting_for: to.name,
      replaced: { ...itemView(replaced, ctx), note: `原来的事项已关闭，改成了请${to.name}做的请求` },
      ...warn,
    }
  }

  if (!inp.allow_duplicate) {
    const dups = findDuplicates(ctx, inp.title)
    if (dups.length) {
      throw new ToolError(
        'possible_duplicate',
        '已经有同名的进行中事项了，什么都没有发送。如果说的是同一件事，请用 existing_item_id 指向它（会重新发送或转成请求）；确定要另发一个请求，请把 allow_duplicate 设为 true。',
        { candidates: dups.map(d => itemView(d, ctx)) },
      )
    }
  }
  const req = touch(
    ctx,
    ctx.domain.sendRequest(actor, {
      toMemberId: to.id,
      title: inp.title,
      details: inp.details ?? null,
      dueAt: due.dueAt,
      dueDate: due.dueDate,
      priority: inp.priority,
    }),
  )
  return { item: itemView(req, ctx), waiting_for: to.name, ...warnings(pastWarning(ctx, req)) }
}

/** send_request with an existing request: re-send (declined/closed), re-route (another person) or just update it. */
function resendRequest(ctx: ExecContext, item: Item, to: Member, inp: CallOf<'send_request'>['input'], due: Due | null) {
  const changes: UpdateItemInput = {}
  if (inp.title !== item.title) changes.title = inp.title
  if (inp.details !== undefined && inp.details !== item.details) changes.details = inp.details
  if (due && (due.dueAt !== item.dueAt || due.dueDate !== item.dueDate)) {
    changes.dueAt = due.dueAt
    changes.dueDate = due.dueDate
  }
  if (inp.priority !== 'normal' && inp.priority !== item.priority) changes.priority = inp.priority
  if (item.ownerId !== to.id) changes.ownerId = to.id
  if (item.status === 'declined' || isClosed(item)) changes.status = 'pending'
  if (Object.keys(changes).length === 0) {
    const already = item.status === 'pending' ? `已经在等${to.name}回复了` : `${to.name}已经${statusLabel(item.status)}`
    return { item: itemView(item, ctx), unchanged: true, message: `${already}，没有重新发送。` }
  }
  const updated = touch(ctx, ctx.domain.updateItem(actorOf(ctx), item.id, changes))
  return {
    item: itemView(updated, ctx),
    waiting_for: updated.status === 'pending' ? to.name : undefined,
    changed: Object.keys(changes),
    ...warnings(changes.dueDate !== undefined ? droppedTimeWarning(ctx, item, inp.due_time, due) : null, pastWarning(ctx, updated)),
  }
}

const ACCEPTED_REQUEST: readonly Item['status'][] = ['accepted', 'in_progress', 'blocked']

function respondToRequest(call: CallOf<'respond_to_request'>, ctx: ExecContext) {
  const item = requireItem(ctx, call.input.item_id)
  if (item.kind === 'request' && call.input.response === 'decline' && item.ownerId === ctx.speaker.id && ACCEPTED_REQUEST.includes(item.status)) {
    throw new ToolError(
      'already_accepted',
      `「${item.title}」已经接受了，不能再拒绝。说话人现在做不了的话，请用 complete_item（resolution "dropped"，原因写在 note）。`,
    )
  }
  const updated = touch(ctx, ctx.domain.respondToRequest(actorOf(ctx), item.id, call.input.response, call.input.message))
  return { item: itemView(updated, ctx), requester_notified: updated.requestedBy ? nameLookup(ctx.members)(updated.requestedBy) : undefined }
}

/**
 * Dropping a request concerns the other side (the requester when the owner backs out, the owner when the requester
 * takes it back): the domain sends them a request_answered "dropped" notice. Report whether the drop notified them,
 * so the reply never implies they know when they don't (e.g. a second drop in the same round sends nothing new).
 * Rows the drop created are told apart from older ones by id. A pending request whose request_new was still waiting
 * in the outbox never reached its owner: the drop withdraws it and the owner is not told (withdrawn_before_delivery).
 */
function droppedRequestNotice(ctx: ExecContext, before: Item, rowsBefore: readonly ScheduledNotification[]): Record<string, string> {
  if (before.status === 'declined') return {} // the owner already said no: both sides know it is not happening
  const nameOf = nameLookup(ctx.members)
  const ownerUnaware =
    before.status === 'pending' && rowsBefore.some(n => n.kind === 'request_new' && n.memberId === before.ownerId && n.status === 'scheduled')
  const others = [...new Set([before.ownerId, before.requestedBy])].filter(
    (id): id is string => !!id && id !== ctx.speaker.id && !(ownerUnaware && id === before.ownerId),
  )
  const seen = new Set(rowsBefore.map(n => n.id))
  const fresh = (ctx.domain.getItemDetail(before.id)?.notifications ?? []).filter(n => !seen.has(n.id) && n.status !== 'cancelled')
  const told = others.filter(id => fresh.some(n => n.memberId === id))
  const untold = others.filter(id => !told.includes(id))
  const out: Record<string, string> = {}
  const messages: string[] = []
  if (ownerUnaware && before.ownerId && before.ownerId !== ctx.speaker.id) {
    const owner = nameOf(before.ownerId)
    out.withdrawn_before_delivery = owner
    messages.push(`${owner}还没收到这个请求，已经撤回，不会再通知${owner}。`)
  }
  if (told.length) out.notified = told.map(nameOf).join('、')
  if (untold.length) {
    const names = untold.map(nameOf).join('、')
    out.not_notified = names
    messages.push(`${names}不会自动收到通知，可能还以为这件事有人做。请在回复里提醒说话人跟${names}说一声。`)
  }
  if (messages.length) out.message = messages.join(' ')
  return out
}

function completeItem(call: CallOf<'complete_item'>, ctx: ExecContext) {
  const { item_id, resolution, note } = call.input
  const item = requireItem(ctx, item_id)
  if (item.status === resolution) return { item: itemView(item, ctx), already: true }
  const droppingRequest = item.kind === 'request' && resolution === 'dropped'
  if (droppingRequest && item.status === 'pending' && item.ownerId === ctx.speaker.id) {
    const requester = item.requestedBy ? nameLookup(ctx.members)(item.requestedBy) : '对方'
    throw new ToolError(
      'use_respond_to_request',
      `「${item.title}」是${requester}请说话人做、还在等回复的请求，什么都没有改。说话人做不了的话，请用 respond_to_request（response "decline"，原因写在 message），${requester}会收到通知。`,
    )
  }
  const rowsBefore = droppingRequest ? (ctx.domain.getItemDetail(item.id)?.notifications ?? []) : null
  const actor = actorOf(ctx)
  let updated: Item
  if (resolution === 'done') {
    updated = ctx.domain.completeItem(actor, item.id, note)
  } else {
    // the note is also the drop's reason: a dropped request's notice to the other side quotes it (去不了了)
    updated = ctx.domain.updateItem(actor, item.id, { status: 'dropped' }, note)
    if (note) ctx.domain.addNote(actor, item.id, note)
  }
  touch(ctx, updated)
  return { item: itemView(ctx.domain.getItem(item.id) ?? updated, ctx), ...(rowsBefore ? droppedRequestNotice(ctx, item, rowsBefore) : {}) }
}

function snoozeItem(call: CallOf<'snooze_item'>, ctx: ExecContext) {
  const { item_id, preset, until_date, until_time } = call.input
  const item = requireItem(ctx, item_id)
  const now = ctx.clock.now()
  let until: Date
  if (preset === 'custom') {
    if (until_date === undefined) throw new ToolError('invalid', 'preset "custom" 需要 until_date（和 until_time）。')
    if (!isLocalDate(until_date)) throw new ToolError('invalid', `日期不存在：${until_date}`)
    until = zonedToUtc(until_date, until_time ?? '09:00', ctx.tz)
  } else {
    if (until_date !== undefined || until_time !== undefined) {
      throw new ToolError('invalid', 'until_date / until_time 只和 preset "custom" 一起用。')
    }
    until = resolveSnoozePreset(preset, now, ctx.tz)
  }
  if (until.getTime() <= now.getTime()) throw new ToolError('past_time', `推迟到的时间 ${formatInstantZh(until, now, ctx.tz)} 已经过了，请换一个将来的时间。`)
  const updated = touch(ctx, ctx.domain.snoozeItem(actorOf(ctx), item.id, until))
  const untilLabel = formatInstantZh(until, now, ctx.tz)
  return { item: itemView(updated, ctx), until: untilLabel, ...snoozeEffect(ctx, updated, until, untilLabel) }
}

/**
 * While an item is snoozed the scheduler holds back its own pings (the due-time ping, the evening-before ping, a
 * reminder item's ping; scheduler/relevance.ts) and pings once at `until`. The due date itself stays, and extra
 * pings set with set_reminder still fire: say both, so the reply neither claims a new date nor more silence than
 * there is.
 */
function snoozeEffect(ctx: ExecContext, item: Item, until: Date, untilLabel: string): Record<string, unknown> {
  const now = ctx.clock.now()
  const extra = extraPings(ctx.domain, item.id, now).filter(n => new Date(n.fireAt).getTime() < until.getTime())
  const extraLabels = [...new Set(extra.map(n => formatInstantZh(n.fireAt, now, ctx.tz)))].slice(0, 3)
  const dueBefore = item.dueAt ? new Date(item.dueAt).getTime() < until.getTime() : item.dueDate ? item.dueDate < localDate(until, ctx.tz) : false
  const parts: string[] = []
  if (dueBefore) {
    parts.push(
      `截止时间还是${dueLabel(item, now, ctx.tz) ?? item.dueDate ?? ''}，在推迟时间之前，没有改：这期间到期也不会提醒。如果事情本身改到以后了（下周再交 / 改天再弄），请改用 update_item（due_change "set"）改截止日期，这也会取消推迟。`,
    )
  }
  if (extraLabels.length) parts.push(`单独设置的提醒 ${extraLabels.join('、')} 照常会发；不要的话用 cancel_reminder。`)
  return {
    effect: `${untilLabel} 之前不再提醒这件事，到时候再提醒一次。`,
    ...(extraLabels.length ? { extra_pings_still_fire: extraLabels } : {}),
    ...(parts.length ? { warning: parts.join(' ') } : {}),
  }
}

function cancelReminder(call: CallOf<'cancel_reminder'>, ctx: ExecContext) {
  const { item_id, remind_date, remind_time } = call.input
  const item = requireItem(ctx, item_id)
  if (!isLocalDate(remind_date)) throw new ToolError('invalid', `日期不存在：${remind_date}`)
  const now = ctx.clock.now()
  const nameOf = nameLookup(ctx.members)
  const pings = extraPings(ctx.domain, item.id, now)
  const local = (n: ScheduledNotification) => `${localDate(new Date(n.fireAt), ctx.tz)} ${localTime(new Date(n.fireAt), ctx.tz)}`
  const hits = pings.filter(n => local(n) === `${remind_date} ${remind_time}`)
  if (!hits.length) {
    const existing = pings.map(n => `${formatInstantZh(n.fireAt, now, ctx.tz)}（${local(n)}）→ ${nameOf(n.memberId)}`)
    const hint =
      item.kind === 'reminder'
        ? '这是一个提醒事项，它本身的提醒不用 cancel_reminder：不要了用 complete_item "dropped"，改时间用 update_item。'
        : '截止时间本身的提醒不能单独取消：事情不做了用 complete_item "dropped"；只是不要截止日期和它的提醒，用 update_item（due_change "clear"）。'
    throw new ToolError(
      'not_found',
      `「${item.title}」在 ${remind_date} ${remind_time} 没有单独设置的提醒，什么都没有取消。${existing.length ? `它现有的单独提醒：${existing.join('；')}。` : '它没有单独设置的提醒。'}${hint}`,
    )
  }
  for (const n of hits) ctx.domain.cancelReminder(actorOf(ctx), n.id)
  touch(ctx, item)
  const remaining = extraPings(ctx.domain, item.id, now).map(n => `${formatInstantZh(n.fireAt, now, ctx.tz)} → ${nameOf(n.memberId)}`)
  return {
    item: itemView(ctx.domain.getItem(item.id) ?? item, ctx),
    cancelled: { at: formatInstantZh(hits[0]!.fireAt, now, ctx.tz), for: [...new Set(hits.map(n => nameOf(n.memberId)))] },
    ...(remaining.length ? { remaining_extra_pings: remaining } : {}),
  }
}

function setReminder(call: CallOf<'set_reminder'>, ctx: ExecContext) {
  const { item_id, remind_date, remind_time, member_ids } = call.input
  const item = requireItem(ctx, item_id)
  if (isClosed(item)) throw new ToolError('invalid', `「${item.title}」已经${statusLabel(item.status)}了，不需要提醒。`)
  const ids = [...new Set(member_ids?.length ? member_ids : [item.ownerId ?? ctx.speaker.id])]
  const members = ids.map(id => requireMember(ctx, id))
  if (!isLocalDate(remind_date)) throw new ToolError('invalid', `日期不存在：${remind_date}`)
  const fireAt = zonedToUtc(remind_date, remind_time, ctx.tz)
  const now = ctx.clock.now()
  if (fireAt.getTime() <= now.getTime()) {
    throw new ToolError('past_time', `提醒时间 ${remind_date} ${remind_time} 已经过了，请换一个将来的时间。`)
  }
  for (const m of members) {
    ctx.domain.setReminder(actorOf(ctx), { itemId: item.id, memberId: m.id, fireAt: fireAt.toISOString(), message: item.title })
  }
  touch(ctx, item)
  return {
    item: itemView(ctx.domain.getItem(item.id) ?? item, ctx),
    reminders: members.map(m => (m.id === ctx.speaker.id ? `${m.name}（说话人）` : m.name)),
    at: formatInstantZh(fireAt, now, ctx.tz),
  }
}
