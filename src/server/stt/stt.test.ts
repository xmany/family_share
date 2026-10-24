import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { SttProviderConfig } from '../config'
import { testConfig } from '../config'
import { audioExtFor, sanitizeKeywords } from './audio'
import { createFfmpegRunner } from './ffmpeg'
import { createStt, SttError } from './index'
import type { SttOptions } from './index'
import { qwenContext } from './providers'

interface Call {
  url: string
  init: RequestInit
}

type Responder = (call: Call, n: number) => Response | Promise<Response>

function fakeFetch(responder: Responder) {
  const calls: Call[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return responder(call, calls.length)
  }) as typeof fetch
  return { fetch: fn, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const openai = (over: Partial<SttProviderConfig> = {}): SttProviderConfig => ({
  provider: 'openai',
  apiKey: 'sk-test',
  model: null,
  baseUrl: null,
  ...over,
})
const qwen = (over: Partial<SttProviderConfig> = {}): SttProviderConfig => ({
  provider: 'qwen',
  apiKey: 'dash-test',
  model: null,
  baseUrl: null,
  ...over,
})

function config(primary: SttProviderConfig | null, fallback: SttProviderConfig | null = null) {
  return testConfig({ stt: { primary, fallback, ffmpegPath: 'ffmpeg', whisper: { python: 'python3', device: 'cpu', idleMs: 900_000 } } })
}

const WAV = Buffer.concat([Buffer.alloc(44, 1), Buffer.alloc(32000, 2)]) // "1 s" of 16 kHz mono PCM
const fakeFfmpeg = async () => WAV
const noFfmpeg = async () => null
const quiet = () => undefined

const OPTS: SttOptions = {
  languages: ['zh', 'en'],
  keywords: ['老公', '老婆', '<b>Costco</b>', '买\r\n菜', '老公', ''],
  prompt: '家庭成员之间的日常安排，普通话，可能夹杂英文。',
}

describe('createStt', () => {
  it('returns null when no provider is configured or the provider is unknown', () => {
    expect(createStt(config(null))).toBeNull()
    expect(createStt(config(openai({ provider: 'whisper-local' })), { log: quiet })).toBeNull()
    expect(createStt(config(openai()))?.name).toBe('openai:gpt-transcribe')
    expect(createStt(config(openai(), qwen()))?.name).toBe('openai:gpt-transcribe → qwen:qwen3-asr-flash')
  })
})

describe('openai gpt-transcribe', () => {
  it('sends the exact multipart fields and converts Traditional to Simplified', async () => {
    const f = fakeFetch(() => json({ text: '明天幫我買東西 Costco', languages: [{ code: 'zh' }, { code: 'en' }], usage: { type: 'duration', seconds: 2.5 } }))
    const stt = createStt(config(openai()), { fetch: f.fetch, runFfmpeg: fakeFfmpeg })!
    const t = await stt.transcribe(Buffer.from('webm-bytes'), 'audio/webm;codecs=opus', OPTS)

    expect(t).toEqual({
      text: '明天帮我买东西 Costco',
      rawText: '明天幫我買東西 Costco',
      detectedLanguages: ['zh', 'en'],
      durationMs: 2500,
      provider: 'openai:gpt-transcribe',
    })
    expect(f.calls).toHaveLength(1)
    const call = f.calls[0]!
    expect(call.url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(call.init.signal).toBeInstanceOf(AbortSignal)

    const fd = call.init.body as FormData
    expect([...new Set([...fd.keys()])]).toEqual(['file', 'model', 'languages[]', 'keywords[]', 'prompt', 'response_format'])
    expect(fd.has('language')).toBe(false)
    expect(fd.get('model')).toBe('gpt-transcribe')
    expect(fd.getAll('languages[]')).toEqual(['zh', 'en'])
    expect(fd.getAll('keywords[]')).toEqual(['老公', '老婆', 'bCostco/b', '买 菜'])
    expect(fd.get('prompt')).toBe(OPTS.prompt)
    expect(fd.get('response_format')).toBe('json')
    const file = fd.get('file') as File
    expect(file.name).toBe('audio.wav')
    expect(file.type).toBe('audio/wav')
    expect(Buffer.from(await file.arrayBuffer()).equals(WAV)).toBe(true)

    // the multipart body serializes with the bracketed field names
    const serialized = await new Request('http://x', { method: 'POST', body: fd }).text()
    expect(serialized).toContain('name="languages[]"')
    expect(serialized).toContain('name="keywords[]"')
  })

  it('sends the original upload when ffmpeg is unavailable, and honours model/baseUrl/simplify', async () => {
    const f = fakeFetch(() => json({ text: '幫我' }))
    const stt = createStt(config(openai({ model: 'gpt-x', baseUrl: 'https://proxy.example.com/v1/' })), { fetch: f.fetch, runFfmpeg: noFfmpeg })!
    const keepScript: SttOptions = { simplify: false }
    const t = await stt.transcribe(Buffer.from('mp4-bytes'), 'audio/mp4', keepScript)
    expect(t.text).toBe('幫我')
    expect(f.calls[0]!.url).toBe('https://proxy.example.com/v1/audio/transcriptions')
    const fd = f.calls[0]!.init.body as FormData
    const file = fd.get('file') as File
    expect(file.name).toBe('audio.m4a')
    expect(file.type).toBe('audio/mp4')
    expect(fd.get('model')).toBe('gpt-x')
    expect(fd.getAll('languages[]')).toEqual(['zh', 'en']) // default hints
    expect(fd.has('keywords[]')).toBe(false)
    expect(fd.has('prompt')).toBe(false)
  })

  it('retries once on 5xx and once on a network error', async () => {
    const f = fakeFetch((_c, n) => (n === 1 ? json({ error: 'busy' }, 503) : json({ text: '好的' })))
    const stt = createStt(config(openai()), { fetch: f.fetch, runFfmpeg: fakeFfmpeg, retryDelayMs: 0 })!
    expect((await stt.transcribe(WAV, 'audio/wav')).text).toBe('好的')
    expect(f.calls).toHaveLength(2)

    const g = fakeFetch((_c, n) => {
      if (n === 1) throw new TypeError('fetch failed')
      return json({ text: '可以' })
    })
    const stt2 = createStt(config(openai()), { fetch: g.fetch, runFfmpeg: fakeFfmpeg, retryDelayMs: 0 })!
    expect((await stt2.transcribe(WAV, 'audio/wav')).text).toBe('可以')
    expect(g.calls).toHaveLength(2)
  })

  it('gives up after the retry with a retryable SttError, and does not retry 4xx', async () => {
    const f = fakeFetch(() => json({ error: 'down' }, 500))
    const stt = createStt(config(openai()), { fetch: f.fetch, runFfmpeg: fakeFfmpeg, retryDelayMs: 0, log: quiet })!
    const err = await stt.transcribe(WAV, 'audio/wav').catch(e => e)
    expect(err).toBeInstanceOf(SttError)
    expect((err as SttError).retryable).toBe(true)
    expect(f.calls).toHaveLength(2)

    const g = fakeFetch(() => json({ error: { message: 'bad key' } }, 401))
    const stt2 = createStt(config(openai()), { fetch: g.fetch, runFfmpeg: fakeFfmpeg, retryDelayMs: 0, log: quiet })!
    const err2 = await stt2.transcribe(WAV, 'audio/wav').catch(e => e)
    expect(err2).toBeInstanceOf(SttError)
    expect((err2 as SttError).retryable).toBe(false)
    expect(g.calls).toHaveLength(1)
  })

  it('times out a hanging request (AbortSignal.timeout) and retries once', async () => {
    const f = fakeFetch(
      call =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(call.init.signal!.reason))
        }),
    )
    const stt = createStt(config(openai()), { fetch: f.fetch, runFfmpeg: fakeFfmpeg, timeoutMs: 30, retryDelayMs: 0, log: quiet })!
    const err = await stt.transcribe(WAV, 'audio/wav').catch(e => e)
    expect(err).toBeInstanceOf(SttError)
    expect(String((err as Error).message)).toContain('timeout')
    expect(f.calls).toHaveLength(2)
  })
})

