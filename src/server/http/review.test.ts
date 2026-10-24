// Regression tests for defects found in review of the HTTP layer.

import { statSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { SttProvider, Transcript } from '../stt/types'
import { getOrCreateAppSecret, signLinkToken } from '../tokens'
import { revokeSessions } from './auth'
import { StreamRegistry } from './sse'
import { harness } from './testkit'

vi.mock('../wechat/index', () => ({
  handleWechatVerify: vi.fn(),
  handleWechatMessage: vi.fn(),
  createWechatBindCode: vi.fn(),
  getWechatBinding: vi.fn(() => ({ bound: false, mode: 'fallback' })),
}))

/** A family timezone that differs from the machine's, so "server timezone" bugs can't pass by accident. */
const machineTz = Intl.DateTimeFormat().resolvedOptions().timeZone
const FAMILY_TZ = machineTz === 'Asia/Kolkata' ? 'America/Sao_Paulo' : 'Asia/Kolkata'

describe('POST /api/items/:id/snooze with an explicit until', () => {
  it('reads a local time without offset in the family timezone, not the server timezone', async () => {
    const h = harness({ timezone: FAMILY_TZ })
    const as = h.t.husband
    const { body } = await h.json('POST', '/api/items', { as, body: { kind: 'task', title: '修柜子' } })
    const r = await h.json('POST', `/api/items/${body.item.id}/snooze`, { as, body: { until: '2026-10-25T09:00' } })
    expect(r.status).toBe(200)
    // 09:00 in the family's timezone
    const expected = FAMILY_TZ === 'Asia/Kolkata' ? '2026-10-25T03:30:00.000Z' : '2026-10-25T12:00:00.000Z'
    expect(r.body.item.snoozedUntil).toBe(expected)
  })

  it('rejects impossible dates and non-ISO formats instead of rolling them over', async () => {
    const h = harness()
    const as = h.t.husband
    const { body } = await h.json('POST', '/api/items', { as, body: { kind: 'task', title: '修柜子' } })
    for (const until of ['2027-02-30T08:00:00Z', '2026/10/25 09:00', 'Oct 25 2026 09:00', 'tomorrow']) {
      const r = await h.json('POST', `/api/items/${body.item.id}/snooze`, { as, body: { until } })
      expect(r.status, until).toBe(400)
      expect(r.body.error.code, until).toBe('invalid')
    }
    expect(h.t.domain.getItem(body.item.id)!.snoozedUntil).toBeNull()
  })
})

describe('POST /api/utterances/voice MIME handling', () => {
  it('hands the provider a MIME type that matches the extension when the browser sent a generic one', async () => {
    const calls: string[] = []
    const stt: SttProvider = {
      name: 'fake',
      async transcribe(_audio, mimeType): Promise<Transcript> {
        calls.push(mimeType)
        return { text: '好的', rawText: '好的', provider: 'fake' }
      },
    }
    const h = harness({ stt })
    const fd = new FormData()
    fd.append('audio', new Blob(['mp4-bytes'], { type: 'application/octet-stream' }), 'voice.m4a')
    const r = await h.json('POST', '/api/utterances/voice', { as: h.t.wife, form: fd })
    expect(r.status).toBe(200)
    expect(h.interpreter.calls[0]!.audioPath).toMatch(/\.m4a$/)
    expect(calls).toEqual(['audio/mp4'])
  })

  it('keeps recordings private to the server user (they are the family talking)', async () => {
    const stt: SttProvider = { name: 'fake', transcribe: async () => ({ text: '好', rawText: '好', provider: 'fake' }) }
    const h = harness({ stt })
    const fd = new FormData()
    fd.append('audio', new Blob(['opus'], { type: 'audio/webm' }), 'voice.webm')
    expect((await h.req('POST', '/api/utterances/voice', { as: h.t.wife, form: fd })).status).toBe(200)
    const path = h.interpreter.calls[0]!.audioPath!
    expect(statSync(path).mode & 0o077).toBe(0)
    expect(statSync(h.ctx.config.audioDir).mode & 0o077).toBe(0)
  })
})

/** Reads an SSE body for up to timeoutMs. Keeps a pending read across calls so no chunk is lost. */
function streamReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending: ReturnType<typeof reader.read> | null = null
  return {
    async read(timeoutMs: number): Promise<{ text: string; done: boolean }> {
      let text = ''
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        pending ??= reader.read()
        const r = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())))])
        if (r === null) return { text, done: false }
        pending = null
        if (r.done) return { text, done: true }
        text += decoder.decode(r.value, { stream: true })
      }
      return { text, done: false }
    },
    cancel: () => reader.cancel(),
  }
}

