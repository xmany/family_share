// The private chat with the assistant over HTTP: nothing a member says there reaches another member's phone —
// not through the board, the live stream, the undo route or a forged clarification answer.

import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '../../shared/api'
import type { Utterance } from '../../shared/types'
import type { SttProvider } from '../stt/types'
import { eventVisibleTo } from './sse'
import { harness } from './testkit'

vi.mock('../wechat/index', () => ({
  handleWechatVerify: vi.fn(),
  handleWechatMessage: vi.fn(),
  createWechatBindCode: vi.fn(),
  getWechatBinding: vi.fn(() => ({ bound: false, mode: 'fallback' })),
}))

/** Reads an SSE body for up to timeoutMs. Keeps a pending read across calls so no chunk is lost. */
function streamReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending: ReturnType<typeof reader.read> | null = null
  return {
    async read(timeoutMs: number): Promise<string> {
      let text = ''
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        pending ??= reader.read()
        const r = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())))])
        if (r === null) return text
        pending = null
        if (r.done) return text
        text += decoder.decode(r.value, { stream: true })
      }
      return text
    },
    cancel: () => reader.cancel(),
  }
}

const SECRET = '给老公准备生日惊喜'

describe('POST /api/utterances with visibility', () => {
  it("a private utterance is on my board and not on anyone else's; its item is on both", async () => {
    const h = harness()
    const { wife, husband } = h.t
    const r = await h.json('POST', '/api/utterances', { as: wife, body: { text: SECRET, visibility: 'private' } })
    expect(r.status).toBe(200)
    expect(r.body.utterance.visibility).toBe('private')
    expect(h.interpreter.calls[0]).toMatchObject({ memberId: wife.id, visibility: 'private' })

    const mine = await h.json('GET', '/api/board', { as: wife })
    expect(mine.body.utterances.map((u: Utterance) => u.text)).toEqual([SECRET])

    const his = await h.json('GET', '/api/board', { as: husband })
    expect(his.body.utterances).toEqual([])
    // the board itself is shared: the item the assistant made is there for everyone
    expect(his.body.items.map((i: { id: string }) => i.id)).toContain(r.body.items[0].id)
    expect(JSON.stringify(his.body.utterances)).not.toContain('惊喜')
  })

  it('without visibility it goes to the family chat, as before', async () => {
    const h = harness()
    const r = await h.json('POST', '/api/utterances', { as: h.t.wife, body: { text: '周六去公园' } })
    expect(r.body.utterance.visibility).toBe('family')
    const his = await h.json('GET', '/api/board', { as: h.t.husband })
    expect(his.body.utterances.map((u: Utterance) => u.text)).toEqual(['周六去公园'])
  })

  it('rejects an unknown visibility instead of guessing a chat', async () => {
    const h = harness()
    const r = await h.json('POST', '/api/utterances', { as: h.t.wife, body: { text: SECRET, visibility: 'secret' } })
    expect(r.status).toBe(400)
    expect(h.interpreter.calls).toEqual([])
  })
})

describe('GET /api/me', () => {
  it('says this server keeps private utterances private (the web app offers the private chat only then)', async () => {
    const h = harness()
    expect((await h.json('GET', '/api/me', { as: h.t.wife })).body.privateChat).toBe(true)
  })
})

describe('POST /api/utterances/voice with visibility', () => {
  const stt: SttProvider = { name: 'fake', transcribe: async () => ({ text: SECRET, rawText: SECRET, provider: 'fake' }) }
  const form = (visibility?: string) => {
    const fd = new FormData()
    fd.append('audio', new Blob(['opus'], { type: 'audio/webm' }), 'voice.webm')
    if (visibility !== undefined) fd.append('visibility', visibility)
    return fd
  }

  it('a recording made in the private chat stays private', async () => {
    const h = harness({ stt })
    const r = await h.json('POST', '/api/utterances/voice', { as: h.t.wife, form: form('private') })
    expect(r.status).toBe(200)
    expect(r.body.utterance.visibility).toBe('private')
    expect((await h.json('GET', '/api/board', { as: h.t.husband })).body.utterances).toEqual([])
  })

  it('no field = the family chat; a value it cannot read is refused before anything is recorded', async () => {
    const h = harness({ stt })
    expect((await h.json('POST', '/api/utterances/voice', { as: h.t.wife, form: form() })).body.utterance.visibility).toBe('family')
    const bad = await h.json('POST', '/api/utterances/voice', { as: h.t.wife, form: form('privat') })
    expect(bad.status).toBe(400)
    expect(h.interpreter.calls).toHaveLength(1)
  })
})

