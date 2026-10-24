// The volatile half of the prompt: one user message per utterance with the board snapshot, a
// precomputed calendar (weekdays, relative labels, lunar dates) and the utterance itself.
// Nothing here may leak into SYSTEM_PROMPT (see prompt.ts).

import type { Item, Member, Utterance, UtteranceSource } from '../../shared/types'
import type { Domain } from '../domain/types'
import { clip, dueLabel, nameLookup } from '../domain/describe'
import {
  DAY,
  WEEKDAY_ZH,
  addDaysToDate,
  daysBetweenDates,
  describeNowForPrompt,
  formatInstantZh,
  localDate,
  localTime,
  weekdayOfDate,
} from '../time'
import { extraPings } from './executor'
import { TIME_OF_DAY_DEFAULTS } from './prompt'
import { type ReplyScript, replyScriptFor } from './script'

/** SPEC §4: with more than this many active items, include the most recently active ones and rely on search_items. */
export const SNAPSHOT_ITEM_CAP = 150
export const RECENT_UTTERANCES = 8
export const CLOSED_CAP = 60

// ---------------------------------------------------------------------------------------------
// script preference

export { type ReplyScript, replyScriptFor } from './script'

const SCRIPT_LABEL: Record<ReplyScript, string> = { simplified: '简体中文', traditional: '繁體中文' }

// ---------------------------------------------------------------------------------------------
// lunar calendar (Intl 'zh-CN-u-ca-chinese'; never let the model convert lunar dates itself)

const LUNAR_DAY_UNITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 1 → 初一, 10 → 初十, 15 → 十五, 20 → 二十, 21 → 廿一, 30 → 三十 */
export function lunarDayName(n: number): string {
  if (n <= 10) return `初${LUNAR_DAY_UNITS[n]}`
  if (n < 20) return `十${LUNAR_DAY_UNITS[n - 10]}`
  if (n === 20) return '二十'
  if (n < 30) return `廿${LUNAR_DAY_UNITS[n - 20]}`
  return '三十'
}

let lunarFmt: Intl.DateTimeFormat | null = null
const lunarCache = new Map<string, { month: string; day: number } | null>()

/**
 * Lunar months where ICU's Chinese calendar disagrees with the official one (GB/T 33661). ICU's new-moon
 * approximation is off by minutes, so a new moon just before midnight Beijing time can land on the next day.
 * 2027: the new moon is at 23:56 Beijing time on 02-06, so 春节 is Saturday 2027-02-06 (published holiday
 * calendars agree), 腊月 ends on 02-05 (除夕 = 腊月廿九) and 正月 has 30 days; ICU 78 says 正月初一 = 02-07.
 * Each entry overrides one whole month: dates first..last are `month` day 1..n.
 */
const LUNAR_MONTH_FIXES: ReadonlyArray<{ month: string; first: string; last: string }> = [{ month: '正月', first: '2027-02-06', last: '2027-03-07' }]

/** Lunar month and day of a local calendar date, e.g. { month: '九月', day: 12 } for 2026-10-21. */
export function lunarParts(date: string): { month: string; day: number } | null {
  const hit = lunarCache.get(date)
  if (hit !== undefined) return hit
  const fix = LUNAR_MONTH_FIXES.find(f => date >= f.first && date <= f.last)
  if (fix) {
    const fixed = { month: fix.month, day: daysBetweenDates(fix.first, date) + 1 }
    lunarCache.set(date, fixed)
    return fixed
  }
  let out: { month: string; day: number } | null = null
  try {
    lunarFmt ??= new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: 'UTC', month: 'long', day: 'numeric' })
    // The lunar date of a civil date does not depend on the time zone: format noon UTC of that day in UTC.
    const parts = lunarFmt.formatToParts(new Date(`${date}T12:00:00Z`))
    const month = parts.find(p => p.type === 'month')?.value
    const day = Number(parts.find(p => p.type === 'day')?.value)
    if (month && Number.isInteger(day) && day >= 1 && day <= 30) out = { month, day }
  } catch {
    out = null
  }
  if (lunarCache.size > 4000) lunarCache.clear()
  lunarCache.set(date, out)
  return out
}

