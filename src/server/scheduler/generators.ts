// Scheduler generators (SPEC §3): daily digest, stale nudge, weekly sync. Pure functions from the board state to
// the outbox rows to enqueue; the scheduler decides when to call them and enqueues with their dedupe keys.

import type { NewNotification } from '../notify/outbox'
import type { Item, ItemStatus, Member } from '../../shared/types'
import { actions, clip, nameLookup } from '../domain/describe'
import { DAY, HOUR, WEEKDAY_ZH, addDaysToDate, localDate, weekdayOfDate } from '../time'

export const DIGEST_URL = '/board'
export const WEEKLY_URL = '/weekly'
/** Local time of the stale nudge and of the Sunday weekly sync. */
export const STALE_TIME = '19:00'
export const WEEKLY_TIME = '19:00'
export const STALE_AFTER_MS = 5 * DAY
export const STALE_EVERY_DAYS = 4
export const BODY_MAX = 120
export const TITLE_MAX = 40

export interface GenEnv {
  now: Date
  /** Family IANA timezone */
  tz: string
  members: readonly Member[]
  /** Active items (ACTIVE_STATUSES) */
  items: readonly Item[]
}

export const digestKey = (memberId: string, localDay: string) => `digest:${memberId}:${localDay}`
export const weeklyKey = (memberId: string, localDay: string) => `weekly:${memberId}:${localDay}`
export const staleKey = (itemId: string, bucket: number) => `stale:${itemId}:${bucket}`

const WORKING_TASK: readonly ItemStatus[] = ['open', 'in_progress', 'blocked']
const WORKING_REQUEST: readonly ItemStatus[] = ['accepted', 'in_progress', 'blocked']
const WAITING_ON_OTHERS: readonly ItemStatus[] = ['pending', 'accepted', 'in_progress', 'blocked']

/** "10/22 周四" */
export function shortDateLabel(localDay: string): string {
  const [, m, d] = localDay.split('-').map(Number) as [number, number, number]
  return `${m}/${d} ${WEEKDAY_ZH[weekdayOfDate(localDay)]}`
}

const isSnoozed = (i: Item, now: Date) => !!i.snoozedUntil && new Date(i.snoozedUntil).getTime() > now.getTime()
const dueDay = (i: Item, tz: string): string | null => (i.dueAt ? localDate(new Date(i.dueAt), tz) : i.dueDate)
/** Rough chronological key (dueAt is UTC, dueDate local; good enough to order a short list). */
const dueSortKey = (i: Item) => i.dueAt ?? (i.dueDate ? `${i.dueDate}T99` : '9999')
const uniq = <T>(xs: T[]) => [...new Set(xs)]

function compose(parts: string[], highlights: string[]): string {
  const head = parts.join('，')
  const tail = highlights.length ? `。${highlights.join('、')}` : ''
  return clip(head + tail, BODY_MAX)
}

// ---------------------------------------------------------------------------------------------
// Daily digest

/**
 * Today's items, overdue, requests waiting for this member's answer, and what they are waiting on from others.
 * null when there is nothing to say.
 */
