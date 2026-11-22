import type { RepeatInput } from '../../shared/repeat'
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
  UtteranceVisibility,
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
  /** Makes it a repeating item (task / reminder; needs a due, which is the first occurrence) */
  repeat?: RepeatInput | null
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
  /**
   * Starts repeating or changes how (re-anchored on the item's due date, which is the next occurrence); null stops
   * repeating. Omit to keep the series: a new due date alone moves only the current occurrence.
   */
  repeat?: RepeatInput | null
}

export interface SendRequestInput {
  toMemberId: string
  title: string
  details?: string | null
  dueAt?: string | null
  dueDate?: string | null
  priority?: Priority
  parentId?: string | null
  /** A repeating request (needs a due, the first occurrence): accepted once, then each occurrence is completed */
  repeat?: RepeatInput | null
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

export interface NewUtteranceOptions {
  /** The utterance this one answers. It must be in the same chat: a private one can only be answered by its owner, in private. */
  replyTo?: string | null
  audioPath?: string | null
  /** Default 'family' */
  visibility?: UtteranceVisibility
}

/**
 * Which chat to read.
 * - 'family' (default): the chat every member sees
 * - { privateOf }: only that member's private chat with the assistant
 * - { visibleTo }: everything that member can see — the family chat and their own private chat, in one timeline
 * No scope returns another member's private utterances.
 */
export type UtteranceScope = 'family' | { privateOf: string } | { visibleTo: string }

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
  /** The board as this member sees it: `utterances` holds the family chat and this member's own private chat. */
  getBoard(memberId: string): BoardResponse

  // ---- writes
  createItem(actor: Actor, input: CreateItemInput): Item
  updateItem(actor: Actor, id: string, changes: UpdateItemInput, reason?: string): Item
  addNote(actor: Actor, itemId: string, text: string): Note
  sendRequest(actor: Actor, input: SendRequestInput): Item
  respondToRequest(actor: Actor, itemId: string, response: 'accept' | 'decline', message?: string): Item
  /** Closes the item as done. A repeating item instead moves on to its next occurrence (status stays active). */
  completeItem(actor: Actor, itemId: string, note?: string): Item
  /** A repeating item: this occurrence will not happen; move on to the next one. */
  skipOccurrence(actor: Actor, itemId: string, note?: string): Item
  snoozeItem(actor: Actor, itemId: string, until: Date): Item
  setReminder(actor: Actor, input: SetReminderInput): ScheduledNotification
  cancelReminder(actor: Actor, notificationId: string): void
  /**
   * Scheduler: moves repeating items whose occurrence went by without being completed on to their next occurrence
   * (see occurrences.ts rolloverAt). System actor; returns how many items moved.
   */
  rollOverRepeats(): number

  // ---- utterances
  createUtterance(memberId: string, source: UtteranceSource, text: string, opts?: NewUtteranceOptions): Utterance
  finishUtterance(id: string, result: FinishUtteranceInput): Utterance
  /** Any utterance by id, private ones included: callers that answer a member must check `visibility` themselves. */
  getUtterance(id: string): Utterance | null
  /** The most recent utterances of a chat, oldest first. Without a scope: the family chat. */
  recentUtterances(limit: number, scope?: UtteranceScope): Utterance[]
  /**
   * Reverts every event caused by the utterance (newest first), cancels notifications it scheduled, marks it 'undone'.
   * A family utterance: by the member who said it or any adult. A private one: only by the member who said it
   * (to anyone else it does not exist: not_found).
   */
  undoUtterance(actor: Actor, utteranceId: string): UndoResponse
}
