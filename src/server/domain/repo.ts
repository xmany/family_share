// Row <-> type mappers and small query helpers for the domain layer.
// SQLite columns are snake_case; shared types are camelCase. JSON columns go through parseJson.

import type { Db } from '../db/db'
import { parseJson } from '../db/db'
import type {
  ActorType,
  Change,
  Clarification,
  EventType,
  Family,
  Item,
  ItemEvent,
  ItemKind,
  ItemStatus,
  Member,
  MemberRole,
  Note,
  Priority,
  Utterance,
  UtteranceSource,
  UtteranceStatus,
} from '../../shared/types'
import { ACTIVE_STATUSES } from '../../shared/types'

// ---------------------------------------------------------------------------------------------
// Row shapes (exactly the columns in schema.ts)

export interface FamilyRow {
  id: number
  name: string
  timezone: string
  created_at: string
}

export interface MemberRow {
  id: string
  name: string
  aliases: string
  role: string
  language: string
  quiet_start: string
  quiet_end: string
  digest_time: string | null
  color: string
  created_at: string
}

export interface ItemRow {
  id: string
  kind: string
  title: string
  details: string | null
  status: string
  owner_id: string | null
  created_by: string
  requested_by: string | null
  due_at: string | null
  due_date: string | null
  snoozed_until: string | null
  snooze_count: number
  priority: string
  parent_id: string | null
  tags: string
  created_at: string
  updated_at: string
  completed_at: string | null
  responded_at: string | null
  last_activity_at: string
}

export interface NoteRow {
  id: string
  item_id: string
  author_type: string
  member_id: string | null
  text: string
  utterance_id: string | null
  created_at: string
}

export interface UtteranceRow {
  id: string
  member_id: string
  source: string
  text: string
  reply: string | null
  status: string
  clarification: string | null
  reply_to: string | null
  error: string | null
  audio_path: string | null
  model: string | null
  usage: string | null
  created_at: string
}

export interface EventRow {
  id: number
  item_id: string | null
  actor_type: string
  member_id: string | null
  type: string
  summary: string
  payload: string
  utterance_id: string | null
  undone: number
  created_at: string
}

/** Minimal notification columns the domain reads directly (the Outbox owns the full mapping). */
export interface NotificationRowLite {
  id: string
  member_id: string
  item_id: string | null
  kind: string
  fire_at: string
  title: string
  body: string
  actions: string
  dedupe_key: string
  respect_quiet_hours: number
  status: string
  utterance_id: string | null
}

// ---------------------------------------------------------------------------------------------
// Mappers

export function toFamily(r: FamilyRow): Family {
  return { name: r.name, timezone: r.timezone }
}

export function toMember(r: MemberRow): Member {
  return {
    id: r.id,
    name: r.name,
    aliases: parseJson<string[]>(r.aliases, []),
    role: r.role as MemberRole,
    language: r.language,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    digestTime: r.digest_time,
    color: r.color,
    createdAt: r.created_at,
  }
}

export function toItem(r: ItemRow, remindAt: string | null): Item {
  return {
    id: r.id,
    kind: r.kind as ItemKind,
    title: r.title,
    details: r.details,
    status: r.status as ItemStatus,
    ownerId: r.owner_id,
    createdBy: r.created_by,
    requestedBy: r.requested_by,
    dueAt: r.due_at,
    dueDate: r.due_date,
    remindAt,
    snoozedUntil: r.snoozed_until,
    snoozeCount: r.snooze_count,
    priority: r.priority as Priority,
    parentId: r.parent_id,
    tags: parseJson<string[]>(r.tags, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    respondedAt: r.responded_at,
    lastActivityAt: r.last_activity_at,
  }
}

export function toNote(r: NoteRow): Note {
  return {
    id: r.id,
    itemId: r.item_id,
    authorType: r.author_type as ActorType,
    memberId: r.member_id,
    text: r.text,
    createdAt: r.created_at,
  }
}

export function toEvent(r: EventRow): ItemEvent {
  return {
    id: r.id,
    itemId: r.item_id,
    actorType: r.actor_type as ActorType,
    memberId: r.member_id,
    type: r.type as EventType,
    summary: r.summary,
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    utteranceId: r.utterance_id,
    undone: r.undone === 1,
    createdAt: r.created_at,
  }
}

export function toUtterance(r: UtteranceRow, changes: Change[]): Utterance {
  return {
    id: r.id,
    memberId: r.member_id,
    source: r.source as UtteranceSource,
    text: r.text,
    reply: r.reply,
    status: r.status as UtteranceStatus,
    clarification: parseJson<Clarification | null>(r.clarification, null),
    changes,
    error: r.error,
    createdAt: r.created_at,
  }
}

/** Item -> full column list for INSERT/UPDATE. */
export function itemToRow(i: Item): ItemRow {
  return {
    id: i.id,
    kind: i.kind,
    title: i.title,
    details: i.details,
    status: i.status,
    owner_id: i.ownerId,
    created_by: i.createdBy,
    requested_by: i.requestedBy,
    due_at: i.dueAt,
    due_date: i.dueDate,
    snoozed_until: i.snoozedUntil,
    snooze_count: i.snoozeCount,
    priority: i.priority,
    parent_id: i.parentId,
    tags: JSON.stringify(i.tags),
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    completed_at: i.completedAt,
    responded_at: i.respondedAt,
    last_activity_at: i.lastActivityAt,
  }
}

// ---------------------------------------------------------------------------------------------
// Query helpers

const ITEM_COLUMNS = [
  'id',
  'kind',
  'title',
  'details',
  'status',
  'owner_id',
  'created_by',
  'requested_by',
  'due_at',
  'due_date',
  'snoozed_until',
  'snooze_count',
  'priority',
  'parent_id',
  'tags',
  'created_at',
  'updated_at',
  'completed_at',
  'responded_at',
  'last_activity_at',
] as const

export function insertItemRow(db: Db, item: Item): void {
  const row = itemToRow(item)
  db.prepare(
    `INSERT INTO items (${ITEM_COLUMNS.join(', ')}) VALUES (${ITEM_COLUMNS.map(c => '@' + c).join(', ')})`,
  ).run(row)
}

export function updateItemRow(db: Db, item: Item): void {
  const row = itemToRow(item)
  db.prepare(
    `UPDATE items SET ${ITEM_COLUMNS.filter(c => c !== 'id')
      .map(c => `${c} = @${c}`)
      .join(', ')} WHERE id = @id`,
  ).run(row)
}

export function getItemRow(db: Db, id: string): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined
}

