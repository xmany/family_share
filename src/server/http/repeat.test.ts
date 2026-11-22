// Repeating items over HTTP: create / edit / skip routes, and 完成 taps from notifications and signed links that may
// arrive twice (retries, two devices) — they must complete one occurrence, never the next one too.
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/db'
import { SCHEMA_SQL } from '../db/schema'
import { zonedToUtc } from '../time'
import { getOrCreateAppSecret, signLinkToken } from '../tokens'
import { harness } from './testkit'

vi.mock('../wechat/index', () => ({
  handleWechatVerify: vi.fn(() => ({ status: 403, body: 'forbidden' })),
  handleWechatMessage: vi.fn(async () => ({ status: 200, body: '', contentType: 'text/plain' })),
  rejectUnsignedWechatCallback: vi.fn(() => ({ status: 403, body: 'invalid signature', contentType: 'text/plain; charset=utf-8' })),
  createWechatBindCode: vi.fn(),
  getWechatBinding: vi.fn(() => ({ bound: false, mode: 'fallback' })),
}))

// harness(): Wed 2026-10-21 12:00 Sydney; Sunday is 2026-10-25
const iso = (date: string, time: string) => zonedToUtc(date, time, 'Australia/Sydney').toISOString()

describe('repeating items over HTTP', () => {
  it('/api/me says the server keeps repeats', async () => {
    const h = harness()
    const r = await h.json('GET', '/api/me', { as: h.t.wife })
    expect(r.body.repeats).toBe(true)
  })

  it('creates, edits and skips', async () => {
    const h = harness()
    const as = h.t.husband
    let r = await h.json('POST', '/api/items', {
      as,
      body: { kind: 'task', title: '倒垃圾', dueAt: iso('2026-10-25', '21:00'), repeat: { freq: 'weekly' } },
    })
    expect(r.status).toBe(200)
    const id = r.body.item.id as string
    expect(r.body.item.repeat).toMatchObject({ freq: 'weekly', weekdays: [0], anchor: '2026-10-25' })

    r = await h.json('POST', `/api/items/${id}/skip`, { as, body: {} })
    expect(r.status).toBe(200)
    expect(r.body.item).toMatchObject({ status: 'open', dueAt: iso('2026-11-01', '21:00') })

    // every two weeks on Monday and Thursday from 11-02
    r = await h.json('PATCH', `/api/items/${id}`, {
      as,
      body: { dueAt: iso('2026-11-02', '21:00'), repeat: { freq: 'weekly', interval: 2, weekdays: [1, 4] } },
    })
    expect(r.body.item.repeat).toMatchObject({ interval: 2, weekdays: [1, 4], anchor: '2026-11-02' })
    r = await h.json('PATCH', `/api/items/${id}`, { as, body: { repeat: null } })
    expect(r.body.item.repeat).toBeNull()

    r = await h.json('POST', `/api/items/${id}/skip`, { as, body: {} })
    expect(r.status).toBe(400)
    r = await h.json('POST', '/api/items', { as, body: { kind: 'task', title: '浇花', repeat: { freq: 'daily' } } })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toMatch(/日期/)
    r = await h.json('POST', '/api/items', { as, body: { kind: 'task', title: '浇花', dueDate: '2026-10-22', repeat: { freq: 'hourly' } } })
    expect(r.status).toBe(400)
  })

  it('a 完成 tapped twice on the same notification completes one occurrence', async () => {
    const h = harness()
    const { husband } = h.t
    const item = h.t.domain.createItem(h.t.as(husband), { kind: 'task', title: '倒垃圾', dueAt: iso('2026-10-25', '21:00'), repeat: { freq: 'weekly' } })
    const ping = h.t.outbox.scheduledForItem(item.id).find(n => n.dedupeKey.startsWith('due:'))!
    h.t.clock.set(new Date(iso('2026-10-25', '20:00')))
    h.t.outbox.markSent(ping.id)
    h.t.clock.set(new Date(iso('2026-10-25', '20:05')))
    const tap = () => h.json('POST', `/api/notifications/${ping.id}/action`, { as: husband, body: { action: 'done' } })
    expect((await tap()).status).toBe(200)
    expect(h.t.domain.getItem(item.id)!.dueAt).toBe(iso('2026-11-01', '21:00'))
    expect((await tap()).status).toBe(200)
    expect(h.t.domain.getItem(item.id)!.dueAt).toBe(iso('2026-11-01', '21:00'))
    // next week's ping completes next week's occurrence
    const next = h.t.outbox.scheduledForItem(item.id).find(n => n.dedupeKey.startsWith('due:'))!
    h.t.clock.set(new Date(iso('2026-11-01', '20:00')))
    h.t.outbox.markSent(next.id)
    h.t.clock.set(new Date(iso('2026-11-01', '20:30')))
    expect((await h.json('POST', `/api/notifications/${next.id}/action`, { as: husband, body: { action: 'done' } })).status).toBe(200)
    expect(h.t.domain.getItem(item.id)!.dueAt).toBe(iso('2026-11-08', '21:00'))
  })

  it('a signed link completes one occurrence, however often it is tapped', async () => {
    const h = harness()
    const { wife } = h.t
    const item = h.t.domain.createItem(h.t.as(wife), { kind: 'reminder', title: '吃药', dueAt: iso('2026-10-22', '08:00'), repeat: { freq: 'daily' } })
    const now = Math.floor(h.t.clock.now().getTime() / 1000)
    const token = signLinkToken({ i: item.id, m: wife.id, a: ['view', 'done'], e: now + 72 * 3600, t: now }, getOrCreateAppSecret(h.t.db))
    h.t.clock.set(new Date(iso('2026-10-22', '08:01')))
    let r = await h.json('POST', `/api/t/${token}/action`, { body: { action: 'done' } })
    expect(r.status).toBe(200)
    expect(r.body.item).toMatchObject({ status: 'open', dueAt: iso('2026-10-23', '08:00') })
    r = await h.json('POST', `/api/t/${token}/action`, { body: { action: 'done' } })
    expect(r.body.item.dueAt).toBe(iso('2026-10-23', '08:00'))
  })
})

describe('openDb migration', () => {
  it('adds items.repeat to a database from before repeating items; existing items do not repeat', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'family-share-db-')), 'family.db')
    const oldSchema = SCHEMA_SQL.replace(/^\s*repeat\s+TEXT[^\n]*\n/m, '')
    expect(oldSchema).not.toMatch(/^\s*repeat\s/m)
    const old = new Database(path)
    old.exec(oldSchema)
    old.prepare(`INSERT INTO members (id, name, role, created_at) VALUES ('m_1', '老婆', 'adult', '2026-10-01T00:00:00.000Z')`).run()
    old
      .prepare(
        `INSERT INTO items (id, kind, title, status, owner_id, created_by, created_at, updated_at, last_activity_at)
         VALUES ('i_old', 'task', '买地毯', 'open', 'm_1', 'm_1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      )
      .run()
    old.close()
    const db = openDb(path)
    expect(db.prepare(`SELECT repeat FROM items WHERE id = 'i_old'`).get()).toEqual({ repeat: null })
    db.close()
    openDb(path).close() // opening again changes nothing
  })
})
