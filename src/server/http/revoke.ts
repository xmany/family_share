// Revoking a member's access (`npm run family -- revoke`, lost phone). Signing the phone's sessions out is not enough:
// the phone also holds the member's WeChat binding (texts to the test account act as them, and their reminders arrive
// there with signed links), web push subscriptions (reminder text on the lock screen), signed /t/ links valid for 72 h,
// maybe an unused WeChat bind code, and whoever has it may have minted invites for other members or added new members
// (POST /api/members) and kept their invite links.

import type { Db } from '../db/db'
import type { Clock } from '../time'
import { DAY } from '../time'
import { revokeLinkTokens } from '../tokens'
import { cancelBindCodes, unbindWechat } from '../wechat/store'
import { revokeInvites, revokeSessions } from './auth'

/** How far back revoke lists the invites the member created for others. */
export const CREATED_INVITES_LOOKBACK_MS = 30 * DAY

export interface CreatedInvite {
  /** the member the invite is for */
  memberId: string
  createdAt: string
  useCount: number
  /** it could still be used, so revoke cancelled it */
  cancelled: boolean
}

export interface RevokeReport {
  sessions: number
  /** the member's own invite links cancelled */
  invites: number
  pushDevices: number
  wechatUnbound: boolean
  bindCodes: number
  /** invites this member created for other members in the last 30 days, oldest first (open ones are cancelled) */
  createdInvites: CreatedInvite[]
}

/**
 * Cuts every way in that a member's lost phone has: sessions, the member's own invites and the invites they created
 * for anyone, push subscriptions, the WeChat binding and unused bind codes, and the signed links already sent.
 * After this the member needs a new invite, and binds WeChat and turns on notifications again on the new phone.
 */
export function revokeMemberAccess(db: Db, clock: Clock, memberId: string): RevokeReport {
  const now = clock.now()
  const nowIso = now.toISOString()
  const sinceIso = new Date(now.getTime() - CREATED_INVITES_LOOKBACK_MS).toISOString()
  return db.transaction((): RevokeReport => {
    const sessions = revokeSessions(db, clock, memberId)
    const invites = revokeInvites(db, clock, memberId)
    const rows = db
      .prepare(
        `SELECT member_id, created_at, use_count, expires_at, revoked_at FROM invites
         WHERE created_by = ? AND member_id != ? AND created_at >= ? ORDER BY created_at, rowid`,
      )
      .all(memberId, memberId, sinceIso) as { member_id: string; created_at: string; use_count: number; expires_at: string; revoked_at: string | null }[]
    db.prepare('UPDATE invites SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL AND expires_at > ?').run(nowIso, memberId, nowIso)
    const pushDevices = db.prepare('DELETE FROM push_subscriptions WHERE member_id = ?').run(memberId).changes
    const wechatUnbound = unbindWechat(db, memberId, now)
    const bindCodes = cancelBindCodes(db, memberId)
    revokeLinkTokens(db, memberId, now)
    return {
      sessions,
      invites,
      pushDevices,
      wechatUnbound,
      bindCodes,
      createdInvites: rows.map(r => ({
        memberId: r.member_id,
        createdAt: r.created_at,
        useCount: r.use_count,
        cancelled: !r.revoked_at && r.expires_at > nowIso,
      })),
    }
  })()
}