/** "农历九月十二"; null when the runtime lacks the Chinese calendar. */
export function lunarLabel(date: string): string | null {
  const p = lunarParts(date)
  return p ? `农历${p.month}${lunarDayName(p.day)}` : null
}

const LUNAR_FESTIVALS: Record<string, string> = {
  正月初一: '春节',
  正月十五: '元宵',
  五月初五: '端午',
  七月初七: '七夕',
  八月十五: '中秋',
  九月初九: '重阳',
  腊月初八: '腊八',
}

function lunarFestival(date: string): string | null {
  const p = lunarParts(date)
  if (!p) return null
  const f = LUNAR_FESTIVALS[`${p.month}${lunarDayName(p.day)}`]
  if (f) return f
  const next = lunarParts(addDaysToDate(date, 1))
  if (p.month === '腊月' && next && next.month === '正月' && next.day === 1) return '除夕'
  return null
}

const RELATIVE: Record<number, string> = { [-2]: '前天', [-1]: '昨天', 0: '今天', 1: '明天', 2: '后天', 3: '大后天' }

/**
 * Three weeks starting on this week's Monday, one line per day:
 * "  周三 2026-10-21 今天 · 农历九月十二"
 */
export function renderCalendar(now: Date, tz: string): string {
  const today = localDate(now, tz)
  const monday = addDaysToDate(today, -((weekdayOfDate(today) + 6) % 7))
  const lines: string[] = []
  const weeks = ['本周', '下周', '下下周']
  for (let w = 0; w < 3; w++) {
    lines.push(`${weeks[w]}:`)
    for (let i = 0; i < 7; i++) {
      const d = addDaysToDate(monday, w * 7 + i)
      const diff = daysBetweenDates(today, d)
      const rel = RELATIVE[diff] ?? (diff < 0 ? '已过' : '')
      const lunar = lunarLabel(d)
      const fest = lunarFestival(d)
      const tail = [rel, lunar ? (fest ? `${lunar}（${fest}）` : lunar) : null].filter(Boolean).join(' · ')
      lines.push(`  ${WEEKDAY_ZH[weekdayOfDate(d)]} ${d}${tail ? ` ${tail}` : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * The first day (初一) of each lunar month starting within the next ~13 months, for lunar dates beyond the
 * 3-week calendar: "十月初一=2026-11-09，冬月初一=2026-12-09，…". Empty when Intl lacks the calendar.
 */
export function renderLunarMonths(now: Date, tz: string, days = 400): string {
  const today = localDate(now, tz)
  const out: string[] = []
  const cur = lunarParts(today)
  if (cur) {
    out.push(`本月（${cur.month}）初一=${addDaysToDate(today, -(cur.day - 1))}`)
  }
  for (let i = 1; i <= days; i++) {
    const d = addDaysToDate(today, i)
    const p = lunarParts(d)
    if (p && p.day === 1) out.push(`${p.month}初一=${d}`)
  }
  return out.join('，')
}

// ---------------------------------------------------------------------------------------------
// the snapshot

export interface SnapshotData {
  now: Date
  tz: string
  speaker: Member
  members: Member[]
  /** At most SNAPSHOT_ITEM_CAP, most recently active first */
  activeItems: Item[]
  /** Active items left out because of the cap */
  omittedActive: number
  /** itemId → latest notes (oldest first, at most 2) */
  notes: Map<string, string[]>
  /** itemId → extra pings still ahead (set_reminder rows, soonest first), so 取消提醒 can find them */
  reminders?: Map<string, Array<{ fireAt: string; memberId: string }>>
  closedRecently: Item[]
  /** Oldest first, without the utterance being interpreted */
  recentUtterances: Utterance[]
  /** The utterance this one answers, when it is a clarification answer */
  answering: Utterance | null
  utterance: { text: string; source: UtteranceSource }
}

/** Gathers everything the snapshot needs from the domain. `currentUtteranceId` is excluded from the recent chat. */
export function gatherSnapshot(
  domain: Domain,
  args: { now: Date; speaker: Member; text: string; source: UtteranceSource; currentUtteranceId: string; replyToUtteranceId?: string | null },
): SnapshotData {
  const tz = domain.getFamily().timezone
  const all = domain.listActiveItems()
  const activeItems = all.slice(0, SNAPSHOT_ITEM_CAP)
  const notes = new Map<string, string[]>()
  for (const it of activeItems) {
    const list = domain.listNotes(it.id)
    if (list.length) notes.set(it.id, list.slice(-2).map(n => n.text))
  }
  const reminders = new Map<string, Array<{ fireAt: string; memberId: string }>>()
  for (const it of activeItems) {
    if (!it.remindAt) continue // nothing scheduled at all for this item
    const pings = extraPings(domain, it.id, args.now)
    if (pings.length) reminders.set(it.id, pings.map(n => ({ fireAt: n.fireAt, memberId: n.memberId })))
  }
  const recent = domain.recentUtterances(RECENT_UTTERANCES + 1).filter(u => u.id !== args.currentUtteranceId)
  const answering = args.replyToUtteranceId ? domain.getUtterance(args.replyToUtteranceId) : null
  return {
    now: args.now,
    tz,
    speaker: args.speaker,
    members: domain.listMembers(),
    activeItems,
    omittedActive: all.length - activeItems.length,
    notes,
    reminders,
    closedRecently: domain.listClosedSince(new Date(args.now.getTime() - 7 * DAY)).slice(0, CLOSED_CAP),
    recentUtterances: recent.slice(-RECENT_UTTERANCES),
    answering,
    utterance: { text: args.text, source: args.source },
  }
}

/** Collapses whitespace and neutralizes angle brackets so family text cannot open or close prompt tags. */
export function sanitize(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/</g, '＜').replace(/>/g, '＞').trim()
}

function localStamp(iso: string, tz: string): string {
  const d = new Date(iso)
  return `${localDate(d, tz)} ${localTime(d, tz)}`
}

function renderItem(it: Item, d: SnapshotData, nameOf: (id: string | null) => string): string {
  const parts = [it.id, it.kind, it.status, sanitize(it.title)]
  parts.push(`负责 ${it.ownerId ? nameOf(it.ownerId) : '未指定'}`)
  if (it.requestedBy) parts.push(`请求人 ${nameOf(it.requestedBy)}`)
  const due = dueLabel(it, d.now, d.tz)
  if (due) parts.push(`截止 ${due}（${it.dueAt ? localStamp(it.dueAt, d.tz) : it.dueDate}）`)
  if (it.snoozedUntil && new Date(it.snoozedUntil).getTime() > d.now.getTime()) {
    parts.push(`推迟到 ${formatInstantZh(it.snoozedUntil, d.now, d.tz)}`)
  }
  const pings = d.reminders?.get(it.id) ?? []
  if (pings.length) {
    const shown = pings.slice(0, 3).map(p => `${formatInstantZh(p.fireAt, d.now, d.tz)}（${localStamp(p.fireAt, d.tz)}）→ ${nameOf(p.memberId)}`)
    parts.push(`另有提醒 ${shown.join('，')}${pings.length > 3 ? `，等共 ${pings.length} 个` : ''}`)
  }
  if (it.priority !== 'normal') parts.push(`优先级 ${it.priority}`)
  if (it.details) parts.push(`说明 ${clip(sanitize(it.details), 80)}`)
  parts.push(`最近动态 ${formatInstantZh(it.lastActivityAt, d.now, d.tz)}`)
  const notes = d.notes.get(it.id)
  const noteLine = notes?.length ? `\n    备注: ${notes.map(n => clip(sanitize(n), 60)).join(' ／ ')}` : ''
  return `- ${parts.join(' | ')}${noteLine}`
}

function renderUtterance(u: Utterance, d: SnapshotData, nameOf: (id: string | null) => string): string {
  const head = `- ${formatInstantZh(u.createdAt, d.now, d.tz)} ${nameOf(u.memberId)}：${clip(sanitize(u.text), 100)}`
  if (u.status === 'clarify' && u.clarification) {
    const opts = u.clarification.options.map(o => sanitize(o)).join(' / ')
    return `${head} → 助手问：${clip(sanitize(u.clarification.question), 80)}${opts ? `（选项：${opts}）` : ''}`
  }
  if (u.status === 'undone') return `${head} →（已撤销）`
  if (u.status === 'processing') return `${head} →（处理中）`
  const reply = u.reply ?? u.error
  const tag = u.status === 'error' ? '（出错）' : ''
  return reply ? `${head} → 助手${tag}：${clip(sanitize(reply), 80)}` : head
}

/** The single user message for a fresh interpreter conversation. */
export function renderTurnInput(d: SnapshotData): string {
  // Member names are family data too (any text up to 40 chars, newlines included): neutralize them everywhere.
  const rawNameOf = nameLookup(d.members)
  const nameOf = (id: string | null) => sanitize(rawNameOf(id))
  const members = d.members
    .map(m => {
      const aliases = m.aliases.length ? m.aliases.map(sanitize).join('、') : '-'
      return `- ${m.id} | ${sanitize(m.name)} | 也叫 ${aliases} | ${m.role}${m.id === d.speaker.id ? ' | ← 说话人' : ''}`
    })
    .join('\n')
  const items = d.activeItems.map(it => renderItem(it, d, nameOf)).join('\n') || '(无)'
  const omitted = d.omittedActive > 0 ? `\n（另有 ${d.omittedActive} 条较早的事项没有列出，需要时用 search_items 查找）` : ''
  const closed =
    d.closedRecently
      .map(it => {
        const at = it.completedAt ? ` | ${formatInstantZh(it.completedAt, d.now, d.tz)}` : ''
        return `- ${it.id} | ${it.kind} | ${it.status} | ${sanitize(it.title)} | 负责 ${it.ownerId ? nameOf(it.ownerId) : '未指定'}${at}`
      })
      .join('\n') || '(无)'
  const chat = d.recentUtterances.map(u => renderUtterance(u, d, nameOf)).join('\n') || '(无)'
  const lunarMonths = renderLunarMonths(d.now, d.tz)

  let answering = ''
  if (d.answering) {
    const a = d.answering
    const q = a.clarification
      ? `\n你问: ${sanitize(a.clarification.question)}${a.clarification.options.length ? `\n选项: ${a.clarification.options.map(sanitize).join(' / ')}` : ''}`
      : a.reply
        ? `\n你答: ${sanitize(a.reply)}`
        : ''
    answering = `\n<answering_clarification>\n${nameOf(a.memberId)}原话: ${sanitize(a.text)}${q}\n</answering_clarification>`
  }

  return `<board_snapshot>
now: ${describeNowForPrompt(d.now, d.tz)}
speaker: ${d.speaker.id} ${sanitize(d.speaker.name)}（回复用${SCRIPT_LABEL[replyScriptFor(d.speaker)]}）
calendar:
${renderCalendar(d.now, d.tz)}
lunar_months: ${lunarMonths || '(无)'}
time_of_day_defaults: ${TIME_OF_DAY_DEFAULTS}
members:
${members}
active_items:
${items}${omitted}
closed_last_7_days:
${closed}
recent_utterances:
${chat}
</board_snapshot>${answering}
<utterance source="${d.utterance.source}">${sanitize(d.utterance.text)}</utterance>`
}
