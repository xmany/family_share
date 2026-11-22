// Repeating items (每天 / 工作日 / 每周日 / 每周二、周五 / 每两周 / 每月15号 / 每年3月8日).
// Pure calendar arithmetic on local "YYYY-MM-DD" dates plus Chinese labels, shared by the server (domain, AI tools)
// and the web app (labels, the edit form). Nothing here knows about timezones or instants.
//
// A repeating item is ONE item that moves on: completing or skipping it moves its due date to the next occurrence
// instead of closing it (see src/server/domain/occurrences.ts for the item-level rules).

import type { RepeatFreq, RepeatRule } from './types'
import { WEEKDAY_ZH, addDaysToDate, daysBetweenDates, isLocalDate, weekdayOfDate } from './time'

export type { RepeatFreq, RepeatRule } from './types'

/** What a person (or the AI) asks for. Everything not given comes from the date of the first occurrence. */
export interface RepeatInput {
  freq: RepeatFreq
  /** Every n days / weeks / months / years. Default 1. */
  interval?: number
  /** weekly: 0 = Sunday … 6 = Saturday. Default: the first occurrence's weekday. */
  weekdays?: number[]
  /** monthly / yearly: day of the month 1–31. Default: the first occurrence's. */
  monthDay?: number
  /** yearly: month 1–12. Default: the first occurrence's. */
  month?: number
}

export const REPEAT_FREQS: readonly RepeatFreq[] = ['daily', 'weekly', 'monthly', 'yearly']
export const MAX_REPEAT_INTERVAL = 99
/** Monday-first, the way a Chinese week is read (周一 … 周日). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
export const WORKDAYS: readonly number[] = [1, 2, 3, 4, 5]

/** Thrown for a rule that cannot be built; the message is Chinese and safe to show. */
export class RepeatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepeatError'
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const partsOf = (date: string) => date.split('-').map(Number) as [number, number, number]
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const mod = (a: number, n: number) => ((a % n) + n) % n
/** Monday of the week the date is in. */
const weekStart = (date: string) => addDaysToDate(date, -((weekdayOfDate(date) + 6) % 7))

/**
 * The rule for an item whose first occurrence is on `firstDate`. Throws RepeatError for anything out of range.
 * Weekly on all seven days becomes daily; the first occurrence is `firstDate` even if it is not one of the weekdays.
 */
export function buildRepeatRule(input: RepeatInput, firstDate: string): RepeatRule {
  if (!input || !REPEAT_FREQS.includes(input.freq)) throw new RepeatError('重复方式只能是 daily / weekly / monthly / yearly')
  if (!isLocalDate(firstDate)) throw new RepeatError(`重复需要第一次的日期（YYYY-MM-DD）：${String(firstDate)}`)
  const interval = input.interval ?? 1
  if (!isInt(interval, 1, MAX_REPEAT_INTERVAL)) throw new RepeatError(`重复间隔需要是 1 到 ${MAX_REPEAT_INTERVAL} 的整数`)
  const [, fm, fd] = partsOf(firstDate)
  let freq = input.freq
  let weekdays: number[] = []
  if (freq === 'weekly') {
    const given = input.weekdays === undefined ? [weekdayOfDate(firstDate)] : input.weekdays
    if (!Array.isArray(given) || given.length === 0 || !given.every(d => isInt(d, 0, 6))) {
      throw new RepeatError('每周重复需要至少一个星期几（0 = 周日 … 6 = 周六）')
    }
    weekdays = [...new Set(given)].sort((a, b) => a - b)
    if (weekdays.length === 7 && interval === 1) {
      freq = 'daily'
      weekdays = []
    }
  } else if (input.weekdays !== undefined && input.weekdays.length > 0) {
    throw new RepeatError('只有每周重复可以选星期几')
  }
  let monthDay: number | null = null
  let month: number | null = null
  if (freq === 'monthly' || freq === 'yearly') {
    monthDay = input.monthDay ?? fd
    if (!isInt(monthDay, 1, 31)) throw new RepeatError('每月的日子需要是 1 到 31')
  } else if (input.monthDay !== undefined) {
    throw new RepeatError('只有每月或每年重复可以指定几号')
  }
  if (freq === 'yearly') {
    month = input.month ?? fm
    if (!isInt(month, 1, 12)) throw new RepeatError('月份需要是 1 到 12')
    if (monthDay! > daysInMonth(2024, month)) throw new RepeatError(`${month}月没有${monthDay}号`)
  } else if (input.month !== undefined) {
    throw new RepeatError('只有每年重复可以指定月份')
  }
  return { freq, interval, weekdays, monthDay, month, anchor: firstDate }
}

/** The rule's input fields (no anchor): for comparing rules and for re-anchoring one on a new first date. */
export function repeatInputOf(rule: RepeatRule): RepeatInput {
  const out: RepeatInput = { freq: rule.freq, interval: rule.interval }
  if (rule.freq === 'weekly') out.weekdays = [...rule.weekdays]
  if (rule.monthDay !== null) out.monthDay = rule.monthDay
  if (rule.month !== null) out.month = rule.month
  return out
}

/** Same rule apart from where the series currently stands (anchor). */
export function sameRepeat(a: RepeatRule | null | undefined, b: RepeatRule | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return JSON.stringify(repeatInputOf(a)) === JSON.stringify(repeatInputOf(b))
}

