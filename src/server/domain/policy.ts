// Notification policy (SPEC §3) as pure functions: given an item, the members, "now", the family
// timezone and the scheduler config, return the outbox rows (NewNotification) to enqueue.
// The domain decides WHEN to call these (on send / respond / assign / timing change) and handles
// cancellation; nothing here touches the database.

import type { Config } from '../config'
import type { NewNotification } from '../notify/outbox'
import type { Item, Member, NotificationKind, ScheduledNotification } from '../../shared/types'
import { CLOSED_STATUSES } from '../../shared/types'
import { HOUR, MINUTE, addDaysToDate, deferPastQuietHours, localDate, localParts, zonedToUtc } from '../time'
import type { NotificationText } from './describe'
import {
  actions,
  assignedText,
  dueDayText,
  dueEveningText,
  dueSoonText,
  explicitReminderText,
  nameLookup,
  reminderItemText,
  requestAnsweredText,
  requestFollowupText,
  requestNewText,
  requestDroppedText,
  requestNoreplyText,
  snoozeText,
} from './describe'

export interface PolicyEnv {
  now: Date
  /** Family IANA timezone */
  timezone: string
  scheduler: Pick<Config['scheduler'], 'requestFollowupMin' | 'requestNoreplyMin'>
  members: readonly Member[]
  /** The member who made the change; never notified about their own action. */
  actorMemberId?: string | null
  /** Stored on every row so undoing the utterance can cancel it. */
  utteranceId?: string | null
}

/** A request is "urgent" (request_new ignores quiet hours) when its dueAt is within this window. */
export const URGENT_WINDOW_MS = 12 * HOUR
/** Request follow-ups never fire sooner than this after the request was sent. */
export const MIN_FOLLOWUP_DELAY_MS = 30 * MINUTE
/** Lead time of the main due reminder. */
export const DUE_LEAD_MS = 60 * MINUTE

/** Every dedupe key the domain uses. `<n>` is the request round (1 = first send, 2 = first re-send …). */
export const dedupeKeys = {
  requestNew: (itemId: string, n: number) => `request_new:${itemId}:${n}`,
  requestFollowup: (itemId: string, n: number) => `request_followup:${itemId}:${n}`,
  requestNoreply: (itemId: string, n: number) => `request_noreply:${itemId}:${n}`,
  /** 'dropped': the other side of a request closed as dropped (planRequestDropped) */
  requestAnswered: (itemId: string, response: 'accept' | 'decline' | 'done' | 'dropped', n: number) =>
    `request_answered:${itemId}:${response}:${n}`,
  assigned: (itemId: string, ownerId: string, eventId: number) => `assigned:${itemId}:${ownerId}:${eventId}`,
  /** dueAt (ISO instant) or dueDate (YYYY-MM-DD) */
  due: (itemId: string, when: string) => `due:${itemId}:${when}`,
  dueEve: (itemId: string, dueAt: string) => `due_eve:${itemId}:${dueAt}`,
  /** kind 'reminder' items: dueAt (ISO) or dueDate */
  reminder: (itemId: string, when: string) => `reminder:${itemId}:${when}`,
  /** setReminder without an item: `explicit:<memberId>:<fireAt>` */
  explicit: (memberId: string, fireAt: string) => `explicit:${memberId}:${fireAt}`,
  /**
   * setReminder / remindAt on an item: `explicit:<itemId>:<memberId>:<fireAt>`. The member is part of the key so two
   * people reminded about the same item at the same time each get their own row.
   */
  explicitItem: (itemId: string, memberId: string, fireAt: string) => `explicit:${itemId}:${memberId}:${fireAt}`,
  snooze: (itemId: string, until: string) => `snooze:${itemId}:${until}`,
}

/** Rows derived purely from an item's timing state (dueAt/dueDate/kind/owner/snoozedUntil). */
const TIMING_PREFIXES = ['due:', 'due_eve:', 'reminder:', 'snooze:'] as const
export function isTimingKey(dedupeKey: string): boolean {
  return TIMING_PREFIXES.some(p => dedupeKey.startsWith(p))
}

/** Kinds that belong to one round of a request (cancelled on respond / close / re-send). */
export const REQUEST_ROUND_KINDS: NotificationKind[] = ['request_new', 'request_followup', 'request_noreply']

