import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Db } from './db/db'
import { newSecret } from './ids'

/** Server-wide HMAC secret, generated on first run and kept in the kv table. */
export function getOrCreateAppSecret(db: Db): string {
  const row = db.prepare(`SELECT value FROM kv WHERE key = 'app_secret'`).get() as { value: string } | undefined
  if (row) return row.value
  const secret = newSecret()
  db.prepare(`INSERT OR IGNORE INTO kv (key, value) VALUES ('app_secret', ?)`).run(secret)
  return (db.prepare(`SELECT value FROM kv WHERE key = 'app_secret'`).get() as { value: string }).value
}

/**
 * Short-lived link token for opening one item without a session (WeChat links open in WeChat's
 * in-app browser, which has no session cookie). Grants only the listed actions on one item for one member.
 */
export interface LinkTokenPayload {
  /** item id */
  i: string
  /** member id the link was sent to */
  m: string
  /** allowed actions */
  a: Array<'view' | 'accept' | 'decline' | 'done'>
  /** expiry, unix seconds */
  e: number
  /**
   * issued at, unix seconds. Links minted before a member's links were revoked (`npm run family -- revoke`, lost
   * phone) stop working; a token without it counts as issued before any revoke.
   */
  t?: number
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function signLinkToken(payload: LinkTokenPayload, secret: string): string {
  const body = b64(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(`link.${body}`).digest('base64url').slice(0, 22)
  return `${body}.${sig}`
}

/** Returns the payload when the signature is valid and not expired, else null. */
export function verifyLinkToken(token: string, secret: string, now: Date): LinkTokenPayload | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(`link.${body}`).digest('base64url').slice(0, 22)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkTokenPayload
    if (typeof p.i !== 'string' || typeof p.m !== 'string' || !Array.isArray(p.a) || typeof p.e !== 'number') return null
    if (p.t !== undefined && typeof p.t !== 'number') return null
    if (p.e * 1000 < now.getTime()) return null
    return p
  } catch {
    return null
  }
}

// Per-member link revocation. A signed link is a bearer token for 72 h (sent to WeChat, so it sits on the phone);
// revoking a member's access must end the ones already out there without rotating the app secret for everyone.
const linkCutoffKey = (memberId: string) => `link_cutoff:${memberId}`

/** Every link already issued to this member stops working (those issued from the next second on still work). */
export function revokeLinkTokens(db: Db, memberId: string, now: Date): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    linkCutoffKey(memberId),
    String(Math.floor(now.getTime() / 1000)),
  )
}

/** True when the token was issued to its member at or before their links were revoked (or has no issue time then). */
export function isLinkTokenRevoked(db: Db, p: LinkTokenPayload): boolean {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(linkCutoffKey(p.m)) as { value: string } | undefined
  if (!row) return false
  const cutoff = Number(row.value)
  // fail closed on a damaged row
  if (!Number.isFinite(cutoff)) return true
  return typeof p.t !== 'number' || p.t <= cutoff
}
