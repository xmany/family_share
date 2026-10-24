import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SttOptions } from '../stt/index'
import type { SttProvider, Transcript, TranscribeOptions } from '../stt/types'
import { SttError } from '../stt/types'
import { harness } from './testkit'

vi.mock('../wechat/index', () => ({
  handleWechatVerify: vi.fn(),
  handleWechatMessage: vi.fn(),
  createWechatBindCode: vi.fn(),
  getWechatBinding: vi.fn(() => ({ bound: false, mode: 'fallback' })),
}))

class FakeStt implements SttProvider {
  readonly name = 'fake'
  calls: { audio: Buffer; mimeType: string; opts?: TranscribeOptions }[] = []
  constructor(private result: string | Error = '明天早上带孩子出去') {}
  async transcribe(audio: Buffer, mimeType: string, opts?: TranscribeOptions): Promise<Transcript> {
    this.calls.push({ audio, mimeType, opts })
    if (this.result instanceof Error) throw this.result
    return { text: this.result, rawText: this.result, provider: 'fake' }
  }
}

function voiceForm(bytes: Buffer | string = 'fake-opus-bytes', type = 'audio/webm;codecs=opus', name = 'note.webm', durationMs = '3200') {
  const fd = new FormData()
  fd.append('audio', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type }), name)
  if (durationMs) fd.append('durationMs', durationMs)
  return fd
}

describe('POST /api/utterances/voice', () => {
  it('saves the upload, transcribes with member hints and interprets as voice', async () => {
    const stt = new FakeStt()
    const h = harness({ stt })
    h.t.domain.createItem(h.t.as(h.t.husband), { kind: 'task', title: '修<柜子>\n门' })
    const r = await h.json('POST', '/api/utterances/voice', { as: h.t.wife, form: voiceForm() })
    expect(r.status).toBe(200)
    expect(r.body.transcript).toBe('明天早上带孩子出去')
    expect(r.body.utterance.text).toBe('明天早上带孩子出去')

    expect(stt.calls).toHaveLength(1)
    const call = stt.calls[0]!
    expect(call.mimeType).toBe('audio/webm')
    expect(call.audio.toString()).toBe('fake-opus-bytes')
    const opts = call.opts as SttOptions
    expect(opts.languages).toEqual(['zh', 'en'])
    expect(opts.simplify).toBe(true)
    expect(opts.prompt).toBe('家庭成员之间的日常安排，普通话，可能夹杂英文。')
    expect(opts.keywords).toEqual(expect.arrayContaining(['老公', '老婆', '孩子爸', '媳妇', '修柜子 门']))
    expect(opts.keywords!.some(k => /[<>\r\n]/.test(k))).toBe(false)

    const input = h.interpreter.calls[0]!
    expect(input).toMatchObject({ memberId: h.t.wife.id, text: '明天早上带孩子出去', source: 'voice' })
    expect(input.audioPath).toMatch(/\/audio\/v_[a-z0-9]+\.webm$/)
    expect(dirname(input.audioPath!)).toBe(h.ctx.config.audioDir)
    expect(readFileSync(input.audioPath!, 'utf8')).toBe('fake-opus-bytes')
    expect(h.t.db.prepare('SELECT audio_path AS p FROM utterances').get()).toEqual({ p: input.audioPath })
  })

  it('accepts iOS mp4 uploads and maps them to .m4a', async () => {
    const stt = new FakeStt('好的')
    const h = harness({ stt })
    const r = await h.json('POST', '/api/utterances/voice', { as: h.t.husband, form: voiceForm('mp4', 'audio/mp4', 'note.m4a') })
    expect(r.status).toBe(200)
    expect(stt.calls[0]!.mimeType).toBe('audio/mp4')
    expect(h.interpreter.calls[0]!.audioPath).toMatch(/\.m4a$/)
  })

  it('422 stt_unavailable without a provider', async () => {
    const h = harness({ stt: null })
    const r = await h.json('POST', '/api/utterances/voice', { as: h.t.wife, form: voiceForm() })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('stt_unavailable')
    expect(h.interpreter.calls).toHaveLength(0)
  })

  it('422 stt_failed on SttError (the audio is kept) and on an empty transcript', async () => {
    const h = harness({ stt: new FakeStt(new SttError('both providers failed', true)) })
    const r = await h.json('POST', '/api/utterances/voice', { as: h.t.wife, form: voiceForm() })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('stt_failed')
    expect(r.body.error.message).toContain('键盘')
    expect(h.interpreter.calls).toHaveLength(0)
    expect(existsSync(h.ctx.config.audioDir)).toBe(true)

    const h2 = harness({ stt: new FakeStt('   ') })
    const r2 = await h2.json('POST', '/api/utterances/voice', { as: h2.t.wife, form: voiceForm() })
    expect(r2.status).toBe(422)
    expect(r2.body.error.code).toBe('stt_failed')
  })

  it('validates the upload: missing, empty, unknown type, too long, too large; needs session + CSRF', async () => {
    const h = harness({ stt: new FakeStt() })
    const as = h.t.wife
    const noAudio = new FormData()
    noAudio.append('durationMs', '1000')
    expect((await h.json('POST', '/api/utterances/voice', { as, form: noAudio })).status).toBe(400)
    expect((await h.json('POST', '/api/utterances/voice', { as, form: voiceForm('') })).status).toBe(400)
    expect((await h.json('POST', '/api/utterances/voice', { as, form: voiceForm('x', 'application/pdf', 'a.pdf') })).status).toBe(400)
    const long = await h.json('POST', '/api/utterances/voice', { as, form: voiceForm('x', 'audio/webm', 'a.webm', '120000') })
    expect(long.status).toBe(400)
    expect(long.body.error.message).toContain('90')
    const big = await h.json('POST', '/api/utterances/voice', { as, form: voiceForm(Buffer.alloc(10 * 1024 * 1024 + 1)) })
    expect(big.status).toBe(413)
    expect(big.body.error.code).toBe('too_large')
    expect((await h.req('POST', '/api/utterances/voice', { form: voiceForm() })).status).toBe(401)
    expect((await h.req('POST', '/api/utterances/voice', { as, csrf: false, form: voiceForm() })).status).toBe(403)
    expect((await h.json('POST', '/api/utterances/voice', { as, body: { audio: 'x' } })).status).toBe(400)
  })
})
