// Timezone-aware helpers built on Intl (no dependencies).
// The family has one IANA timezone; every "local" value below is in that timezone.

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

/** Controllable clock for tests. */
export class FixedClock implements Clock {
  private t: number
  constructor(start: Date | string) {
    this.t = new Date(start).getTime()
  }
  now(): Date {
    return new Date(this.t)
  }
  set(t: Date | string): void {
    this.t = new Date(t).getTime()
  }
  advance(ms: number): void {
    this.t += ms
  }
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export interface LocalParts {
  year: number
  month: number // 1-12
  day: number
  hour: number // 0-23
  minute: number
  second: number
  weekday: number // 0 = Sunday … 6 = Saturday
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>()
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    partsFormatters.set(tz, f)
  }
  return f
}

const WEEKDAY_EN: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function localParts(instant: Date, tz: string): LocalParts {
  const out: Record<string, string> = {}
  for (const p of partsFormatter(tz).formatToParts(instant)) out[p.type] = p.value
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_EN[out.weekday ?? 'Sun'] ?? 0,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local calendar date "YYYY-MM-DD" of an instant. */
export function localDate(instant: Date, tz: string): string {
  const p = localParts(instant, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Local time of day "HH:MM" of an instant. */
export function localTime(instant: Date, tz: string): string {
  const p = localParts(instant, tz)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** Offset of tz from UTC at an instant, in ms (e.g. +11h for Sydney in summer). */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = localParts(instant, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

export function parseHHMM(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

export function isLocalDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, mo, d] = s.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/**
 * Converts a local date + time in tz to the UTC instant.
 * Non-existent local times (DST spring-forward gap) resolve to the instant just after the gap.
 */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  if (!isLocalDate(date)) throw new Error(`invalid local date: ${date}`)
  const hm = parseHHMM(time)
  if (!hm) throw new Error(`invalid local time: ${time}`)
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(y, mo - 1, d, hm.h, hm.m)
  const off1 = tzOffsetMs(new Date(guess), tz)
  let t = guess - off1
  const off2 = tzOffsetMs(new Date(t), tz)
  if (off2 !== off1) {
    const t2 = guess - off2
    // If t2 maps back to the requested wall time, prefer it; otherwise we are in a gap.
    t = localTime(new Date(t2), tz) === time && localDate(new Date(t2), tz) === date ? t2 : Math.max(t, t2)
  }
  return new Date(t)
}

/** Pure calendar arithmetic on "YYYY-MM-DD". */
export function addDaysToDate(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, mo - 1, d + days))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** 0 = Sunday … 6 = Saturday for a "YYYY-MM-DD". */
export function weekdayOfDate(date: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

/** Whole days from local date a to local date b (b - a). */
export function daysBetweenDates(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number) as [number, number, number]
  const [y2, m2, d2] = b.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY)
}

function minutesOf(hhmm: string): number {
  const p = parseHHMM(hhmm)
  if (!p) throw new Error(`invalid HH:MM: ${hhmm}`)
  return p.h * 60 + p.m
}

/** True if the instant's local time falls in [quietStart, quietEnd). Handles windows over midnight. start == end means no quiet hours. */
export function isWithinQuietHours(instant: Date, quietStart: string, quietEnd: string, tz: string): boolean {
  const s = minutesOf(quietStart)
  const e = minutesOf(quietEnd)
  if (s === e) return false
  const p = localParts(instant, tz)
  const now = p.hour * 60 + p.minute
  return s < e ? now >= s && now < e : now >= s || now < e
}

/** If the instant is inside quiet hours, the instant they end; otherwise the instant itself. */
export function deferPastQuietHours(instant: Date, quietStart: string, quietEnd: string, tz: string): Date {
  if (!isWithinQuietHours(instant, quietStart, quietEnd, tz)) return instant
  const today = localDate(instant, tz)
  const endToday = zonedToUtc(today, quietEnd, tz)
  return endToday.getTime() > instant.getTime() ? endToday : zonedToUtc(addDaysToDate(today, 1), quietEnd, tz)
}

/** e.g. "2026-10-21 周三 14:05（Australia/Sydney，UTC+11:00）" — for the LLM prompt. */
export function describeNowForPrompt(now: Date, tz: string): string {
  const p = localParts(now, tz)
  const off = tzOffsetMs(now, tz) / MINUTE
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${localDate(now, tz)} ${WEEKDAY_ZH[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}（${tz}，UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}）`
}

/** Short Chinese label for a local date relative to today: 今天 / 明天 / 后天 / 昨天 / 周六 10/24 / 2027/1/3 */
export function formatDateZh(date: string, now: Date, tz: string): string {
  const today = localDate(now, tz)
  const diff = daysBetweenDates(today, date)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === 2) return '后天'
  if (diff === -1) return '昨天'
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const wd = WEEKDAY_ZH[weekdayOfDate(date)]
  if (diff > 0 && diff < 7) return `${wd} ${mo}/${d}`
  if (y !== Number(today.slice(0, 4))) return `${y}/${mo}/${d}`
  return `${mo}/${d} ${wd}`
}

/** Short Chinese label for an instant: 今天 08:30 / 明天 08:30 / 周六 10/24 08:30 */
export function formatInstantZh(instant: Date | string, now: Date, tz: string): string {
  const t = typeof instant === 'string' ? new Date(instant) : instant
  return `${formatDateZh(localDate(t, tz), now, tz)} ${localTime(t, tz)}`
}

export type SnoozePreset = 'tonight' | 'tomorrow' | 'weekend' | 'next_week'

/**
 * tonight   — today 20:00, or 1 hour from now if that's later
 * tomorrow  — tomorrow 09:00
 * weekend   — the next Saturday or Sunday 10:00 that is still ahead
 * next_week — next Monday 09:00
 */
export function resolveSnoozePreset(preset: SnoozePreset, now: Date, tz: string): Date {
  const today = localDate(now, tz)
  switch (preset) {
    case 'tonight': {
      const eight = zonedToUtc(today, '20:00', tz)
      const inAnHour = new Date(now.getTime() + HOUR)
      return eight.getTime() > inAnHour.getTime() ? eight : inAnHour
    }
    case 'tomorrow':
      return zonedToUtc(addDaysToDate(today, 1), '09:00', tz)
    case 'weekend': {
      for (let i = 0; i < 8; i++) {
        const d = addDaysToDate(today, i)
        const wd = weekdayOfDate(d)
        if (wd !== 6 && wd !== 0) continue
        const t = zonedToUtc(d, '10:00', tz)
        if (t.getTime() > now.getTime()) return t
      }
      return zonedToUtc(addDaysToDate(today, 7), '10:00', tz)
    }
    case 'next_week': {
      const wd = weekdayOfDate(today)
      const untilMonday = ((8 - wd) % 7) || 7
      return zonedToUtc(addDaysToDate(today, untilMonday), '09:00', tz)
    }
  }
}