/** A RepeatRule read back from JSON (the items.repeat column, event payloads); null for anything malformed. */
export function asRepeatRule(v: unknown): RepeatRule | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (!REPEAT_FREQS.includes(r.freq as RepeatFreq)) return null
  if (!isInt(r.interval, 1, MAX_REPEAT_INTERVAL) || typeof r.anchor !== 'string' || !isLocalDate(r.anchor)) return null
  const weekdays = Array.isArray(r.weekdays) ? r.weekdays.filter(d => isInt(d, 0, 6)) : []
  if (r.freq === 'weekly' && weekdays.length === 0) return null
  const monthDay = isInt(r.monthDay, 1, 31) ? r.monthDay : null
  const month = isInt(r.month, 1, 12) ? r.month : null
  if ((r.freq === 'monthly' || r.freq === 'yearly') && monthDay === null) return null
  if (r.freq === 'yearly' && month === null) return null
  return {
    freq: r.freq as RepeatFreq,
    interval: r.interval,
    weekdays: r.freq === 'weekly' ? [...new Set(weekdays)].sort((a, b) => a - b) : [],
    monthDay: r.freq === 'monthly' || r.freq === 'yearly' ? monthDay : null,
    month: r.freq === 'yearly' ? month : null,
    anchor: r.anchor,
  }
}

/**
 * The first date of the series strictly after `after`. The series counts from `rule.anchor` (every `interval` days,
 * weeks — Monday to Sunday — months or years); a month without the rule's day uses its last day (31号 → 2月28日).
 */
export function nextOccurrence(rule: RepeatRule, after: string): string {
  const n = rule.interval
  switch (rule.freq) {
    case 'daily': {
      const k = Math.floor(daysBetweenDates(rule.anchor, after) / n) + 1
      return addDaysToDate(rule.anchor, k * n)
    }
    case 'weekly': {
      const anchorWeek = weekStart(rule.anchor)
      // within 7·n + 7 days there is always a day of a counted week that is one of the weekdays
      for (let i = 1; i <= 7 * n + 7; i++) {
        const d = addDaysToDate(after, i)
        if (!rule.weekdays.includes(weekdayOfDate(d))) continue
        if (mod(daysBetweenDates(anchorWeek, weekStart(d)) / 7, n) === 0) return d
      }
      throw new Error(`no weekly occurrence after ${after}`) // unreachable with a valid rule
    }
    case 'monthly': {
      const [ay, am] = partsOf(rule.anchor)
      const [y, m] = partsOf(after)
      const base = ay * 12 + (am - 1)
      const k0 = Math.floor((y * 12 + (m - 1) - base) / n)
      for (let k = k0; k <= k0 + 2; k++) {
        const idx = base + k * n
        const yy = Math.floor(idx / 12)
        const mm = mod(idx, 12) + 1
        const date = ymd(yy, mm, Math.min(rule.monthDay!, daysInMonth(yy, mm)))
        if (date > after) return date
      }
      throw new Error(`no monthly occurrence after ${after}`)
    }
    case 'yearly': {
      const [ay] = partsOf(rule.anchor)
      const [y] = partsOf(after)
      const k0 = Math.floor((y - ay) / n)
      for (let k = k0; k <= k0 + 2; k++) {
        const yy = ay + k * n
        const date = ymd(yy, rule.month!, Math.min(rule.monthDay!, daysInMonth(yy, rule.month!)))
        if (date > after) return date
      }
      throw new Error(`no yearly occurrence after ${after}`)
    }
  }
}

/** 2 → 两 (每两周), other numbers as digits (每3天). */
const count = (n: number) => (n === 2 ? '两' : String(n))

/** "周二、周五" in Monday-first order. */
export function weekdaysLabel(weekdays: readonly number[]): string {
  return WEEKDAY_ORDER.filter(d => weekdays.includes(d))
    .map(d => WEEKDAY_ZH[d])
    .join('、')
}

/** 每天 / 每两天 / 工作日 / 每周日 / 每周二、周五 / 每两周的周日 / 每月15号 / 每三个月的1号 / 每年3月8日 */
export function describeRepeat(rule: Pick<RepeatRule, 'freq' | 'interval' | 'weekdays' | 'monthDay' | 'month'>): string {
  const n = rule.interval
  switch (rule.freq) {
    case 'daily':
      return n === 1 ? '每天' : `每${count(n)}天`
    case 'weekly': {
      const days = rule.weekdays
      if (n === 1 && days.length === 5 && WORKDAYS.every(d => days.includes(d))) return '工作日'
      if (n === 1 && days.length === 2 && days.includes(0) && days.includes(6)) return '每个周末'
      const list = weekdaysLabel(days)
      return n === 1 ? `每${list}` : `每${count(n)}周的${list}`
    }
    case 'monthly':
      return n === 1 ? `每月${rule.monthDay}号` : `每${count(n)}个月的${rule.monthDay}号`
    case 'yearly':
      return n === 1 ? `每年${rule.month}月${rule.monthDay}日` : `每${count(n)}年的${rule.month}月${rule.monthDay}日`
  }
}

/** "每周日 21:00" — the rule plus the item's time of day, when it has one. */
export function repeatLabel(rule: RepeatRule, time: string | null | undefined): string {
  return time ? `${describeRepeat(rule)} ${time}` : describeRepeat(rule)
}