describe("another member and someone's private utterance", () => {
  it('undo answers 404 exactly as for an unknown id, and changes nothing', async () => {
    const h = harness()
    const { wife, husband } = h.t
    const r = await h.json('POST', '/api/utterances', { as: wife, body: { text: SECRET, visibility: 'private' } })
    const uid = r.body.utterance.id as string

    const his = await h.json('POST', `/api/utterances/${uid}/undo`, { as: husband })
    const unknown = await h.json('POST', '/api/utterances/u_doesnotexist/undo', { as: husband })
    expect(his.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(his.body.error.code).toBe(unknown.body.error.code)
    expect(JSON.stringify(his.body)).not.toContain('惊喜')
    expect(h.t.domain.getUtterance(uid)!.status).toBe('done')

    const hers = await h.json('POST', `/api/utterances/${uid}/undo`, { as: wife })
    expect(hers.status).toBe(200)
    expect(hers.body.utterance.status).toBe('undone')
  })
})

describe('GET /api/stream and private utterances', () => {
  it("delivers a private utterance to its owner's stream only; board changes still reach everyone", async () => {
    const h = harness({ app: { pingIntervalMs: 60_000 } })
    const { wife, husband } = h.t
    const hers = streamReader((await h.req('GET', '/api/stream', { as: wife })).body!)
    const his = streamReader((await h.req('GET', '/api/stream', { as: husband })).body!)
    expect(await hers.read(50)).toContain('"hello"')
    expect(await his.read(50)).toContain('"hello"')

    await h.json('POST', '/api/utterances', { as: wife, body: { text: SECRET, visibility: 'private' } })
    const herText = await hers.read(100)
    const hisText = await his.read(100)
    expect(herText).toContain('"type":"utterance"')
    expect(herText).toContain('惊喜')
    expect(hisText).not.toContain('"type":"utterance"')
    // FakeInterpreter titles the item with the utterance text; the event itself carries ids only
    expect(hisText).toContain('"type":"board_changed"')
    expect(hisText).not.toContain('惊喜')

    await h.json('POST', '/api/utterances', { as: wife, body: { text: '周六去公园' } })
    expect(await his.read(100)).toContain('周六去公园')
    await hers.cancel()
    await his.cancel()
  })

  it('eventVisibleTo: only a private utterance is restricted, and never to a stream without a member', () => {
    const u = (visibility: 'family' | 'private'): ServerEvent => ({
      type: 'utterance',
      utterance: { id: 'u_1', memberId: 'm_wife', source: 'text', visibility, text: 'x', reply: null, status: 'done', clarification: null, changes: [], error: null, createdAt: '2026-10-21T01:00:00.000Z' },
    })
    expect(eventVisibleTo(u('family'), 'm_husband')).toBe(true)
    expect(eventVisibleTo(u('family'), undefined)).toBe(true)
    expect(eventVisibleTo(u('private'), 'm_wife')).toBe(true)
    expect(eventVisibleTo(u('private'), 'm_husband')).toBe(false)
    expect(eventVisibleTo(u('private'), undefined)).toBe(false)
    expect(eventVisibleTo(u('private'), null)).toBe(false)
    expect(eventVisibleTo({ type: 'board_changed', itemIds: ['i_1'], utteranceId: 'u_1', byMemberId: 'm_wife' }, 'm_husband')).toBe(true)
    expect(eventVisibleTo({ type: 'ping' }, undefined)).toBe(true)
  })
})
