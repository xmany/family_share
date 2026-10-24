// Invites and sessions (SPEC §5). Raw secrets are never stored: both tables key on sha256 hex.
//
// Invites: `${PUBLIC_URL}/join#token=<secret>`, valid 7 days, reusable up to 5 times (an iPhone's
// home-screen app does not share Safari's cookies, so a person may need to join twice), revocable,
// and only ever consumed by POST /api/auth/join — never by a GET (WeChat link previews fetch URLs).
//
// Sessions: cookie `fs_session` (httpOnly, SameSite=Lax, Secure on https, Max-Age 400 days). The
// cookie is re-issued when last_seen_at is refreshed, so a phone in regular use never gets logged out.

import type { Db } from '../db/db'
import { newSecret, sha256Hex } from '../ids'
import type { Clock } from '../time'
import { DAY, MINUTE } from '../time'

export const SESSION_COOKIE = 'fs_session'
export const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60
export const SESSION_TTL_MS = SESSION_MAX_AGE_S * 1000
export const INVITE_TTL_MS = 7 * DAY
export const INVITE_MAX_USES = 5
/** last_seen_at is written at most this often per session */
export const LAST_SEEN_INTERVAL_MS = 5 * MINUTE

export function inviteUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/join#token=${token}`
}

export interface InviteInfo {
  token: string
  inviteUrl: string
  expiresAt: string
}

export function createInvite(db: Db, clock: Clock, publicUrl: string, memberId: string, createdBy: string | null): InviteInfo {
  const token = newSecret()
  const now = clock.now()
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString()
  db.prepare(
    `INSERT INTO invites (token_hash, member_id, created_by, created_at, expires_at, use_count) VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(sha256Hex(token), memberId, createdBy, now.toISOString(), expiresAt)
  return { token, inviteUrl: inviteUrl(publicUrl, token), expiresAt }
}

export type InviteProblem = 'unknown' | 'expired' | 'revoked' | 'used_up'
export type RedeemResult = { ok: true; memberId: string } | { ok: false; reason: InviteProblem }

interface InviteRow {
  token_hash: string
  member_id: string
  expires_at: string
  use_count: number
  revoked_at: string | null
}

/** Counts one use of an invite (atomically) and returns its member, or why it can't be used. */
export function redeemInvite(db: Db, clock: Clock, token: string): RedeemResult {
  const hash = sha256Hex(token)
  const nowIso = clock.now().toISOString()
  return db.transaction((): RedeemResult => {
    const row = db.prepare('SELECT token_hash, member_id, expires_at, use_count, revoked_at FROM invites WHERE token_hash = ?').get(hash) as
      | InviteRow
      | undefined
    if (!row) return { ok: false, reason: 'unknown' }
    if (row.revoked_at) return { ok: false, reason: 'revoked' }
    if (row.expires_at <= nowIso) return { ok: false, reason: 'expired' }
    if (row.use_count >= INVITE_MAX_USES) return { ok: false, reason: 'used_up' }
    const res = db
      .prepare(
        `UPDATE invites SET use_count = use_count + 1, used_at = COALESCE(used_at, ?)
         WHERE token_hash = ? AND use_count < ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(nowIso, hash, INVITE_MAX_USES, nowIso)
    if (res.changes === 0) return { ok: false, reason: 'used_up' }
    return { ok: true, memberId: row.member_id }
  })()
}

export const INVITE_PROBLEM_ZH: Record<InviteProblem, string> = {
  unknown: '这个邀请链接无效，请让家人重新生成一个',
  expired: '这个邀请链接已过期，请让家人重新生成一个',
  revoked: '这个邀请链接已作废，请让家人重新生成一个',
  used_up: '这个邀请链接已经用过太多次了，请让家人重新生成一个',
}

/** Revokes every unexpired invite of a member. Returns how many. */
export function revokeInvites(db: Db, clock: Clock, memberId: string): number {
  const nowIso = clock.now().toISOString()
  return db.prepare('UPDATE invites SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL AND expires_at > ?').run(nowIso, memberId, nowIso).changes
}

/** Creates a session and returns the raw cookie value. */
export function createSession(db: Db, clock: Clock, memberId: string, userAgent: string | null): string {
  const secret = newSecret()
  const nowIso = clock.now().toISOString()
  db.prepare('INSERT INTO sessions (token_hash, member_id, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256Hex(secret),
    memberId,
    userAgent ? userAgent.slice(0, 300) : null,
    nowIso,
    nowIso,
  )
  return secret
}

export interface SessionInfo {
  tokenHash: string
  memberId: string
  lastSeenAt: string
}

/** The live session for a cookie value, or null (unknown, revoked, or unused for 400 days). */
export function findSession(db: Db, clock: Clock, rawToken: string | undefined | null): SessionInfo | null {
  if (!rawToken || rawToken.length > 200) return null
  const row = db
    .prepare('SELECT token_hash, member_id, last_seen_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL')
    .get(sha256Hex(rawToken)) as { token_hash: string; member_id: string; last_seen_at: string } | undefined
  if (!row) return null
  if (new Date(row.last_seen_at).getTime() + SESSION_TTL_MS <= clock.now().getTime()) return null
  return { tokenHash: row.token_hash, memberId: row.member_id, lastSeenAt: row.last_seen_at }
}

/** Updates last_seen_at when it is older than 5 minutes. Returns true when it wrote. */
export function touchSession(db: Db, clock: Clock, s: SessionInfo): boolean {
  const now = clock.now()
  if (now.getTime() - new Date(s.lastSeenAt).getTime() < LAST_SEEN_INTERVAL_MS) return false
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now.toISOString(), s.tokenHash)
  return true
}

export function revokeSession(db: Db, clock: Clock, tokenHash: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(clock.now().toISOString(), tokenHash)
}

/** Signs a member out everywhere (lost phone). Returns how many sessions were revoked. */
export function revokeSessions(db: Db, clock: Clock, memberId: string): number {
  return db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL')
    .run(clock.now().toISOString(), memberId).changes
}

/** Active sessions per member (for the CLI list). */
export function sessionCounts(db: Db): Map<string, number> {
  const rows = db.prepare('SELECT member_id, COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL GROUP BY member_id').all() as {
    member_id: string
    n: number
  }[]
  return new Map(rows.map(r => [r.member_id, r.n]))
}
