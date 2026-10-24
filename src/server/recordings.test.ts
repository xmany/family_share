// Old voice recordings can be deleted without leaving utterances.audio_path pointing at a missing file.

import { existsSync, lutimesSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneRecordings } from './recordings'
import { createTestContext } from './testing'

const DAY = 24 * 60 * 60 * 1000

describe('pruneRecordings', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'family-share-audio-'))
    dirs.push(dir)
    const t = createTestContext()
    const now = t.clock.now()
    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY)
    /** A file last written `ageDays` ago */
    const file = (path: string, ageDays: number, content = 'opus') => {
      writeFileSync(path, content)
      utimesSync(path, daysAgo(ageDays), daysAgo(ageDays))
      return path
    }
    const audioPaths = () =>
      Object.fromEntries(
        (t.db.prepare('SELECT id, audio_path FROM utterances').all() as { id: string; audio_path: string | null }[]).map(r => [r.id, r.audio_path]),
      )
    return { t, dir, now, daysAgo, file, audioPaths }
  }

  it('deletes recordings older than the limit and clears their audio_path; transcripts and newer recordings stay', () => {
    const { t, dir, now, file, audioPaths } = setup()
    const old = file(join(dir, 'v_old.webm'), 31, 'x'.repeat(1000))
    const recent = file(join(dir, 'v_recent.m4a'), 29)
    // a failed transcription leaves a recording that no utterance points at
    const orphan = file(join(dir, 'v_failed.webm'), 40, 'y'.repeat(24))
    const oldU = t.domain.createUtterance(t.husband.id, 'voice', '买牛奶', { audioPath: old })
    const recentU = t.domain.createUtterance(t.wife.id, 'voice', '周六游泳', { audioPath: recent })
    const typed = t.domain.createUtterance(t.wife.id, 'text', '打字的')

    expect(pruneRecordings(t.db, dir, { olderThanDays: 30, now })).toEqual({ files: 2, bytes: 1024 })
    expect([existsSync(old), existsSync(orphan), existsSync(recent)]).toEqual([false, false, true])
    expect(audioPaths()).toEqual({ [oldU.id]: null, [recentU.id]: recent, [typed.id]: null })
    expect(t.domain.getUtterance(oldU.id)?.text).toBe('买牛奶')
  })

  it('matches rows by file name, so paths saved before the project folder moved are cleared too', () => {
    const { t, dir, now, file, audioPaths } = setup()
    file(join(dir, 'v_moved.webm'), 60)
    const u = t.domain.createUtterance(t.husband.id, 'voice', '旧录音', { audioPath: '/old/place/data/audio/v_moved.webm' })
    expect(pruneRecordings(t.db, dir, { olderThanDays: 30, now }).files).toBe(1)
    expect(audioPaths()[u.id]).toBeNull()
  })

  it('a dry run only counts', () => {
    const { t, dir, now, file, audioPaths } = setup()
    const old = file(join(dir, 'v_old.webm'), 90, 'abc')
    const u = t.domain.createUtterance(t.husband.id, 'voice', '买牛奶', { audioPath: old })
    expect(pruneRecordings(t.db, dir, { olderThanDays: 30, now, dryRun: true })).toEqual({ files: 1, bytes: 3 })
    expect(existsSync(old)).toBe(true)
    expect(audioPaths()[u.id]).toBe(old)
  })

  it('leaves other files, folders, symlinks and a missing audio folder alone', () => {
    const { t, dir, now, daysAgo, file } = setup()
    const kept = [file(join(dir, 'notes.txt'), 90), file(join(dir, '.DS_Store'), 90), join(dir, 'v_folder'), join(dir, 'v_link.webm')]
    mkdirSync(kept[2]!)
    utimesSync(kept[2]!, daysAgo(90), daysAgo(90))
    const outside = mkdtempSync(join(tmpdir(), 'family-share-outside-'))
    dirs.push(outside)
    const target = file(join(outside, 'keep.webm'), 90)
    symlinkSync(target, kept[3]!)
    lutimesSync(kept[3]!, daysAgo(90), daysAgo(90))

    expect(pruneRecordings(t.db, dir, { olderThanDays: 1, now })).toEqual({ files: 0, bytes: 0 })
    expect([...kept, target].map(p => existsSync(p))).toEqual([true, true, true, true, true])
    expect(pruneRecordings(t.db, join(dir, 'missing'), { olderThanDays: 1, now })).toEqual({ files: 0, bytes: 0 })
  })
})
