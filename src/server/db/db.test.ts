import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from './db'
import { SCHEMA_SQL } from './schema'

const columns = (db: Database.Database, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name)

describe('openDb migrations', () => {
  it('adds utterances.visibility to a database created before the private chat; what was said stays in the family chat', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'family-share-db-')), 'family.db')
    // the schema as it was: no visibility column
    const oldSchema = SCHEMA_SQL.replace(/^\s*visibility\s+TEXT[^\n]*\n/m, '')
    expect(oldSchema).not.toContain('visibility')
    const old = new Database(path)
    old.exec(oldSchema)
    expect(columns(old, 'utterances')).not.toContain('visibility')
    old.prepare(`INSERT INTO members (id, name, role, created_at) VALUES ('m_1', '老婆', 'adult', '2026-10-01T00:00:00.000Z')`).run()
    old
      .prepare(`INSERT INTO utterances (id, member_id, source, text, status, created_at) VALUES ('u_old', 'm_1', 'text', '周六去公园', 'done', '2026-10-01T00:00:00.000Z')`)
      .run()
    old.close()

    const db = openDb(path)
    expect(columns(db, 'utterances')).toContain('visibility')
    expect(db.prepare(`SELECT visibility FROM utterances WHERE id = 'u_old'`).get()).toEqual({ visibility: 'family' })
    // the constraint came with it
    expect(() =>
      db
        .prepare(`INSERT INTO utterances (id, member_id, source, visibility, text, status, created_at) VALUES ('u_bad', 'm_1', 'text', 'everyone', 'x', 'done', '2026-10-01T00:00:00.000Z')`)
        .run(),
    ).toThrow(/CHECK/)
    db.close()

    // opening again (every server start) changes nothing
    const again = openDb(path)
    expect(columns(again, 'utterances').filter(c => c === 'visibility')).toHaveLength(1)
    again.close()
  })

  it('a fresh database has the column from the start', () => {
    const db = openDb(':memory:')
    expect(columns(db, 'utterances')).toContain('visibility')
    db.close()
  })
})
