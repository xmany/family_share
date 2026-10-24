import type { Db } from '../db/db'
import { parseJson } from '../db/db'
import { newId } from '../ids'
import type { Clock } from '../time'
import type { Bus } from '../bus'
import type { NotificationAction, NotificationKind, NotificationStatus, ScheduledNotification } from '../../shared/types'

export interface NewNotification {
  memberId: string
  itemId?: string | null
  kind: NotificationKind
  /** Defaults to now (deliver on the next scheduler tick) */
  fireAt?: Date | string
  title: string
  body: string
  /** In-app path. Defaults to "/item/<itemId>" when itemId is set, else "/" */
  url?: string
  actions?: NotificationAction[]
  /** Unique; a second enqueue with the same key is ignored */
  dedupeKey: string
  respectQuietHours?: boolean
  utteranceId?: string | null
}

interface Row {
  id: string
  member_id: string
  item_id: string | null
  kind: string
  fire_at: string
  title: string
  body: string
  url: string
  actions: string
  dedupe_key: string
  respect_quiet_hours: number
  status: string
  attempts: number
  sent_at: string | null
  last_error: string | null
  utterance_id: string | null
  created_at: string
}

function toNotification(r: Row): ScheduledNotification {
  return {
    id: r.id,
    memberId: r.member_id,
    itemId: r.item_id,
    kind: r.kind as NotificationKind,
    fireAt: r.fire_at,
    title: r.title,
    body: r.body,
    url: r.url,
    actions: parseJson<NotificationAction[]>(r.actions, []),
    dedupeKey: r.dedupe_key,
    respectQuietHours: r.respect_quiet_hours === 1,
    status: r.status as NotificationStatus,
    attempts: r.attempts,
    sentAt: r.sent_at,
    lastError: r.last_error,
    createdAt: r.created_at,
  }
}

/**
 * The notification outbox. Every notification — immediate or future — is a row here;
 * the scheduler delivers rows whose fire_at has passed. Writing a row is cheap and
 * transactional with the item change that caused it, so nothing is lost on a crash.
 */
export class Outbox {
  constructor(
    private db: Db,
    private clock: Clock,
    private bus?: Bus,
  ) {}

  /** Inserts a notification unless one with the same dedupeKey exists. Returns null when deduped. */
  enqueue(n: NewNotification): ScheduledNotification | null {
    const now = this.clock.now()
    const fireAt = n.fireAt ? new Date(n.fireAt) : now
    const id = newId('nt')
    const url = n.url ?? (n.itemId ? `/item/${n.itemId}` : '/')
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications
         (id, member_id, item_id, kind, fire_at, title, body, url, actions, dedupe_key, respect_quiet_hours, status, attempts, utterance_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)`,
      )
      .run(
        id,
        n.memberId,
        n.itemId ?? null,
        n.kind,
        fireAt.toISOString(),
        n.title,
        n.body,
        url,
        JSON.stringify(n.actions ?? []),
        n.dedupeKey,
        n.respectQuietHours === false ? 0 : 1,
        n.utteranceId ?? null,
        now.toISOString(),
      )
    if (res.changes === 0) return null
    if (fireAt.getTime() <= now.getTime()) this.bus?.wakeScheduler()
    return this.get(id)
  }

  get(id: string): ScheduledNotification | null {
    const r = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Row | undefined
    return r ? toNotification(r) : null
  }

  /** Scheduled rows whose fire_at <= now, oldest first. */
  due(now: Date, limit = 100): ScheduledNotification[] {
    const rows = this.db
      .prepare(`SELECT * FROM notifications WHERE status = 'scheduled' AND fire_at <= ? ORDER BY fire_at LIMIT ?`)
      .all(now.toISOString(), limit) as Row[]
    return rows.map(toNotification)
  }

  /** Scheduled (future or due) notifications for an item. */
  scheduledForItem(itemId: string): ScheduledNotification[] {
    const rows = this.db
      .prepare(`SELECT * FROM notifications WHERE item_id = ? AND status = 'scheduled' ORDER BY fire_at`)
      .all(itemId) as Row[]
    return rows.map(toNotification)
  }

  /** All notifications for an item (any status), newest first. */
  listForItem(itemId: string, limit = 50): ScheduledNotification[] {
    const rows = this.db
      .prepare(`SELECT * FROM notifications WHERE item_id = ? ORDER BY fire_at DESC LIMIT ?`)
      .all(itemId, limit) as Row[]
    return rows.map(toNotification)
  }

  /** Earliest scheduled fire_at for an item (used for Item.remindAt). */
  nextForItem(itemId: string): string | null {
    const r = this.db
      .prepare(`SELECT MIN(fire_at) AS t FROM notifications WHERE item_id = ? AND status = 'scheduled'`)
      .get(itemId) as { t: string | null } | undefined
    return r?.t ?? null
  }

  /** Cancels scheduled notifications for an item, optionally only some kinds. Returns ids cancelled. */
  cancelForItem(itemId: string, kinds?: NotificationKind[]): string[] {
    const rows = this.scheduledForItem(itemId).filter(n => !kinds || kinds.includes(n.kind))
    const stmt = this.db.prepare(`UPDATE notifications SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'`)
    for (const n of rows) stmt.run(n.id)
    return rows.map(n => n.id)
  }

  cancel(id: string): boolean {
    return this.db.prepare(`UPDATE notifications SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'`).run(id).changes > 0
  }

  /** Restores a cancelled notification (used by undo). */
  reschedule(id: string, fireAt?: Date | string): void {
    if (fireAt) {
      this.db.prepare(`UPDATE notifications SET status = 'scheduled', fire_at = ? WHERE id = ?`).run(new Date(fireAt).toISOString(), id)
    } else {
      this.db.prepare(`UPDATE notifications SET status = 'scheduled' WHERE id = ?`).run(id)
    }
  }

  /** Moves a scheduled notification later (quiet hours). */
  defer(id: string, fireAt: Date): void {
    this.db.prepare(`UPDATE notifications SET fire_at = ? WHERE id = ? AND status = 'scheduled'`).run(fireAt.toISOString(), id)
  }

  markSent(id: string): void {
    this.db
      .prepare(`UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`)
      .run(this.clock.now().toISOString(), id)
  }

  /** Records a failed attempt. After maxAttempts the row is marked failed; otherwise it is retried at retryAt. */
  markFailed(id: string, error: string, retryAt: Date | null, maxAttempts = 5): void {
    const n = this.get(id)
    if (!n) return
    const attempts = n.attempts + 1
    if (!retryAt || attempts >= maxAttempts) {
      this.db.prepare(`UPDATE notifications SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`).run(attempts, error, id)
    } else {
      this.db
        .prepare(`UPDATE notifications SET attempts = ?, last_error = ?, fire_at = ? WHERE id = ?`)
        .run(attempts, error, retryAt.toISOString(), id)
    }
  }

  markSkipped(id: string, reason: string): void {
    this.db.prepare(`UPDATE notifications SET status = 'skipped', last_error = ? WHERE id = ?`).run(reason, id)
  }

  /** True if any notification with this dedupe key exists (any status). */
  exists(dedupeKey: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM notifications WHERE dedupe_key = ?').get(dedupeKey)
  }

  recordDelivery(notificationId: string, channel: string, ok: boolean, error?: string): void {
    this.db
      .prepare('INSERT INTO deliveries (notification_id, channel, ok, error, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(notificationId, channel, ok ? 1 : 0, error ?? null, this.clock.now().toISOString())
  }
}
