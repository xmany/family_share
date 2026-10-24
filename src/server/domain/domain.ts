// The domain service — the only code that writes items, notes, events, utterances and members.
// See docs/SPEC.md §1–3 and domain/types.ts for the contract.

import type { BoardResponse, ItemDetailResponse, ServerEvent, UndoResponse } from '../../shared/api'
import type {
  EventType,
  Family,
  Item,
  ItemKind,
  ItemStatus,
  Member,
  MemberRole,
  Note,
  Priority,
  ScheduledNotification,
  Utterance,
  UtteranceSource,
  UtteranceStatus,
} from '../../shared/types'
import { ACTIVE_STATUSES, CLOSED_STATUSES } from '../../shared/types'
import type { Bus } from '../bus'
import type { Config } from '../config'
import type { Db } from '../db/db'
import { parseJson } from '../db/db'
import { newId } from '../ids'
import { Outbox } from '../notify/outbox'
import type { NewNotification } from '../notify/outbox'
import type { Clock } from '../time'
import { DAY, isLocalDate, isValidTimezone, parseHHMM, zonedToUtc } from '../time'
import { normalizeForSearch } from './normalize'
import type {
  Actor,
  CreateItemInput,
  Domain,
  FinishUtteranceInput,
  MemberPatch,
  NewMemberInput,
  SearchItemsQuery,
  SendRequestInput,
  SetReminderInput,
  UpdateItemInput,
} from './types'
import { DomainError } from './types'
import type { FieldChanges, NameOf } from './describe'
import {
  clip,
  kindLabel,
  nameLookup,
  statusLabel,
  summarizeCreated,
  summarizeFieldsUpdated,
  summarizeNote,
  summarizeReassigned,
  summarizeReminderCancelled,
  summarizeReminderSet,
  summarizeRequestSent,
  summarizeResponded,
  summarizeSnoozed,
  summarizeStatus,
  summarizeUndone,
} from './describe'
import type { PolicyEnv } from './policy'
import {
  NON_ANSWER_KINDS,
  REQUEST_ROUND_KINDS,
  isTimingKey,
  planAssigned,
  planExplicitReminder,
  planRequestAnswered,
  planRequestDropped,
  planRequestSent,
  planTiming,
  requestFollowupAt,
  requestNoreplyAt,
  requestReachesOwnerAt,
  timingKeys,
} from './policy'
import type { EventRow, ItemRow, NotificationRowLite, UtteranceRow } from './repo'
import {
  ACTIVE_SQL,
  changesForUtterances,
  getFamilyRow,
  getItemRow,
  getMemberRow,
  getNotificationByKey,
  getNotificationLite,
  getUtteranceRow,
  insertItemRow,
  listMemberRows,
  listNoteRows,
  requestRounds,
  rowsToItems,
  toEvent,
  toFamily,
  toItem,
  toMember,
  toNote,
  toUtterance,
  updateItemRow,
} from './repo'

export interface DomainDeps {
  db: Db
  clock: Clock
  bus: Bus
  /**
   * The app's outbox (same db). The domain writes through its own bus-less Outbox on the same db instead, so that
   * enqueueing inside a transaction never wakes the scheduler mid-transaction; it wakes it after commit.
   */
  outbox: Outbox
  config: Pick<Config, 'scheduler' | 'publicUrl'>
}

/** Avatar colors handed out in order to new members (then cycled). */
export const MEMBER_PALETTE = ['#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'] as const

export const TITLE_MAX = 200
export const TEXT_MAX = 2000
export const REMINDER_MESSAGE_MAX = 200
export const MEMBER_NAME_MAX = 40

const KINDS: readonly ItemKind[] = ['task', 'request', 'idea', 'reminder']
const STATUSES: readonly ItemStatus[] = [...ACTIVE_STATUSES, ...CLOSED_STATUSES]
const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high']
const ROLES: readonly MemberRole[] = ['adult', 'kid', 'relative']
const SOURCES: readonly UtteranceSource[] = ['text', 'voice', 'clarification', 'wechat', 'whatsapp']
const UTTERANCE_STATUSES: readonly UtteranceStatus[] = ['processing', 'done', 'clarify', 'error', 'undone']

/** Item fields that events record in payload.before / payload.after (and undo may revert). */
const REVERTIBLE_FIELDS = [
  'kind',
  'title',
  'details',
  'status',
  'ownerId',
  'dueAt',
  'dueDate',
  'snoozedUntil',
  'snoozeCount',
  'priority',
  'parentId',
  'tags',
  'completedAt',
  'respondedAt',
] as const
type RevertibleField = (typeof REVERTIBLE_FIELDS)[number]
type ItemPatch = Partial<Pick<Item, RevertibleField>>

/**
 * Fields that undo reverts together or not at all: reverting dueDate while a later edit kept a new dueAt would
 * leave both set, and reverting respondedAt/completedAt without the status would leave a half-reverted state.
 */
const REVERT_GROUPS: readonly (readonly RevertibleField[])[] = [
  ['status', 'completedAt', 'respondedAt'],
  ['dueAt', 'dueDate'],
  ['snoozedUntil', 'snoozeCount'],
  ['kind'],
  ['title'],
  ['details'],
  ['ownerId'],
  ['priority'],
  ['parentId'],
  ['tags'],
]

const invalid = (message: string): never => {
  throw new DomainError('invalid', message)
}
const isClosed = (s: ItemStatus) => CLOSED_STATUSES.includes(s)
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Per-write context, created inside the transaction. */
interface Tx {
  actor: Actor
  now: Date
  nowIso: string
  tz: string
  members: Member[]
  nameOf: NameOf
  utteranceId: string | null
  /** item ids to report in board_changed */
  touched: Set<string>
  dirty: boolean
  /** a row due now was written: wake the scheduler after commit */
  wake: boolean
}

interface StatusPlan {
  respond?: 'accept' | 'decline'
  resend?: boolean
  closing?: boolean
  reopening?: boolean
}