/** Every kind except request_answered: what an undo cancels on an item that someone else closed (their "done" notice stays). */
export const NON_ANSWER_KINDS: NotificationKind[] = [
  'request_new',
  'request_followup',
  'request_noreply',
  'assigned',
  'due',
  'explicit',
  'stale',
  'digest',
  'weekly',
  'test',
]

const isClosed = (item: Item) => CLOSED_STATUSES.includes(item.status)

function dueRef(item: Item, tz: string): Date | null {
  if (item.dueAt) return new Date(item.dueAt)
  if (item.dueDate) return zonedToUtc(item.dueDate, '09:00', tz)
  return null
}

/**
 * request_new ignores quiet hours when the request is urgent: priority high, dueAt within 12 h
 * (or overdue), or a day-only dueDate of today or earlier.
 */
export function isUrgentRequest(item: Item, now: Date, tz: string): boolean {
  if (item.priority === 'high') return true
  if (item.dueAt) return new Date(item.dueAt).getTime() - now.getTime() <= URGENT_WINDOW_MS
  if (item.dueDate) return item.dueDate <= localDate(now, tz)
  return false
}

/** min(sent + REQUEST_FOLLOWUP_MIN, dueAt − 3 h), never sooner than sent + 30 min. */
export function requestFollowupAt(sentAt: Date, dueAt: string | null, cfg: PolicyEnv['scheduler']): Date {
  let t = sentAt.getTime() + cfg.requestFollowupMin * MINUTE
  if (dueAt) t = Math.min(t, new Date(dueAt).getTime() - 3 * HOUR)
  return new Date(Math.max(t, sentAt.getTime() + MIN_FOLLOWUP_DELAY_MS))
}

/**
 * min(sent + REQUEST_NOREPLY_MIN, dueAt − 1 h). Also floored at sent + 30 min (a request due within the
 * hour would otherwise tell the requester "no reply yet" the moment they sent it).
 */
export function requestNoreplyAt(sentAt: Date, dueAt: string | null, cfg: PolicyEnv['scheduler']): Date {
  let t = sentAt.getTime() + cfg.requestNoreplyMin * MINUTE
  if (dueAt) t = Math.min(t, new Date(dueAt).getTime() - HOUR)
  return new Date(Math.max(t, sentAt.getTime() + MIN_FOLLOWUP_DELAY_MS))
}

function notActor(memberId: string | null | undefined, env: PolicyEnv): memberId is string {
  return !!memberId && memberId !== env.actorMemberId
}

/**
 * When a round's request_new reaches the owner if it is sent at `sentAt`: right away when the request is urgent
 * (request_new ignores quiet hours), otherwise at the end of the owner's quiet hours when sent inside them.
 * request_followup and request_noreply are measured from here, not from sentAt: a request sent at 23:15 must not
 * nudge the owner ("还没回复") and the requester the same minute it first reaches the owner at 07:30.
 */
export function requestReachesOwnerAt(item: Item, sentAt: Date, env: Pick<PolicyEnv, 'timezone' | 'members'>): Date {
  if (isUrgentRequest(item, sentAt, env.timezone)) return sentAt
  const owner = env.members.find(m => m.id === item.ownerId)
  return owner ? deferPastQuietHours(sentAt, owner.quietStart, owner.quietEnd, env.timezone) : sentAt
}

/** sendRequest (or a re-send): request_new now + request_followup to the owner, request_noreply to the requester. */
export function planRequestSent(item: Item, round: number, env: PolicyEnv): NewNotification[] {
  if (item.kind !== 'request' || item.status !== 'pending' || !item.ownerId || !item.requestedBy) return []
  const nameOf = nameLookup(env.members)
  const tz = env.timezone
  const out: NewNotification[] = []
  const common = { itemId: item.id, utteranceId: env.utteranceId ?? null }
  // follow-up / no-reply count from when request_new actually reaches the owner (quiet hours may hold it back)
  const start = notActor(item.ownerId, env) ? requestReachesOwnerAt(item, env.now, env) : env.now
  if (notActor(item.ownerId, env)) {
    out.push({
      ...common,
      memberId: item.ownerId,
      kind: 'request_new',
      fireAt: env.now,
      ...requestNewText(item, nameOf(item.requestedBy), env.now, tz),
      actions: actions('accept', 'decline'),
      dedupeKey: dedupeKeys.requestNew(item.id, round),
      respectQuietHours: !isUrgentRequest(item, env.now, tz),
    })
    const followAt = requestFollowupAt(start, item.dueAt, env.scheduler)
    out.push({
      ...common,
      memberId: item.ownerId,
      kind: 'request_followup',
      fireAt: followAt,
      ...requestFollowupText(item, nameOf(item.requestedBy), followAt, tz),
      actions: actions('accept', 'decline'),
      dedupeKey: dedupeKeys.requestFollowup(item.id, round),
      respectQuietHours: true,
    })
  }
  const noreplyAt = requestNoreplyAt(start, item.dueAt, env.scheduler)
  out.push({
    ...common,
    memberId: item.requestedBy,
    kind: 'request_noreply',
    fireAt: noreplyAt,
    ...requestNoreplyText(item, nameOf(item.ownerId), noreplyAt, tz),
    actions: actions('open'),
    dedupeKey: dedupeKeys.requestNoreply(item.id, round),
    respectQuietHours: true,
  })
  return out
}

