// Shared test helper: a fully wired in-memory domain with a fixed clock and two adults.
// Other modules' tests (scheduler, interpreter, http) reuse this — keep it stable.
//
//   const t = createTestContext()                 // Wed 2026-10-21 12:00 Sydney
//   t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯' })
//   t.clock.advance(60 * MINUTE)
//
// Defaults: family '测试家' in 'Australia/Sydney', clock '2026-10-21T01:00:00.000Z'
// (Wednesday 12:00 local), members 老公 (husband) and 老婆 (wife), both adults with the default
// quiet hours 22:00–07:30 and digest 07:30. Bus events are recorded in `t.events`.

import type { ServerEvent } from '../shared/api'
import type { Family, Member } from '../shared/types'
import { Bus } from './bus'
import type { Config } from './config'
import { testConfig } from './config'
import type { Db } from './db/db'
import { openDb } from './db/db'
import { createDomain } from './domain/domain'
import type { Actor, Domain } from './domain/types'
import { Outbox } from './notify/outbox'
import { FixedClock } from './time'

export const TEST_NOW = '2026-10-21T01:00:00.000Z'
export const TEST_TIMEZONE = 'Australia/Sydney'
export const HUSBAND = { name: '老公', aliases: ['我老公', '他', '孩子爸', '爸爸'] } as const
export const WIFE = { name: '老婆', aliases: ['我老婆', '她', '媳妇', '孩子妈', '妈妈'] } as const

export interface TestContext {
  db: Db
  clock: FixedClock
  bus: Bus
  outbox: Outbox
  domain: Domain
  config: Config
  family: Family
  husband: Member
  wife: Member
  /** Every ServerEvent broadcast on the bus, in order */
  events: ServerEvent[]
  /** Actor for a button press by this member */
  as(member: Member): Actor
  /** Actor for an AI change caused by this member's utterance */
  asAi(member: Member, utteranceId: string): Actor
}

export function createTestContext(opts: { now?: string; timezone?: string } = {}): TestContext {
  const timezone = opts.timezone ?? TEST_TIMEZONE
  const db = openDb(':memory:')
  const clock = new FixedClock(opts.now ?? TEST_NOW)
  const bus = new Bus()
  const events: ServerEvent[] = []
  bus.on('server_event', e => events.push(e))
  const outbox = new Outbox(db, clock, bus)
  const config = testConfig({ familyTimezone: timezone })
  const domain = createDomain({ db, clock, bus, outbox, config })
  const family = domain.ensureFamily(config.familyName, timezone)
  const husband = domain.createMember({ name: HUSBAND.name, aliases: [...HUSBAND.aliases], role: 'adult' })
  const wife = domain.createMember({ name: WIFE.name, aliases: [...WIFE.aliases], role: 'adult' })
  events.length = 0
  return {
    db,
    clock,
    bus,
    outbox,
    domain,
    config,
    family,
    husband,
    wife,
    events,
    as: member => ({ type: 'member', memberId: member.id }),
    asAi: (member, utteranceId) => ({ type: 'ai', memberId: member.id, utteranceId }),
  }
}
