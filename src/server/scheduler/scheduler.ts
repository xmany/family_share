// The deterministic background loop (SPEC §3). Each tick:
//   1. generators: daily digest (member.digestTime), stale nudges (19:00), weekly sync (Sunday 19:00) — each runs
//      when its local time fell between the previous tick and now (the previous tick time is kept in kv, so the first
//      tick after downtime catches up, same local day only); dedupe keys make re-runs harmless;
//   2. delivery of due outbox rows: relevance check → too-late skip → duplicate-ping skip → quiet-hours deferral →
//      re-wording for the delivery instant (今天 / 明天) → notifier fan-out → sent / retry with backoff (1, 5, 15,
//      60 min; 5 attempts) / failed / skipped('no_channels').
// Ticks never overlap: a tick requested while one runs makes the running one go round once more. Each row is claimed
// (compare-and-set on fire_at) before it is sent, so a second scheduler on the same database file — the CLI's
// `family test-notify` runs a full tick next to the server — never sends it too. stop() lets a running tick finish
// the row it is sending and then stop.

import type { Bus } from '../bus'
import type { Config } from '../config'
import type { Db } from '../db/db'
import { dedupeKeys, requestFollowupAt, requestNoreplyAt, textAtDelivery } from '../domain/policy'
import type { Domain } from '../domain/types'
import type { Outbox } from '../notify/outbox'
import type { DeliveryResult, Notifier } from '../notify/types'
import type { Item, ScheduledNotification } from '../../shared/types'
import type { Clock } from '../time'
import { MINUTE, deferPastQuietHours, isWithinQuietHours, localDate, weekdayOfDate, zonedToUtc } from '../time'
import {
  STALE_MIN_GAP_MS,
  STALE_TIME,
  WEEKLY_TIME,
  digestKey,
  digestNotification,
  isStaleCandidate,
  staleNotification,
  weekStartLocalDay,
  weeklyKey,
  weeklyNotification,
} from './generators'
import type { GenEnv } from './generators'
import {
  LATE_AFTER_MS,
  duplicatePing,
  eveningBeforeMissed,
  isTooLate,
  lateness,
  requestPastDue,
  skipReason,
  withLatePrefix,
} from './relevance'
import type { Scheduler, TickReport } from './types'

export interface SchedulerDeps {
  config: Config
  db: Db
  clock: Clock
  bus: Bus
  outbox: Outbox
  domain: Domain
  notifier: Notifier
  log?: Pick<Console, 'warn' | 'error'>
}

/** Retry delays after the 1st, 2nd, 3rd and 4th failed attempt; the 5th failure is final. */
export const RETRY_BACKOFF_MIN = [1, 5, 15, 60] as const
export const MAX_ATTEMPTS = 5
export const LAST_TICK_KEY = 'scheduler:last_tick'
/** How long a claimed row stays invisible to other ticks while it is being sent (well above the channel timeouts). */
export const CLAIM_LEASE_MS = 5 * MINUTE
const BATCH = 100
const MAX_BATCHES = 10

export function retryDelayMs(attemptsSoFar: number): number {
  const i = Math.min(Math.max(attemptsSoFar, 0), RETRY_BACKOFF_MIN.length - 1)
  return RETRY_BACKOFF_MIN[i]! * MINUTE
}

