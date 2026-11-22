// 重复: how an item repeats, picked by hand (the new-item form and the item editor). The common choices only —
// every n days and the like still come from the chat, and an item that already has such a rule keeps it untouched
// ('keep') unless another choice is picked.

import type { RepeatInput, RepeatRule } from '../../shared/repeat'
import { RepeatError, WEEKDAY_ORDER, WORKDAYS, buildRepeatRule, describeRepeat } from '../../shared/repeat'
import { WEEKDAY_ZH, isLocalDate, weekdayOfDate } from '../../shared/time'

export type RepeatMode = 'none' | 'keep' | 'daily' | 'workdays' | 'weekly' | 'biweekly' | 'monthly' | 'yearly'

export interface RepeatDraft {
  mode: RepeatMode
  /** weekly / biweekly: the picked weekdays (0 = Sunday … 6 = Saturday); empty = the date's weekday */
  weekdays: number[]
}

const OPTIONS: Array<{ mode: Exclude<RepeatMode, 'keep'>; label: string }> = [
  { mode: 'none', label: '不重复' },
  { mode: 'daily', label: '每天' },
  { mode: 'workdays', label: '工作日（周一到周五）' },
  { mode: 'weekly', label: '每周' },
  { mode: 'biweekly', label: '每两周' },
  { mode: 'monthly', label: '每月' },
  { mode: 'yearly', label: '每年' },
]

/** The draft for an item's current rule; a rule the picker has no choice for is 'keep'. */
export function draftFromRule(rule: RepeatRule | null): RepeatDraft {
  if (!rule) return { mode: 'none', weekdays: [] }
  const n = rule.interval
  if (rule.freq === 'daily' && n === 1) return { mode: 'daily', weekdays: [] }
  if (rule.freq === 'weekly' && n === 1 && rule.weekdays.length === 5 && WORKDAYS.every(d => rule.weekdays.includes(d))) {
    return { mode: 'workdays', weekdays: [] }
  }
  if (rule.freq === 'weekly' && (n === 1 || n === 2)) return { mode: n === 1 ? 'weekly' : 'biweekly', weekdays: [...rule.weekdays] }
  if (rule.freq === 'monthly' && n === 1) return { mode: 'monthly', weekdays: [] }
  if (rule.freq === 'yearly' && n === 1) return { mode: 'yearly', weekdays: [] }
  return { mode: 'keep', weekdays: [] }
}

/** What to send for the draft; null = does not repeat. Monthly / yearly take their day from the date. */
export function repeatInputFor(draft: RepeatDraft, date: string): RepeatInput | null {
  const days = draft.weekdays.length ? draft.weekdays : isLocalDate(date) ? [weekdayOfDate(date)] : []
  switch (draft.mode) {
    case 'none':
    case 'keep':
      return null
    case 'daily':
      return { freq: 'daily' }
    case 'workdays':
      return { freq: 'weekly', weekdays: [...WORKDAYS] }
    case 'weekly':
      return { freq: 'weekly', weekdays: days }
    case 'biweekly':
      return { freq: 'weekly', interval: 2, weekdays: days }
    case 'monthly':
      return { freq: 'monthly' }
    case 'yearly':
      return { freq: 'yearly' }
  }
}

/** "每周日" for the draft on `date`, or null when it does not repeat or cannot be built (no date yet). */
export function draftLabel(draft: RepeatDraft, date: string, current: RepeatRule | null): string | null {
  if (draft.mode === 'keep') return current ? describeRepeat(current) : null
  const input = repeatInputFor(draft, date)
  if (!input || !isLocalDate(date)) return null
  try {
    return describeRepeat(buildRepeatRule(input, date))
  } catch (e) {
    if (e instanceof RepeatError) return null
    throw e
  }
}

export function RepeatPicker({
  id,
  draft,
  date,
  current = null,
  onChange,
}: {
  id: string
  draft: RepeatDraft
  /** the due date (first / next occurrence), YYYY-MM-DD or '' */
  date: string
  /** the item's rule now, for a 'keep' draft */
  current?: RepeatRule | null
  onChange: (draft: RepeatDraft) => void
}) {
  const hasDate = isLocalDate(date)
  const weekly = draft.mode === 'weekly' || draft.mode === 'biweekly'
  const picked = draft.weekdays.length ? draft.weekdays : hasDate ? [weekdayOfDate(date)] : []
  const label = draftLabel(draft, date, current)
  const toggle = (d: number) => {
    const next = picked.includes(d) ? picked.filter(x => x !== d) : [...picked, d]
    if (next.length) onChange({ ...draft, weekdays: next })
  }
  return (
    <div>
      <label className="label" htmlFor={id}>
        重复
      </label>
      <select
        id={id}
        className="input"
        value={draft.mode}
        disabled={!hasDate && draft.mode === 'none'}
        onChange={e => onChange({ mode: e.target.value as RepeatMode, weekdays: draft.weekdays })}
      >
        {draft.mode === 'keep' && <option value="keep">{label ?? '保持现在的规则'}</option>}
        {OPTIONS.map(o => (
          <option key={o.mode} value={o.mode}>
            {o.label}
          </option>
        ))}
      </select>
      {weekly && hasDate && (
        <div className="seg seg-fill mt-2" role="group" aria-label="星期几">
          {WEEKDAY_ORDER.map(d => (
            <button
              key={d}
              type="button"
              className="seg-btn min-w-0 px-0"
              aria-pressed={picked.includes(d)}
              aria-label={WEEKDAY_ZH[d]}
              onClick={() => toggle(d)}
            >
              {WEEKDAY_ZH[d].slice(1)}
            </button>
          ))}
        </div>
      )}
      <p className="hint mt-1.5">
        {!hasDate
          ? '先选日期，才能设重复'
          : draft.mode === 'none'
            ? '只做一次'
            : `${label ?? ''}，从这个日期开始。完成一次后自动排到下一次`}
      </p>
    </div>
  )
}
