import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { testConfig } from '../config'
import type { AppContext } from '../context'
import type { DeliveryResult } from '../notify/types'
import type { ScheduledNotification } from '../../shared/types'
import { openDb } from '../db/db'
import { createSession, findSession, redeemInvite } from '../http/auth'
import { FakeNotifier, FakeScheduler, FakeInterpreter } from '../http/testkit'
import { createTestContext } from '../testing'
import { FixedClock } from '../time'
import { parseArgs, splitList } from './args'
import { isMainModule } from './main'
import { findMember, runCli } from './commands'

describe('parseArgs', () => {
  it('parses commands, --flag value, --flag=value, booleans and positionals', () => {
    expect(parseArgs(['add', '--name', '老婆', '--aliases=她,媳妇', '--role', 'adult'])).toEqual({
      command: 'add',
      flags: { name: '老婆', aliases: '她,媳妇', role: 'adult' },
      positionals: [],
    })
    expect(parseArgs(['list', 'extra', '--verbose', '-h'])).toEqual({ command: 'list', flags: { verbose: true, help: true }, positionals: ['extra'] })
    expect(parseArgs([])).toEqual({ command: null, flags: {}, positionals: [] })
    expect(parseArgs(['init', '--name', '--timezone', 'UTC']).flags).toEqual({ name: true, timezone: 'UTC' })
    expect(parseArgs(['x', '--', '--not-a-flag']).positionals).toEqual(['--not-a-flag'])
  })

  it('splits alias lists on ASCII/full-width commas and 、', () => {
    expect(splitList('她,媳妇，孩子妈、 老婆 ;x')).toEqual(['她', '媳妇', '孩子妈', '老婆', 'x'])
    expect(splitList(undefined)).toEqual([])
  })
})

function cli(opts: { now?: string } = {}) {
  const db = openDb(':memory:')
  const clock = new FixedClock(opts.now ?? '2026-10-21T01:00:00.000Z')
  const config = testConfig({ publicUrl: 'https://family.test', familyTimezone: 'Australia/Sydney' })
  const out: string[] = []
  const err: string[] = []
  const run = (...argv: string[]) => runCli(argv, { config, db, clock, out: l => out.push(l), err: l => err.push(l) })
  return { db, clock, config, out, err, run }
}

