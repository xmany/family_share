// Delivery-time checks (SPEC §3): is an outbox row still worth sending, and how late is it?

import type { Item, NotificationKind, ScheduledNotification } from '../../shared/types'
import { CLOSED_STATUSES } from '../../shared/types'
import { explicitReminderText } from '../domain/describe'
import { isTimingKey, timingKeys } from '../domain/policy'
import { HOUR, MINUTE, localDate } from '../time'
import { isStaleCandidate } from './generators'

export const LATE_PREFIX = '（迟到）'
/** Rows delivered more than this after their fire time get the LATE_PREFIX. */
export const LATE_AFTER_MS = 15 * MINUTE
/** Rows of these kinds more than this late are skipped (too_late). */
export const TOO_LATE_MS = 12 * HOUR
export const TOO_LATE_KINDS: readonly NotificationKind[] = ['due', 'digest', 'weekly', 'stale', 'request_followup']

const REQUEST_ROUND: readonly NotificationKind[] = ['request_new', 'request_followup', 'request_noreply']

/**
 * Why a due row should be skipped instead of delivered, or null to deliver it.
 * - request_answered is exempt from the "pending" and "closed" checks (the answer IS the state change; a
 *   `request_answered:<id>:done:<n>` row always concerns a closed item).
 * - request_new / followup / noreply: the request must still be pending (and the recipient still the owner/requester).
 * - any other item-bound row: the item must not be closed.
 * - request_followup / request_noreply: not once the request is due (requestPastDue).
 * - timing rows (due:, due_eve:, snooze:, reminder: keys): the key must still be one of timingKeys(item), and
 *   while the item is snoozed only its snooze: row goes out (the board and the digest hide snoozed items too).
 * - assigned: the recipient must still own the item. stale: the item must still be stale.
 */
export function skipReason(
  n: Pick<ScheduledNotification, 'kind' | 'itemId' | 'memberId' | 'dedupeKey'>,
  item: Item | null,
  now: Date,
  tz: string,
): string | null {
  if (!n.itemId) return null
  if (!item) return 'item_missing'
  if (n.kind === 'request_answered') return null
  if (REQUEST_ROUND.includes(n.kind)) {
    if (item.kind !== 'request' || item.status !== 'pending') return 'not_pending'
    const recipient = n.kind === 'request_noreply' ? item.requestedBy : item.ownerId
    if (recipient !== n.memberId) return 'recipient_changed'
    if (requestPastDue(n, item, now, tz)) return 'past_due'
    return null
  }
  if (CLOSED_STATUSES.includes(item.status)) return 'item_closed'
  if (isTimingKey(n.dedupeKey) && !timingKeys(item).includes(n.dedupeKey)) return 'timing_changed'
  if (isTimingKey(n.dedupeKey) && !n.dedupeKey.startsWith('snooze:') && isSnoozedAt(item, now)) return 'snoozed'
  if (n.kind === 'assigned' && item.ownerId !== n.memberId) return 'recipient_changed'
  if (n.kind === 'stale' && (item.ownerId !== n.memberId || !isStaleCandidate(item, now))) return 'not_stale'
  return null
}

const isSnoozedAt = (item: Pick<Item, 'snoozedUntil'>, at: Date) =>
  !!item.snoozedUntil && new Date(item.snoozedUntil).getTime() > at.getTime()

/**
 * A request's follow-up ("还没回复") and the requester's no-reply notice are pointless once the request is due: its
 * dueAt has come, or its dueDate is over. Asking at 07:30 to accept a 07:00 airport run only confuses both sides.
 * Also used to cap a quiet-hours deferral of these rows at the due time.
 */
export function requestPastDue(
  n: Pick<ScheduledNotification, 'kind'>,
  item: Pick<Item, 'dueAt' | 'dueDate'>,
  at: Date,
  tz: string,
): boolean {
  if (n.kind !== 'request_followup' && n.kind !== 'request_noreply') return false
  if (item.dueAt) return new Date(item.dueAt).getTime() <= at.getTime()
  if (item.dueDate) return item.dueDate < localDate(at, tz)
  return false
}

/** Kinds that ping a member about an item at a time: due / due_eve / snooze pings, reminder items, setReminder. */
const PING_KINDS: readonly NotificationKind[] = ['due', 'explicit']
/** Two pings about the same item for the same member this close together are one too many. */
export const DUPLICATE_PING_MS = MINUTE

/**
 * True when the member already got a ping about the same item at (about) the same time: a reminder set for the
 * minute of the item's own due ping (dueAt − 60 min, the 20:00 evening-before slot, 09:00 on a dueDate), in either
 * order of setting them. The first one delivered wins; this one is skipped. `siblings` = the item's rows.
 * A setReminder row with its own message (not just the item's title) still goes out: it says something new.
 */
export function duplicatePing(
  n: Pick<ScheduledNotification, 'id' | 'kind' | 'itemId' | 'memberId' | 'fireAt' | 'dedupeKey' | 'title'>,
  item: Pick<Item, 'title'>,
  siblings: readonly Pick<ScheduledNotification, 'id' | 'kind' | 'memberId' | 'status' | 'sentAt'>[],
): boolean {
  if (!n.itemId || !PING_KINDS.includes(n.kind)) return false
  // (the title does not depend on the time or the timezone)
  const plainTitle = explicitReminderText(item.title, item.title, new Date(n.fireAt), 'UTC').title
  if (n.dedupeKey.startsWith('explicit:') && n.title !== plainTitle) return false
  const from = new Date(n.fireAt).getTime() - DUPLICATE_PING_MS
  return siblings.some(
    s =>
      s.id !== n.id &&
      s.memberId === n.memberId &&
      PING_KINDS.includes(s.kind) &&
      s.status === 'sent' &&
      !!s.sentAt &&
      new Date(s.sentAt).getTime() >= from,
  )
}

/**
 * A `due_eve:` row ("明早：…", 20:00 the evening before an early dueAt) is pointless — and its wording ("明早" /
 * "明天 08:30") is wrong — once it would reach the member on the due day itself: quiet hours that start before 20:00
 * push it into the due morning, or the server was down overnight. The 60-minute `due` row covers that morning.
 */
export function eveningBeforeMissed(
  n: Pick<ScheduledNotification, 'dedupeKey'>,
  item: Pick<Item, 'dueAt'> | null,
  deliverAt: Date,
  tz: string,
): boolean {
  if (!n.dedupeKey.startsWith('due_eve:') || !item?.dueAt) return false
  return localDate(deliverAt, tz) >= localDate(new Date(item.dueAt), tz)
}

export function lateness(n: Pick<ScheduledNotification, 'fireAt'>, now: Date): number {
  return Math.max(0, now.getTime() - new Date(n.fireAt).getTime())
}

export function isTooLate(n: Pick<ScheduledNotification, 'kind' | 'fireAt'>, now: Date): boolean {
  return TOO_LATE_KINDS.includes(n.kind) && lateness(n, now) > TOO_LATE_MS
}

export function withLatePrefix<T extends Pick<ScheduledNotification, 'title' | 'fireAt'>>(n: T, now: Date): T {
  if (lateness(n, now) <= LATE_AFTER_MS || n.title.startsWith(LATE_PREFIX)) return n
  return { ...n, title: LATE_PREFIX + n.title }
}
