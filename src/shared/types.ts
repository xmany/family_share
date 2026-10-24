// Domain types shared by the server and the web app.
// All instants are ISO 8601 strings in UTC (e.g. "2026-10-24T21:30:00.000Z").
// Local calendar dates are "YYYY-MM-DD" in the family's timezone.
// Local times of day are "HH:MM" (24h) in the family's timezone.

export type MemberRole = 'adult' | 'kid' | 'relative'

export interface Member {
  id: string
  /** Display name, e.g. "老公", "老婆", "外婆" */
  name: string
  /** Other names the AI should map to this member, e.g. ["她", "老婆", "媳妇", "孩子妈"] */
  aliases: string[]
  role: MemberRole
  /** BCP 47, e.g. "zh-CN" */
  language: string
  /** Quiet hours, local "HH:MM". Notifications that respect quiet hours are deferred to quietEnd. */
  quietStart: string
  quietEnd: string
  /** Local "HH:MM" for the daily digest, or null to disable */
  digestTime: string | null
  /** CSS color used for this member's avatar */
  color: string
  createdAt: string
}

export interface Family {
  name: string
  /** IANA timezone, e.g. "Australia/Sydney" */
  timezone: string
}

/**
 * task     — something one person will do (has an owner)
 * request  — one member asked another to do something; needs accept/decline
 * idea     — no deadline, "someday / we should…"; resurfaced in the weekly review
 * reminder — a ping at a time, no real work attached
 */
export type ItemKind = 'task' | 'request' | 'idea' | 'reminder'

/**
 * open        — not started (tasks, ideas, reminders)
 * pending     — request waiting for the owner to accept or decline
 * accepted    — request accepted by the owner (behaves like an open task)
 * declined    — request declined by the owner (requester decides what next)
 * in_progress — started
 * blocked     — waiting on something outside the family
 * done        — finished
 * dropped     — no longer needed (we never hard-delete)
 */
export type ItemStatus =
  | 'open'
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'dropped'

export const ACTIVE_STATUSES: readonly ItemStatus[] = ['open', 'pending', 'accepted', 'declined', 'in_progress', 'blocked']
export const CLOSED_STATUSES: readonly ItemStatus[] = ['done', 'dropped']

export type Priority = 'low' | 'normal' | 'high'

export interface Item {
  id: string
  kind: ItemKind
  title: string
  details: string | null
  status: ItemStatus
  /** Who is responsible. null only for unassigned ideas. */
  ownerId: string | null
  createdBy: string
  /** For requests: who asked */
  requestedBy: string | null
  /** Exact deadline/appointment instant when a time is known */
  dueAt: string | null
  /** Local date when only the day is known (mutually exclusive with dueAt) */
  dueDate: string | null
  /** Next scheduled notification for this item (derived; read-only) */
  remindAt: string | null
  snoozedUntil: string | null
  snoozeCount: number
  priority: Priority
  parentId: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
  completedAt: string | null
  /** When the owner accepted/declined a request */
  respondedAt: string | null
  /** Last time anything happened to this item (any event or note) */
  lastActivityAt: string
}

export type ActorType = 'member' | 'ai' | 'system'

export interface Note {
  id: string
  itemId: string
  authorType: ActorType
  /** The human responsible (for ai notes: the member who spoke) */
  memberId: string | null
  text: string
  createdAt: string
}

export type EventType =
  | 'item_created'
  | 'item_updated'
  | 'status_changed'
  | 'item_reassigned'
  | 'note_added'
  | 'request_sent'
  | 'request_responded'
  | 'item_completed'
  | 'item_snoozed'
  | 'reminder_set'
  | 'reminder_cancelled'
  | 'undone'

export interface ItemEvent {
  id: number
  itemId: string | null
  actorType: ActorType
  /** The human responsible. For ai events: the member whose utterance caused it. null for system. */
  memberId: string | null
  type: EventType
  /** Short human-readable Chinese summary rendered by the server, e.g. "新建请求 → 老婆：带孩子出去（周六 08:30）" */
  summary: string
  /** Machine data. For undo: { before: Partial<Item> | null, after: Partial<Item> | null, ... } */
  payload: Record<string, unknown>
  utteranceId: string | null
  undone: boolean
  createdAt: string
}

export type UtteranceSource = 'text' | 'voice' | 'clarification' | 'wechat' | 'whatsapp'
export type UtteranceStatus = 'processing' | 'done' | 'clarify' | 'error' | 'undone'

export interface Clarification {
  question: string
  /** 2-4 short tappable answers */
  options: string[]
}

/** One change caused by an utterance, rendered as a line in the chat "what changed" card */
export interface Change {
  eventId: number
  type: EventType
  itemId: string | null
  itemTitle: string | null
  summary: string
}

export interface Utterance {
  id: string
  memberId: string
  source: UtteranceSource
  /** What the member said (typed text or the voice transcript) */
  text: string
  /** The assistant's short reply */
  reply: string | null
  status: UtteranceStatus
  clarification: Clarification | null
  changes: Change[]
  error: string | null
  createdAt: string
}

export type NotificationKind =
  | 'request_new' // someone asked you to do something
  | 'request_followup' // you haven't answered a request yet
  | 'request_noreply' // (to requester) they haven't answered your request
  | 'request_answered' // (to requester) they accepted/declined
  | 'assigned' // something was assigned to you
  | 'due' // something is due soon
  | 'explicit' // a reminder someone set on purpose
  | 'stale' // an undated task has been sitting for a while
  | 'digest' // daily summary
  | 'weekly' // weekly family sync
  | 'test'

export type NotificationStatus = 'scheduled' | 'sent' | 'cancelled' | 'failed' | 'skipped'

export interface NotificationAction {
  action: 'accept' | 'decline' | 'done' | 'snooze_tonight' | 'snooze_tomorrow' | 'open'
  title: string
}

export interface ScheduledNotification {
  id: string
  memberId: string
  itemId: string | null
  kind: NotificationKind
  fireAt: string
  title: string
  body: string
  /** In-app path to open (path routes, not hash routes), e.g. "/item/i_abc123" */
  url: string
  actions: NotificationAction[]
  /** Unique key to prevent duplicates, e.g. "due:i_abc:2026-10-24T21:30:00.000Z" */
  dedupeKey: string
  /** If true, deferred to the member's quietEnd when fireAt falls in quiet hours */
  respectQuietHours: boolean
  status: NotificationStatus
  attempts: number
  sentAt: string | null
  lastError: string | null
  createdAt: string
}

/**
 * Web push payload in the Declarative Web Push shape (RFC 8030 magic number).
 * iOS/iPadOS 18.4+ renders it without running the service worker (no action buttons);
 * Chrome/Android and older iOS hand it to the service worker `push` handler, which shows it
 * with `notification.data.actions` as buttons. Keep the serialized JSON under 3 KB.
 */
export interface PushPayload {
  web_push: 8030
  notification: {
    title: string
    body: string
    /** Absolute URL, e.g. "https://family.example.com/item/i_abc123?src=push" */
    navigate: string
    lang: string
    tag?: string
    data: {
      notificationId: string
      itemId: string | null
      kind: NotificationKind
      /** Buttons for the service worker (Android). iOS ignores them. */
      actions: NotificationAction[]
    }
  }
  /** WebKit extension; string per WebKit's example */
  app_badge?: string
}

/** How a member uses the WeChat channel. fallback = only when web push isn't healthy. */
export type WechatMode = 'fallback' | 'both' | 'only' | 'off'
