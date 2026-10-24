import type { Bus } from './bus'
import type { Config } from './config'
import type { Db } from './db/db'
import type { Domain } from './domain/types'
import type { Interpreter } from './ai/types'
import type { Notifier } from './notify/types'
import type { Outbox } from './notify/outbox'
import type { Scheduler } from './scheduler/types'
import type { SttProvider } from './stt/types'
import type { Clock } from './time'

/** Everything the server needs, built once in index.ts (and with fakes in tests). */
export interface AppContext {
  config: Config
  db: Db
  clock: Clock
  bus: Bus
  outbox: Outbox
  domain: Domain
  interpreter: Interpreter
  /** null when no speech-to-text provider is configured */
  stt: SttProvider | null
  notifier: Notifier
  scheduler: Scheduler
}
