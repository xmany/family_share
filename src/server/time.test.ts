import { describe, expect, it } from 'vitest'
import {
  addDaysToDate,
  deferPastQuietHours,
  describeNowForPrompt,
  formatDateZh,
  isWithinQuietHours,
  localDate,
  localTime,
  resolveSnoozePreset,
  zonedToUtc,
} from './time'

const SYD = 'Australia/Sydney'
const NY = 'America/New_York'

describe('zonedToUtc', () => {
  it('converts a normal local time', () => {
    // Sydney is UTC+11 in October (AEDT)
    expect(zonedToUtc('2026-10-24', '08:30', SYD).toISOString()).toBe('2026-10-23T21:30:00.000Z')
    expect(zonedToUtc('2026-07-01', '08:30', SYD).toISOString()).toBe('2026-06-30T22:30:00.000Z')
  })

  it('round-trips across a DST change', () => {
    // New York falls back on 2026-11-01 02:00 -> 01:00
    const before = zonedToUtc('2026-10-31', '09:00', NY)
    const after = zonedToUtc('2026-11-02', '09:00', NY)
    expect(localTime(before, NY)).toBe('09:00')
    expect(localTime(after, NY)).toBe('09:00')
    expect(after.getTime() - before.getTime()).toBe(2 * 24 * 3600_000 + 3600_000)
  })

  it('moves a non-existent spring-forward time past the gap', () => {
    // Sydney springs forward 2026-10-04 02:00 -> 03:00
    const t = zonedToUtc('2026-10-04', '02:30', SYD)
    expect(localDate(t, SYD)).toBe('2026-10-04')
    expect(['03:00', '03:30']).toContain(localTime(t, SYD))
  })

  it('rejects bad input', () => {
    expect(() => zonedToUtc('2026-02-30', '08:00', SYD)).toThrow()
    expect(() => zonedToUtc('2026-10-24', '25:00', SYD)).toThrow()
  })
})

describe('quiet hours', () => {
  it('handles windows over midnight', () => {
    expect(isWithinQuietHours(zonedToUtc('2026-10-21', '23:00', SYD), '22:00', '07:30', SYD)).toBe(true)
    expect(isWithinQuietHours(zonedToUtc('2026-10-21', '06:00', SYD), '22:00', '07:30', SYD)).toBe(true)
    expect(isWithinQuietHours(zonedToUtc('2026-10-21', '07:30', SYD), '22:00', '07:30', SYD)).toBe(false)
    expect(isWithinQuietHours(zonedToUtc('2026-10-21', '12:00', SYD), '22:00', '07:30', SYD)).toBe(false)
  })

  it('defers to the end of quiet hours', () => {
    const late = zonedToUtc('2026-10-21', '23:15', SYD)
    expect(deferPastQuietHours(late, '22:00', '07:30', SYD).toISOString()).toBe(zonedToUtc('2026-10-22', '07:30', SYD).toISOString())
    const early = zonedToUtc('2026-10-22', '05:00', SYD)
    expect(deferPastQuietHours(early, '22:00', '07:30', SYD).toISOString()).toBe(zonedToUtc('2026-10-22', '07:30', SYD).toISOString())
    const noon = zonedToUtc('2026-10-22', '12:00', SYD)
    expect(deferPastQuietHours(noon, '22:00', '07:30', SYD)).toBe(noon)
  })

  it('treats equal start and end as no quiet hours', () => {
    expect(isWithinQuietHours(zonedToUtc('2026-10-21', '03:00', SYD), '00:00', '00:00', SYD)).toBe(false)
  })
})

describe('snooze presets', () => {
  // 2026-10-21 is a Wednesday
  const wedNoon = zonedToUtc('2026-10-21', '12:00', SYD)

  it('tonight is 20:00 or an hour from now', () => {
    expect(localTime(resolveSnoozePreset('tonight', wedNoon, SYD), SYD)).toBe('20:00')
    const lateEvening = zonedToUtc('2026-10-21', '19:45', SYD)
    expect(localTime(resolveSnoozePreset('tonight', lateEvening, SYD), SYD)).toBe('20:45')
  })

  it('tomorrow, weekend and next week', () => {
    const tomorrow = resolveSnoozePreset('tomorrow', wedNoon, SYD)
    expect(localDate(tomorrow, SYD)).toBe('2026-10-22')
    expect(localTime(tomorrow, SYD)).toBe('09:00')
    expect(localDate(resolveSnoozePreset('weekend', wedNoon, SYD), SYD)).toBe('2026-10-24')
    const satAfternoon = zonedToUtc('2026-10-24', '15:00', SYD)
    expect(localDate(resolveSnoozePreset('weekend', satAfternoon, SYD), SYD)).toBe('2026-10-25')
    expect(localDate(resolveSnoozePreset('next_week', wedNoon, SYD), SYD)).toBe('2026-10-26')
    const monday = zonedToUtc('2026-10-26', '08:00', SYD)
    expect(localDate(resolveSnoozePreset('next_week', monday, SYD), SYD)).toBe('2026-11-02')
  })
})

describe('formatting', () => {
  const now = zonedToUtc('2026-10-21', '12:00', SYD)
  it('labels dates relative to today', () => {
    expect(formatDateZh('2026-10-21', now, SYD)).toBe('今天')
    expect(formatDateZh('2026-10-22', now, SYD)).toBe('明天')
    expect(formatDateZh('2026-10-24', now, SYD)).toBe('周六 10/24')
    expect(formatDateZh(addDaysToDate('2026-10-21', 30), now, SYD)).toBe('11/20 周五')
  })
  it('describes now for the prompt', () => {
    expect(describeNowForPrompt(now, SYD)).toBe('2026-10-21 周三 12:00（Australia/Sydney，UTC+11:00）')
  })
})
