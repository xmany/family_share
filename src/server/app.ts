// Wiring: builds the AppContext the HTTP server, the scheduler and the CLI share.

import type { MessagesApi } from './ai/index'
import { createInterpreter } from './ai/index'
import { Bus } from './bus'
import type { Config } from './config'
import type { AppContext } from './context'
import { openDb } from './db/db'
import { createDomain } from './domain/index'
import { createNotifier } from './notify/index'
import { Outbox } from './notify/outbox'
import type { NotificationChannel } from './notify/types'
import { createScheduler, schedulerIdle } from './scheduler/index'
import { createStt } from './stt/index'
import type { SttProvider } from './stt/types'
import type { Clock } from './time'
import { systemClock } from './time'
import { getOrCreateAppSecret } from './tokens'
import { waitForWechatBackground } from './wechat/index'

export interface BuildContextOptions {
  /** Defaults to the system clock */
  clock?: Clock
  /** Fake Anthropic Messages API for tests */
  api?: MessagesApi
  /** undefined = from config; null = no speech-to-text */
  stt?: SttProvider | null
  /** Notification channels to use instead of the configured ones (tests) */
  channels?: NotificationChannel[]
}

/** Opens the database (config.dbPath, or ':memory:'), ensures the family exists and wires every module. */
export function buildContext(config: Config, opts: BuildContextOptions = {}): AppContext {
  const db = openDb(config.dbPath)
  const clock = opts.clock ?? systemClock
  const bus = new Bus()
  const outbox = new Outbox(db, clock, bus)
  const domain = createDomain({ db, clock, bus, outbox, config })
  // Must come first: getFamily() and every write throw until the family row exists.
  domain.ensureFamily(config.familyName, config.familyTimezone)
  const appSecret = getOrCreateAppSecret(db)
  const interpreter = createInterpreter({ config, domain, clock, ...(opts.api ? { api: opts.api } : {}) })
  const stt = opts.stt !== undefined ? opts.stt : createStt(config)
  const notifier = createNotifier({
    config,
    db,
    clock,
    domain,
    outbox,
    appSecret,
    ...(opts.channels ? { channels: opts.channels } : {}),
  })
  const scheduler = createScheduler({ config, db, clock, bus, outbox, domain, notifier })
  return { config, db, clock, bus, outbox, domain, interpreter, stt, notifier, scheduler }
}

export const INTERRUPTED_REPLY = '服务器重启了，这句话没有处理完，请再说一次'

/**
 * Finishes utterances that a crash or restart left in 'processing' (status error, with a Chinese explanation).
 * Without this they show "处理中…" forever and the app offers no undo for whatever was already applied.
 * Call it once when the SERVER starts — never from buildContext, which the CLI also uses while the server runs.
 */
export function recoverInterruptedUtterances(ctx: AppContext): number {
  const rows = ctx.db.prepare(`SELECT id FROM utterances WHERE status = 'processing' ORDER BY created_at`).all() as { id: string }[]
  let n = 0
  for (const { id } of rows) {
    try {
      ctx.domain.finishUtterance(id, { status: 'error', reply: INTERRUPTED_REPLY, error: INTERRUPTED_REPLY, usage: { error: { code: 'interrupted' } } })
      n++
    } catch (e) {
      console.error(`[startup] could not finish interrupted utterance ${id}`, e)
    }
  }
  return n
}

/** Work that outlives its HTTP request: WeChat replies being interpreted, and the scheduler tick sending a row. */
export async function backgroundWork(ctx: AppContext): Promise<void> {
  await Promise.all([waitForWechatBackground(ctx), schedulerIdle(ctx.scheduler)])
}

/**
 * Waits for work that outlives its HTTP request (WeChat messages are acknowledged at once, then interpreted and
 * answered in the background; a scheduler tick stopped by scheduler.stop() still finishes the row it is sending)
 * so a graceful shutdown does not close the database under it. Resolves false on timeout.
 */
export async function drainBackgroundWork(
  ctx: AppContext,
  timeoutMs: number,
  wait: (ctx: AppContext) => Promise<void> = backgroundWork,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([
      wait(ctx).then(
        () => true as const,
        () => true as const,
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}