describe('family CLI', () => {
  it('init creates the family, then updates name and timezone', async () => {
    const c = cli()
    expect(await c.run('init', '--name', '王家', '--timezone', 'Australia/Melbourne')).toBe(0)
    expect(c.db.prepare('SELECT name, timezone FROM family').get()).toEqual({ name: '王家', timezone: 'Australia/Melbourne' })
    expect(await c.run('init', '--timezone', 'Asia/Singapore', '--name', '我们家')).toBe(0)
    expect(c.db.prepare('SELECT name, timezone FROM family').get()).toEqual({ name: '我们家', timezone: 'Asia/Singapore' })
    expect(await c.run('init', '--timezone', 'Mars/Olympus')).toBe(1)
    expect(c.err.join('\n')).toContain('invalid --timezone')
  })

  it('add prints a working invite URL; invite and revoke by name', async () => {
    const c = cli()
    expect(await c.run('add', '--name', '老婆', '--aliases', '她,媳妇')).toBe(0)
    const line = c.out.find(l => l.includes('/join#token='))!.trim()
    expect(line).toMatch(/^https:\/\/family\.test\/join#token=[A-Za-z0-9_-]{40,}$/)
    const token = line.split('#token=')[1]!
    const r = redeemInvite(c.db, c.clock, token)
    expect(r.ok).toBe(true)
    const member = c.db.prepare('SELECT id, name, aliases, role FROM members').get() as { id: string; name: string; aliases: string; role: string }
    expect(member).toMatchObject({ name: '老婆', aliases: '["她","媳妇"]', role: 'adult' })

    c.out.length = 0
    expect(await c.run('invite', '--member', '媳妇')).toBe(0) // alias works too
    expect(c.out.some(l => l.includes('/join#token='))).toBe(true)

    const raw = createSession(c.db, c.clock, member.id, null)
    expect(await c.run('revoke', '--member', member.id)).toBe(0)
    expect(findSession(c.db, c.clock, raw)).toBeNull()
    expect(redeemInvite(c.db, c.clock, token)).toEqual({ ok: false, reason: 'revoked' })

    expect(await c.run('add', '--name', '小明', '--role', 'baby')).toBe(1)
    expect(await c.run('add')).toBe(1)
    expect(await c.run('invite', '--member', '没有这个人')).toBe(1)
    expect(c.err.join('\n')).toContain('no member')
  })

  it('list shows the family and members', async () => {
    const c = cli()
    await c.run('add', '--name', '老公')
    await c.run('add', '--name', '外婆', '--role', 'relative')
    c.out.length = 0
    expect(await c.run('list')).toBe(0)
    expect(c.out[0]).toContain('Australia/Sydney')
    expect(c.out.some(l => l.includes('老公') && l.includes('adult'))).toBe(true)
    expect(c.out.some(l => l.includes('外婆') && l.includes('relative'))).toBe(true)
  })

  it('vapid prints an env-ready key pair', async () => {
    const c = cli()
    expect(await c.run('vapid')).toBe(0)
    expect(c.out.find(l => l.startsWith('VAPID_PUBLIC_KEY='))).toMatch(/^VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{80,}$/)
    expect(c.out.find(l => l.startsWith('VAPID_PRIVATE_KEY='))).toMatch(/^VAPID_PRIVATE_KEY=[A-Za-z0-9_-]{40,}$/)
  })

  it('test-notify reports a member without devices', async () => {
    const t = createTestContext()
    const scheduler = new FakeScheduler(t)
    const ctx: AppContext = {
      config: t.config,
      db: t.db,
      clock: t.clock,
      bus: t.bus,
      outbox: t.outbox,
      domain: t.domain,
      interpreter: new FakeInterpreter(t),
      stt: null,
      notifier: new FakeNotifier(t),
      scheduler,
    }
    const out: string[] = []
    const code = await runCli(['test-notify', '--member', '老婆'], {
      config: t.config,
      db: t.db,
      out: l => out.push(l),
      err: l => out.push(l),
      buildContext: () => ctx,
    })
    expect(code).toBe(0)
    expect(scheduler.ticks).toBe(0)
    expect(out.join('\n')).toContain('status skipped, reached 0 device(s)')
    expect(t.db.prepare(`SELECT member_id, status, last_error FROM notifications WHERE kind = 'test'`).get()).toEqual({
      member_id: t.wife.id,
      status: 'skipped',
      last_error: 'no_channels',
    })
  })

  it('test-notify delivers only its own notification and never runs a scheduler tick in the CLI process', async () => {
    // The server may be running against the same database: a tick here would deliver every due row a second
    // time (there is no cross-process claim) and run the generators concurrently with the server's scheduler.
    const t = createTestContext()
    t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '倒垃圾' }) // request_new due now
    const scheduler = new FakeScheduler(t)
    const seenStatus: string[] = []
    const notifier = new (class extends FakeNotifier {
      override async deliver(n: ScheduledNotification): Promise<DeliveryResult[]> {
        seenStatus.push(t.outbox.get(n.id)!.status)
        const results = [
          { channel: 'webpush', ok: true },
          { channel: 'webpush', ok: false, error: '410 Gone', permanent: true },
        ]
        for (const r of results) t.outbox.recordDelivery(n.id, r.channel, r.ok, r.error)
        return results
      }
    })(t)
    const ctx: AppContext = {
      config: t.config,
      db: t.db,
      clock: t.clock,
      bus: t.bus,
      outbox: t.outbox,
      domain: t.domain,
      interpreter: new FakeInterpreter(t),
      stt: null,
      notifier,
      scheduler,
    }
    const out: string[] = []
    const code = await runCli(['test-notify', '--member', '老婆'], { config: t.config, db: t.db, out: l => out.push(l), err: l => out.push(l), buildContext: () => ctx })
    expect(code).toBe(0)
    expect(scheduler.ticks).toBe(0)
    expect(out.join('\n')).toContain('reached 1 device(s)')
    const rows = t.db.prepare('SELECT kind, status FROM notifications ORDER BY kind').all()
    expect(rows).toEqual([
      { kind: 'request_followup', status: 'scheduled' },
      { kind: 'request_new', status: 'scheduled' }, // left for the server's scheduler
      { kind: 'request_noreply', status: 'scheduled' },
      { kind: 'test', status: 'sent' },
    ])
    // the row was never claimable by another process's scheduler while this one delivered it
    expect(seenStatus).toEqual(['cancelled'])
  })

  it('help and unknown commands', async () => {
    const c = cli()
    expect(await c.run()).toBe(0)
    expect(c.out.join('\n')).toContain('npm run family')
    expect(await c.run('frobnicate')).toBe(1)
  })

  it('findMember matches id, name and alias', () => {
    const t = createTestContext()
    const members = t.domain.listMembers()
    expect(findMember(members, t.wife.id)?.name).toBe('老婆')
    expect(findMember(members, '老公')?.id).toBe(t.husband.id)
    expect(findMember(members, '孩子妈')?.id).toBe(t.wife.id)
    expect(findMember(members, 'nobody')).toBeNull()
  })
})

describe('CLI entry guard', () => {
  it('recognises the entry file when it is reached through a symlinked directory', () => {
    // Node resolves symlinks for import.meta.url but process.argv[1] keeps the path as typed; a mismatch made the
    // CLI exit 0 without doing anything (e.g. a checkout under a symlinked folder, or /tmp → /private/tmp on macOS).
    const root = mkdtempSync(join(tmpdir(), 'family-share-cli-'))
    mkdirSync(join(root, 'real'))
    const file = join(root, 'real', 'family.js')
    writeFileSync(file, '')
    symlinkSync(join(root, 'real'), join(root, 'link'))
    const metaUrl = pathToFileURL(file).href
    expect(isMainModule(join(root, 'link', 'family.js'), metaUrl)).toBe(true)
    expect(isMainModule(file, metaUrl)).toBe(true)
    expect(isMainModule(join(root, 'real', 'other.js'), metaUrl)).toBe(false)
    expect(isMainModule(undefined, metaUrl)).toBe(false)
  })
})
