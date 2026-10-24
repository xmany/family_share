import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testConfig } from '../config'
import type { SttProvider } from '../stt/index'
import { SttError } from '../stt/index'
import { runCli } from './commands'

function run(argv: string[], stt: SttProvider | null) {
  const out: string[] = []
  const err: string[] = []
  const code = runCli(argv, { config: testConfig(), out: l => out.push(l), err: l => err.push(l), createStt: () => stt })
  return code.then(c => ({ code: c, out, err }))
}

describe('stt-test', () => {
  it('transcribes a file twice and disposes the provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-cli-'))
    const file = join(dir, 'clip.m4a')
    writeFileSync(file, Buffer.from('fake audio'))
    const seen: string[] = []
    let disposed = false
    const stt: SttProvider = {
      name: 'whisper:turbo',
      async transcribe(_audio, mime) {
        seen.push(mime)
        return { text: '明天买牛奶', rawText: '明天买牛奶', provider: 'whisper:turbo' }
      },
      dispose: () => {
        disposed = true
      },
    }
    try {
      const r = await run(['stt-test', '--file', file], stt)
      expect(r.code).toBe(0)
      expect(seen).toEqual(['audio/mp4', 'audio/mp4'])
      expect(r.out.join('\n')).toMatch(/provider: whisper:turbo/)
      expect(r.out.filter(l => l.includes('明天买牛奶'))).toHaveLength(2)
      expect(disposed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('explains how to turn speech-to-text on', async () => {
    const r = await run(['stt-test', '--file', '/nonexistent.m4a'], null)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/STT_PROVIDER=whisper/)
  })

  it('reports a transcription failure as a normal CLI error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-cli-'))
    const file = join(dir, 'clip.wav')
    writeFileSync(file, Buffer.from('x'))
    const stt: SttProvider = {
      name: 'whisper:turbo',
      transcribe: async () => {
        throw new SttError('语音识别失败（whisper:turbo: 没听清，请再说一次）')
      },
    }
    try {
      const r = await run(['stt-test', '--file', file], stt)
      expect(r.code).toBe(1)
      expect(r.err.join('\n')).toMatch(/没听清/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
