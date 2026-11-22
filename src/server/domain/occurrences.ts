// Repeating items, item-level rules (the calendar math is in src/shared/repeat.ts).
//
// A repeating item is ONE item whose dueAt / dueDate is its current occurrence. It moves on to the next occurrence:
// - when it is completed (完成这次) or skipped (跳过这次) — the next occurrence after the current one, and never one
//   that is already over;
// - by itself (the scheduler's rollover) when nobody completed it: a reminder item once its ping is done with
//   (ROLLOVER_GRACE_MS after its time); a task or request only from the start of the day before the next occurrence,
//   so a missed one stays on the board as overdue until then and the next one still gets all its pings.
// The time of day stays the same wall-clock time across DST changes (each occurrence is converted on its own).

import type { Item, RepeatRule } from '../../shared/types'
import { nextOccurrence } from '../../shared/repeat'
import { HOUR, addDaysToDate, localDate, localTime, zonedToUtc } from '../time'

/** How long after a timed occurrence before the scheduler moves it on: covers the ping's retries (1+5+15+60 min). */
export const ROLLOVER_GRACE_MS = 2 * HOUR
/** Safety cap on how many occurrences one move may step over (e.g. after a long downtime). */
const MAX_STEPS = 1000

export interface Occurrence {
  dueAt: string | null
  dueDate: string | null
  /** Local date of the occurrence (the rule's new anchor) */
  date: string
}

/** Local date and time of day of the item's due; null when it has none. */
export function dueParts(item: Pick<Item, 'dueAt' | 'dueDate'>, tz: string): { date: string; time: string | null } | null {
  if (item.dueAt) {
    const t = new Date(item.dueAt)
    return { date: localDate(t, tz), time: localTime(t, tz) }
  }
  if (item.dueDate) return { date: item.dueDate, time: null }
  return null
}

/** The due fields of the occurrence on `date` at the item's time of day. */
export function occurrenceOn(date: string, time: string | null, tz: string): Occurrence {
  return time ? { dueAt: zonedToUtc(date, time, tz).toISOString(), dueDate: null, date } : { dueAt: null, dueDate: date, date }
}

/** True once the occurrence has passed: its time has come, or (date only) its day is over. */
export function occurrenceOver(o: Pick<Occurrence, 'dueAt' | 'dueDate'>, now: Date, tz: string): boolean {
  if (o.dueAt) return new Date(o.dueAt).getTime() <= now.getTime()
  if (o.dueDate) return o.dueDate < localDate(now, tz)
  return false
}

/**
 * The occurrence after the item's current one. The series position is max(anchor, current due date): an occurrence
 * moved later (改到周一) is followed by the next one after it, and one moved earlier (提前到周六) still counts as
 * the occurrence it stood for, so completing it does not bring back the very next day.
 * With `notOverAt`, occurrences already over at that instant are stepped over too (completing an old one late).
 */
export function nextOccurrenceOf(item: Pick<Item, 'dueAt' | 'dueDate' | 'repeat'>, tz: string, notOverAt?: Date): Occurrence | null {
  const rule = item.repeat
  const cur = dueParts(item, tz)
  if (!rule || !cur) return null
  let after = rule.anchor > cur.date ? rule.anchor : cur.date
  for (let i = 0; i < MAX_STEPS; i++) {
    const next = occurrenceOn(nextOccurrence(rule, after), cur.time, tz)
    if (!notOverAt || !occurrenceOver(next, notOverAt, tz)) return next
    after = next.date
  }
  return null
}

/** The item as it stands after moving on to `o` (due fields and the rule's anchor; nothing else). */
export function movedTo<T extends Pick<Item, 'dueAt' | 'dueDate' | 'repeat'>>(item: T, o: Occurrence): T {
  return { ...item, dueAt: o.dueAt, dueDate: o.dueDate, repeat: { ...(item.repeat as RepeatRule), anchor: o.date } }
}

/**
 * When the scheduler moves an occurrence nobody completed on to the next one; null for an item that does not repeat
 * (or has no due). Reminder items: ROLLOVER_GRACE_MS after their time (date only: when their day is over). Tasks and
 * requests: when their occurrence is over that way AND the day before the next occurrence has begun.
 */
export function rolloverAt(item: Pick<Item, 'kind' | 'dueAt' | 'dueDate' | 'repeat'>, tz: string): Date | null {
  const cur = dueParts(item, tz)
  if (!item.repeat || !cur) return null
  const over = item.dueAt
    ? new Date(new Date(item.dueAt).getTime() + ROLLOVER_GRACE_MS)
    : zonedToUtc(addDaysToDate(cur.date, 1), '00:00', tz)
  if (item.kind === 'reminder') return over
  const next = nextOccurrenceOf(item, tz)
  if (!next) return over
  const dayBefore = zonedToUtc(addDaysToDate(next.date, -1), '00:00', tz)
  return dayBefore.getTime() > over.getTime() ? dayBefore : over
}

/**
 * Where a rollover at `now` moves the item: the first occurrence whose own rollover is still ahead. null when nothing
 * is due to move yet.
 */
export function rolloverTarget(item: Pick<Item, 'kind' | 'dueAt' | 'dueDate' | 'repeat'>, now: Date, tz: string): Occurrence | null {
  const at = rolloverAt(item, tz)
  if (!at || at.getTime() > now.getTime()) return null
  let cur = item
  let target: Occurrence | null = null
  for (let i = 0; i < MAX_STEPS; i++) {
    const next = nextOccurrenceOf(cur, tz)
    if (!next) return target
    target = next
    cur = movedTo(cur, next)
    const again = rolloverAt(cur, tz)
    if (!again || again.getTime() > now.getTime()) break
  }
  return target
}
