import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '../../shared/api'
import { StreamRegistry } from './sse'
import { harness } from './testkit'

vi.mock('../wechat/index', () => ({
  handleWechatVerify: vi.fn(),
  handleWechatMessage: vi.fn(),
  createWechatBindCode: vi.fn(),
  getWechatBinding: vi.fn(() => ({ bound: false, mode: 'fallback' })),
}))

function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'family-share-web-'))
  mkdirSync(join(dir, 'assets'))
  mkdirSync(join(dir, 'icons'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>家庭同步</title><div id="root"></div>')
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("push", () => {})')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"家庭同步"}')
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(dir, 'assets', 'index-abc123.css'), 'body{}')
  writeFileSync(join(dir, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return dir
}

describe('static web app (production)', () => {
  it('serves files with the right caching and falls back to index.html for app routes', async () => {
    const h = harness({ app: { webDir: webDir() } })
    const get = (p: string) => h.req('GET', p)

    let r = await get('/')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect(await r.text()).toContain('家庭同步')

    for (const p of ['/board', '/item/i_abc', '/weekly', '/settings', '/join', '/t/eyJpIjoiaV94In0.c2lnbmF0dXJl?from=singlemessage', '/index.html']) {
      r = await get(p)
      expect(r.status, p).toBe(200)
      expect(r.headers.get('cache-control'), p).toBe('no-cache')
      expect(await r.text(), p).toContain('<div id="root">')
    }

    r = await get('/sw.js')
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect(r.headers.get('content-type')).toContain('text/javascript')
    r = await get('/manifest.webmanifest')
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect(r.headers.get('content-type')).toContain('application/manifest+json')

    r = await get('/assets/index-abc123.js')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await r.text()).toBe('console.log(1)')
    expect((await get('/assets/index-abc123.css')).headers.get('content-type')).toContain('text/css')
    expect((await get('/icons/icon-192.png')).headers.get('content-type')).toBe('image/png')

    // a missing hashed asset must not get index.html (the browser would try to run HTML as JS)
    expect((await get('/assets/missing-000.js')).status).toBe(404)
    // traversal never escapes the web root
    r = await get('/..%2f..%2f..%2fetc%2fpasswd')
    expect(await r.text()).not.toContain('root:')

    // API paths are never the SPA
    const api = await h.json('GET', '/api/nope', { as: h.t.husband })
    expect(api.status).toBe(404)
    expect(api.body.error.code).toBe('not_found')
    expect((await get('/wechat/other')).status).toBe(404)
    expect((await h.json('GET', '/healthz')).body).toEqual({ ok: true })
    expect((await get('/')).headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('without a build, non-API paths are a plain 404', async () => {
    const h = harness({ app: { webDir: null } })
    const r = await h.req('GET', '/board')
    expect(r.status).toBe(404)
    expect(await r.text()).toContain('build:web')
  })
})

async function readEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<ServerEvent[]> {
  const decoder = new TextDecoder()
  const events: ServerEvent[] = []
  let buf = ''
  while (events.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = frame
        .split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice(6))
        .join('\n')
      if (data) events.push(JSON.parse(data) as ServerEvent)
    }
  }
  return events
}

describe('GET /api/stream (SSE)', () => {
  it('sends hello, then bus events, pings, and cleans up on disconnect', async () => {
    const streams = new StreamRegistry()
    const h = harness({ app: { streams, pingIntervalMs: 20 } })
    const before = h.t.bus.listenerCount('server_event')
    const res = await h.req('GET', '/api/stream?from=pwa', { as: h.t.wife })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toContain('no-cache')
    const reader = res.body!.getReader()

    const [hello] = await readEvents(reader, 1)
    expect(hello).toEqual({ type: 'hello', serverTime: '2026-10-21T01:00:00.000Z' })
    expect(h.t.bus.listenerCount('server_event')).toBe(before + 1)
    expect(streams.size).toBe(1)

    const item = h.t.domain.createItem(h.t.as(h.t.husband), { kind: 'task', title: '买菜' })
    const next = await readEvents(reader, 1)
    expect(next[0]).toMatchObject({ type: 'board_changed', itemIds: [item.id], byMemberId: h.t.husband.id })

    const pings = await readEvents(reader, 2)
    expect(pings.some(e => e.type === 'ping')).toBe(true)

    await reader.cancel()
    expect(h.t.bus.listenerCount('server_event')).toBe(before)
    expect(streams.size).toBe(0)
  })

  it('StreamRegistry.closeAll ends open streams (graceful shutdown)', async () => {
    const streams = new StreamRegistry()
    const h = harness({ app: { streams } })
    const before = h.t.bus.listenerCount('server_event')
    const res = await h.req('GET', '/api/stream', { as: h.t.husband })
    const reader = res.body!.getReader()
    await readEvents(reader, 1)
    streams.closeAll()
    let done = false
    for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done
    expect(done).toBe(true)
    expect(h.t.bus.listenerCount('server_event')).toBe(before)
  })
})
