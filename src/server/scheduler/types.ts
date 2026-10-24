export interface TickReport {
  delivered: number
  deferred: number
  failed: number
  generated: number
}

/**
 * Deterministic background loop. Every tick (default 30 s, and immediately when the Bus emits
 * 'notifications_queued'):
 *  1. deliver due outbox rows (deferring ones that fall in the recipient's quiet hours),
 *  2. run generators that enqueue follow-ups (request follow-up / no-reply, stale tasks,
 *     daily digest, weekly sync) with dedupe keys so re-runs are harmless.
 */
export interface Scheduler {
  start(): void
  stop(): void
  tick(): Promise<TickReport>
}