/**
 * To the requester when the owner accepts/declines, or when anyone completes the request ('done').
 * `responderId` defaults to the actor (for accept/decline it is the owner).
 */
export function planRequestAnswered(
  item: Item,
  response: 'accept' | 'decline' | 'done',
  round: number,
  env: PolicyEnv,
  opts: { message?: string | null; responderId?: string | null } = {},
): NewNotification[] {
  if (item.kind !== 'request' || !notActor(item.requestedBy, env)) return []
  const nameOf = nameLookup(env.members)
  const responder = opts.responderId ?? env.actorMemberId ?? item.ownerId
  return [
    {
      memberId: item.requestedBy,
      itemId: item.id,
      kind: 'request_answered',
      fireAt: env.now,
      ...requestAnsweredText(item, response, nameOf(responder), opts.message ?? null, env.now, env.timezone),
      actions: actions('open'),
      dedupeKey: dedupeKeys.requestAnswered(item.id, response, round),
      respectQuietHours: true,
      utteranceId: env.utteranceId ?? null,
    },
  ]
}

/**
 * A request closed as dropped: tell the other side it is off — the requester when the owner backs out, the owner
 * when the requester takes it back (a third person dropping it tells both). Never the actor. The caller skips this
 * for a request that was declined (both sides already know) and passes `ownerUnaware` when the owner never got the
 * request (its request_new was still waiting in the outbox): withdrawing it needs no notice.
 * Kind request_answered (the scheduler delivers it for a closed item); key `request_answered:<id>:dropped:<n>`, plus
 * `:<ownerId>` on the owner's row when both sides are told.
 */
export function planRequestDropped(
  item: Item,
  round: number,
  env: PolicyEnv,
  opts: { message?: string | null; ownerUnaware?: boolean } = {},
): NewNotification[] {
  if (item.kind !== 'request' || !item.ownerId || !item.requestedBy) return []
  const nameOf = nameLookup(env.members)
  const actorName = nameOf(env.actorMemberId ?? null)
  const byOwner = env.actorMemberId === item.ownerId
  const toRequester = notActor(item.requestedBy, env)
  const toOwner = notActor(item.ownerId, env) && !opts.ownerUnaware
  const key = dedupeKeys.requestAnswered(item.id, 'dropped', round)
  const row = (memberId: string, isOwner: boolean, dedupeKey: string): NewNotification => ({
    memberId,
    itemId: item.id,
    kind: 'request_answered',
    fireAt: env.now,
    ...requestDroppedText(item, actorName, { byOwner, toOwner: isOwner, message: opts.message ?? null }),
    actions: actions('open'),
    dedupeKey,
    respectQuietHours: true,
    utteranceId: env.utteranceId ?? null,
  })
  const out: NewNotification[] = []
  if (toRequester) out.push(row(item.requestedBy, false, key))
  if (toOwner) out.push(row(item.ownerId, true, toRequester ? `${key}:${item.ownerId}` : key))
  return out
}

/** The owner changed to someone other than the actor (also used when an item is created for someone else). */
export function planAssigned(item: Item, eventId: number, env: PolicyEnv): NewNotification[] {
  if (!notActor(item.ownerId, env) || isClosed(item)) return []
  const nameOf = nameLookup(env.members)
  return [
    {
      memberId: item.ownerId,
      itemId: item.id,
      kind: 'assigned',
      fireAt: env.now,
      ...assignedText(item, env.actorMemberId ? nameOf(env.actorMemberId) : null, env.now, env.timezone),
      actions: actions('done', 'open'),
      dedupeKey: dedupeKeys.assigned(item.id, item.ownerId, eventId),
      respectQuietHours: true,
      utteranceId: env.utteranceId ?? null,
    },
  ]
}

