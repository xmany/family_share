// Per-member channel rows (table member_channels). Generic storage only; the WeChat binding helpers on top of it
// live in ../wechat/store.ts, the routing decisions in notifier.ts.

import type { Db } from '../db/db'
import { parseJson } from '../db/db'

export interface MemberChannelRow {
  memberId: string
  channel: string
  enabled: boolean
  config: Record<string, unknown>
  updatedAt: string
}

interface Row {
  member_id: string
  channel: string
  enabled: number
  config: string
  updated_at: string
}

function toRow(r: Row): MemberChannelRow {
  const config = parseJson<unknown>(r.config, {})
  return {
    memberId: r.member_id,
    channel: r.channel,
    enabled: r.enabled === 1,
    config: config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {},
    updatedAt: r.updated_at,
  }
}

export function readMemberChannel(db: Db, memberId: string, channel: string): MemberChannelRow | null {
  const r = db.prepare('SELECT * FROM member_channels WHERE member_id = ? AND channel = ?').get(memberId, channel) as Row | undefined
  return r ? toRow(r) : null
}

/** All rows of one channel (a family has a handful of members, so callers filter in JS). */
export function listChannelRows(db: Db, channel: string): MemberChannelRow[] {
  return (db.prepare('SELECT * FROM member_channels WHERE channel = ? ORDER BY member_id').all(channel) as Row[]).map(toRow)
}

/** Insert or replace the row for (member, channel). */
export function writeMemberChannel(
  db: Db,
  memberId: string,
  channel: string,
  enabled: boolean,
  config: Record<string, unknown>,
  now: Date,
): void {
  db.prepare(
    `INSERT INTO member_channels (member_id, channel, enabled, config, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(member_id, channel) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at`,
  ).run(memberId, channel, enabled ? 1 : 0, JSON.stringify(config), now.toISOString())
}

/** A channel is enabled for a member unless a row says otherwise. */
export function isChannelEnabled(db: Db, memberId: string, channel: string): boolean {
  return readMemberChannel(db, memberId, channel)?.enabled ?? true
}