describe('GET /api/stream after the session ends', () => {
  it('closes the stream and stops sending family events once the session is revoked', async () => {
    const streams = new StreamRegistry()
    const h = harness({ app: { streams, pingIntervalMs: 20 } })
    const before = h.t.bus.listenerCount('server_event')
    const res = await h.req('GET', '/api/stream', { as: h.t.wife })
    const reader = streamReader(res.body!)
    expect((await reader.read(50)).text).toContain('"hello"')

    revokeSessions(h.t.db, h.t.clock, h.t.wife.id) // lost phone: `npm run family -- revoke`
    h.t.domain.createItem(h.t.as(h.t.husband), { kind: 'task', title: '秘密礼物' })
    const after = await reader.read(300)
    expect(after.text).not.toContain('board_changed')
    expect(after.done).toBe(true)
    expect(h.t.bus.listenerCount('server_event')).toBe(before)
    expect(streams.size).toBe(0)
  })

  it('also ends when the session expires while connected', async () => {
    const h = harness({ app: { pingIntervalMs: 20 } })
    const res = await h.req('GET', '/api/stream', { as: h.t.wife })
    const reader = streamReader(res.body!)
    await reader.read(30)
    h.t.clock.advance(401 * 24 * 3600 * 1000)
    expect((await reader.read(300)).done).toBe(true)
  })
})

describe('HEAD /api/stream', () => {
  it('does not open a stream nobody can read (Hono drops the body of HEAD responses without cancelling it)', async () => {
    const streams = new StreamRegistry()
    const h = harness({ app: { streams } })
    const before = h.t.bus.listenerCount('server_event')
    for (let i = 0; i < 3; i++) {
      const r = await h.req('HEAD', '/api/stream', { as: h.t.wife })
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('text/event-stream')
    }
    await new Promise(r => setTimeout(r, 10))
    expect(h.t.bus.listenerCount('server_event')).toBe(before)
    expect(streams.size).toBe(0)
  })
})

describe('many SSE clients', () => {
  it('does not trip the EventEmitter leak warning with more than 10 open streams', async () => {
    const warnings: string[] = []
    const onWarning = (w: Error) => warnings.push(w.name)
    process.on('warning', onWarning)
    try {
      const h = harness()
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
      for (let i = 0; i < 14; i++) {
        const res = await h.req('GET', '/api/stream', { as: i % 2 ? h.t.wife : h.t.husband })
        readers.push(res.body!.getReader())
      }
      await new Promise(r => setTimeout(r, 20))
      expect(warnings).not.toContain('MaxListenersExceededWarning')
      for (const r of readers) await r.cancel()
    } finally {
      process.off('warning', onWarning)
    }
  })
})

describe('signed links', () => {
  it("a token without 'view' cannot read the item", async () => {
    const h = harness()
    const item = h.t.domain.createItem(h.t.as(h.t.wife), { kind: 'task', title: '交水费' })
    const e = Math.floor(h.t.clock.now().getTime() / 1000) + 3600
    const token = signLinkToken({ i: item.id, m: h.t.wife.id, a: ['done'], e }, getOrCreateAppSecret(h.t.db))
    const r = await h.json('GET', `/api/t/${token}`)
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('forbidden')
  })
})