function dueEligible(item: Item): item is Item & { ownerId: string } {
  return !isClosed(item) && (item.kind === 'task' || item.kind === 'request') && item.status !== 'declined' && !!item.ownerId
}
function reminderEligible(item: Item): item is Item & { ownerId: string } {
  return !isClosed(item) && item.kind === 'reminder' && !!item.ownerId
}
function snoozeRecipient(item: Item): string | null {
  if (isClosed(item) || !item.snoozedUntil) return null
  return item.ownerId ?? item.createdBy
}

/**
 * The timing-derived dedupe keys that are valid for the item's CURRENT state, independent of "now".
 * Any scheduled timing row (see isTimingKey) whose key is not in this list is stale and must be cancelled.
 */
export function timingKeys(item: Item): string[] {
  const keys: string[] = []
  if (dueEligible(item)) {
    if (item.dueAt) keys.push(dedupeKeys.due(item.id, item.dueAt), dedupeKeys.dueEve(item.id, item.dueAt))
    else if (item.dueDate) keys.push(dedupeKeys.due(item.id, item.dueDate))
  }
  if (reminderEligible(item)) {
    if (item.dueAt) keys.push(dedupeKeys.reminder(item.id, item.dueAt))
    else if (item.dueDate) keys.push(dedupeKeys.reminder(item.id, item.dueDate))
  }
  if (snoozeRecipient(item) && item.snoozedUntil) keys.push(dedupeKeys.snooze(item.id, item.snoozedUntil))
  return keys
}

/**
 * Timing rows to (re)plan now: due reminders for tasks/requests, the reminder ping for kind 'reminder',
 * and the end-of-snooze ping. Only rows whose fire time is still ahead are returned.
 *
 * - dueAt (task/request): `due` at dueAt − 60 min (ignores quiet hours); plus `due_eve` at 20:00 the evening
 *   before when dueAt is before 10:00 local and more than 12 h away (respects quiet hours).
 * - dueDate (task/request): `due` at 09:00 on dueDate (respects quiet hours).
 * - kind reminder: `explicit` exactly at dueAt (ignores quiet hours), or 09:00 on dueDate (respects them).
 * - snoozedUntil: `due` at snoozedUntil to the owner (or the creator of an unowned idea), respects quiet hours.
 */
export function planTiming(item: Item, env: PolicyEnv): NewNotification[] {
  const tz = env.timezone
  const now = env.now.getTime()
  const out: NewNotification[] = []
  const common = { itemId: item.id, utteranceId: env.utteranceId ?? null }

  if (dueEligible(item)) {
    if (item.dueAt) {
      const due = new Date(item.dueAt)
      const soon = new Date(due.getTime() - DUE_LEAD_MS)
      if (soon.getTime() > now) {
        out.push({
          ...common,
          memberId: item.ownerId,
          kind: 'due',
          fireAt: soon,
          ...dueSoonText(item, soon, tz),
          actions: actions('done', 'snooze_tonight'),
          dedupeKey: dedupeKeys.due(item.id, item.dueAt),
          respectQuietHours: false,
        })
      }
      if (localParts(due, tz).hour < 10 && due.getTime() - now > 12 * HOUR) {
        const eve = zonedToUtc(addDaysToDate(localDate(due, tz), -1), '20:00', tz)
        if (eve.getTime() > now) {
          out.push({
            ...common,
            memberId: item.ownerId,
            kind: 'due',
            fireAt: eve,
            ...dueEveningText(item, eve, tz),
            actions: actions('done', 'snooze_tonight'),
            dedupeKey: dedupeKeys.dueEve(item.id, item.dueAt),
            respectQuietHours: true,
          })
        }
      }
    } else if (item.dueDate) {
      const at = zonedToUtc(item.dueDate, '09:00', tz)
      if (at.getTime() > now) {
        out.push({
          ...common,
          memberId: item.ownerId,
          kind: 'due',
          fireAt: at,
          ...dueDayText(item, at, tz),
          actions: actions('done', 'snooze_tomorrow'),
          dedupeKey: dedupeKeys.due(item.id, item.dueDate),
          respectQuietHours: true,
        })
      }
    }
  }

  if (reminderEligible(item)) {
    const when = item.dueAt ?? item.dueDate
    const at = item.dueAt ? new Date(item.dueAt) : item.dueDate ? zonedToUtc(item.dueDate, '09:00', tz) : null
    if (when && at && at.getTime() > now) {
      out.push({
        ...common,
        memberId: item.ownerId,
        kind: 'explicit',
        fireAt: at,
        ...reminderItemText(item, at, tz),
        actions: actions('done'),
        dedupeKey: dedupeKeys.reminder(item.id, when),
        respectQuietHours: !item.dueAt,
      })
    }
  }

  const snoozeTo = snoozeRecipient(item)
  if (snoozeTo && item.snoozedUntil) {
    const at = new Date(item.snoozedUntil)
    if (at.getTime() > now) {
      out.push({
        ...common,
        memberId: snoozeTo,
        kind: 'due',
        fireAt: at,
        ...snoozeText(item, at, tz),
        actions: actions('done', 'snooze_tomorrow'),
        dedupeKey: dedupeKeys.snooze(item.id, item.snoozedUntil),
        respectQuietHours: true,
      })
    }
  }
  return out
}

