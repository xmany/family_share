import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { loadConfig, testConfig } from '../config'
import { createStt, createSttFromBackends } from './index'
import type { PreparedAudio } from './providers'
import { SttError } from './types'
import { WhisperWorker, cleanWhisperText, createWhisperBackend, whisperLanguage, whisperPrompt } from './whisper'

// A stand-in for the Python worker, speaking the same line protocol. The request's wav path picks the behaviour.
const FAKE_WORKER = String.raw`
const mode = process.argv[1] || 'ok'
if (mode === 'fatal') { process.stdout.write(JSON.stringify({ fatal: 'ModuleNotFoundError: No module named whisper' }) + '\n'); process.exit(2) }
process.stdout.write(JSON.stringify({ ready: true }) + '\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.wav.includes('crash')) process.exit(3)
    if (req.wav.includes('hang')) continue
    if (req.wav.includes('err')) { process.stdout.write(JSON.stringify({ id: req.id, error: 'RuntimeError: bad audio' }) + '\n'); continue }
    process.stdout.write('some library noise\n')
    process.stdout.write(JSON.stringify({ id: req.id, text: req.wav.includes('silence') ? '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目' : '明天早上你能带孩子出去吗?我九点有个会,八十块.', language: req.language, pid: process.pid, prompt: req.prompt }) + '\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`

function fakeWorker(opts: { mode?: string; idleMs?: number; timeoutMs?: number } = {}) {
  let spawns = 0
  const worker = new WhisperWorker({
    command: process.execPath,
    args: ['-e', FAKE_WORKER, opts.mode ?? 'ok'],
    idleMs: opts.idleMs ?? 60_000,
    timeoutMs: opts.timeoutMs ?? 5_000,
    log: () => undefined,
    spawnImpl: (command, args) => {
      spawns++
      return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    },
  })
  return { worker, spawns: () => spawns }
}

const wavAudio = (): PreparedAudio => {
  // 44-byte WAV header + 1 s of 16 kHz mono silence
  const data = Buffer.alloc(32_000)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16_000, 24)
  h.writeUInt32LE(32_000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  const wav = Buffer.concat([h, data])
  return { original: wav, mimeType: 'audio/wav', ext: 'wav', wav }
}

describe('whisper worker (fake process)', () => {
  it('answers requests and keeps one process for several notes', async () => {
    const { worker, spawns } = fakeWorker()
    try {
      const a = await worker.transcribe({ wav: '/tmp/a.wav', language: 'zh' })
      const b = await worker.transcribe({ wav: '/tmp/b.wav', language: 'zh' })
      expect(a.text).toContain('明天早上')
      expect(b.language).toBe('zh')
      expect(spawns()).toBe(1)
    } finally {
      worker.dispose()
    }
  })

  it('runs requests one at a time and matches answers to requests', async () => {
    const { worker } = fakeWorker()
    try {
      const results = await Promise.all([1, 2, 3].map(n => worker.transcribe({ wav: `/tmp/${n}.wav` })))
      expect(results.every(r => r.text.includes('明天早上'))).toBe(true)
    } finally {
      worker.dispose()
    }
  })

  it('reports a Python error for one request without killing the process', async () => {
    const { worker, spawns } = fakeWorker()
    try {
      await expect(worker.transcribe({ wav: '/tmp/err.wav' })).rejects.toThrow(/bad audio/)
      await expect(worker.transcribe({ wav: '/tmp/ok.wav' })).resolves.toMatchObject({ language: null })
      expect(spawns()).toBe(1)
    } finally {
      worker.dispose()
    }
  })

  it('fails a request when the process crashes, then starts a new one', async () => {
    const { worker, spawns } = fakeWorker()
    try {
      const err = await worker.transcribe({ wav: '/tmp/crash.wav' }).catch(e => e)
      expect(err).toBeInstanceOf(SttError)
      expect((err as SttError).retryable).toBe(true)
      await expect(worker.transcribe({ wav: '/tmp/ok.wav' })).resolves.toBeTruthy()
      expect(spawns()).toBe(2)
    } finally {
      worker.dispose()
    }
  })

  it('times out a stuck request and recovers', async () => {
    const { worker, spawns } = fakeWorker({ timeoutMs: 300 })
    try {
      await expect(worker.transcribe({ wav: '/tmp/hang.wav' })).rejects.toThrow(/没有结果/)
      await expect(worker.transcribe({ wav: '/tmp/ok.wav' })).resolves.toBeTruthy()
      expect(spawns()).toBe(2)
    } finally {
      worker.dispose()
    }
  })

  it('surfaces a model that cannot load as a non-retryable error', async () => {
    const { worker } = fakeWorker({ mode: 'fatal' })
    const err = await worker.transcribe({ wav: '/tmp/a.wav' }).catch(e => e)
    expect(err).toBeInstanceOf(SttError)
    expect(String(err.message)).toMatch(/No module named whisper/)
    expect((err as SttError).retryable).toBe(false)
  })

  it('explains a Python that does not exist', async () => {
    const worker = new WhisperWorker({ command: '/nonexistent/python3', args: [], idleMs: 1000, timeoutMs: 5000, log: () => undefined })
    await expect(worker.transcribe({ wav: '/tmp/a.wav' })).rejects.toThrow(/无法启动|ENOENT/)
  })

  it('exits after the idle time and restarts for the next note', async () => {
    const { worker, spawns } = fakeWorker({ idleMs: 50 })
    try {
      await worker.transcribe({ wav: '/tmp/a.wav' })
      expect(worker.running).toBe(true)
      await new Promise(r => setTimeout(r, 400))
      expect(worker.running).toBe(false)
      await worker.transcribe({ wav: '/tmp/b.wav' })
      expect(spawns()).toBe(2)
    } finally {
      worker.dispose()
    }
  })
})

