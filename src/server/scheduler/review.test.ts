// Reviewer regression tests for the scheduler (each failed before its fix).
import { describe, expect, it } from 'vitest'
import type { ChannelSetting } from '../../shared/api'
import type { ScheduledNotification } from '../../shared/types'
import type { DeliveryResult, Notifier } from '../notify/types'
import { createTestContext } from '../testing'
import type { TestContext } from '../testing'
import { zonedToUtc } from '../time'
import { createScheduler } from './scheduler'

const TZ = 'Australia/Sydney'
const at = (date: string, time: string) => zonedToUtc(date, time, TZ)
const OK: DeliveryResult[] = [{ channel: 'fake', ok: true }]

type Respond = (n: ScheduledNotification, call: number) => DeliveryResult[] | Promise<DeliveryResult[]>

function fakeNotifier(respond: Respond = () => OK): Notifier & { calls: ScheduledNotification[] } {
  const calls: ScheduledNotification[] = []
  return {
    calls,
    channels: () => ['fake'],
    async deliver(n) {
      calls.push(n)
      return respond(n, calls.length)
    },
    vapidPublicKey: () => null,
    savePushSubscription() {},
    removePushSubscription() {},
    pushSubscriptionCount: () => 0,
    getMemberChannels: (): ChannelSetting[] => [],
    setMemberChannels: (): ChannelSetting[] => [],
  }
}

function schedulerFor(t: TestContext, notifier: Notifier) {
  return createScheduler({ config: t.config, db: t.db, clock: t.clock, bus: t.bus, outbox: t.outbox, domain: t.domain, notifier })
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>(r => (release = r))
  return { promise, release }
}

function enqueueNow(t: TestContext, key: string) {
  return t.outbox.enqueue({
    memberId: t.wife.id,
    kind: 'explicit',
    title: '提醒：交水费',
    body: '今天',
    dedupeKey: key,
    respectQuietHours: false,
  })!
}