/** setReminder / createItem.remindAt: `explicit` at fireAt, ignores quiet hours. */
export function planExplicitReminder(
  args: { memberId: string; fireAt: Date; message: string; item: Item | null },
  env: PolicyEnv,
): NewNotification {
  const fireIso = args.fireAt.toISOString()
  return {
    memberId: args.memberId,
    itemId: args.item?.id ?? null,
    kind: 'explicit',
    fireAt: args.fireAt,
    ...explicitReminderText(args.message, args.item?.title ?? null, args.fireAt, env.timezone),
    actions: args.item ? actions('done', 'open') : [],
    dedupeKey: args.item ? dedupeKeys.explicitItem(args.item.id, args.memberId, fireIso) : dedupeKeys.explicit(args.memberId, fireIso),
    respectQuietHours: false,
    utteranceId: env.utteranceId ?? null,
  }
}

/** Instant used to describe an item's due time (dueAt, or 09:00 on dueDate). Exported for the scheduler. */
export function dueInstant(item: Item, tz: string): Date | null {
  return dueRef(item, tz)
}

/**
 * The text of an item-bound row as it should read at the instant it is delivered (`env.now`). Rows are worded when
 * they are planned (a decline at 23:10 says "明天 15:00"), but a quiet-hours deferral, a retry or downtime can move
 * delivery past midnight, so the scheduler re-renders them from the item's current state just before sending.
 * Titles that name who acted (request_answered, assigned) are kept: that person is not on the item.
 * `answerMessage` is the message of the accept/decline a request_answered row reports; undefined = unknown.
 * Returns null when the stored text stays as it is: explicit setReminder rows, stale / digest / weekly / test rows,
 * request_answered for a completion or a drop (no due label) or with an unknown message.
 */
export function textAtDelivery(
  n: Pick<ScheduledNotification, 'kind' | 'dedupeKey' | 'title'>,
  item: Item,
  env: { now: Date; timezone: string; members: readonly Member[]; answerMessage?: string | null },
): NotificationText | null {
  const { now, timezone: tz } = env
  const nameOf = nameLookup(env.members)
  const key = n.dedupeKey
  switch (n.kind) {
    case 'request_new':
      return requestNewText(item, nameOf(item.requestedBy), now, tz)
    case 'request_followup':
      return requestFollowupText(item, nameOf(item.requestedBy), now, tz)
    case 'request_noreply':
      return requestNoreplyText(item, nameOf(item.ownerId), now, tz)
    case 'request_answered': {
      const response = key.split(':')[2] // request_answered:<itemId>:<response>:<n>[:<memberId>]
      if ((response !== 'accept' && response !== 'decline') || env.answerMessage === undefined) return null
      return { title: n.title, body: requestAnsweredText(item, response, '', env.answerMessage, now, tz).body }
    }
    case 'assigned':
      return { title: n.title, body: assignedText(item, null, now, tz).body }
    case 'due':
      if (key.startsWith('due_eve:')) return dueEveningText(item, now, tz)
      if (key.startsWith('snooze:')) return snoozeText(item, now, tz)
      if (key.startsWith('due:')) return item.dueAt ? dueSoonText(item, now, tz) : dueDayText(item, now, tz)
      return null
    case 'explicit':
      return key.startsWith('reminder:') ? reminderItemText(item, now, tz) : null
    default:
      return null
  }
}