describe('whisper backend', () => {
  const settings = { python: process.execPath, device: 'cpu', idleMs: 60_000 }
  const backend = (mode = 'ok') =>
    createWhisperBackend({ provider: 'whisper', apiKey: '', model: null, baseUrl: null }, settings, {
      log: () => undefined,
      // run the fake worker instead of `python -u -c <source> model device`
      spawnImpl: command => spawn(command, ['-e', FAKE_WORKER, mode], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams,
    })

  it('writes the WAV, asks in Mandarin with the family words, and cleans the text', async () => {
    const b = backend()
    try {
      const r = await b.transcribe(wavAudio(), { languages: ['zh', 'en'], keywords: ['旧柜子'] })
      expect(b.name).toBe('whisper:turbo')
      expect(r.text).toBe('明天早上你能带孩子出去吗？我九点有个会，八十块。')
      expect(r.detectedLanguages).toEqual(['zh'])
      expect(r.durationMs).toBe(1000)
    } finally {
      b.dispose()
    }
  })

  it('needs the ffmpeg WAV', async () => {
    const b = backend()
    try {
      await expect(b.transcribe({ ...wavAudio(), wav: null }, {})).rejects.toThrow(/ffmpeg/)
    } finally {
      b.dispose()
    }
  })

  it('treats a hallucinated subtitle credit as nothing heard', async () => {
    const b = createWhisperBackend({ provider: 'whisper', apiKey: '', model: 'turbo', baseUrl: null }, settings, {
      log: () => undefined,
      spawnImpl: command => spawn(command, ['-e', FAKE_WORKER.replace("req.wav.includes('silence')", 'true'), 'ok'], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams,
    })
    try {
      await expect(b.transcribe(wavAudio(), {})).rejects.toThrow(/没听清/)
    } finally {
      b.dispose()
    }
  })

  it('is disposed through the provider chain', async () => {
    const b = backend()
    let disposed = 0
    const original = b.dispose
    b.dispose = () => {
      disposed++
      original()
    }
    const stt = createSttFromBackends([b], async () => null, () => undefined)
    stt.dispose?.()
    expect(disposed).toBe(1)
  })
})

describe('whisper text helpers', () => {
  it('drops subtitle-credit hallucinations but keeps real sentences', () => {
    expect(cleanWhisperText('请不吝点赞 订阅 转发 打赏支持明镜与点点栏目')).toBe('')
    expect(cleanWhisperText('字幕由Amara.org社区提供')).toBe('')
    expect(cleanWhisperText('谢谢观看')).toBe('')
    expect(cleanWhisperText('买牛奶。请不吝点赞 订阅 转发 打赏支持明镜与点点栏目')).toBe('买牛奶。')
    expect(cleanWhisperText('取消Netflix订阅')).toBe('取消Netflix订阅')
    expect(cleanWhisperText('把这个转发给妈妈')).toBe('把这个转发给妈妈')
  })

  it('drops a transcript that only repeats the prompt', () => {
    const prompt = whisperPrompt({ keywords: ['旧柜子', '老婆'] })
    expect(cleanWhisperText('旧柜子、老婆', prompt)).toBe('')
    expect(cleanWhisperText('旧柜子挂出去了', prompt)).toBe('旧柜子挂出去了')
  })

  it('gives Chinese sentences Chinese punctuation, not English words or numbers', () => {
    expect(cleanWhisperText('你能带孩子出去吗?我九点有个会,')).toBe('你能带孩子出去吗？我九点有个会，')
    expect(cleanWhisperText('挂到Facebook Marketplace上,八十块.')).toBe('挂到Facebook Marketplace上，八十块。')
    expect(cleanWhisperText('药吃3.5片, OK?')).toBe('药吃3.5片， OK?')
  })

  it('picks one language for Whisper', () => {
    expect(whisperLanguage(['zh', 'en'])).toBe('zh')
    expect(whisperLanguage(undefined)).toBe('zh')
    expect(whisperLanguage(['zh-HK'])).toBe('yue')
    expect(whisperLanguage(['yue', 'en'])).toBe('yue')
    expect(whisperLanguage(['en'])).toBe('en')
  })

  it('builds a short prompt with the family words', () => {
    expect(whisperPrompt({})).toBe('以下是普通话的句子，可能夹杂英文。')
    const p = whisperPrompt({ prompt: '家庭成员之间的日常安排。', keywords: ['老公', '老婆', '旧柜子'] })
    expect(p).toBe('家庭成员之间的日常安排。常用词：老公、老婆、旧柜子。')
    const long = whisperPrompt({ keywords: Array.from({ length: 50 }, (_, i) => `很长很长的一个事项名字${i}`) })
    expect(long.length).toBeLessThanOrEqual(160)
  })
})

describe('whisper config', () => {
  const env = (vars: Record<string, string>) => loadConfig(vars as NodeJS.ProcessEnv, { loadDotEnv: false })

  it('needs no API key for STT_PROVIDER=whisper', () => {
    const c = env({ STT_PROVIDER: 'whisper', WHISPER_PYTHON: '/py/bin/python', WHISPER_IDLE_MINUTES: '5' })
    expect(c.stt.primary).toEqual({ provider: 'whisper', apiKey: '', model: null, baseUrl: null })
    expect(c.stt.whisper).toEqual({ python: '/py/bin/python', device: 'cpu', idleMs: 300_000 })
  })

  it('can use local whisper as the fallback of a hosted provider', () => {
    const c = env({ OPENAI_API_KEY: 'sk-x', STT_FALLBACK_PROVIDER: 'whisper', STT_FALLBACK_MODEL: 'large-v3' })
    expect(c.stt.primary?.provider).toBe('openai')
    expect(c.stt.fallback).toEqual({ provider: 'whisper', apiKey: '', model: 'large-v3', baseUrl: null })
  })

  it('still needs a key for hosted providers', () => {
    expect(env({ STT_PROVIDER: 'openai' }).stt.primary).toBeNull()
    expect(env({}).stt.primary).toBeNull()
  })

  it('builds a whisper provider from config', () => {
    const stt = createStt(testConfig({ stt: { primary: { provider: 'whisper', apiKey: '', model: 'turbo', baseUrl: null }, fallback: null, ffmpegPath: 'ffmpeg', whisper: { python: 'python3', device: 'cpu', idleMs: 1000 } } }), { log: () => undefined })
    expect(stt?.name).toBe('whisper:turbo')
    stt?.dispose?.()
  })
})

describe('renamed settings', () => {
  it('warns about CLAUDE_* names left in .env', async () => {
    const { warnRenamedSettings } = await import('../config')
    const warnings: string[] = []
    const found = warnRenamedSettings('# comment\nCLAUDE_EFFORT=high\nAI_MODEL=claude-opus-5-5\n  CLAUDE_MODEL = x\n', w => warnings.push(w))
    expect(found).toEqual(['CLAUDE_MODEL', 'CLAUDE_EFFORT'])
    expect(warnings.join('\n')).toMatch(/CLAUDE_EFFORT was renamed to AI_EFFORT/)
    expect(warnRenamedSettings('AI_EFFORT=high\n# CLAUDE_EFFORT=max\n', () => undefined)).toEqual([])
  })

  it('reads the AI_* names', () => {
    const c = loadConfig({ AI_MODEL: 'claude-sonnet-5-5', AI_EFFORT: 'low', AI_FALLBACKS: 'off', AI_MAX_ITERATIONS: '4', CLAUDE_EFFORT: 'max' } as NodeJS.ProcessEnv, { loadDotEnv: false })
    expect(c.anthropic).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', fallbacks: false, maxIterations: 4 })
  })
})
