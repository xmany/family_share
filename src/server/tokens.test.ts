import { describe, expect, it } from 'vitest'
import { openDb } from './db/db'
import { getOrCreateAppSecret, isLinkTokenRevoked, revokeLinkTokens, signLinkToken, verifyLinkToken } from './tokens'

describe('link tokens', () => {
  const secret = 'test-secret'
  const now = new Date('2026-10-21T01:00:00.000Z')
  const payload = { i: 'i_abc', m: 'm_def', a: ['view', 'done'] as Array<'view' | 'done'>, e: now.getTime() / 1000 + 3600 }

  it('round-trips a valid token', () => {
    expect(verifyLinkToken(signLinkToken(payload, secret), secret, now)).toEqual(payload)
  })

  it('rejects tampering, wrong secret and expiry', () => {
    const t = signLinkToken(payload, secret)
    const [body, sig] = t.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ ...payload, a: ['view', 'done', 'accept'] })).toString('base64url')
    expect(verifyLinkToken(`${forged}.${sig}`, secret, now)).toBeNull()
    expect(verifyLinkToken(`${body}.x${sig.slice(1)}`, secret, now)).toBeNull()
    expect(verifyLinkToken(t, 'other', now)).toBeNull()
    expect(verifyLinkToken(t, secret, new Date(now.getTime() + 2 * 3600_000))).toBeNull()
    expect(verifyLinkToken('garbage', secret, now)).toBeNull()
  })

  it('revokes the links already issued to one member (lost phone), not later ones or other members’', () => {
    const db = openDb(':memory:')
    const s = now.getTime() / 1000
    const link = (m: string, t?: number) => ({ ...payload, m, ...(t === undefined ? {} : { t }) })
    expect(isLinkTokenRevoked(db, link('m_def', s))).toBe(false)
    revokeLinkTokens(db, 'm_def', now)
    expect(isLinkTokenRevoked(db, link('m_def', s - 60))).toBe(true)
    expect(isLinkTokenRevoked(db, link('m_def', s))).toBe(true) // same second as the revoke
    expect(isLinkTokenRevoked(db, link('m_def'))).toBe(true) // no issue time
    expect(isLinkTokenRevoked(db, link('m_def', s + 1))).toBe(false)
    expect(isLinkTokenRevoked(db, link('m_other', s - 60))).toBe(false)
    // a non-numeric issue time does not verify at all
    const bad = signLinkToken({ ...payload, t: 'x' } as unknown as typeof payload, secret)
    expect(verifyLinkToken(bad, secret, now)).toBeNull()
  })

  it('keeps one app secret per database', () => {
    const db = openDb(':memory:')
    const a = getOrCreateAppSecret(db)
    expect(getOrCreateAppSecret(db)).toBe(a)
    expect(a.length).toBeGreaterThan(30)
  })
})
