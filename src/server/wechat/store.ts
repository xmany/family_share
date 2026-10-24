// WeChat persistence: the member <-> openid binding (member_channels row 'wechat', config { openid, mode }),
// one-time bind codes (bind_codes) and inbound message dedupe (wechat_inbound).
// The raw openid never leaves this module except to the template sender.

import { randomInt } from 'node:crypto'
import type { Db } from '../db/db'
import { parseJson } from '../db/db'
import { listChannelRows, readMemberChannel, writeMemberChannel } from '../notify/memberChannels'
import type { WechatMode } from '../../shared/types'
import { DAY, HOUR, MINUTE } from '../time'

export const WECHAT_CHANNEL = 'wechat'
export const WECHAT_MODES: readonly WechatMode[] = ['fallback', 'both', 'only', 'off']
export const DEFAULT_WECHAT_MODE: WechatMode = 'fallback'
export const BIND_CODE_TTL_MS = 30 * MINUTE
/** Failed "绑定 xxxxxx" attempts allowed per openid per hour (6-digit codes must not be guessable). */
export const BIND_MAX_FAILURES_PER_HOUR = 5

export function isWechatMode(v: unknown): v is WechatMode {
  return typeof v === 'string' && (WECHAT_MODES as readonly string[]).includes(v)
}

export interface WechatBindingState {
  openid: string | null
  mode: WechatMode
  enabled: boolean
}

export function readWechatBinding(db: Db, memberId: string): WechatBindingState {
  const row = readMemberChannel(db, memberId, WECHAT_CHANNEL)
  const openid = typeof row?.config.openid === 'string' && row.config.openid !== '' ? row.config.openid : null
  const mode = isWechatMode(row?.config.mode) ? row.config.mode : DEFAULT_WECHAT_MODE
  return { openid, mode, enabled: row?.enabled ?? true }
}

function writeBinding(db: Db, memberId: string, state: WechatBindingState, now: Date): void {
  const config: Record<string, unknown> = { mode: state.mode }
  if (state.openid) config.openid = state.openid
  writeMemberChannel(db, memberId, WECHAT_CHANNEL, state.enabled, config, now)
}

/** The member bound to this openid, if any. */
export function findMemberIdByOpenid(db: Db, openid: string): string | null {
  for (const r of listChannelRows(db, WECHAT_CHANNEL)) if (r.config.openid === openid) return r.memberId
  return null
}

/**
 * Binds the openid to the member (keeping their mode; re-enabling the channel). Any other member bound to the same
 * openid is unbound first: one WeChat account reaches one family member. Returns the members that lost the binding.
 */
export function bindWechatOpenid(db: Db, memberId: string, openid: string, now: Date): string[] {
  return db.transaction(() => {
    const unbound: string[] = []
    for (const r of listChannelRows(db, WECHAT_CHANNEL)) {
      if (r.memberId !== memberId && r.config.openid === openid) {
        writeBinding(db, r.memberId, { ...readWechatBinding(db, r.memberId), openid: null }, now)
        unbound.push(r.memberId)
      }
    }
    const current = readWechatBinding(db, memberId)
    writeBinding(db, memberId, { ...current, openid, enabled: true }, now)
    return unbound
  })()
}

/** Removes the member's openid (mode and enabled are kept). Returns true when something was bound. */
export function unbindWechat(db: Db, memberId: string, now: Date): boolean {
  const current = readWechatBinding(db, memberId)
  if (!current.openid) return false
  writeBinding(db, memberId, { ...current, openid: null }, now)
  return true
}

/** Unbinds whoever holds this openid (e.g. on an `unsubscribe` event). Returns the member ids unbound. */
export function unbindWechatOpenid(db: Db, openid: string, now: Date): string[] {
  const ids = listChannelRows(db, WECHAT_CHANNEL)
    .filter(r => r.config.openid === openid)
    .map(r => r.memberId)
  for (const id of ids) unbindWechat(db, id, now)
  return ids
}