describe('scheduler review', () => {
  it('two schedulers on the same database (server + `family test-notify`) deliver a due row once', async () => {
    const t = createTestContext()
    const g = gate()
    const server = fakeNotifier(async () => {
      await g.promise
      return OK
    })
    const cli = fakeNotifier()
    const row = enqueueNow(t, 'x:1')
    const serverTick = schedulerFor(t, server).tick() // now waiting inside deliver()
    expect(server.calls).toHaveLength(1)
    await schedulerFor(t, cli).tick() // the CLI process ticks meanwhile
    g.release()
    await serverTick
    expect(server.calls.length + cli.calls.length).toBe(1)
    expect(t.outbox.get(row.id)!.status).toBe('sent')
  })

  it('a row claimed by a tick that died mid-send is picked up again later', async () => {
    const t = createTestContext()
    const row = enqueueNow(t, 'x:2')
    const hung = fakeNotifier(() => new Promise<DeliveryResult[]>(() => {})) // never settles (process killed)
    void schedulerFor(t, hung).tick()
    expect(hung.calls).toHaveLength(1)
    const next = fakeNotifier()
    const s2 = schedulerFor(t, next)
    await s2.tick()
    expect(next.calls).toHaveLength(0) // still claimed
    t.clock.advance(10 * 60_000)
    await s2.tick()
    expect(next.calls.map(c => c.id)).toEqual([row.id])
    expect(t.outbox.get(row.id)!.status).toBe('sent')
  })

  it('stop() during a tick stops after the in-flight row (the database is closed right after)', async () => {
    const t = createTestContext()
    const g = gate()
    const notifier = fakeNotifier(async (_n, call) => {
      if (call === 1) await g.promise
      return OK
    })
    const a = enqueueNow(t, 'x:a')
    const b = enqueueNow(t, 'x:b')
    const s = schedulerFor(t, notifier)
    const running = s.tick()
    s.stop()
    g.release()
    await running
    expect(notifier.calls).toHaveLength(1)
    const states = [t.outbox.get(a.id)!.status, t.outbox.get(b.id)!.status].sort()
    expect(states).toEqual(['scheduled', 'sent'])
    // after a restart the rest goes out
    await s.tick()
    expect(notifier.calls).toHaveLength(2)
  })

  it('an evening-before reminder pushed by quiet hours into the due morning is skipped, not sent as "明早"', async () => {
    const t = createTestContext()
    t.domain.updateMember(t.wife.id, { quietStart: '19:30', quietEnd: '07:30' })
    const item = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '带孩子去游泳', dueAt: at('2026-10-23', '08:00').toISOString() })
    const rows = t.outbox.scheduledForItem(item.id)
    const eve = rows.find(r => r.dedupeKey.startsWith('due_eve:'))!
    const soon = rows.find(r => r.dedupeKey.startsWith('due:'))!
    expect(eve.fireAt).toBe(at('2026-10-22', '20:00').toISOString())
    const notifier = fakeNotifier()
    const s = schedulerFor(t, notifier)

    t.clock.set(at('2026-10-22', '20:00'))
    await s.tick()
    expect(t.outbox.get(eve.id)).toMatchObject({ status: 'skipped', lastError: 'superseded' })

    t.clock.set(at('2026-10-23', '07:00'))
    await s.tick()
    t.clock.set(at('2026-10-23', '07:30'))
    await s.tick()
    expect(notifier.calls.filter(c => c.itemId === item.id).map(c => c.id)).toEqual([soon.id])
  })

  it('an evening-before reminder still goes out when quiet hours only push it later that evening', async () => {
    const t = createTestContext()
    t.domain.updateMember(t.wife.id, { quietStart: '19:30', quietEnd: '21:00' })
    const item = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '带孩子去游泳', dueAt: at('2026-10-23', '08:00').toISOString() })
    const eve = t.outbox.scheduledForItem(item.id).find(r => r.dedupeKey.startsWith('due_eve:'))!
    const notifier = fakeNotifier()
    const s = schedulerFor(t, notifier)
    t.clock.set(at('2026-10-22', '20:00'))
    await s.tick()
    expect(t.outbox.get(eve.id)).toMatchObject({ status: 'scheduled', fireAt: at('2026-10-22', '21:00').toISOString() })
    t.clock.set(at('2026-10-22', '21:00'))
    await s.tick()
    expect(notifier.calls.map(c => c.id)).toEqual([eve.id])
  })

  it('an evening-before reminder caught up after downtime on the due morning is skipped', async () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.wife), { kind: 'task', title: '带孩子去游泳', dueAt: at('2026-10-23', '09:30').toISOString() })
    const eve = t.outbox.scheduledForItem(item.id).find(r => r.dedupeKey.startsWith('due_eve:'))!
    const notifier = fakeNotifier()
    t.clock.set(at('2026-10-23', '07:45')) // server was down from Thursday afternoon (< 12 h late)
    await schedulerFor(t, notifier).tick()
    expect(t.outbox.get(eve.id)).toMatchObject({ status: 'skipped', lastError: 'superseded' })
    expect(notifier.calls.map(c => c.dedupeKey).some(k => k.startsWith('due_eve:'))).toBe(false)
  })
})

describe('scheduler review: quiet hours across DST', () => {
  it('a row deferred on the night clocks go forward (4 Oct 2026) lands at 07:30 local, AEDT', async () => {
    const t = createTestContext({ now: at('2026-10-03', '23:00').toISOString() })
    const row = t.outbox.enqueue({ memberId: t.wife.id, kind: 'explicit', title: '提醒', body: 'x', dedupeKey: 'dst:1', respectQuietHours: true })!
    await schedulerFor(t, fakeNotifier()).tick()
    expect(t.outbox.get(row.id)!.fireAt).toBe('2026-10-03T20:30:00.000Z') // 07:30 at UTC+11
  })

  it('a row deferred on the night clocks go back (5 Apr 2026) lands at 07:30 local, AEST', async () => {
    const t = createTestContext({ now: at('2026-04-04', '23:00').toISOString() })
    const row = t.outbox.enqueue({ memberId: t.wife.id, kind: 'explicit', title: '提醒', body: 'x', dedupeKey: 'dst:2', respectQuietHours: true })!
    await schedulerFor(t, fakeNotifier()).tick()
    expect(t.outbox.get(row.id)!.fireAt).toBe('2026-04-04T21:30:00.000Z') // 07:30 at UTC+10
  })
})
