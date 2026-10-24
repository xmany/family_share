// Pure board logic: which section each item goes in, due labels, the weekly view.
// Every function takes `now` and the family timezone explicitly (unit-tested in node).

import type { Item } from '../../shared/types'
import { ACTIVE_STATUSES } from '../../shared/types'
import { DAY, addDaysToDate, formatDateZh, formatInstantZh, localDate } from '../../shared/time'

export function isActive(item: Item): boolean {
  return ACTIVE_STATUSES.includes(item.status)
}

export function isSnoozed(item: Item, now: Date): boolean {
  return !!item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now.getTime()
}

export interface DueInfo {
  /** "今天 08:30" / "明天" / "周六 10/24 08:30" */
  label: string
  /** Local date the item is due */
  date: string
  /** Sort key (ms). Day-only items sort at the end of their day. */
  sortKey: number
  overdue: boolean
  today: boolean
}

export function dueInfo(item: Item, now: Date, tz: string): DueInfo | null {
  const today = localDate(now, tz)
  if (item.dueAt) {
    const t = new Date(item.dueAt)
    const date = localDate(t, tz)
    return {
      label: formatInstantZh(t, now, tz),
      date,
      sortKey: t.getTime(),
      overdue: t.getTime() < now.getTime(),
      today: date === today,
    }
  }
  if (item.dueDate) {
    const date = item.dueDate
    // end of that local day (approximation good enough for sorting)
    const [y, m, d] = date.split('-').map(Number) as [number, number, number]
    return {
      label: formatDateZh(date, now, tz),
      date,
      sortKey: Date.UTC(y, m - 1, d, 23, 59),
      overdue: date < today,
      today: date === today,
    }
  }
  return null
}

export function isPendingForMe(item: Item, meId: string): boolean {
  return item.kind === 'request' && item.status === 'pending' && item.ownerId === meId
}

export function pendingForMeCount(items: Item[], meId: string): number {
  return items.reduce((n, it) => n + (isPendingForMe(it, meId) ? 1 : 0), 0)
}

export interface BoardSections {
  /** 等我回复 — pending requests to me */
  awaitingMe: Item[]
  /** 今天 / 已过期 — my items due today or overdue (not snoozed) */
  today: Item[]
  /** 我的待办 — my other open items, plus requests I sent that came back declined (my call now) */
  mine: Item[]
  /** 我在等别人 — requests I sent that are still with the other person + items I created for someone else */
  waitingOnOthers: Item[]
  /** 进行中 — started/blocked items and everything else active in the family */
  inProgress: Item[]
  /** 想法 */
  ideas: Item[]
  /** 本周完成 — done in the last 7 days */
  doneThisWeek: Item[]
}

const byDueThenActivity = (now: Date, tz: string) => (a: Item, b: Item) => {
  const da = dueInfo(a, now, tz)
  const db = dueInfo(b, now, tz)
  if (da && db) return da.sortKey - db.sortKey
  if (da) return -1
  if (db) return 1
  return b.lastActivityAt.localeCompare(a.lastActivityAt)
}

/** Each item lands in at most one section. */
export function buildSections(items: Item[], meId: string, now: Date, tz: string): BoardSections {
  const s: BoardSections = {
    awaitingMe: [],
    today: [],
    mine: [],
    waitingOnOthers: [],
    inProgress: [],
    ideas: [],
    doneThisWeek: [],
  }
  const weekAgo = now.getTime() - 7 * DAY
  for (const it of items) {
    if (it.status === 'done') {
      if (it.completedAt && new Date(it.completedAt).getTime() >= weekAgo) s.doneThisWeek.push(it)
      continue
    }
    if (!isActive(it)) continue
    if (isPendingForMe(it, meId)) {
      s.awaitingMe.push(it)
      continue
    }
    if (it.kind === 'idea') {
      s.ideas.push(it)
      continue
    }
    if (it.ownerId === meId) {
      // a request I turned down is the requester's to decide on now
      if (it.kind === 'request' && it.status === 'declined') continue
      const due = dueInfo(it, now, tz)
      if (due && (due.today || due.overdue) && !isSnoozed(it, now)) s.today.push(it)
      else if (it.status === 'in_progress' || it.status === 'blocked') s.inProgress.push(it)
      else s.mine.push(it)
      continue
    }
    // they said 做不了: nothing to wait for — I decide (重新请求 / 不需要了)
    if (it.kind === 'request' && it.requestedBy === meId && it.status === 'declined') {
      s.mine.push(it)
      continue
    }
    const iAsked = it.kind === 'request' && it.requestedBy === meId
    const iHandedOver = it.createdBy === meId && !!it.ownerId && it.ownerId !== meId
    if (iAsked || iHandedOver) {
      s.waitingOnOthers.push(it)
      continue
    }
    s.inProgress.push(it)
  }
  const cmp = byDueThenActivity(now, tz)
  s.awaitingMe.sort(cmp)
  s.today.sort(cmp)
  s.mine.sort(cmp)
  s.waitingOnOthers.sort(cmp)
  s.inProgress.sort(cmp)
  s.ideas.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  s.doneThisWeek.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
  return s
}

export interface WeeklyView {
  done: Item[]
  /** active (non-idea) items created more than 7 days ago */
  stuck: Item[]
  ideas: Item[]
  /** dated items in the next 7 days (today included), grouped by local date */
  upcoming: Array<{ date: string; label: string; items: Item[] }>
}

export function buildWeekly(items: Item[], now: Date, tz: string): WeeklyView {
  const weekAgo = now.getTime() - 7 * DAY
  const today = localDate(now, tz)
  const last = addDaysToDate(today, 6)
  const done: Item[] = []
  const stuck: Item[] = []
  const ideas: Item[] = []
  const byDate = new Map<string, Item[]>()
  for (const it of items) {
    if (it.status === 'done') {
      if (it.completedAt && new Date(it.completedAt).getTime() >= weekAgo) done.push(it)
      continue
    }
    if (!isActive(it)) continue
    if (it.kind === 'idea') {
      ideas.push(it)
      continue
    }
    if (new Date(it.createdAt).getTime() < weekAgo) stuck.push(it)
    const due = dueInfo(it, now, tz)
    if (due && due.date >= today && due.date <= last) {
      const list = byDate.get(due.date) ?? []
      list.push(it)
      byDate.set(due.date, list)
    }
  }
  done.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
  stuck.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  ideas.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const cmp = byDueThenActivity(now, tz)
  const upcoming = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, label: formatDateZh(date, now, tz), items: list.sort(cmp) }))
  return { done, stuck, ideas, upcoming }
}

/** Whole days since an instant (for "已经 9 天"). */
export function daysSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY))
}