/** Changes only mode / enabled; the openid is untouched (binding goes through the bind flow). */
export function setWechatPreferences(db: Db, memberId: string, prefs: { mode?: WechatMode; enabled?: boolean }, now: Date): void {
  const current = readWechatBinding(db, memberId)
  writeBinding(
    db,
    memberId,
    { openid: current.openid, mode: prefs.mode ?? current.mode, enabled: prefs.enabled ?? current.enabled },
    now,
  )
}

// ---------------------------------------------------------------------------------------------
// Bind codes

/** Creates a fresh 6-digit code (30 min, single use). The member's older unused codes stop working. */
export function createBindCode(db: Db, memberId: string, now: Date): { code: string; expiresAt: string } {
  return db.transaction(() => {
    const nowIso = now.toISOString()
    db.prepare(`DELETE FROM bind_codes WHERE expires_at < ?`).run(new Date(now.getTime() - DAY).toISOString())
    db.prepare(`DELETE FROM bind_codes WHERE member_id = ? AND channel = ? AND used_at IS NULL`).run(memberId, WECHAT_CHANNEL)
    const expiresAt = new Date(now.getTime() + BIND_CODE_TTL_MS).toISOString()
    const insert = db.prepare(
      `INSERT OR IGNORE INTO bind_codes (code, member_id, channel, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    for (let i = 0; i < 50; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      if (insert.run(code, memberId, WECHAT_CHANNEL, nowIso, expiresAt).changes === 1) return { code, expiresAt }
    }
    throw new Error('could not allocate a bind code')
  })()
}

/** Consumes a code: returns the member id when the code exists, is unused and not expired (and marks it used). */
export function consumeBindCode(db: Db, code: string, now: Date): string | null {
  return db.transaction(() => {
    const r = db
      .prepare(`SELECT member_id FROM bind_codes WHERE code = ? AND channel = ? AND used_at IS NULL AND expires_at > ?`)
      .get(code, WECHAT_CHANNEL, now.toISOString()) as { member_id: string } | undefined
    if (!r) return null
    db.prepare(`UPDATE bind_codes SET used_at = ? WHERE code = ?`).run(now.toISOString(), code)
    return r.member_id
  })()
}

/** Drops the member's unused codes (revoke: a code fetched on a lost phone must not bind another WeChat). Returns how many. */
export function cancelBindCodes(db: Db, memberId: string): number {
  return db.prepare(`DELETE FROM bind_codes WHERE member_id = ? AND channel = ? AND used_at IS NULL`).run(memberId, WECHAT_CHANNEL).changes
}

interface FailureState {
  count: number
  since: string
}

const failureKey = (openid: string) => `wechat_bind_fail:${openid}`

/** True when this openid already used up its failed bind attempts for the current hour. */
export function bindAttemptsExhausted(db: Db, openid: string, now: Date): boolean {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(failureKey(openid)) as { value: string } | undefined
  const s = parseJson<FailureState | null>(r?.value, null)
  if (!s || now.getTime() - new Date(s.since).getTime() > HOUR) return false
  return s.count >= BIND_MAX_FAILURES_PER_HOUR
}

export function recordBindFailure(db: Db, openid: string, now: Date): void {
  const key = failureKey(openid)
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  const s = parseJson<FailureState | null>(r?.value, null)
  const fresh = !s || now.getTime() - new Date(s.since).getTime() > HOUR
  const next: FailureState = fresh ? { count: 1, since: now.toISOString() } : { count: s.count + 1, since: s.since }
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(next))
}

export function clearBindFailures(db: Db, openid: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(failureKey(openid))
}

// ---------------------------------------------------------------------------------------------
// Inbound dedupe (WeChat retries a callback up to 3 times when we are slow)

/** Records an inbound message key; false when it was already seen (a WeChat retry). */
export function recordInbound(db: Db, msgKey: string, openid: string, msgType: string, now: Date): boolean {
  db.prepare('DELETE FROM wechat_inbound WHERE created_at < ?').run(new Date(now.getTime() - 3 * DAY).toISOString())
  return (
    db
      .prepare('INSERT OR IGNORE INTO wechat_inbound (msg_id, openid, msg_type, created_at) VALUES (?, ?, ?, ?)')
      .run(msgKey, openid, msgType, now.toISOString()).changes === 1
  )
}