/** Earliest scheduled fire_at per item (same semantics as Outbox.nextForItem, batched). */
export function remindAtMap(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT item_id, MIN(fire_at) AS t FROM notifications
       WHERE status = 'scheduled' AND item_id IS NOT NULL GROUP BY item_id`,
    )
    .all() as { item_id: string; t: string }[]
  return new Map(rows.map(r => [r.item_id, r.t]))
}

export function rowsToItems(db: Db, rows: ItemRow[]): Item[] {
  if (rows.length === 0) return []
  const remind = remindAtMap(db)
  return rows.map(r => toItem(r, remind.get(r.id) ?? null))
}

export const ACTIVE_SQL = `(${ACTIVE_STATUSES.map(s => `'${s}'`).join(', ')})`

export function getMemberRow(db: Db, id: string): MemberRow | undefined {
  return db.prepare('SELECT * FROM members WHERE id = ?').get(id) as MemberRow | undefined
}

export function listMemberRows(db: Db): MemberRow[] {
  return db.prepare('SELECT * FROM members ORDER BY created_at, rowid').all() as MemberRow[]
}

export function getFamilyRow(db: Db): FamilyRow | undefined {
  return db.prepare('SELECT * FROM family WHERE id = 1').get() as FamilyRow | undefined
}

export function listNoteRows(db: Db, itemId: string): NoteRow[] {
  return db.prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY created_at, rowid').all(itemId) as NoteRow[]
}

export function getUtteranceRow(db: Db, id: string): UtteranceRow | undefined {
  return db.prepare('SELECT * FROM utterances WHERE id = ?').get(id) as UtteranceRow | undefined
}

/** Builds Utterance.changes for many utterances in one query (oldest change first). */
export function changesForUtterances(db: Db, ids: string[]): Map<string, Change[]> {
  const out = new Map<string, Change[]>()
  if (ids.length === 0) return out
  const rows = db
    .prepare(
      `SELECT e.id, e.item_id, e.type, e.summary, e.payload, e.utterance_id, i.title AS item_title
       FROM events e LEFT JOIN items i ON i.id = e.item_id
       WHERE e.utterance_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY e.id`,
    )
    .all(...ids) as {
    id: number
    item_id: string | null
    type: string
    summary: string
    payload: string
    utterance_id: string
    item_title: string | null
  }[]
  for (const r of rows) {
    const payload = parseJson<Record<string, unknown>>(r.payload, {})
    const list = out.get(r.utterance_id) ?? []
    list.push({
      eventId: r.id,
      type: r.type as EventType,
      itemId: r.item_id,
      itemTitle: r.item_title ?? titleFromPayload(payload),
      summary: r.summary,
    })
    out.set(r.utterance_id, list)
  }
  return out
}

/** Title kept in an event payload (for events whose item was deleted by undo). */
export function titleFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.itemTitle === 'string') return payload.itemTitle
  const after = payload.after
  if (after && typeof after === 'object' && 'title' in after && typeof after.title === 'string') return after.title
  return null
}

export function getNotificationLite(db: Db, id: string): NotificationRowLite | undefined {
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRowLite | undefined
}

export function getNotificationByKey(db: Db, dedupeKey: string): NotificationRowLite | undefined {
  return db.prepare('SELECT * FROM notifications WHERE dedupe_key = ?').get(dedupeKey) as NotificationRowLite | undefined
}

/** Number of request_sent events ever written for an item (including undone ones) — the request round counter. */
export function requestRounds(db: Db, itemId: string): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE item_id = ? AND type = 'request_sent'`)
    .get(itemId) as { n: number }
  return r.n
}