const emptyReport = (): TickReport => ({ delivered: 0, deferred: 0, failed: 0, generated: 0 })
const addReport = (a: TickReport, b: TickReport): TickReport => ({
  delivered: a.delivered + b.delivered,
  deferred: a.deferred + b.deferred,
  failed: a.failed + b.failed,
  generated: a.generated + b.generated,
})

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { config, db, clock, bus, outbox, domain, notifier } = deps
  const log = deps.log ?? console

  let timer: ReturnType<typeof setInterval> | null = null
  let wakePending = false
  let started = false
  let running: Promise<TickReport> | null = null
  let again = false
  /** set by stop(): a running tick finishes the row it is sending and then stops */
  let halted = false

  // -------------------------------------------------------------------------------------------
  // bookkeeping

  function readLastTick(): Date | null {
    const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(LAST_TICK_KEY) as { value: string } | undefined
    if (!r) return null
    const t = new Date(r.value)
    return Number.isNaN(t.getTime()) ? null : t
  }

  function writeLastTick(now: Date): void {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      LAST_TICK_KEY,
      now.toISOString(),
    )
  }

  /** Compare-and-set on fire_at: returns the lease (the row's new fire_at) when this tick now owns the row. */
  function claim(n: ScheduledNotification, at: Date): string | null {
    const lease = new Date(at.getTime() + CLAIM_LEASE_MS).toISOString()
    const won =
      db
        .prepare(`UPDATE notifications SET fire_at = ? WHERE id = ? AND status = 'scheduled' AND fire_at = ?`)
        .run(lease, n.id, n.fireAt).changes === 1
    return won ? lease : null
  }

  /** Once a claimed row is final (sent / failed / skipped / cancelled), give it back its real fire time. */
  function releaseClaim(id: string, fireAt: string, lease: string): void {
    db.prepare(`UPDATE notifications SET fire_at = ? WHERE id = ? AND fire_at = ? AND status != 'scheduled'`).run(fireAt, id, lease)
  }

  /** A stale nudge for this item was sent (or is waiting) within the last 4 days. */
  function recentStale(itemId: string, now: Date): boolean {
    return !!db
      .prepare(
        `SELECT 1 FROM notifications WHERE item_id = ? AND kind = 'stale' AND status IN ('scheduled', 'sent') AND fire_at > ? LIMIT 1`,
      )
      .get(itemId, new Date(now.getTime() - STALE_MIN_GAP_MS).toISOString())
  }

  // -------------------------------------------------------------------------------------------
  // generators

  function guarded(what: string, fn: () => number): number {
    try {
      return fn()
    } catch (e) {
      log.error(`[scheduler] ${what} generator failed`, e)
      return 0
    }
  }

  function runGenerators(now: Date): number {
    let tz: string
    try {
      tz = domain.getFamily().timezone
    } catch {
      return 0 // family not initialised yet
    }
    const last = readLastTick()
    const from = last && last.getTime() <= now.getTime() ? last : new Date(now.getTime() - config.scheduler.intervalMs)
    const arrived = (t: Date) => t.getTime() > from.getTime() && t.getTime() <= now.getTime()
    const today = localDate(now, tz)
    const members = domain.listMembers()
    let active: Item[] | null = null
    const env = (): GenEnv => ({ now, tz, members, items: (active ??= domain.listActiveItems()) })
    let generated = 0

    generated += guarded('digest', () => {
      let n = 0
      for (const m of members) {
        if (!m.digestTime) continue
        const at = zonedToUtc(today, m.digestTime, tz)
        if (!arrived(at) || outbox.exists(digestKey(m.id, today))) continue
        const row = digestNotification(m, env(), at)
        if (row && outbox.enqueue(row)) n++
      }
      return n
    })

    generated += guarded('stale', () => {
      const at = zonedToUtc(today, STALE_TIME, tz)
      if (!arrived(at)) return 0
      let n = 0
      for (const item of env().items) {
        if (!isStaleCandidate(item, now) || !item.ownerId || recentStale(item.id, now)) continue
        if (outbox.enqueue(staleNotification(item as Item & { ownerId: string }, env(), at))) n++
      }
      return n
    })

    generated += guarded('weekly', () => {
      if (weekdayOfDate(today) !== 0) return 0
      const at = zonedToUtc(today, WEEKLY_TIME, tz)
      if (!arrived(at)) return 0
      const adults = members.filter(m => m.role === 'adult' && !outbox.exists(weeklyKey(m.id, today)))
      if (!adults.length) return 0
      const weekStart = zonedToUtc(weekStartLocalDay(now, tz), '00:00', tz)
      const doneThisWeek = domain.listClosedSince(weekStart).filter(i => i.status === 'done')
      let n = 0
      for (const m of adults) {
        const row = weeklyNotification(m, { ...env(), doneThisWeek }, at)
        if (row && outbox.enqueue(row)) n++
      }
      return n
    })

    writeLastTick(now)
    return generated
  }

  // -------------------------------------------------------------------------------------------
  // delivery

  async function deliverOne(queued: ScheduledNotification, now: Date, report: TickReport): Promise<void> {
    // re-read: an earlier row's send was async, and the domain may have cancelled or re-worded this one meanwhile
    const n = outbox.get(queued.id)
    if (!n || n.status !== 'scheduled' || new Date(n.fireAt).getTime() > now.getTime()) return
    const item = n.itemId ? domain.getItem(n.itemId) : null
    const tz = domain.getFamily().timezone
    const reason = skipReason(n, item, now, tz)
    if (reason) {
      outbox.markSkipped(n.id, reason)
      return
    }
    const member = domain.getMember(n.memberId)
    if (!member) {
      outbox.markSkipped(n.id, 'no_member')
      return
    }
    if (isTooLate(n, now)) {
      outbox.markSkipped(n.id, 'too_late')
      return
    }
    if (eveningBeforeMissed(n, item, now, tz)) {
      outbox.markSkipped(n.id, 'superseded')
      return
    }
    if (item && duplicatePing(n, item, outbox.listForItem(item.id))) {
      outbox.markSkipped(n.id, 'duplicate')
      return
    }
    if (n.respectQuietHours && isWithinQuietHours(now, member.quietStart, member.quietEnd, tz)) {
      const until = deferPastQuietHours(now, member.quietStart, member.quietEnd, tz)
      if (eveningBeforeMissed(n, item, until, tz)) {
        outbox.markSkipped(n.id, 'superseded')
        return
      }
      // a follow-up / no-reply held back past the request's due time would arrive after the event
      if (item && requestPastDue(n, item, until, tz)) {
        outbox.markSkipped(n.id, 'past_due')
        return
      }
      outbox.defer(n.id, until)
      if (item && n.kind === 'request_new') alignRequestRound(n, item, until)
      report.deferred++
      return
    }

    // Claim the row before sending: another scheduler on the same database (the CLI's `test-notify` runs a full
    // tick next to the server) must not send it too. If this process dies mid-send the row comes back after the
    // lease (and the notifier skips the channels that already got it).
    const lease = claim(n, clock.now()) // the real time: a long tick must not hand out leases already expired
    if (!lease) return
    try {
      await sendClaimed(item ? reworded(n, item, now, tz) : n, item, now, report)
    } finally {
      releaseClaim(n.id, n.fireAt, lease)
    }
  }

  /**
   * The row worded for the delivery instant: "今天 / 明天" are computed when a row is planned, and a quiet-hours
   * deferral, a retry or downtime can move delivery past midnight (a decline at 23:10 read at 07:30 must say
   * "今天 15:00", not "明天 15:00"). The new text is stored too, so the item's notification history shows what was sent.
   */
  function reworded(n: ScheduledNotification, item: Item, now: Date, tz: string): ScheduledNotification {
    try {
      const answerMessage = n.kind === 'request_answered' ? answerMessageOf(n, item.id) : undefined
      const text = textAtDelivery(n, item, { now, timezone: tz, members: domain.listMembers(), answerMessage })
      if (!text || (text.title === n.title && text.body === n.body)) return n
      db.prepare(`UPDATE notifications SET title = ?, body = ? WHERE id = ? AND status = 'scheduled'`).run(text.title, text.body, n.id)
      return { ...n, title: text.title, body: text.body }
    } catch (e) {
      log.error(`[scheduler] re-wording ${n.id} failed; sending the stored text`, e)
      return n // the stored text is still better than no notification
    }
  }

  /** The message of the accept / decline a `request_answered:<id>:<response>:<n>` row reports; undefined if not found. */
  function answerMessageOf(n: ScheduledNotification, itemId: string): string | null | undefined {
    const [, , response, round] = n.dedupeKey.split(':')
    const ev = (domain.getItemDetail(itemId)?.events ?? [])
      .filter(e => e.type === 'request_responded' && !e.undone && e.payload.response === response && e.payload.n === Number(round))
      .pop()
    if (!ev) return undefined
    return typeof ev.payload.message === 'string' ? ev.payload.message : null
  }

  /**
   * A round's request_new reaches the owner at `at` (deferred to the end of quiet hours, or delivered late): its
   * follow-up and no-reply must not come sooner than they would after a request sent at `at`, or the owner gets
   * "还没回复" the same minute as the request itself and the requester is told nobody answered. Only moves rows later.
   */
  function alignRequestRound(n: ScheduledNotification, item: Item, at: Date): void {
    const round = Number(n.dedupeKey.split(':')[2])
    const targets = new Map<string, Date>([
      [dedupeKeys.requestFollowup(item.id, round), requestFollowupAt(at, item.dueAt, config.scheduler)],
      [dedupeKeys.requestNoreply(item.id, round), requestNoreplyAt(at, item.dueAt, config.scheduler)],
    ])
    for (const row of outbox.scheduledForItem(item.id)) {
      const target = targets.get(row.dedupeKey)
      if (target && new Date(row.fireAt).getTime() < target.getTime()) outbox.defer(row.id, target)
    }
  }

  async function sendClaimed(n: ScheduledNotification, item: Item | null, now: Date, report: TickReport): Promise<void> {
    let results: DeliveryResult[]
    try {
      results = await notifier.deliver(withLatePrefix(n, now))
    } catch (e) {
      log.error(`[scheduler] notifier failed for ${n.id}`, e)
      results = [{ channel: 'notifier', ok: false, permanent: false, error: `exception: ${(e as Error)?.message ?? String(e)}` }]
    }

    const after = outbox.get(n.id)
    if (results.some(r => r.ok)) {
      if (after?.status !== 'sent') outbox.markSent(n.id)
      // a request that reached the owner late (downtime, retries): its follow-ups count from now
      if (item && n.kind === 'request_new' && lateness(n, now) > LATE_AFTER_MS) alignRequestRound(n, item, now)
      report.delivered++
      return
    }
    if (!after || after.status !== 'scheduled') return // cancelled meanwhile: leave it cancelled
    if (results.length === 0) {
      outbox.markSkipped(n.id, 'no_channels')
      return
    }
    const error = results
      .map(r => `${r.channel}: ${r.error ?? 'failed'}`)
      .join('; ')
      .slice(0, 500)
    const transient = results.some(r => !r.permanent)
    outbox.markFailed(n.id, error, transient ? new Date(now.getTime() + retryDelayMs(after.attempts)) : null, MAX_ATTEMPTS)
    report.failed++
  }

  async function deliverDue(now: Date, report: TickReport): Promise<void> {
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = outbox.due(now, BATCH)
      for (const n of rows) {
        if (halted) return
        try {
          await deliverOne(n, now, report)
        } catch (e) {
          // never let one bad row stall the queue: back it off like a transient failure
          log.error(`[scheduler] delivering ${n.id} failed`, e)
          try {
            const cur = outbox.get(n.id)
            if (cur?.status === 'scheduled') {
              outbox.markFailed(n.id, `exception: ${(e as Error)?.message ?? String(e)}`, new Date(now.getTime() + retryDelayMs(cur.attempts)), MAX_ATTEMPTS)
              report.failed++
            }
          } catch {
            // give up on this row for this tick
          }
        }
      }
      if (rows.length < BATCH) break
    }
  }

  async function runOnce(): Promise<TickReport> {
    const report = emptyReport()
    const now = clock.now()
    report.generated = runGenerators(now)
    await deliverDue(now, report)
    return report
  }

  function tick(): Promise<TickReport> {
    if (running) {
      again = true
      return running
    }
    halted = false
    again = false
    running = (async () => {
      try {
        let total = await runOnce()
        while (again && !halted) {
          again = false
          total = addReport(total, await runOnce())
        }
        return total
      } finally {
        running = null
      }
    })()
    return running
  }

  function runInBackground(): void {
    tick().catch(e => log.error('[scheduler] tick failed', e))
  }

  /** Bus 'notifications_queued': the domain emits it after commit; still defer so we never run inside its call stack. */
  function onQueued(): void {
    if (!started || wakePending) return
    wakePending = true
    setImmediate(() => {
      wakePending = false
      if (started) runInBackground()
    })
  }

  const scheduler: Scheduler = {
    start() {
      if (started) return
      started = true
      bus.on('notifications_queued', onQueued)
      timer = setInterval(runInBackground, config.scheduler.intervalMs)
      timer.unref?.()
      // catch up right away after a restart
      setImmediate(() => {
        if (started) runInBackground()
      })
    },
    stop() {
      started = false
      halted = true
      bus.off('notifications_queued', onQueued)
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
  inFlight.set(scheduler, () => running)
  return scheduler
}

/** The running tick of each scheduler, for schedulerIdle() — kept off the Scheduler contract (stop(): void). */
const inFlight = new WeakMap<Scheduler, () => Promise<TickReport> | null>()

/**
 * Resolves when the scheduler has no tick running. After stop(), a running tick finishes the row it is sending and
 * then ends, so `stop(); await schedulerIdle(s)` lets a graceful shutdown close the database only after that send
 * was recorded. Never starts a tick. Resolves at once for schedulers not made by createScheduler (test fakes).
 */
export async function schedulerIdle(s: Scheduler): Promise<void> {
  const current = inFlight.get(s)?.()
  if (current) {
    await current.then(
      () => undefined,
      () => undefined,
    )
  }
}
