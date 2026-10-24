import type {
  BoardResponse,
  ItemDetailResponse,
  UndoResponse,
} from '../../shared/api'
import type {
  Clarification,
  Family,
  Item,
  ItemEvent,
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

/** Who is making a change. For AI changes, memberId is the speaker and utteranceId links the change to what they said. */
export interface Actor {
  type: 'member' | 'ai' | 'system'
  memberId: string | null
  utteranceId?: string | null
}

export type DomainErrorCode = 'not_found' | 'invalid' | 'forbidden' | 'conflict'

/** Thrown for any rejected operation. The message is shown to the AI (as a tool error) or the user, in Chinese where possible. */
export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export interface CreateItemInput {
  kind: ItemKind
  title: string
  details?: string | null
  /** Defaults to the actor's member for task/reminder; may be null for ideas. Use sendRequest to ask someone else. */
  ownerId?: string | null
  dueAt?: string | null
  dueDate?: string | null
  priority?: Priority
  parentId?: string | null
  tags?: string[]
  /** Optional explicit reminder for the owner at this instant */
  remindAt?: string | null
}

export interface UpdateItemInput {
  /** idea <-> task <-> reminder conversions only; requests stay requests */
  kind?: Exclude<ItemKind, 'request'>
  title?: string
  details?: string | null
  status?: ItemStatus
  ownerId?: string | null
  dueAt?: string | null
  dueDate?: string | null
  priority?: Priority
  tags?: string[]
  parentId?: string | null
}

export interface SendRequestInput {
  toMemberId: string
  title: string
  details?: string | null
  dueAt?: string | null
  dueDate?: string | null
  priority?: Priority
  parentId?: string | null
}

export interface SetReminderInput {
  itemId?: string | null
  /** Who gets the reminder */
  memberId: string
  fireAt: string
  message: string
}

export interface SearchItemsQuery {
  /** Substring match on title/details/notes (case-insensitive) */
  text?: string
  status?: ItemStatus[]
  kind?: ItemKind
  ownerId?: string
  includeClosed?: boolean
  limit?: number
}

export interface NewMemberInput {
  name: string
  aliases?: string[]
  role: MemberRole
  color?: string
  language?: string
}

export interface MemberPatch {
  name?: string
  aliases?: string[]
  quietStart?: string
  quietEnd?: string
  digestTime?: string | null
  color?: string
  language?: string
}

export interface FinishUtteranceInput {
  status: UtteranceStatus
  reply: string | null
  clarification?: Clarification | null
  error?: string | null
  model?: string | null
  usage?: unknown
}

/**
 * The domain service: the ONLY code that writes items, notes, events, utterances and members.
 * Every write runs in a single SQLite transaction, records ItemEvents (with before/after for undo),
 * enqueues notifications through the Outbox per the notification policy, and broadcasts
 * { type: 'board_changed' } on the Bus after commit.
 */
export interface Domain {
  // ---- family & members
  ensureFamily(name: string, timezone: string): Family
  getFamily(): Family
  setTimezone(timezone: string): Family
  listMembers(): Member[]
  getMember(id: string): Member | null
  createMember(input: NewMemberInput): Member
  updateMember(id: string, patch: MemberPatch): Member

  // ---- reads
  getItem(id: string): Item | null
  getItemDetail(id: string): ItemDetailResponse | null
  listActiveItems(): Item[]
  /** Items closed (done/dropped) since the given instant */
  listClosedSince(since: Date): Item[]
  searchItems(query: SearchItemsQuery): Item[]
  listNotes(itemId: string): Note[]
  recentEvents(limit: number): ItemEvent[]
  getBoard(memberId: string): BoardResponse

  // ---- writes
  createItem(actor: Actor, input: CreateItemInput): Item
  updateItem(actor: Actor, id: string, changes: UpdateItemInput, reason?: string): Item
  addNote(actor: Actor, itemId: string, text: string): Note
  sendRequest(actor: Actor, input: SendRequestInput): Item
  respondToRequest(actor: Actor, itemId: string, response: 'accept' | 'decline', message?: string): Item
  completeItem(actor: Actor, itemId: string, note?: string): Item
  snoozeItem(actor: Actor, itemId: string, until: Date): Item
  setReminder(actor: Actor, input: SetReminderInput): ScheduledNotification
  cancelReminder(actor: Actor, notificationId: string): void

  // ---- utterances
  createUtterance(memberId: string, source: UtteranceSource, text: string, opts?: { replyTo?: string | null; audioPath?: string | null }): Utterance
  finishUtterance(id: string, result: FinishUtteranceInput): Utterance
  getUtterance(id: string): Utterance | null
  recentUtterances(limit: number): Utterance[]
  /** Reverts every event caused by the utterance (newest first), cancels notifications it scheduled, marks it 'undone'. */
  undoUtterance(actor: Actor, utteranceId: string): UndoResponse
}
