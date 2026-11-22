import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL } from './schema'

export type Db = Database.Database

/** Opens (and migrates) the SQLite database. Use ':memory:' in tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA_SQL)
  migrate(db)
  // Family data: readable by the server's user only (db + WAL/SHM files).
  if (path !== ':memory:') {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600)
  }
  return db
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some(c => c.name === column)
}

/** Brings a database created by an older version up to SCHEMA_SQL. Every step is safe to run again. */
function migrate(db: Db): void {
  // private chat with the assistant: existing utterances were all said in the family chat
  addColumn(db, 'utterances', 'visibility', `TEXT NOT NULL DEFAULT 'family' CHECK (visibility IN ('family', 'private'))`)
  // repeating items: existing items do not repeat
  addColumn(db, 'items', 'repeat', 'TEXT')
}

function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  } catch (e) {
    // the server and `npm run family` can open an old database at the same moment: the other one added it first
    if (!hasColumn(db, table, column)) throw e
  }
}

/** Parses a JSON column, falling back when null/invalid. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