export function digestNotification(member: Member, env: GenEnv, fireAt: Date): NewNotification | null {
  const { now, tz, items } = env
  const nameOf = nameLookup(env.members)
  const today = localDate(now, tz)
  const byDue = (a: Item, b: Item) => dueSortKey(a).localeCompare(dueSortKey(b))

  // pending / declined requests are not "work" yet
  const mine = items.filter(
    i => i.ownerId === member.id && !(i.kind === 'request' && (i.status === 'pending' || i.status === 'declined')) && !isSnoozed(i, now),
  )
  const overdue = mine
    .filter(i => (i.dueAt ? new Date(i.dueAt).getTime() < now.getTime() : !!i.dueDate && i.dueDate < today))
    .sort(byDue)
  const todays = mine.filter(i => !overdue.includes(i) && dueDay(i, tz) === today).sort(byDue)
  const waitingForMe = items
    .filter(i => i.kind === 'request' && i.status === 'pending' && i.ownerId === member.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const waitingOnOthers = items
    .filter(i => i.kind === 'request' && i.requestedBy === member.id && !!i.ownerId && i.ownerId !== member.id && WAITING_ON_OTHERS.includes(i.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  if (!overdue.length && !todays.length && !waitingForMe.length && !waitingOnOthers.length) return null

  const parts: string[] = []
  if (todays.length) parts.push(`今天要做 ${todays.length} 件`)
  if (overdue.length) parts.push(`已过期 ${overdue.length} 件`)
  if (waitingForMe.length) parts.push(`${uniq(waitingForMe.map(i => nameOf(i.requestedBy))).join('、')}在等你回复 ${waitingForMe.length} 件`)
  if (waitingOnOthers.length) parts.push(`你在等${uniq(waitingOnOthers.map(i => nameOf(i.ownerId))).join('、')} ${waitingOnOthers.length} 件`)
  const top = uniq([...waitingForMe, ...overdue, ...todays, ...waitingOnOthers])
    .slice(0, 3)
    .map(i => clip(i.title, 16))

  return {
    memberId: member.id,
    itemId: null,
    kind: 'digest',
    fireAt,
    title: clip(`今日摘要 · ${shortDateLabel(today)}`, TITLE_MAX),
    body: compose(parts, top),
    url: DIGEST_URL,
    actions: [],
    dedupeKey: digestKey(member.id, today),
    respectQuietHours: true,
  }
}

// ---------------------------------------------------------------------------------------------
// Stale nudge

/** Active task / accepted request, owned, no due date, not snoozed, nothing happened for more than 5 days. */
export function isStaleCandidate(item: Item, now: Date): boolean {
  if (item.dueAt || item.dueDate || !item.ownerId) return false
  if (item.kind === 'task') {
    if (!WORKING_TASK.includes(item.status)) return false
  } else if (item.kind === 'request') {
    if (!WORKING_REQUEST.includes(item.status)) return false
  } else {
    return false
  }
  if (isSnoozed(item, now)) return false
  return now.getTime() - new Date(item.lastActivityAt).getTime() > STALE_AFTER_MS
}

export function daysSinceActivity(item: Item, now: Date): number {
  return Math.floor((now.getTime() - new Date(item.lastActivityAt).getTime()) / DAY)
}

/** floor(daysSinceActivity / 4) — SPEC §3 */
export function staleBucket(item: Item, now: Date): number {
  return Math.floor(daysSinceActivity(item, now) / STALE_EVERY_DAYS)
}

export function staleNotification(item: Item & { ownerId: string }, env: GenEnv, fireAt: Date): NewNotification {
  const nameOf = nameLookup(env.members)
  const days = daysSinceActivity(item, env.now)
  const asked = item.kind === 'request' && item.requestedBy && item.requestedBy !== item.ownerId ? `${nameOf(item.requestedBy)}请你做的，` : ''
  return {
    memberId: item.ownerId,
    itemId: item.id,
    kind: 'stale',
    fireAt,
    title: clip(`好几天没动静了：${item.title}`, TITLE_MAX),
    body: clip(`${asked}已经 ${days} 天没更新了。定个时间、拆成小步，还是不做了？`, BODY_MAX),
    actions: actions('snooze_tomorrow', 'done', 'open'),
    dedupeKey: staleKey(item.id, staleBucket(item, env.now)),
    respectQuietHours: true,
  }
}

// ---------------------------------------------------------------------------------------------
// Weekly sync (Sunday 19:00, adults)

/** Monday 00:00 local of the week containing `now` (weeks run Monday–Sunday). */
export function weekStartLocalDay(now: Date, tz: string): string {
  const today = localDate(now, tz)
  const wd = weekdayOfDate(today)
  return addDaysToDate(today, -((wd + 6) % 7))
}

/**
 * Done this week (with who did what), stuck (> 7 days open), ideas waiting for a decision, next week's dated items.
 * The same family-wide summary goes to every adult. null when there is nothing at all.
 */
export function weeklyNotification(member: Member, env: GenEnv & { doneThisWeek: readonly Item[] }, fireAt: Date): NewNotification | null {
  const { now, tz, items } = env
  const nameOf = nameLookup(env.members)
  const today = localDate(now, tz)
  const done = env.doneThisWeek.filter(i => i.status === 'done')
  const stuck = items
    .filter(i => i.kind !== 'idea' && now.getTime() - new Date(i.createdAt).getTime() > 7 * DAY)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const ideas = items.filter(i => i.kind === 'idea')
  const end = addDaysToDate(today, 7)
  const nextWeek = items
    .filter(i => {
      const d = dueDay(i, tz)
      return !!d && d > today && d <= end
    })
    .sort((a, b) => dueSortKey(a).localeCompare(dueSortKey(b)))

  if (!done.length && !stuck.length && !ideas.length && !nextWeek.length) return null

  const parts: string[] = []
  if (done.length) {
    const counts = new Map<string, number>()
    for (const i of done) {
      const who = i.ownerId ? nameOf(i.ownerId) : null
      if (who) counts.set(who, (counts.get(who) ?? 0) + 1)
    }
    const breakdown = [...counts.entries()].map(([who, n]) => `${who} ${n}`).join('、')
    parts.push(`本周完成 ${done.length} 件${breakdown ? `（${breakdown}）` : ''}`)
  }
  if (stuck.length) parts.push(`${stuck.length} 件拖了一周多`)
  if (ideas.length) parts.push(`${ideas.length} 个想法待定`)
  if (nextWeek.length) parts.push(`下周有 ${nextWeek.length} 件安排`)
  const top = uniq([...stuck.slice(0, 2), ...nextWeek])
    .slice(0, 3)
    .map(i => clip(i.title, 16))

  return {
    memberId: member.id,
    itemId: null,
    kind: 'weekly',
    fireAt,
    title: clip(`本周小结 · ${shortDateLabel(today)}`, TITLE_MAX),
    body: compose(parts, top),
    url: WEEKLY_URL,
    actions: [],
    dedupeKey: weeklyKey(member.id, today),
    respectQuietHours: true,
  }
}

/** Stale nudges at most every 4 days per item: the gap is shortened a little so DST days don't push it a day. */
export const STALE_MIN_GAP_MS = STALE_EVERY_DAYS * DAY - 2 * HOUR
