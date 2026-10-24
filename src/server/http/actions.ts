// Small operations shared by the HTTP routes and the CLI.

import type { Member, ScheduledNotification } from '../../shared/types'
import type { AppContext } from '../context'
import type { NewNotification } from '../notify/outbox'
import type { DeliveryResult } from '../notify/types'
import { newSecret } from '../ids'
import { sanitizeKeywords } from '../stt/audio'
import type { SttOptions } from '../stt/index'

export interface TestNotificationResult {
  notificationId: string
  /** Endpoints the test reached (successful deliveries recorded for it) */
  delivered: number
  status: string
}

/**
 * Enqueues a `test` notification for the member (fires now, ignores quiet hours) and reports how many endpoints it
 * reached.
 * - In the server (default): runs one scheduler tick, which delivers it like any other row.
 * - `direct` (the CLI, a second process on the same database): delivers only this row through the notifier. A tick
 *   there would deliver every due row a second time — the outbox has no cross-process claim — and run the generators
 *   concurrently with the server's scheduler. The row is created already cancelled, in one transaction, so no
 *   scheduler can pick it up meanwhile; it ends sent / failed / skipped.
 */
export async function sendTestNotification(
  ctx: AppContext,
  member: Member,
  opts: { waitMs?: number; direct?: boolean } = {},
): Promise<TestNotificationResult> {
  const now = ctx.clock.now()
  const input = {
    memberId: member.id,
    kind: 'test' as const,
    fireAt: now,
    title: '测试通知',
    body: `${member.name}，能看到这条就说明通知设置好了`,
    url: '/settings',
    actions: [],
    dedupeKey: `test:${member.id}:${now.toISOString()}:${newSecret().slice(0, 8)}`,
    respectQuietHours: false,
  }
  if (opts.direct) return deliverDirectly(ctx, input)

  const n = ctx.outbox.enqueue(input)
  if (!n) throw new Error('test notification was deduplicated')
  await ctx.scheduler.tick()
  // A tick already running (woken by the enqueue, or another process's) may own the row: wait briefly for it to
  // settle. While a scheduler holds its claim, fire_at is the lease time (in the future) but attempts is still 0;
  // after a transient failure attempts > 0 and fire_at is the retry time, which is not worth waiting for.
  const deadline = Date.now() + (opts.waitMs ?? 8000)
  const inFlight = (r: ScheduledNotification | null | undefined) =>
    r?.status === 'scheduled' && (r.attempts === 0 || new Date(r.fireAt).getTime() <= ctx.clock.now().getTime())
  let row = ctx.outbox.get(n.id)
  while (inFlight(row) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
    row = ctx.outbox.get(n.id)
  }
  const d = ctx.db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok FROM deliveries WHERE notification_id = ?')
    .get(n.id) as { total: number; ok: number }
  const status = row?.status ?? 'scheduled'
  // Channels report one delivery row per endpoint; a scheduler that records none but marked it sent reached at least one.
  const delivered = d.total > 0 ? d.ok : status === 'sent' ? 1 : 0
  return { notificationId: n.id, delivered, status }
}

async function deliverDirectly(ctx: AppContext, input: NewNotification): Promise<TestNotificationResult> {
  const n = ctx.db.transaction(() => {
    const row = ctx.outbox.enqueue(input)
    if (row) ctx.outbox.cancel(row.id)
    return row
  })()
  if (!n) throw new Error('test notification was deduplicated')
  let results: DeliveryResult[]
  try {
    results = await ctx.notifier.deliver(n)
  } catch (e) {
    results = [{ channel: 'notifier', ok: false, error: `exception: ${e instanceof Error ? e.message : String(e)}` }]
  }
  if (results.some(r => r.ok)) ctx.outbox.markSent(n.id)
  else if (results.length === 0) ctx.outbox.markSkipped(n.id, 'no_channels')
  else
    ctx.outbox.markFailed(
      n.id,
      results.map(r => `${r.channel}: ${r.error ?? 'failed'}`).join('; ').slice(0, 500),
      null,
    )
  return { notificationId: n.id, delivered: results.filter(r => r.ok).length, status: ctx.outbox.get(n.id)?.status ?? 'failed' }
}

/** STT language hints for a member's BCP 47 language (gpt-transcribe `languages[]`). */
export function sttLanguagesFor(language: string | null | undefined): string[] {
  const lang = (language || 'zh-CN').toLowerCase()
  if (lang.startsWith('yue') || lang === 'zh-hk' || lang === 'zh-mo') return ['yue', 'zh', 'en']
  if (lang.startsWith('zh')) return ['zh', 'en']
  const primary = lang.split('-')[0] || 'zh'
  return primary === 'en' ? ['en', 'zh'] : [primary, 'en']
}

/** Members writing Traditional Chinese keep the provider's script; everyone else gets Simplified. */
export function sttSimplifyFor(language: string | null | undefined): boolean {
  const lang = (language || 'zh-CN').toLowerCase()
  return !(lang.startsWith('yue') || lang.includes('hant') || ['zh-tw', 'zh-hk', 'zh-mo'].includes(lang))
}

export const STT_PROMPT = '家庭成员之间的日常安排，普通话，可能夹杂英文。'
const MAX_TITLE_KEYWORDS = 40

/** Keywords: member names + aliases, then up to 40 active item titles; sanitized and capped at 50. */
export function sttOptionsFor(ctx: AppContext, member: Member): SttOptions {
  const members = ctx.domain.listMembers()
  const names = members.flatMap(m => [m.name, ...m.aliases])
  const titles = ctx.domain
    .listActiveItems()
    .slice(0, MAX_TITLE_KEYWORDS)
    .map(i => i.title)
  return {
    languages: sttLanguagesFor(member.language),
    keywords: sanitizeKeywords([...names, ...titles]),
    prompt: STT_PROMPT,
    simplify: sttSimplifyFor(member.language),
  }
}
