// `revoke --member` (lost phone) must do more than sign the sessions out: see src/server/http/revoke.ts.

import { describe, expect, it } from 'vitest'
import { testConfig } from '../config'
import { openDb } from '../db/db'
import { createInvite, createSession, findSession, redeemInvite } from '../http/auth'
import { FixedClock } from '../time'
import { isLinkTokenRevoked } from '../tokens'
import { bindWechatOpenid, findMemberIdByOpenid } from '../wechat/store'
import { runCli } from './commands'

describe('family CLI revoke', () => {
  it('signs out, removes push devices, unbinds WeChat, cancels links and the invites the member created, and lists those', async () => {
    const db = openDb(':memory:')
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const config = testConfig({ publicUrl: 'https://family.test', familyTimezone: 'Pacific/Auckland' })
    const out: string[] = []
    const run = (...argv: string[]) => runCli(argv, { config, db, clock, out: l => out.push(l), err: l => out.push(l) })
    expect(await run('add', '--name', '老公')).toBe(0)
    expect(await run('add', '--name', '老婆')).toBe(0)
    const ids = new Map((db.prepare('SELECT id, name FROM members').all() as { id: string; name: string }[]).map(m => [m.name, m.id]))
    const husband = ids.get('老公')!
    const wife = ids.get('老婆')!

    const session = createSession(db, clock, husband, null)
    db.prepare(`INSERT INTO push_subscriptions (id, member_id, endpoint, p256dh, auth, created_at) VALUES ('ps1', ?, 'https://push.example/1', 'p', 'a', ?)`).run(
      husband,
      clock.now().toISOString(),
    )
    bindWechatOpenid(db, husband, 'o_husband', clock.now())
    // minted from the husband's phone
    const forWife = createInvite(db, clock, config.publicUrl, wife, husband)

    clock.advance(60_000)
    out.length = 0
    expect(await run('revoke', '--member', '老公')).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('1 session(s) signed out')
    expect(text).toContain('1 push device(s) removed')
    expect(text).toContain('WeChat unbound')
    expect(text).toMatch(new RegExp(`for 老婆 \\(${wife}\\)\\s+used 0x\\s+→ cancelled`))

    expect(findSession(db, clock, session)).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?').get(husband) as { n: number }).n).toBe(0)
    expect(findMemberIdByOpenid(db, 'o_husband')).toBeNull()
    expect(redeemInvite(db, clock, forWife.token)).toEqual({ ok: false, reason: 'revoked' })
    const sentAt = Math.floor(clock.now().getTime() / 1000) - 30
    expect(isLinkTokenRevoked(db, { i: 'i_x', m: husband, a: ['view'], e: sentAt + 3600, t: sentAt })).toBe(true)
    expect(isLinkTokenRevoked(db, { i: 'i_x', m: wife, a: ['view'], e: sentAt + 3600, t: sentAt })).toBe(false)
  })
})