export function createDomain(deps: DomainDeps): Domain {
  const { db, clock, bus, config } = deps
  // No bus: Outbox.enqueue would otherwise call bus.wakeScheduler() inside our transaction (a synchronous
  // listener could then read or write uncommitted rows, or abort the transaction by throwing).
  const outbox = new Outbox(db, clock)

  // -------------------------------------------------------------------------------------------
  // helpers: reads

  function familyOrThrow(): Family {
    const r = getFamilyRow(db)
    if (!r) throw new DomainError('not_found', '家庭还没有初始化')
    return toFamily(r)
  }

  function loadItem(id: string): Item | null {
    const r = getItemRow(db, id)
    return r ? toItem(r, outbox.nextForItem(id)) : null
  }

  function requireItem(id: string): Item {
    const item = typeof id === 'string' ? loadItem(id) : null
    if (!item) throw new DomainError('not_found', `找不到这个事项（${String(id)}）`)
    return item
  }

  function requireMemberRef(tx: Tx, id: unknown, what = '成员'): Member {
    const m = typeof id === 'string' ? tx.members.find(x => x.id === id) : undefined
    if (!m) return invalid(`找不到这个${what}（${String(id)}）`)
    return m
  }

  function requireActorMember(tx: Tx): Member {
    if (!tx.actor.memberId) return invalid('需要知道是哪位家人在操作')
    return requireMemberRef(tx, tx.actor.memberId)
  }

  // -------------------------------------------------------------------------------------------
  // helpers: validation

  function normTitle(v: unknown): string {
    if (typeof v !== 'string') return invalid('标题不能为空')
    const t = v.replace(/\s+/g, ' ').trim()
    if (t.length === 0) return invalid('标题不能为空')
    if (t.length > TITLE_MAX) return invalid(`标题太长了（最多 ${TITLE_MAX} 个字）`)
    return t
  }

  function normText(v: unknown, what: string, max = TEXT_MAX): string | null {
    if (v === null || v === undefined) return null
    if (typeof v !== 'string') return invalid(`${what}格式不对`)
    const t = v.trim()
    if (t.length > max) return invalid(`${what}太长了（最多 ${max} 个字）`)
    return t === '' ? null : t
  }

  /**
   * ISO 8601 instant with Z or an offset; a local "YYYY-MM-DDTHH:MM" without offset is read in the family timezone.
   * Anything else is rejected: `new Date()` would read other formats in the SERVER's timezone and silently roll
   * impossible dates over (2026-02-30 → March 2).
   */
  function normInstant(tx: Tx, v: unknown, what: string): string {
    const bad = (s: string): never => invalid(`${what}不是有效的时间：${s}（需要 ISO 8601，如 2026-10-24T08:30:00+11:00）`)
    if (typeof v !== 'string' || v.trim() === '') return invalid(`${what}格式不对，需要 ISO 8601 时间`)
    const s = v.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return invalid(`${what}需要具体时间；只有日期请用 dueDate（YYYY-MM-DD）`)
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s)
    if (!m) return bad(s)
    const [, date, hh, mm, ss, offset] = m
    if (!isLocalDate(date!) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) return bad(s)
    if (!offset) return zonedToUtc(date!, `${hh}:${mm}`, tx.tz).toISOString()
    const t = new Date(s.replace(' ', 'T'))
    if (Number.isNaN(t.getTime())) return bad(s)
    return t.toISOString()
  }

  function normDate(v: unknown): string {
    if (typeof v !== 'string' || !isLocalDate(v.trim())) return invalid(`日期格式不对，需要 YYYY-MM-DD：${String(v)}`)
    return v.trim()
  }

  function normPriority(v: unknown): Priority {
    if (!PRIORITIES.includes(v as Priority)) return invalid('优先级只能是 low / normal / high')
    return v as Priority
  }

  function normTags(v: unknown): string[] {
    if (!Array.isArray(v)) return invalid('标签需要是字符串列表')
    const out: string[] = []
    for (const t of v) {
      if (typeof t !== 'string') return invalid('标签需要是字符串列表')
      const s = t.trim()
      if (s && s.length <= 30 && !out.includes(s)) out.push(s)
    }
    return out.slice(0, 20)
  }

  function normParent(v: unknown, selfId: string | null): string {
    if (typeof v !== 'string' || !getItemRow(db, v)) return invalid(`找不到上级事项（${String(v)}）`)
    if (v === selfId) return invalid('事项不能是自己的上级')
    return v
  }

  function normAliases(v: unknown): string[] {
    if (!Array.isArray(v)) return invalid('别名需要是字符串列表')
    const out: string[] = []
    for (const a of v) {
      if (typeof a !== 'string') return invalid('别名需要是字符串列表')
      const s = a.trim()
      if (s && s.length <= MEMBER_NAME_MAX && !out.includes(s)) out.push(s)
    }
    return out
  }

  function normHHMM(v: unknown, what: string): string {
    const p = typeof v === 'string' ? parseHHMM(v) : null
    if (!p) return invalid(`${what}格式不对，需要 HH:MM`)
    return `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`
  }

  function normMemberName(v: unknown, exceptId: string | null): string {
    if (typeof v !== 'string' || v.trim() === '') return invalid('名字不能为空')
    const name = v.trim()
    if (name.length > MEMBER_NAME_MAX) return invalid(`名字太长了（最多 ${MEMBER_NAME_MAX} 个字）`)
    const clash = listMemberRows(db).find(m => m.id !== exceptId && m.name.toLowerCase() === name.toLowerCase())
    if (clash) return invalid(`已经有叫「${name}」的家人了`)
    return name
  }

  // -------------------------------------------------------------------------------------------
  // helpers: transactions, events, notifications

  function beginTx(actor: Actor): Tx {
    if (!actor || !['member', 'ai', 'system'].includes(actor.type)) invalid('未知的操作者')
    const family = familyOrThrow()
    const members = listMemberRows(db).map(toMember)
    if (actor.memberId && !members.some(m => m.id === actor.memberId)) invalid(`找不到这个成员（${actor.memberId}）`)
    if ((actor.type === 'member' || actor.type === 'ai') && !actor.memberId) invalid('需要知道是哪位家人在操作')
    const utteranceId = actor.utteranceId ?? null
    if (utteranceId) {
      const u = getUtteranceRow(db, utteranceId)
      if (!u) invalid(`找不到这条消息记录（${utteranceId}）`)
      // changes are undone per utterance: they must belong to the member who said it …
      if (u!.member_id !== actor.memberId) invalid('这条消息不是这位家人说的')
      // … and nothing may be added to an utterance after it was undone (the interpreter may still be running)
      if (u!.status === 'undone') throw new DomainError('conflict', '这句话已经撤销了，不再执行新的改动')
    }
    const now = clock.now()
    return {
      actor,
      now,
      nowIso: now.toISOString(),
      tz: family.timezone,
      members,
      nameOf: nameLookup(members),
      utteranceId,
      touched: new Set(),
      dirty: false,
      wake: false,
    }
  }

  /** Bus listeners run after commit; a throwing listener must not make a committed write look failed. */
  function safeEmit(fn: () => void): void {
    try {
      fn()
    } catch (e) {
      console.error('[domain] bus listener failed', e)
    }
  }

  function broadcastBoard(itemIds: string[], actor: Actor | null, utteranceId?: string | null): void {
    const ev: ServerEvent = { type: 'board_changed', itemIds }
    const uid = utteranceId ?? actor?.utteranceId
    if (uid) ev.utteranceId = uid
    if (actor) ev.byMemberId = actor.memberId
    safeEmit(() => bus.broadcast(ev))
  }

  function afterCommit(tx: Tx | null): void {
    if (tx?.wake) safeEmit(() => bus.wakeScheduler())
  }

  /** Runs fn in one SQLite transaction; broadcasts board_changed (and wakes the scheduler) after commit. */
  function write<T>(actor: Actor, fn: (tx: Tx) => T): T {
    let ctx: Tx | null = null
    const result = db.transaction(() => {
      ctx = beginTx(actor)
      return fn(ctx)
    })()
    const done = ctx as Tx | null
    afterCommit(done)
    if (done && done.dirty) broadcastBoard([...done.touched], actor)
    return result
  }

  function policyEnv(tx: Tx): PolicyEnv {
    return {
      now: tx.now,
      timezone: tx.tz,
      scheduler: config.scheduler,
      members: tx.members,
      actorMemberId: tx.actor.memberId,
      utteranceId: tx.utteranceId,
    }
  }

  function insertEvent(
    tx: Tx,
    itemId: string | null,
    type: EventType,
    summary: string,
    payload: Record<string, unknown>,
    opts: { utteranceId?: string | null } = {},
  ): number {
    const res = db
      .prepare(
        `INSERT INTO events (item_id, actor_type, member_id, type, summary, payload, utterance_id, undone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        itemId,
        tx.actor.type,
        tx.actor.memberId,
        type,
        summary,
        JSON.stringify(payload),
        opts.utteranceId === undefined ? tx.utteranceId : opts.utteranceId,
        tx.nowIso,
      )
    tx.dirty = true
    if (itemId) tx.touched.add(itemId)
    return Number(res.lastInsertRowid)
  }

  function patchEventPayload(eventId: number, patch: Record<string, unknown>): void {
    const r = db.prepare('SELECT payload FROM events WHERE id = ?').get(eventId) as { payload: string } | undefined
    if (!r) return
    const payload = { ...parseJson<Record<string, unknown>>(r.payload, {}), ...patch }
    db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(payload), eventId)
  }

  function saveItem(tx: Tx, item: Item): void {
    item.updatedAt = tx.nowIso
    item.lastActivityAt = tx.nowIso
    updateItemRow(db, item)
    tx.dirty = true
    tx.touched.add(item.id)
  }

  /**
   * Enqueues a notification; when the dedupe key already exists:
   * - cancelled → revived with the new content and fire time (so re-planning after a change-and-change-back works),
   * - scheduled → recipient/text refreshed (fire time untouched, it may have been deferred by the scheduler),
   * - sent/skipped/failed → left alone.
   */
  function upsertNotification(tx: Tx, n: NewNotification, opts: { keepUtterance?: boolean } = {}): ScheduledNotification | null {
    const created = outbox.enqueue(n)
    if (created) {
      if (new Date(created.fireAt).getTime() <= tx.now.getTime()) tx.wake = true
      return created
    }
    const ex = getNotificationByKey(db, n.dedupeKey)
    if (!ex) return null
    const actionsJson = JSON.stringify(n.actions ?? [])
    const respect = n.respectQuietHours === false ? 0 : 1
    if (ex.status === 'cancelled') {
      const fireAt = n.fireAt ? new Date(n.fireAt) : tx.now
      // url: keep the row's (the Outbox chose the default route when it was first inserted)
      db.prepare(
        `UPDATE notifications SET status = 'scheduled', member_id = ?, item_id = ?, fire_at = ?, title = ?, body = ?, url = COALESCE(?, url),
         actions = ?, respect_quiet_hours = ?, attempts = 0, sent_at = NULL, last_error = NULL,
         utterance_id = CASE WHEN ? THEN utterance_id ELSE ? END
         WHERE id = ?`,
      ).run(
        n.memberId,
        n.itemId ?? null,
        fireAt.toISOString(),
        n.title,
        n.body,
        n.url ?? null,
        actionsJson,
        respect,
        opts.keepUtterance ? 1 : 0,
        n.utteranceId ?? null,
        ex.id,
      )
      if (fireAt.getTime() <= tx.now.getTime()) tx.wake = true
    } else if (ex.status === 'scheduled') {
      if (ex.member_id !== n.memberId || ex.title !== n.title || ex.body !== n.body || ex.actions !== actionsJson) {
        db.prepare(`UPDATE notifications SET member_id = ?, title = ?, body = ?, actions = ?, respect_quiet_hours = ? WHERE id = ?`).run(
          n.memberId,
          n.title,
          n.body,
          actionsJson,
          respect,
          ex.id,
        )
      }
    }
    return outbox.get(ex.id)
  }

  /** Cancels stale timing rows and (re)plans the current ones. Returns the ids it cancelled. */
  function reconcileTiming(tx: Tx, item: Item, opts: { keepUtterance?: boolean } = {}): string[] {
    const valid = new Set(timingKeys(item))
    const cancelled: string[] = []
    for (const n of outbox.scheduledForItem(item.id)) {
      if (isTimingKey(n.dedupeKey) && !valid.has(n.dedupeKey) && outbox.cancel(n.id)) cancelled.push(n.id)
    }
    for (const plan of planTiming(item, policyEnv(tx))) upsertNotification(tx, plan, opts)
    return cancelled
  }

  function cancelKinds(itemId: string, kinds?: ScheduledNotification['kind'][]): string[] {
    return outbox.cancelForItem(itemId, kinds)
  }

  /**
   * Re-schedules notifications that an earlier change cancelled, when they are relevant again
   * (still in the future, item active, right recipient). Timing rows are left to reconcileTiming.
   */
  function restoreCancelled(tx: Tx, ids: unknown, item: Item): void {
    if (!Array.isArray(ids) || isClosed(item.status)) return
    for (const id of ids) {
      if (typeof id !== 'string') continue
      const row = getNotificationLite(db, id)
      if (!row || row.status !== 'cancelled' || row.item_id !== item.id) continue
      if (new Date(row.fire_at).getTime() <= tx.now.getTime()) continue
      if (isTimingKey(row.dedupe_key)) continue
      if (!isRelevant(row, item)) continue
      outbox.reschedule(id)
    }
  }

  function isRelevant(row: NotificationRowLite, item: Item): boolean {
    switch (row.kind) {
      case 'request_new':
      case 'request_followup':
        return item.kind === 'request' && item.status === 'pending' && row.member_id === item.ownerId
      case 'request_noreply':
        return item.kind === 'request' && item.status === 'pending' && row.member_id === item.requestedBy
      case 'assigned':
        return row.member_id === item.ownerId
      case 'explicit':
        return row.dedupe_key.startsWith('explicit:')
      default:
        return false
    }
  }

  /** When a closed item is re-opened by hand: bring back explicit/assigned rows its closing cancelled. */
  function restoreAfterReopen(tx: Tx, item: Item): void {
    const rows = db
      .prepare(
        `SELECT payload FROM events WHERE item_id = ? AND undone = 0 AND type IN ('item_completed', 'status_changed')
         ORDER BY id DESC LIMIT 5`,
      )
      .all(item.id) as { payload: string }[]
    for (const r of rows) {
      const p = parseJson<Record<string, unknown>>(r.payload, {})
      const after = p.after as ItemPatch | undefined
      if (after?.status && isClosed(after.status)) {
        restoreCancelled(tx, p.cancelled, item)
        return
      }
    }
  }

  function snapshot(item: Item): ItemPatch & Pick<Item, 'id' | 'createdBy' | 'requestedBy'> {
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      details: item.details,
      status: item.status,
      ownerId: item.ownerId,
      createdBy: item.createdBy,
      requestedBy: item.requestedBy,
      dueAt: item.dueAt,
      dueDate: item.dueDate,
      priority: item.priority,
      parentId: item.parentId,
      tags: item.tags,
      snoozedUntil: item.snoozedUntil,
      snoozeCount: item.snoozeCount,
      completedAt: item.completedAt,
      respondedAt: item.respondedAt,
    }
  }

  /** before/after containing only the given fields that actually differ. */
  function diff(before: Item, after: Item, fields: readonly RevertibleField[]): { before: ItemPatch; after: ItemPatch } | null {
    const b: Record<string, unknown> = {}
    const a: Record<string, unknown> = {}
    for (const f of fields) {
      if (!sameValue(before[f], after[f])) {
        b[f] = before[f]
        a[f] = after[f]
      }
    }
    return Object.keys(a).length ? { before: b as ItemPatch, after: a as ItemPatch } : null
  }

  function insertNote(tx: Tx, itemId: string, text: string): Note {
    const id = newId('n')
    db.prepare(
      'INSERT INTO notes (id, item_id, author_type, member_id, text, utterance_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, itemId, tx.actor.type, tx.actor.memberId, text, tx.utteranceId, tx.nowIso)
    return { id, itemId, authorType: tx.actor.type, memberId: tx.actor.memberId, text, createdAt: tx.nowIso }
  }

  function summaryEnv(tx: Tx) {
    return { now: tx.now, tz: tx.tz, nameOf: tx.nameOf }
  }

  // -------------------------------------------------------------------------------------------
  // status rules (SPEC §2)

  function planStatus(tx: Tx, before: Item, next: Item, target: ItemStatus): StatusPlan {
    const from = before.status
    const actorId = tx.actor.memberId
    const closing = isClosed(target)
    const reopening = isClosed(from) && !closing
    if (next.kind !== 'request') {
      if (target === 'pending' || target === 'accepted' || target === 'declined') {
        invalid(`${kindLabel(next.kind)}没有「${statusLabel(target)}」这个状态（可用：待办、进行中、卡住了、完成、不做了）`)
      }
      return { closing, reopening }
    }
    const ownerName = tx.nameOf(before.ownerId)
    const requesterName = tx.nameOf(before.requestedBy)
    const mustBeOwner = (msg: string) => {
      if (actorId !== before.ownerId) throw new DomainError('forbidden', msg)
    }
    switch (target) {
      case 'open':
        return invalid('请求没有「待办」状态（可用：已接受、进行中、卡住了、完成、不做了）')
      case 'pending':
        if (from === 'declined' || isClosed(from)) {
          if (actorId !== before.requestedBy) throw new DomainError('forbidden', `只有${requesterName}可以重新发送这个请求`)
          return { resend: true, reopening }
        }
        return invalid('请求已经接受了，不能退回「待回复」')
      case 'accepted':
      case 'declined':
        if (from === 'pending') {
          mustBeOwner(`只有${ownerName}可以接受或拒绝这个请求`)
          return { respond: target === 'accepted' ? 'accept' : 'decline' }
        }
        if (target === 'accepted' && (from === 'in_progress' || from === 'blocked')) return {}
        if (target === 'accepted' && isClosed(from)) {
          mustBeOwner(`只有${ownerName}可以重新接受这个请求`)
          return { reopening }
        }
        return invalid(`这个请求现在是「${statusLabel(from)}」，只有待回复的请求可以接受或拒绝`)
      case 'in_progress':
      case 'blocked':
        if (from === 'accepted' || from === 'in_progress' || from === 'blocked') return {}
        if (isClosed(from)) {
          mustBeOwner(`只有${ownerName}可以重新打开这个请求`)
          return { reopening }
        }
        if (from === 'pending') return invalid('请求还在等回复，先接受再改状态')
        return invalid('请求已经被拒绝了；可以重新发送，或者标记不做了')
      case 'done':
      case 'dropped':
        return { closing }
    }
  }

  // -------------------------------------------------------------------------------------------
  // the one item-update path (updateItem, respondToRequest, completeItem all go through here)

  interface ApplyOpts {
    reason?: string | null
    /** respond message or completion note: stored as a Note, linked from the status event */
    message?: string | null
  }

  function applyUpdate(tx: Tx, before: Item, changes: UpdateItemInput, opts: ApplyOpts = {}): Item {
    const next: Item = { ...before, tags: [...before.tags] }
    const fc: FieldChanges = {}
    const c = changes ?? {}

    if (c.kind !== undefined && c.kind !== before.kind) {
      if (!KINDS.includes(c.kind)) invalid('类型只能是 task / idea / reminder')
      if ((c.kind as ItemKind) === 'request') invalid('不能把事项改成请求；要请别人做请用 send_request')
      if (before.kind === 'request') invalid('请求不能改成其他类型；可以先标记不做了再新建')
      next.kind = c.kind
    }
    if (c.title !== undefined) next.title = normTitle(c.title)
    if (c.details !== undefined) next.details = normText(c.details, '说明')
    if (c.priority !== undefined) next.priority = normPriority(c.priority)
    if (c.tags !== undefined) next.tags = normTags(c.tags)
    if (c.parentId !== undefined) next.parentId = c.parentId === null ? null : normParent(c.parentId, before.id)

    const dueAtIn = c.dueAt === undefined ? undefined : c.dueAt === null ? null : normInstant(tx, c.dueAt, '时间')
    const dueDateIn = c.dueDate === undefined ? undefined : c.dueDate === null ? null : normDate(c.dueDate)
    if (dueAtIn && dueDateIn) invalid('dueAt 和 dueDate 只能设一个：有具体时间用 dueAt，只有日期用 dueDate')
    if (dueAtIn !== undefined) {
      next.dueAt = dueAtIn
      if (dueAtIn) next.dueDate = null
    }
    if (dueDateIn !== undefined) {
      next.dueDate = dueDateIn
      if (dueDateIn) next.dueAt = null
    }
    if (next.kind === 'idea' && (next.dueAt || next.dueDate)) {
      if (dueAtIn || dueDateIn) invalid('想法没有截止时间；要定时间请先改成待办（kind: task）')
      next.dueAt = null // converting a dated task into an idea drops the date
      next.dueDate = null
    }

    if (c.ownerId !== undefined) {
      if (c.ownerId === null) {
        if (next.kind !== 'idea') invalid('待办和提醒需要一个负责人')
        next.ownerId = null
      } else {
        next.ownerId = requireMemberRef(tx, c.ownerId).id
      }
    }
    if (next.kind !== 'idea' && !next.ownerId) next.ownerId = requireActorMember(tx).id
    if (next.kind === 'request' && next.ownerId === next.requestedBy) invalid('不能把请求交给发起人自己；自己做的话请建一个待办')

    let target: ItemStatus | null = null
    if (c.status !== undefined && c.status !== before.status) {
      if (!STATUSES.includes(c.status)) invalid(`未知状态：${String(c.status)}`)
      target = c.status
    }
    const ownerChanged = next.ownerId !== before.ownerId
    let plan: StatusPlan = {}
    if (target) plan = planStatus(tx, before, next, target)
    else if (next.kind === 'request' && ownerChanged && (before.status === 'pending' || before.status === 'declined')) {
      // re-routing an unanswered (or declined) request asks the new person
      target = 'pending'
      plan = { resend: true }
    }
    if (target) next.status = target
    if (plan.closing) next.completedAt = tx.nowIso
    if (plan.reopening || plan.resend) next.completedAt = null
    if (plan.respond) next.respondedAt = tx.nowIso
    if (plan.resend) next.respondedAt = null
    // A new due time (or re-opening) ends an earlier snooze: the scheduler holds an item's due / reminder pings back
    // while it is snoozed (scheduler/relevance.ts), so an old snooze would silence the new time. reconcileTiming
    // below cancels the snooze: row; snoozedUntil is recorded on the event, so undo restores both.
    const dueMoved = !!(next.dueAt || next.dueDate) && (next.dueAt !== before.dueAt || next.dueDate !== before.dueDate)
    const snoozeEnds =
      (dueMoved || !!plan.reopening) && !!next.snoozedUntil && new Date(next.snoozedUntil).getTime() > tx.now.getTime()
    if (snoozeEnds) next.snoozedUntil = null
    /** where the cleared snoozedUntil is recorded: with the due change, else with the re-opening status change */
    const snoozeWithFields: RevertibleField[] = snoozeEnds && dueMoved ? ['snoozedUntil'] : []
    const snoozeWithStatus: RevertibleField[] = snoozeEnds && !dueMoved ? ['snoozedUntil'] : []

    // ---- events (only changed fields), then persist
    const reason = opts.reason ? clip(opts.reason, 200) : null
    const extra = reason ? { reason } : {}
    const env = summaryEnv(tx)
    let lastEventId: number | null = null

    const fieldDiff = diff(before, next, ['kind', 'title', 'details', 'priority', 'tags', 'parentId', 'dueAt', 'dueDate', ...snoozeWithFields])
    if (fieldDiff) {
      const a = fieldDiff.after
      if ('title' in a) fc.title = { from: before.title, to: next.title }
      if ('details' in a) fc.details = { to: next.details }
      if ('priority' in a) fc.priority = next.priority
      if ('kind' in a) fc.kind = next.kind
      if ('tags' in a) fc.tags = next.tags
      if ('parentId' in a) fc.parentChanged = true
      if ('dueAt' in a || 'dueDate' in a) fc.due = { dueAt: next.dueAt, dueDate: next.dueDate }
      lastEventId = insertEvent(tx, before.id, 'item_updated', summarizeFieldsUpdated(next.title, fc, env), { ...fieldDiff, ...extra })
    }

    let round = requestRounds(db, before.id)
    let assignedEventId: number | null = null
    if (plan.resend) {
      round += 1
      const d = diff(before, next, ['ownerId', 'status', 'respondedAt', 'completedAt', ...snoozeWithStatus]) ?? { before: {}, after: {} }
      lastEventId = insertEvent(tx, before.id, 'request_sent', summarizeRequestSent(next, round, env), { ...d, n: round, ...extra })
    } else {
      if (ownerChanged) {
        const d = diff(before, next, ['ownerId'])
        assignedEventId = insertEvent(tx, before.id, 'item_reassigned', summarizeReassigned(next.title, next.ownerId, env), { ...d, ...extra })
        lastEventId = assignedEventId
      }
      if (target) {
        const d = diff(before, next, ['status', 'completedAt', 'respondedAt', ...snoozeWithStatus])
        let noteId: string | null = null
        if (opts.message) noteId = insertNote(tx, before.id, opts.message).id
        const msgExtra = { ...(opts.message ? { message: opts.message } : {}), ...(noteId ? { noteId } : {}) }
        if (plan.respond) {
          lastEventId = insertEvent(tx, before.id, 'request_responded', summarizeResponded(next, plan.respond, opts.message ?? null, env), {
            ...d,
            response: plan.respond,
            n: round,
            ...msgExtra,
            ...extra,
          })
        } else {
          const type: EventType = target === 'done' ? 'item_completed' : 'status_changed'
          lastEventId = insertEvent(tx, before.id, type, summarizeStatus(next.title, before.status, target), { ...d, ...msgExtra, ...extra })
        }
      }
    }
    if (lastEventId === null && !opts.message) return before // nothing changed
    if (lastEventId === null && opts.message) {
      // e.g. completing an already-done item with a note
      const note = insertNote(tx, before.id, opts.message)
      insertEvent(tx, before.id, 'note_added', summarizeNote(next.title, opts.message), { before: null, after: null, noteId: note.id, text: opts.message })
    }
    saveItem(tx, next)

    // ---- notifications
    const penv = policyEnv(tx)
    const cancelled: string[] = []
    if (plan.closing) {
      // A pending request whose request_new is still waiting in the outbox (held back by quiet hours, or not picked
      // up yet) never reached its owner: withdrawing it needs no notice to them. Checked before the cancel below.
      const ownerUnaware =
        next.kind === 'request' &&
        before.status === 'pending' &&
        outbox.scheduledForItem(next.id).some(n => n.kind === 'request_new' && n.memberId === before.ownerId)
      cancelled.push(...cancelKinds(next.id))
      if (target === 'done' && next.kind === 'request') {
        for (const n of planRequestAnswered(next, 'done', round, penv, { message: opts.message ?? null })) upsertNotification(tx, n)
      }
      // Dropping an open request tells the other side it is off (not after a decline: both sides know already).
      if (target === 'dropped' && next.kind === 'request' && !isClosed(before.status) && before.status !== 'declined') {
        const message = opts.message ?? reason
        for (const n of planRequestDropped(next, round, penv, { message, ownerUnaware })) upsertNotification(tx, n)
      }
    } else if (plan.resend) {
      // a new round: the old round's rows and any undelivered answer ("declined") are stale now
      cancelled.push(...cancelKinds(next.id, [...REQUEST_ROUND_KINDS, 'request_answered']))
      for (const n of planRequestSent(next, round, penv)) upsertNotification(tx, n)
    } else {
      if (plan.respond) {
        cancelled.push(...cancelKinds(next.id, REQUEST_ROUND_KINDS))
        for (const n of planRequestAnswered(next, plan.respond, round, penv, { message: opts.message ?? null, responderId: before.ownerId })) {
          upsertNotification(tx, n)
        }
      }
      // (also when the owner accepts and hands it over in one update)
      if (assignedEventId !== null && next.ownerId) {
        for (const n of planAssigned(next, assignedEventId, penv)) upsertNotification(tx, n)
      }
      if (plan.reopening) {
        // an undelivered "完成了 / 不做了 / 取消了" notice about the request is wrong once it is open again
        for (const n of outbox.scheduledForItem(next.id)) {
          if (n.kind === 'request_answered' && /^request_answered:[^:]+:(done|dropped):/.test(n.dedupeKey)) outbox.cancel(n.id)
        }
        restoreAfterReopen(tx, next)
      }
    }
    cancelled.push(...reconcileTiming(tx, next))
    if (fieldDiff && !plan.resend) refreshPendingRound(tx, next, round)
    if (cancelled.length && lastEventId !== null) patchEventPayload(lastEventId, { cancelled })
    return requireItem(next.id)
  }

  /**
   * A pending request was edited (title, details, time, priority): its current round's undelivered rows must not
   * carry the old text/time, and follow-up / no-reply move with dueAt ("3 h / 1 h before dueAt if sooner").
   * Only rows still scheduled are touched; nothing is created or revived.
   */
  function refreshPendingRound(tx: Tx, item: Item, round: number): void {
    if (item.kind !== 'request' || item.status !== 'pending' || round < 1) return
    const sent = db
      .prepare(`SELECT created_at FROM events WHERE item_id = ? AND type = 'request_sent' AND undone = 0 ORDER BY id DESC LIMIT 1`)
      .get(item.id) as { created_at: string } | undefined
    const sentAt = sent ? new Date(sent.created_at) : tx.now
    const plans = planRequestSent(item, round, { ...policyEnv(tx), actorMemberId: null })
    const env = { timezone: tx.tz, members: tx.members }
    // Follow-up / no-reply count from when this round's request_new reaches the owner (quiet hours may hold it
    // back): when it was sent, when it will go out, or — without a live row — as planned when the request was sent.
    let reachesOwnerAt = requestReachesOwnerAt(item, sentAt, env)
    const newPlan = plans.find(p => p.kind === 'request_new')
    const newRow = newPlan ? getNotificationByKey(db, newPlan.dedupeKey) : undefined
    if (newRow?.status === 'sent') {
      reachesOwnerAt = new Date(outbox.get(newRow.id)?.sentAt ?? newRow.fire_at)
    } else if (newRow?.status === 'scheduled' && newPlan) {
      if (newPlan.respectQuietHours === false && newRow.respect_quiet_hours === 1 && new Date(newRow.fire_at).getTime() > tx.now.getTime()) {
        // the edit made a request that quiet hours were holding back urgent (due within 12 h, or priority high):
        // it goes out now, like a fresh urgent request would
        db.prepare(`UPDATE notifications SET fire_at = ? WHERE id = ? AND status = 'scheduled'`).run(tx.nowIso, newRow.id)
        tx.wake = true
        newRow.fire_at = tx.nowIso
      }
      // fire_at is the send time (not picked up yet), the end of quiet hours (deferred) or a retry time
      reachesOwnerAt = requestReachesOwnerAt(item, new Date(Math.max(new Date(newRow.fire_at).getTime(), sentAt.getTime())), env)
    }
    const fireAtFor: Partial<Record<ScheduledNotification['kind'], Date>> = {
      request_followup: requestFollowupAt(reachesOwnerAt, item.dueAt, config.scheduler),
      request_noreply: requestNoreplyAt(reachesOwnerAt, item.dueAt, config.scheduler),
    }
    for (const n of plans) {
      const ex = getNotificationByKey(db, n.dedupeKey)
      if (!ex || ex.status !== 'scheduled') continue
      const fireAt = fireAtFor[n.kind]
      db.prepare(
        `UPDATE notifications SET title = ?, body = ?, actions = ?, respect_quiet_hours = ?, fire_at = COALESCE(?, fire_at) WHERE id = ?`,
      ).run(n.title, n.body, JSON.stringify(n.actions ?? []), n.respectQuietHours === false ? 0 : 1, fireAt?.toISOString() ?? null, ex.id)
      if (fireAt && fireAt.getTime() <= tx.now.getTime()) tx.wake = true
    }
  }

  // -------------------------------------------------------------------------------------------
  // undo

  function deleteItemCompletely(itemId: string, title: string): void {
    db.prepare(
      `UPDATE events SET item_id = NULL, payload = json_set(payload, '$.itemTitle', ?, '$.deletedItemId', ?) WHERE item_id = ?`,
    ).run(title, itemId, itemId)
    db.prepare('DELETE FROM deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE item_id = ?)').run(itemId)
    db.prepare('DELETE FROM notifications WHERE item_id = ?').run(itemId)
    db.prepare('DELETE FROM notes WHERE item_id = ?').run(itemId)
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId)
  }

  function deleteNote(noteId: unknown): void {
    if (typeof noteId === 'string') db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
  }

  function undoUtteranceTx(tx: Tx, utteranceId: string): { utteranceId: string; itemIds: string[]; existing: string[] } {
    const u = getUtteranceRow(db, utteranceId)
    if (!u) throw new DomainError('not_found', `找不到这条消息（${utteranceId}）`)
    const actorMember = tx.actor.memberId ? tx.members.find(m => m.id === tx.actor.memberId) : undefined
    if (!actorMember || (actorMember.id !== u.member_id && actorMember.role !== 'adult')) {
      throw new DomainError('forbidden', '只有说这句话的人或家里的大人可以撤销')
    }
    if (u.status === 'undone') throw new DomainError('conflict', '这条已经撤销过了')

    const events = (
      db.prepare('SELECT * FROM events WHERE utterance_id = ? AND undone = 0 ORDER BY id DESC').all(utteranceId) as EventRow[]
    ).map(toEvent)

    // 1. everything this utterance scheduled and is still pending
    const scheduledIds = db
      .prepare(`SELECT id FROM notifications WHERE utterance_id = ? AND status = 'scheduled'`)
      .all(utteranceId) as { id: string }[]
    for (const r of scheduledIds) outbox.cancel(r.id)

    const affected = new Map<string, Item>()
    /** state of each affected item before this undo (used to repair invariants) */
    const originals = new Map<string, Item>()
    const deleted: string[] = []
    const dropped: string[] = []
    const reverted: { eventId: number; fields: string[] }[] = []
    const skipped: { eventId: number; fields: string[] }[] = []
    const repaired: { itemId: string; fields: string[] }[] = []
    const restoreLater: { itemId: string; ids: unknown }[] = []

    const current = (itemId: string): Item | null => {
      const cached = affected.get(itemId)
      if (cached) return cached
      const it = loadItem(itemId)
      if (it) {
        affected.set(itemId, it)
        originals.set(itemId, { ...it, tags: [...it.tags] })
      }
      return it
    }

    // 2. revert newest first
    for (const ev of events) {
      const p = ev.payload
      if (ev.type === 'reminder_cancelled') {
        const nid = p.notificationId
        const row = typeof nid === 'string' ? getNotificationLite(db, nid) : undefined
        if (row && row.status === 'cancelled' && new Date(row.fire_at).getTime() > tx.now.getTime()) {
          const item = row.item_id ? current(row.item_id) : null
          if (!item || !isClosed(item.status)) outbox.reschedule(row.id)
        }
        reverted.push({ eventId: ev.id, fields: [] })
        continue
      }
      if (ev.type === 'reminder_set' || ev.type === 'undone') {
        reverted.push({ eventId: ev.id, fields: [] }) // its row was cancelled in step 1
        continue
      }
      if (!ev.itemId) continue
      const item = current(ev.itemId)
      if (!item) continue

      const isCreation = p.created === true || ev.type === 'item_created'
      if (isCreation) {
        const others = db
          .prepare(
            `SELECT COUNT(*) AS n FROM events WHERE item_id = ? AND undone = 0 AND type != 'undone'
             AND (utterance_id IS NULL OR utterance_id != ?)`,
          )
          .get(item.id, utteranceId) as { n: number }
        const children = db.prepare('SELECT COUNT(*) AS n FROM items WHERE parent_id = ?').get(item.id) as { n: number }
        if (others.n === 0 && children.n === 0) {
          deleteItemCompletely(item.id, item.title)
          affected.delete(item.id)
          deleted.push(item.id)
          tx.touched.add(item.id)
        } else if (!isClosed(item.status)) {
          item.status = 'dropped'
          item.completedAt = tx.nowIso
          dropped.push(item.id)
        }
        reverted.push({ eventId: ev.id, fields: [] })
        continue
      }

      if (ev.type === 'note_added') {
        deleteNote(p.noteId)
        reverted.push({ eventId: ev.id, fields: [] })
        continue
      }
      if (p.noteId) deleteNote(p.noteId)

      const after = (p.after ?? {}) as Record<string, unknown>
      const beforeVals = (p.before ?? {}) as Record<string, unknown>
      const ok: string[] = []
      const no: string[] = []
      for (const group of REVERT_GROUPS) {
        const fields = group.filter(f => f in after)
        if (fields.length === 0) continue
        if (fields.every(f => sameValue(item[f], after[f]))) {
          for (const f of fields) setField(item, f, beforeVals[f])
          ok.push(...fields)
        } else {
          no.push(...fields)
        }
      }
      reverted.push({ eventId: ev.id, fields: ok })
      if (no.length) skipped.push({ eventId: ev.id, fields: no })
      if (p.cancelled) restoreLater.push({ itemId: item.id, ids: p.cancelled })
    }

    // 3. persist and make notifications consistent with the restored state
    for (const item of affected.values()) {
      const orig = originals.get(item.id)
      const fixed = orig ? repairInvariants(item, orig) : []
      if (fixed.length) repaired.push({ itemId: item.id, fields: fixed })
      saveItem(tx, item)
      if (isClosed(item.status)) {
        // an item someone else closed keeps its "done" notice to the requester; one this undo dropped loses everything
        cancelKinds(item.id, dropped.includes(item.id) ? undefined : NON_ANSWER_KINDS)
      } else {
        for (const r of restoreLater) if (r.itemId === item.id) restoreCancelled(tx, r.ids, item)
        reconcileTiming(tx, item, { keepUtterance: true })
      }
    }

    // 4. mark, log, finish
    if (events.length) {
      db.prepare(`UPDATE events SET undone = 1 WHERE id IN (${events.map(() => '?').join(', ')})`).run(...events.map(e => e.id))
    }
    const existing = [...affected.keys()]
    insertEvent(
      tx,
      existing.length === 1 ? (existing[0] ?? null) : null,
      'undone',
      summarizeUndone(u.text, events.length),
      {
        before: null,
        after: null,
        utteranceId,
        eventIds: events.map(e => e.id),
        reverted,
        skipped,
        repaired,
        deletedItemIds: deleted,
        droppedItemIds: dropped,
      },
      { utteranceId: null },
    )
    db.prepare(`UPDATE utterances SET status = 'undone' WHERE id = ?`).run(utteranceId)
    tx.dirty = true
    for (const id of existing) tx.touched.add(id)
    return { utteranceId, itemIds: [...existing, ...deleted], existing }
  }

  /**
   * After a partial undo (some fields skipped because later changes touched them) the item may break the item rules.
   * Repairs it towards its pre-undo state and returns the fields it had to keep.
   */
  function repairInvariants(item: Item, orig: Item): RevertibleField[] {
    const fixed: RevertibleField[] = []
    for (let pass = 0; pass < 3; pass++) {
      const n = fixed.length
      if (item.dueAt && item.dueDate) {
        if (orig.dueAt) item.dueDate = null
        else item.dueAt = null
        fixed.push(orig.dueAt ? 'dueDate' : 'dueAt')
      }
      if (item.kind !== 'idea' && !item.ownerId) {
        if (orig.ownerId) {
          item.ownerId = orig.ownerId
          fixed.push('ownerId')
        } else {
          item.kind = orig.kind // it was an unowned idea
          fixed.push('kind')
        }
      }
      if (item.kind === 'idea' && (item.dueAt || item.dueDate)) {
        if (orig.kind !== 'idea') {
          item.kind = orig.kind
          fixed.push('kind')
        } else {
          item.dueAt = null
          item.dueDate = null
          fixed.push('dueAt', 'dueDate')
        }
      }
      if (item.kind === 'request' && item.ownerId === item.requestedBy && orig.ownerId !== item.ownerId) {
        item.ownerId = orig.ownerId
        fixed.push('ownerId')
      }
      if (fixed.length === n) break
    }
    return [...new Set(fixed)]
  }

  function setField(item: Item, f: RevertibleField, v: unknown): void {
    const rec = item as unknown as Record<string, unknown>
    if (f === 'tags') rec[f] = Array.isArray(v) ? v : []
    else if (f === 'snoozeCount') rec[f] = typeof v === 'number' ? v : 0
    else rec[f] = v ?? null
  }

  // -------------------------------------------------------------------------------------------
  // utterances

  function utteranceFromRow(r: UtteranceRow): Utterance {
    return toUtterance(r, changesForUtterances(db, [r.id]).get(r.id) ?? [])
  }

  function getUtterance(id: string): Utterance | null {
    const r = getUtteranceRow(db, id)
    return r ? utteranceFromRow(r) : null
  }

  function recentUtterances(limit: number): Utterance[] {
    const n = Math.max(1, Math.min(500, Math.floor(limit) || 1))
    const rows = (
      db.prepare('SELECT * FROM utterances ORDER BY created_at DESC, rowid DESC LIMIT ?').all(n) as UtteranceRow[]
    ).reverse()
    const changes = changesForUtterances(
      db,
      rows.map(r => r.id),
    )
    return rows.map(r => toUtterance(r, changes.get(r.id) ?? []))
  }

  function broadcastUtterance(u: Utterance | null): void {
    if (u) safeEmit(() => bus.broadcast({ type: 'utterance', utterance: u }))
  }

  // -------------------------------------------------------------------------------------------
  // reads

  function listActiveItems(): Item[] {
    const rows = db
      .prepare(`SELECT * FROM items WHERE status IN ${ACTIVE_SQL} ORDER BY last_activity_at DESC, rowid DESC`)
      .all() as ItemRow[]
    return rowsToItems(db, rows)
  }

  function listClosedSince(since: Date): Item[] {
    const rows = db
      .prepare(
        `SELECT * FROM items WHERE status IN ('done', 'dropped') AND COALESCE(completed_at, updated_at) >= ?
         ORDER BY COALESCE(completed_at, updated_at) DESC, rowid DESC`,
      )
      .all(since.toISOString()) as ItemRow[]
    return rowsToItems(db, rows)
  }

  // -------------------------------------------------------------------------------------------
  // the Domain

  const domain: Domain = {
    // ---- family & members
    ensureFamily(name, timezone) {
      const existing = getFamilyRow(db)
      if (existing) return toFamily(existing)
      if (!isValidTimezone(timezone)) invalid(`无效的时区：${timezone}`)
      const n = typeof name === 'string' && name.trim() ? name.trim() : '我们家'
      db.prepare('INSERT INTO family (id, name, timezone, created_at) VALUES (1, ?, ?, ?)').run(n, timezone, clock.now().toISOString())
      return { name: n, timezone }
    },

    getFamily: familyOrThrow,

    setTimezone(timezone) {
      if (!isValidTimezone(timezone)) invalid(`无效的时区：${timezone}`)
      const ids: string[] = []
      let ctx: Tx | null = null
      db.transaction(() => {
        familyOrThrow()
        db.prepare('UPDATE family SET timezone = ? WHERE id = 1').run(timezone)
        const tx = beginTx({ type: 'system', memberId: null })
        ctx = tx
        // re-plan every timing row in the new zone (09:00 / 20:00 rules are local)
        for (const item of listActiveItems()) {
          for (const n of outbox.scheduledForItem(item.id)) if (isTimingKey(n.dedupeKey)) outbox.cancel(n.id)
          reconcileTiming(tx, item, { keepUtterance: true })
          ids.push(item.id)
        }
      })()
      afterCommit(ctx)
      broadcastBoard(ids, null)
      return familyOrThrow()
    },

    listMembers() {
      return listMemberRows(db).map(toMember)
    },

    getMember(id) {
      const r = getMemberRow(db, id)
      return r ? toMember(r) : null
    },

    createMember(input) {
      const member = db.transaction((): Member => {
        const name = normMemberName(input?.name, null)
        if (!ROLES.includes(input.role)) invalid('角色只能是 adult / kid / relative')
        const aliases = input.aliases === undefined ? [] : normAliases(input.aliases)
        const existing = listMemberRows(db)
        let color = input.color?.trim()
        if (!color) {
          const used = new Set(existing.map(m => m.color))
          color = MEMBER_PALETTE.find(c => !used.has(c)) ?? MEMBER_PALETTE[existing.length % MEMBER_PALETTE.length]!
        }
        const language = input.language?.trim() || 'zh-CN'
        const id = newId('m')
        db.prepare(
          `INSERT INTO members (id, name, aliases, role, language, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, name, JSON.stringify(aliases), input.role, language, color, clock.now().toISOString())
        return toMember(getMemberRow(db, id)!)
      })()
      broadcastBoard([], null)
      return member
    },

    updateMember(id, patch) {
      const member = db.transaction((): Member => {
        const row = getMemberRow(db, id)
        if (!row) throw new DomainError('not_found', `找不到这个成员（${id}）`)
        const m = toMember(row)
        const p: MemberPatch = patch ?? {}
        if (p.name !== undefined) m.name = normMemberName(p.name, id)
        if (p.aliases !== undefined) m.aliases = normAliases(p.aliases)
        if (p.quietStart !== undefined) m.quietStart = normHHMM(p.quietStart, '免打扰开始时间')
        if (p.quietEnd !== undefined) m.quietEnd = normHHMM(p.quietEnd, '免打扰结束时间')
        if (p.digestTime !== undefined) m.digestTime = p.digestTime === null ? null : normHHMM(p.digestTime, '每日摘要时间')
        if (p.color !== undefined) m.color = typeof p.color === 'string' && p.color.trim() ? p.color.trim() : m.color
        if (p.language !== undefined) m.language = typeof p.language === 'string' && p.language.trim() ? p.language.trim() : m.language
        db.prepare(
          `UPDATE members SET name = ?, aliases = ?, quiet_start = ?, quiet_end = ?, digest_time = ?, color = ?, language = ? WHERE id = ?`,
        ).run(m.name, JSON.stringify(m.aliases), m.quietStart, m.quietEnd, m.digestTime, m.color, m.language, id)
        return toMember(getMemberRow(db, id)!)
      })()
      broadcastBoard([], null)
      return member
    },

    // ---- reads
    getItem(id) {
      return loadItem(id)
    },

    getItemDetail(id): ItemDetailResponse | null {
      const item = loadItem(id)
      if (!item) return null
      const events = (db.prepare('SELECT * FROM events WHERE item_id = ? ORDER BY id').all(id) as EventRow[]).map(toEvent)
      return { item, notes: listNoteRows(db, id).map(toNote), events, notifications: outbox.listForItem(id) }
    },

    listActiveItems,
    listClosedSince,

    searchItems(query: SearchItemsQuery) {
      const q = query ?? {}
      const where: string[] = []
      const params: unknown[] = []
      if (q.status && q.status.length) {
        const st = q.status.filter(s => STATUSES.includes(s))
        if (!st.length) return []
        where.push(`i.status IN (${st.map(() => '?').join(', ')})`)
        params.push(...st)
      } else if (!q.includeClosed) {
        where.push(`i.status IN ${ACTIVE_SQL}`)
      }
      if (q.kind) {
        where.push('i.kind = ?')
        params.push(q.kind)
      }
      if (q.ownerId) {
        where.push('i.owner_id = ?')
        params.push(q.ownerId)
      }
      const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 20) || 20))
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
      const listSql = `SELECT i.* FROM items i ${whereSql} ORDER BY i.last_activity_at DESC, i.rowid DESC`
      // Text is matched in JS on Simplified-normalized, case-folded text (SPEC §4), so "買燈" finds "买灯".
      const text = typeof q.text === 'string' ? normalizeForSearch(q.text) : ''
      if (!text) return rowsToItems(db, db.prepare(`${listSql} LIMIT ?`).all(...params, limit) as ItemRow[])
      const rows = db.prepare(listSql).all(...params) as ItemRow[]
      const notesByItem = new Map<string, string[]>()
      const noteRows = db
        .prepare(`SELECT n.item_id, n.text FROM notes n JOIN items i ON i.id = n.item_id ${whereSql}`)
        .all(...params) as { item_id: string; text: string }[]
      for (const n of noteRows) notesByItem.set(n.item_id, [...(notesByItem.get(n.item_id) ?? []), n.text])
      const hits = rows.filter(r =>
        [r.title, r.details ?? '', ...(notesByItem.get(r.id) ?? [])].some(s => normalizeForSearch(s).includes(text)),
      )
      return rowsToItems(db, hits.slice(0, limit))
    },

    listNotes(itemId) {
      return listNoteRows(db, itemId).map(toNote)
    },

    recentEvents(limit) {
      const n = Math.max(1, Math.min(1000, Math.floor(limit) || 1))
      return (db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(n) as EventRow[]).map(toEvent)
    },

    getBoard(memberId): BoardResponse {
      const meRow = getMemberRow(db, memberId)
      if (!meRow) throw new DomainError('not_found', `找不到这个成员（${memberId}）`)
      const now = clock.now()
      const items = [...listActiveItems(), ...listClosedSince(new Date(now.getTime() - 7 * DAY))].sort((a, b) =>
        b.lastActivityAt.localeCompare(a.lastActivityAt),
      )
      return {
        me: toMember(meRow),
        family: familyOrThrow(),
        members: listMemberRows(db).map(toMember),
        items,
        utterances: recentUtterances(30),
        serverTime: now.toISOString(),
      }
    },

    // ---- writes
    createItem(actor, input: CreateItemInput) {
      return write(actor, tx => {
        const creator = requireActorMember(tx)
        const inp = input ?? ({} as CreateItemInput)
        if (!KINDS.includes(inp.kind)) invalid('类型只能是 task / idea / reminder')
        if (inp.kind === 'request') invalid('请求要用 send_request 发给对方')
        const title = normTitle(inp.title)
        const details = normText(inp.details, '说明')
        const priority = inp.priority === undefined ? 'normal' : normPriority(inp.priority)
        const tags = inp.tags === undefined ? [] : normTags(inp.tags)
        const parentId = inp.parentId ? normParent(inp.parentId, null) : null
        let ownerId: string | null
        if (inp.ownerId === undefined) ownerId = inp.kind === 'idea' ? null : creator.id
        else if (inp.ownerId === null) ownerId = inp.kind === 'idea' ? null : invalid('待办和提醒需要一个负责人')
        else ownerId = requireMemberRef(tx, inp.ownerId).id
        const dueAt = inp.dueAt ? normInstant(tx, inp.dueAt, '时间') : null
        const dueDate = inp.dueDate ? normDate(inp.dueDate) : null
        if (dueAt && dueDate) invalid('dueAt 和 dueDate 只能设一个：有具体时间用 dueAt，只有日期用 dueDate')
        if (inp.kind === 'idea' && (dueAt || dueDate)) invalid('想法没有截止时间；要定时间请建成待办（kind: task）')
        const remindAt = inp.remindAt ? normInstant(tx, inp.remindAt, '提醒时间') : null
        if (remindAt && new Date(remindAt).getTime() <= tx.now.getTime()) invalid('提醒时间已经过了')

        const item: Item = {
          id: newId('i'),
          kind: inp.kind,
          title,
          details,
          status: 'open',
          ownerId,
          createdBy: creator.id,
          requestedBy: null,
          dueAt,
          dueDate,
          remindAt: null,
          snoozedUntil: null,
          snoozeCount: 0,
          priority,
          parentId,
          tags,
          createdAt: tx.nowIso,
          updatedAt: tx.nowIso,
          completedAt: null,
          respondedAt: null,
          lastActivityAt: tx.nowIso,
        }
        insertItemRow(db, item)
        const env = summaryEnv(tx)
        const eventId = insertEvent(tx, item.id, 'item_created', summarizeCreated(item, creator.id, env), {
          before: null,
          after: snapshot(item),
          created: true,
        })
        const penv = policyEnv(tx)
        if (ownerId && ownerId !== creator.id) for (const n of planAssigned(item, eventId, penv)) upsertNotification(tx, n)
        reconcileTiming(tx, item)
        // a reminder item already pings its owner exactly at dueAt; a remindAt at the same instant would ping twice
        const duplicatesOwnPing = item.kind === 'reminder' && !!dueAt && remindAt === dueAt
        if (remindAt && !duplicatesOwnPing) {
          const to = ownerId ?? creator.id
          const fire = new Date(remindAt)
          const row = upsertNotification(tx, planExplicitReminder({ memberId: to, fireAt: fire, message: title, item }, penv))
          insertEvent(tx, item.id, 'reminder_set', summarizeReminderSet(to, title, fire, env), {
            before: null,
            after: null,
            notificationId: row?.id ?? null,
            memberId: to,
            fireAt: remindAt,
            message: title,
          })
        }
        return requireItem(item.id)
      })
    },

    updateItem(actor, id, changes, reason) {
      return write(actor, tx => applyUpdate(tx, requireItem(id), changes, { reason: reason ?? null }))
    },

    addNote(actor, itemId, text) {
      return write(actor, tx => {
        const item = requireItem(itemId)
        const t = normText(text, '备注')
        if (!t) return invalid('备注不能为空')
        const note = insertNote(tx, item.id, t)
        insertEvent(tx, item.id, 'note_added', summarizeNote(item.title, t), { before: null, after: null, noteId: note.id, text: t })
        saveItem(tx, item)
        return note
      })
    },

    sendRequest(actor, input: SendRequestInput) {
      return write(actor, tx => {
        const requester = requireActorMember(tx)
        const inp = input ?? ({} as SendRequestInput)
        const to = requireMemberRef(tx, inp.toMemberId)
        if (to.id === requester.id) invalid('不能给自己发请求；自己做的话请建一个待办（create_item）')
        const title = normTitle(inp.title)
        const details = normText(inp.details, '说明')
        const priority = inp.priority === undefined ? 'normal' : normPriority(inp.priority)
        const parentId = inp.parentId ? normParent(inp.parentId, null) : null
        const dueAt = inp.dueAt ? normInstant(tx, inp.dueAt, '时间') : null
        const dueDate = inp.dueDate ? normDate(inp.dueDate) : null
        if (dueAt && dueDate) invalid('dueAt 和 dueDate 只能设一个：有具体时间用 dueAt，只有日期用 dueDate')
        const item: Item = {
          id: newId('i'),
          kind: 'request',
          title,
          details,
          status: 'pending',
          ownerId: to.id,
          createdBy: requester.id,
          requestedBy: requester.id,
          dueAt,
          dueDate,
          remindAt: null,
          snoozedUntil: null,
          snoozeCount: 0,
          priority,
          parentId,
          tags: [],
          createdAt: tx.nowIso,
          updatedAt: tx.nowIso,
          completedAt: null,
          respondedAt: null,
          lastActivityAt: tx.nowIso,
        }
        insertItemRow(db, item)
        const round = requestRounds(db, item.id) + 1
        insertEvent(tx, item.id, 'request_sent', summarizeRequestSent(item, round, summaryEnv(tx)), {
          before: null,
          after: snapshot(item),
          created: true,
          n: round,
        })
        for (const n of planRequestSent(item, round, policyEnv(tx))) upsertNotification(tx, n)
        reconcileTiming(tx, item)
        return requireItem(item.id)
      })
    },

    respondToRequest(actor, itemId, response, message) {
      return write(actor, tx => {
        const item = requireItem(itemId)
        if (item.kind !== 'request') invalid('这不是请求，不需要接受或拒绝')
        if (response !== 'accept' && response !== 'decline') invalid('回复只能是 accept 或 decline')
        if (tx.actor.memberId !== item.ownerId) {
          throw new DomainError('forbidden', `只有${tx.nameOf(item.ownerId)}可以回复这个请求`)
        }
        if (item.status !== 'pending') invalid(`这个请求现在是「${statusLabel(item.status)}」，已经回复过了`)
        const msg = normText(message, '回复')
        return applyUpdate(tx, item, { status: response === 'accept' ? 'accepted' : 'declined' }, { message: msg })
      })
    },

    completeItem(actor, itemId, note) {
      return write(actor, tx => {
        const item = requireItem(itemId)
        const msg = normText(note, '备注')
        return applyUpdate(tx, item, { status: 'done' }, { message: msg })
      })
    },

    snoozeItem(actor, itemId, until) {
      return write(actor, tx => {
        const item = requireItem(itemId)
        const t = until instanceof Date ? until : new Date(normInstant(tx, until, '推迟时间'))
        if (Number.isNaN(t.getTime())) invalid('推迟时间格式不对')
        if (t.getTime() <= tx.now.getTime()) invalid('推迟的时间要在将来')
        if (isClosed(item.status)) invalid(`这个事项已经${statusLabel(item.status)}了，不能推迟`)
        const next: Item = { ...item, snoozedUntil: t.toISOString(), snoozeCount: item.snoozeCount + 1 }
        const d = diff(item, next, ['snoozedUntil', 'snoozeCount'])
        insertEvent(tx, item.id, 'item_snoozed', summarizeSnoozed(item.title, t, summaryEnv(tx)), { ...d })
        saveItem(tx, next)
        reconcileTiming(tx, next)
        return requireItem(item.id)
      })
    },

    setReminder(actor, input: SetReminderInput) {
      return write(actor, tx => {
        const inp = input ?? ({} as SetReminderInput)
        const member = requireMemberRef(tx, inp.memberId)
        const fireIso = normInstant(tx, inp.fireAt, '提醒时间')
        const fire = new Date(fireIso)
        if (fire.getTime() <= tx.now.getTime()) invalid('提醒时间已经过了')
        const item = inp.itemId ? requireItem(inp.itemId) : null
        if (item && isClosed(item.status)) invalid(`这个事项已经${statusLabel(item.status)}了，不需要再提醒`)
        const message = normText(inp.message, '提醒内容', REMINDER_MESSAGE_MAX) ?? item?.title ?? invalid('提醒内容不能为空')
        const row = upsertNotification(tx, planExplicitReminder({ memberId: member.id, fireAt: fire, message, item }, policyEnv(tx)))
        if (!row) throw new DomainError('conflict', '提醒没有保存成功')
        insertEvent(tx, item?.id ?? null, 'reminder_set', summarizeReminderSet(member.id, message, fire, summaryEnv(tx)), {
          before: null,
          after: null,
          notificationId: row.id,
          memberId: member.id,
          fireAt: fireIso,
          message,
        })
        if (item) saveItem(tx, item)
        tx.dirty = true
        return row
      })
    },

    cancelReminder(actor, notificationId) {
      write(actor, tx => {
        const row = getNotificationLite(db, notificationId)
        if (!row) throw new DomainError('not_found', `找不到这个提醒（${notificationId}）`)
        if (row.kind !== 'explicit' || !row.dedupe_key.startsWith('explicit:')) {
          invalid('只能取消单独设置的提醒；提醒事项本身请改时间或标记不做了')
        }
        if (row.status !== 'scheduled') invalid('这个提醒已经发出或者取消了')
        outbox.cancel(row.id)
        const message = row.title.replace(/^提醒：/, '')
        insertEvent(tx, row.item_id, 'reminder_cancelled', summarizeReminderCancelled(message, new Date(row.fire_at), summaryEnv(tx)), {
          before: null,
          after: null,
          notificationId: row.id,
          memberId: row.member_id,
          fireAt: row.fire_at,
          message,
        })
        if (row.item_id) {
          const item = loadItem(row.item_id)
          if (item) saveItem(tx, item)
        }
        tx.dirty = true
      })
    },

    // ---- utterances
    createUtterance(memberId, source, text, opts) {
      const u = db.transaction((): Utterance => {
        if (!getMemberRow(db, memberId)) invalid(`找不到这个成员（${memberId}）`)
        if (!SOURCES.includes(source)) invalid(`未知来源：${String(source)}`)
        if (typeof text !== 'string') invalid('内容需要是文字')
        const replyTo = opts?.replyTo ?? null
        if (replyTo && !getUtteranceRow(db, replyTo)) invalid(`找不到要回复的消息（${replyTo}）`)
        const id = newId('u')
        db.prepare(
          `INSERT INTO utterances (id, member_id, source, text, status, reply_to, audio_path, created_at)
           VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
        ).run(id, memberId, source, text.trim().slice(0, 5000), replyTo, opts?.audioPath ?? null, clock.now().toISOString())
        return getUtterance(id)!
      })()
      broadcastUtterance(u)
      return u
    },

    finishUtterance(id, result: FinishUtteranceInput) {
      const u = db.transaction((): Utterance => {
        const row = getUtteranceRow(db, id)
        if (!row) throw new DomainError('not_found', `找不到这条消息（${id}）`)
        if (!UTTERANCE_STATUSES.includes(result.status)) invalid(`未知状态：${String(result.status)}`)
        // 'undone' only through undoUtterance, which also reverts the changes
        if (result.status === 'undone') invalid('撤销请用 undoUtterance')
        // an utterance undone while it was still processing stays undone
        const status = row.status === 'undone' ? 'undone' : result.status
        db.prepare(
          `UPDATE utterances SET status = ?, reply = ?, clarification = ?, error = ?, model = COALESCE(?, model), usage = COALESCE(?, usage)
           WHERE id = ?`,
        ).run(
          status,
          result.reply ?? null,
          result.clarification ? JSON.stringify(result.clarification) : null,
          result.error ?? null,
          result.model ?? null,
          result.usage === undefined ? null : JSON.stringify(result.usage),
          id,
        )
        return getUtterance(id)!
      })()
      broadcastUtterance(u)
      return u
    },

    getUtterance,
    recentUtterances,

    undoUtterance(actor, utteranceId): UndoResponse {
      // undo is not itself part of the utterance it reverts
      const undoActor: Actor = { type: actor.type, memberId: actor.memberId, utteranceId: null }
      let itemIds: string[] = []
      let existing: string[] = []
      let ctx: Tx | null = null
      db.transaction(() => {
        const tx = beginTx(undoActor)
        ctx = tx
        const r = undoUtteranceTx(tx, utteranceId)
        itemIds = r.itemIds
        existing = r.existing
      })()
      afterCommit(ctx)
      broadcastBoard(itemIds, undoActor, utteranceId)
      const utterance = getUtterance(utteranceId)!
      broadcastUtterance(utterance)
      return { utterance, items: existing.map(id => loadItem(id)).filter((i): i is Item => !!i) }
    },
  }
  return domain
}
