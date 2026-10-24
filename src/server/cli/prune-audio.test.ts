// `prune-audio --days N`, run nightly by scripts/backup.sh when AUDIO_KEEP_DAYS is set: see src/server/recordings.ts.

import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTestContext } from '../testing'
import { runCli } from './commands'

describe('family CLI prune-audio', () => {
  it('deletes old recordings, supports --dry-run and checks --days', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'family-share-prune-'))
    try {
      const t = createTestContext()
      const old = join(dir, 'v_old.webm')
      writeFileSync(old, Buffer.alloc(1024 * 1024))
      const at = new Date(t.clock.now().getTime() - 45 * 24 * 60 * 60 * 1000)
      utimesSync(old, at, at)
      const u = t.domain.createUtterance(t.husband.id, 'voice', '买牛奶', { audioPath: old })
      const out: string[] = []
      const err: string[] = []
      const config = { ...t.config, audioDir: dir }
      const run = (...argv: string[]) => runCli(argv, { config, db: t.db, clock: t.clock, out: l => out.push(l), err: l => err.push(l) })

      expect(await run('prune-audio', '--days', '30', '--dry-run')).toBe(0)
      expect(out.pop()).toBe(`dry run: would delete 1 recording(s), 1.0 MB, older than 30 days in ${dir}`)
      expect(existsSync(old)).toBe(true)

      expect(await run('prune-audio', '--days', '60')).toBe(0)
      expect(out.pop()).toBe(`deleted 0 recording(s), 0 KB, older than 60 days in ${dir} (transcripts kept)`)

      expect(await run('prune-audio', '--days=30')).toBe(0)
      expect(out.pop()).toBe(`deleted 1 recording(s), 1.0 MB, older than 30 days in ${dir} (transcripts kept)`)
      expect(existsSync(old)).toBe(false)
      expect(t.db.prepare('SELECT audio_path, text FROM utterances WHERE id = ?').get(u.id)).toEqual({ audio_path: null, text: '买牛奶' })

      for (const bad of [[], ['--days'], ['--days', '0'], ['--days', '1.5'], ['--days', 'abc']]) {
        expect(await run('prune-audio', ...bad)).toBe(1)
      }
      expect(err.join('\n')).toContain('--days must be a whole number of days')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
