import { describe, expect, it } from 'vitest'
import type { RepeatRule } from './types'
import { RepeatError, asRepeatRule, buildRepeatRule, describeRepeat, nextOccurrence, repeatLabel, sameRepeat } from './repeat'

/** The next `n` occurrences after `from` (each one counted from the previous, as the item moves on). */
function series(rule: RepeatRule, from: string, n: number): string[] {
  const out: string[] = []
  let after = from
  let r = rule
  for (let i = 0; i < n; i++) {
    after = nextOccurrence(r, after)
    r = { ...r, anchor: after }
    out.push(after)
  }
  return out
}

describe('buildRepeatRule', () => {
  it('takes what is not given from the first occurrence', () => {
    // 2026-10-25 is a Sunday
    expect(buildRepeatRule({ freq: 'weekly' }, '2026-10-25')).toEqual({
      freq: 'weekly',
      interval: 1,
      weekdays: [0],
      monthDay: null,
      month: null,
      anchor: '2026-10-25',
    })
    expect(buildRepeatRule({ freq: 'monthly' }, '2026-10-31')).toMatchObject({ freq: 'monthly', monthDay: 31, month: null, weekdays: [] })
    expect(buildRepeatRule({ freq: 'yearly' }, '2027-03-08')).toMatchObject({ freq: 'yearly', monthDay: 8, month: 3 })
    expect(buildRepeatRule({ freq: 'daily', interval: 3 }, '2026-10-21')).toMatchObject({ freq: 'daily', interval: 3, weekdays: [] })
  })

  it('sorts and dedupes weekdays; all seven days every week is daily', () => {
    expect(buildRepeatRule({ freq: 'weekly', weekdays: [5, 2, 5] }, '2026-10-23').weekdays).toEqual([2, 5])
    expect(buildRepeatRule({ freq: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] }, '2026-10-23')).toMatchObject({ freq: 'daily', weekdays: [] })
    expect(buildRepeatRule({ freq: 'weekly', interval: 2, weekdays: [0, 1, 2, 3, 4, 5, 6] }, '2026-10-23').freq).toBe('weekly')
  })

  it('rejects what it cannot build, in Chinese', () => {
    expect(() => buildRepeatRule({ freq: 'hourly' as 'daily' }, '2026-10-21')).toThrow(RepeatError)
    expect(() => buildRepeatRule({ freq: 'daily', interval: 0 }, '2026-10-21')).toThrow(/间隔/)
    expect(() => buildRepeatRule({ freq: 'daily', interval: 100 }, '2026-10-21')).toThrow(/间隔/)
    expect(() => buildRepeatRule({ freq: 'daily', interval: 1.5 }, '2026-10-21')).toThrow(/间隔/)
    expect(() => buildRepeatRule({ freq: 'weekly', weekdays: [] }, '2026-10-21')).toThrow(/星期/)
    expect(() => buildRepeatRule({ freq: 'weekly', weekdays: [7] }, '2026-10-21')).toThrow(/星期/)
    expect(() => buildRepeatRule({ freq: 'daily', weekdays: [1] }, '2026-10-21')).toThrow(/每周/)
    expect(() => buildRepeatRule({ freq: 'monthly', monthDay: 32 }, '2026-10-21')).toThrow(/1 到 31/)
    expect(() => buildRepeatRule({ freq: 'yearly', month: 2, monthDay: 30 }, '2026-10-21')).toThrow(/2月没有30号/)
    expect(() => buildRepeatRule({ freq: 'weekly' }, '2026-02-30')).toThrow(/日期/)
  })
})

