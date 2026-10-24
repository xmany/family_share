// Voice recordings in DATA_DIR/audio. The voice route keeps every upload as v_<id>.<ext> and stores its path in
// utterances.audio_path, but nothing reads a recording back once it is transcribed, so old ones can be deleted:
// `npm run family -- prune-audio`, which scripts/backup.sh runs every night when AUDIO_KEEP_DAYS is set.

import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Db } from './db/db'

const DAY_MS = 24 * 60 * 60 * 1000

export interface PruneResult {
  /** Recordings deleted (for a dry run: that would be deleted) */
  files: number
  bytes: number
}

/**
 * Deletes the server's recordings (v_*) in `audioDir` last written more than `olderThanDays` days before `now`.
 * Their utterances.audio_path is cleared first, so the database never points at a deleted file. Rows are matched
 * by file name, which still works after the project folder has moved. The transcripts are kept.
 */
export function pruneRecordings(db: Db, audioDir: string, opts: { olderThanDays: number; now: Date; dryRun?: boolean }): PruneResult {
  const cutoff = opts.now.getTime() - opts.olderThanDays * DAY_MS
  let names: string[]
  try {
    names = readdirSync(audioDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0 }
    throw e
  }
  const old: { name: string; path: string; size: number }[] = []
  for (const name of names) {
    if (!name.startsWith('v_')) continue
    const path = join(audioDir, name)
    const st = lstatSync(path)
    if (st.isFile() && st.mtimeMs < cutoff) old.push({ name, path, size: st.size })
  }
  const result = { files: old.length, bytes: old.reduce((sum, f) => sum + f.size, 0) }
  if (opts.dryRun || old.length === 0) return result

  const deleting = new Set(old.map(f => f.name))
  // read outside the transaction: in WAL mode a transaction that reads and then writes can fail with SQLITE_BUSY
  // when the running server has written in between, and busy_timeout does not retry that
  const rows = db.prepare('SELECT id, audio_path FROM utterances WHERE audio_path IS NOT NULL').all() as { id: string; audio_path: string }[]
  const clear = db.prepare('UPDATE utterances SET audio_path = NULL WHERE id = ?')
  db.transaction(() => {
    for (const r of rows) if (deleting.has(basename(r.audio_path))) clear.run(r.id)
  })()
  for (const f of old) rmSync(f.path, { force: true })
  return result
}