describe('qwen3-asr-flash', () => {
  it('posts the OpenAI-compatible chat body with a base64 WAV data URL', async () => {
    const f = fakeFetch(() =>
      json({
        choices: [{ index: 0, message: { role: 'assistant', content: '周六帶孩子去公園', annotations: [{ type: 'audio_info', language: 'zh', emotion: 'neutral' }] } }],
        usage: { seconds: 3 },
      }),
    )
    const stt = createStt(config(qwen()), { fetch: f.fetch, runFfmpeg: fakeFfmpeg })!
    const t = await stt.transcribe(Buffer.from('m4a'), 'audio/mp4', OPTS)
    expect(t).toEqual({
      text: '周六带孩子去公园',
      rawText: '周六帶孩子去公園',
      detectedLanguages: ['zh'],
      durationMs: 3000,
      provider: 'qwen:qwen3-asr-flash',
    })
    const call = f.calls[0]!
    expect(call.url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer dash-test')
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    const body = JSON.parse(call.init.body as string)
    expect(body).toEqual({
      model: 'qwen3-asr-flash',
      messages: [
        { role: 'system', content: qwenContext(OPTS) },
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${WAV.toString('base64')}` } }] },
      ],
      stream: false,
      asr_options: { enable_itn: true },
    })
    expect(body.messages[0].content).toContain('老公、老婆')
  })

  it('pins the language for a single hint, omits the system message without context, accepts content parts', async () => {
    const f = fakeFetch(() => json({ choices: [{ message: { content: [{ text: 'hello ' }, { text: 'world' }] } }] }))
    const stt = createStt(config(qwen({ baseUrl: 'https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/' })), {
      fetch: f.fetch,
      runFfmpeg: fakeFfmpeg,
    })!
    const t = await stt.transcribe(WAV, 'audio/wav', { languages: ['en'] })
    expect(t.text).toBe('hello world')
    expect(f.calls[0]!.url).toBe('https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions')
    const body = JSON.parse(f.calls[0]!.init.body as string)
    expect(body.messages).toHaveLength(1)
    expect(body.asr_options).toEqual({ enable_itn: true, language: 'en' })
  })

  it('retries once without the context message when qwen rejects it (400), and not for other errors', async () => {
    // The system-message shape for qwen3-asr-flash context is not shown in Alibaba's docs: a wrong guess must not
    // turn every transcription into a failure.
    const f = fakeFetch(call => {
      const body = JSON.parse(call.init.body as string)
      return body.messages[0].role === 'system'
        ? json({ error: { code: 'InvalidParameter', message: 'messages[0].content is invalid' } }, 400)
        : json({ choices: [{ message: { content: '好的' } }] })
    })
    const stt = createStt(config(qwen()), { fetch: f.fetch, runFfmpeg: fakeFfmpeg, retryDelayMs: 0, log: quiet })!
    expect((await stt.transcribe(WAV, 'audio/wav', OPTS)).text).toBe('好的')
    expect(f.calls).toHaveLength(2)
    expect(JSON.parse(f.calls[1]!.init.body as string).messages.map((m: { role: string }) => m.role)).toEqual(['user'])

    const g = fakeFetch(() => json({ error: { message: 'bad key' } }, 401))
    const stt2 = createStt(config(qwen()), { fetch: g.fetch, runFfmpeg: fakeFfmpeg, retryDelayMs: 0, log: quiet })!
    await expect(stt2.transcribe(WAV, 'audio/wav', OPTS)).rejects.toBeInstanceOf(SttError)
    expect(g.calls).toHaveLength(1)
  })

  it('refuses without ffmpeg (non-WAV upload) and makes no request', async () => {
    const f = fakeFetch(() => json({}))
    const stt = createStt(config(qwen()), { fetch: f.fetch, runFfmpeg: noFfmpeg, log: quiet })!
    await expect(stt.transcribe(Buffer.from('webm'), 'audio/webm')).rejects.toBeInstanceOf(SttError)
    expect(f.calls).toHaveLength(0)
  })
})

describe('primary → fallback', () => {
  it('falls back to qwen when openai fails, and throws SttError when both fail', async () => {
    const f = fakeFetch(call => (call.url.includes('openai') ? json({ error: 'x' }, 500) : json({ choices: [{ message: { content: '收到' } }] })))
    const stt = createStt(config(openai(), qwen()), { fetch: f.fetch, runFfmpeg: fakeFfmpeg, retryDelayMs: 0, log: quiet })!
    const t = await stt.transcribe(WAV, 'audio/wav')
    expect(t.provider).toBe('qwen:qwen3-asr-flash')
    expect(f.calls.map(c => new URL(c.url).host)).toEqual(['api.openai.com', 'api.openai.com', 'dashscope-intl.aliyuncs.com'])

    const g = fakeFetch(() => json({ error: 'x' }, 400))
    const stt2 = createStt(config(openai(), qwen()), { fetch: g.fetch, runFfmpeg: fakeFfmpeg, log: quiet })!
    const err = await stt2.transcribe(WAV, 'audio/wav').catch(e => e)
    expect(err).toBeInstanceOf(SttError)
    expect(String(err.message)).toContain('openai')
    expect(String(err.message)).toContain('qwen')
  })
})

describe('helpers', () => {
  it('maps upload types to extensions', () => {
    expect(audioExtFor('audio/webm;codecs=opus')).toBe('webm')
    expect(audioExtFor('audio/mp4;codecs=mp4a.40.2')).toBe('m4a')
    expect(audioExtFor('', 'note.m4a')).toBe('m4a')
    expect(audioExtFor('application/octet-stream', 'note.exe')).toBeNull()
  })

  it('sanitizes keywords and caps them at 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => `词${i}`)
    expect(sanitizeKeywords(many)).toHaveLength(50)
    expect(sanitizeKeywords(['a<b>c', ' x\ny ', 'x y', '<>'])).toEqual(['abc', 'x y'])
  })
})

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A 0.25 s 44.1 kHz stereo 16-bit WAV of silence. */
function stereoWav(): Buffer {
  const rate = 44100
  const frames = rate / 4
  const data = Buffer.alloc(frames * 4)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(2, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 4, 28)
  h.writeUInt16LE(4, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

describe('ffmpeg runner', () => {
  it('resolves null when ffmpeg is missing', async () => {
    const run = createFfmpegRunner('/nonexistent/ffmpeg-xyz', { log: quiet })
    expect(await run(Buffer.from('x'), 'webm')).toBeNull()
  })

  it.skipIf(!hasFfmpeg())('converts to 16 kHz mono PCM WAV', async () => {
    const run = createFfmpegRunner('ffmpeg', { log: quiet })
    const out = await run(stereoWav(), 'wav')
    expect(out).not.toBeNull()
    expect(out!.subarray(0, 4).toString()).toBe('RIFF')
    // locate the fmt chunk (ffmpeg may add a LIST chunk first)
    const fmt = out!.indexOf('fmt ')
    expect(out!.readUInt16LE(fmt + 10)).toBe(1) // channels
    expect(out!.readUInt32LE(fmt + 12)).toBe(16000) // sample rate
    expect(out!.readUInt16LE(fmt + 22)).toBe(16) // bits per sample
  })

  it.skipIf(!hasFfmpeg())('resolves null for garbage input', async () => {
    const run = createFfmpegRunner('ffmpeg', { log: quiet })
    expect(await run(Buffer.from('definitely not audio'), 'webm')).toBeNull()
  })
})