describe('nextOccurrence', () => {
  it('daily, every n days counted from the anchor', () => {
    expect(series(buildRepeatRule({ freq: 'daily' }, '2026-10-30'), '2026-10-30', 3)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02'])
    const every3 = buildRepeatRule({ freq: 'daily', interval: 3 }, '2026-10-21')
    expect(series(every3, '2026-10-21', 3)).toEqual(['2026-10-24', '2026-10-27', '2026-10-30'])
    // an occurrence moved later (10-25) is followed by the next date of the series, not 3 days after the move
    expect(nextOccurrence(every3, '2026-10-25')).toBe('2026-10-27')
  })

  it('weekly on one or several days', () => {
    const sundays = buildRepeatRule({ freq: 'weekly' }, '2026-10-25')
    expect(series(sundays, '2026-10-25', 3)).toEqual(['2026-11-01', '2026-11-08', '2026-11-15'])
    // the day after a Saturday move is still the series' Sunday
    expect(nextOccurrence(sundays, '2026-10-24')).toBe('2026-10-25')
    const tueFri = buildRepeatRule({ freq: 'weekly', weekdays: [2, 5] }, '2026-10-23')
    expect(series(tueFri, '2026-10-23', 4)).toEqual(['2026-10-27', '2026-10-30', '2026-11-03', '2026-11-06'])
    const workdays = buildRepeatRule({ freq: 'weekly', weekdays: [1, 2, 3, 4, 5] }, '2026-10-23')
    expect(series(workdays, '2026-10-23', 3)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28'])
  })

  it('every other week keeps its weeks (Monday-first), also with several days', () => {
    const fortnightly = buildRepeatRule({ freq: 'weekly', interval: 2 }, '2026-10-25')
    expect(series(fortnightly, '2026-10-25', 3)).toEqual(['2026-11-08', '2026-11-22', '2026-12-06'])
    // moved to the Monday after: the next one is still in the series' week
    expect(nextOccurrence(fortnightly, '2026-10-26')).toBe('2026-11-08')
    const monThu = buildRepeatRule({ freq: 'weekly', interval: 2, weekdays: [1, 4] }, '2026-10-26')
    expect(series(monThu, '2026-10-26', 4)).toEqual(['2026-10-29', '2026-11-09', '2026-11-12', '2026-11-23'])
  })

  it('monthly on the 31st uses the last day of short months and does not drift', () => {
    const rule = buildRepeatRule({ freq: 'monthly' }, '2027-01-31')
    expect(series(rule, '2027-01-31', 4)).toEqual(['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31'])
    const quarterly = buildRepeatRule({ freq: 'monthly', interval: 3 }, '2026-11-15')
    expect(series(quarterly, '2026-11-15', 3)).toEqual(['2027-02-15', '2027-05-15', '2027-08-15'])
  })

  it('yearly, including 29 February', () => {
    expect(series(buildRepeatRule({ freq: 'yearly' }, '2027-03-08'), '2027-03-08', 2)).toEqual(['2028-03-08', '2029-03-08'])
    const leap = buildRepeatRule({ freq: 'yearly' }, '2028-02-29')
    expect(series(leap, '2028-02-29', 4)).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'])
  })
})

describe('labels', () => {
  it('describes the rule the way a family says it', () => {
    const b = (input: Parameters<typeof buildRepeatRule>[0], date = '2026-10-25') => describeRepeat(buildRepeatRule(input, date))
    expect(b({ freq: 'daily' })).toBe('每天')
    expect(b({ freq: 'daily', interval: 2 })).toBe('每两天')
    expect(b({ freq: 'daily', interval: 3 })).toBe('每3天')
    expect(b({ freq: 'weekly' })).toBe('每周日')
    expect(b({ freq: 'weekly', weekdays: [5, 2] })).toBe('每周二、周五')
    expect(b({ freq: 'weekly', weekdays: [0, 1] })).toBe('每周一、周日')
    expect(b({ freq: 'weekly', weekdays: [1, 2, 3, 4, 5] })).toBe('工作日')
    expect(b({ freq: 'weekly', weekdays: [0, 6] })).toBe('每个周末')
    expect(b({ freq: 'weekly', interval: 2 })).toBe('每两周的周日')
    expect(b({ freq: 'monthly' }, '2026-11-15')).toBe('每月15号')
    expect(b({ freq: 'monthly', interval: 3 }, '2026-11-01')).toBe('每3个月的1号')
    expect(b({ freq: 'yearly' }, '2027-03-08')).toBe('每年3月8日')
    expect(repeatLabel(buildRepeatRule({ freq: 'weekly' }, '2026-10-25'), '21:00')).toBe('每周日 21:00')
    expect(repeatLabel(buildRepeatRule({ freq: 'weekly' }, '2026-10-25'), null)).toBe('每周日')
  })
})

describe('asRepeatRule / sameRepeat', () => {
  it('reads back a stored rule and refuses malformed ones', () => {
    const rule = buildRepeatRule({ freq: 'weekly', weekdays: [2, 5] }, '2026-10-27')
    expect(asRepeatRule(JSON.parse(JSON.stringify(rule)))).toEqual(rule)
    expect(asRepeatRule(null)).toBeNull()
    expect(asRepeatRule({ ...rule, freq: 'hourly' })).toBeNull()
    expect(asRepeatRule({ ...rule, weekdays: [] })).toBeNull()
    expect(asRepeatRule({ ...rule, anchor: '2026-13-01' })).toBeNull()
    expect(asRepeatRule({ ...buildRepeatRule({ freq: 'monthly' }, '2026-10-27'), monthDay: null })).toBeNull()
  })

  it('compares rules without their anchor', () => {
    const a = buildRepeatRule({ freq: 'weekly' }, '2026-10-25')
    expect(sameRepeat(a, { ...a, anchor: '2026-11-01' })).toBe(true)
    expect(sameRepeat(a, buildRepeatRule({ freq: 'weekly' }, '2026-10-26'))).toBe(false)
    expect(sameRepeat(null, undefined)).toBe(true)
    expect(sameRepeat(a, null)).toBe(false)
  })
})
