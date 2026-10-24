// Regression tests: no request body is read (and buffered) before the cheap checks pass. Hono's bodyLimit reads a body
// sent without Content-Length (chunked, or HTTP/2 through Funnel) into memory up to the limit before calling next(),
// so with the limit in front of the CSRF + session checks anyone on the public URL could make the server hold up to
// 10.5 MB per connection and only then get a 401. The same held for /wechat/mp before its signature check.

import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { describe, expect, it, vi } from 'vitest'
import { wechatSignature } from '../wechat/inbound'
import { harness } from './testkit'

const { handleWechatMessage } = vi.hoisted(() => ({
  handleWechatMessage: vi.fn(async (_ctx: unknown, _q: Record<string, string>, raw: string) => ({
    status: 200,
    body: `len ${raw.length}`,
    contentType: 'text/plain; charset=utf-8',
  })),
}))

// the real query checks (signature, timestamp); only the message handler is replaced
vi.mock('../wechat/index', async importOriginal => ({
  ...(await importOriginal<typeof import('../wechat/index')>()),
  handleWechatMessage,
}))

const CHUNK = 64 * 1024
const WECHAT = { appId: 'wxapp', appSecret: 'wxsecret', token: 'tok123', templateId: 'tpl_1', followQrUrl: null }

/** A body with no Content-Length that records how much of it the server pulled. */
function streamedBody(total: number) {
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close()
      const n = Math.min(CHUNK, total - pulled)
      pulled += n
      controller.enqueue(new Uint8Array(n).fill(120))
    },
  })
  return { stream, pulled: () => pulled }
}

function streamedRequest(path: string, total: number, headers: Record<string, string> = {}) {
  const body = streamedBody(total)
  const req = new Request(`http://localhost${path}`, { method: 'POST', headers, body: body.stream, duplex: 'half' } as RequestInit)
  expect(req.headers.has('content-length')).toBe(false)
  return { req, pulled: body.pulled }
}

describe('request bodies are not read before the CSRF and session checks', () => {
  it('turns away an unauthenticated or unmarked streamed upload without reading it', async () => {
    const h = harness()
    const cases: { path: string; headers: Record<string, string>; status: number }[] = [
      { path: '/api/utterances/voice', headers: { 'X-Family-Share': '1', 'Content-Type': 'multipart/form-data; boundary=x' }, status: 401 },
      { path: '/api/items', headers: { 'X-Family-Share': '1', 'Content-Type': 'application/json' }, status: 401 },
      { path: '/api/members', headers: { 'X-Family-Share': '1', Cookie: 'fs_session=not-a-session' }, status: 401 },
      // a member's cookie but no CSRF header (a cross-site form post)
      { path: '/api/utterances/voice', headers: { Cookie: h.cookieFor(h.t.wife) }, status: 403 },
    ]
    for (const tc of cases) {
      const { req, pulled } = streamedRequest(tc.path, 4 * 1024 * 1024, tc.headers)
      const res = await h.app.request(req)
      expect(res.status, tc.path).toBe(tc.status)
      // at most what the stream queues up on its own; reading it first would pull 1–4 MB
      expect(pulled(), tc.path).toBeLessThanOrEqual(2 * CHUNK)
    }
  })

  it('still limits a member’s streamed body, and the routes without a session to 32 KB', async () => {
    const h = harness()
    const member = { 'X-Family-Share': '1', 'Content-Type': 'application/json', Cookie: h.cookieFor(h.t.wife) }
    let r = streamedRequest('/api/items', 2 * 1024 * 1024, member)
    let res = await h.app.request(r.req)
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('too_large')
    expect(r.pulled()).toBeLessThanOrEqual(1024 * 1024 + 2 * CHUNK)

    // join, logout and signed-link actions run without a session: they get a small limit
    for (const path of ['/api/auth/join', '/api/auth/logout', '/api/t/abc.def/action']) {
      r = streamedRequest(path, 1024 * 1024, { 'X-Family-Share': '1', 'Content-Type': 'application/json' })
      res = await h.app.request(r.req)
      expect(res.status, path).toBe(413)
      expect(r.pulled(), path).toBeLessThanOrEqual(32 * 1024 + 2 * CHUNK)
    }
    // a normal join still works
    const join = await h.json('POST', '/api/auth/join', { body: { token: h.inviteFor(h.t.wife) } })
    expect(join.status).toBe(200)
  })

  it('answers 401 while a chunked upload is still being sent (real listener)', async () => {
    const h = harness()
    const server = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' })
    try {
      await new Promise<void>(resolve => (server.listening ? resolve() : server.once('listening', () => resolve())))
      const { port } = server.address() as AddressInfo
      const status = await new Promise<number | string>(resolve => {
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          path: '/api/utterances/voice',
          method: 'POST',
          headers: { 'X-Family-Share': '1', 'Content-Type': 'multipart/form-data; boundary=x', 'Transfer-Encoding': 'chunked' },
        })
        const timer = setTimeout(() => {
          req.destroy()
          resolve('no answer before the upload finished')
        }, 3000)
        req.on('response', res => {
          clearTimeout(timer)
          res.resume()
          req.destroy()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', () => undefined)
        // the upload is never finished: the server must answer from the headers alone
        req.write(Buffer.alloc(CHUNK, 120))
      })
      expect(status).toBe(401)
    } finally {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('POST /wechat/mp checks its signature before reading the body', () => {
  const setup = () => {
    handleWechatMessage.mockClear()
    const h = harness({ config: { wechat: { ...WECHAT } } })
    const ts = String(Math.floor(h.t.clock.now().getTime() / 1000))
    const signed = (timestamp = ts, nonce = 'n1') => `signature=${wechatSignature(WECHAT.token, timestamp, nonce)}&timestamp=${timestamp}&nonce=${nonce}`
    return { h, ts, signed }
  }

  it('refuses unsigned, wrongly signed and stale callbacks without reading them', async () => {
    const { h, ts, signed } = setup()
    const stale = String(Number(ts) - 3600)
    for (const query of ['', `signature=deadbeef&timestamp=${ts}&nonce=n1`, signed(stale)]) {
      const { req, pulled } = streamedRequest(`/wechat/mp?${query}`, 1024 * 1024, { 'Content-Type': 'text/xml' })
      const res = await h.app.request(req)
      expect(res.status, query).toBe(403)
      expect(pulled(), query).toBeLessThanOrEqual(2 * CHUNK)
    }
    expect(handleWechatMessage).not.toHaveBeenCalled()
  })

  it('refuses everything when the callback is not configured', async () => {
    handleWechatMessage.mockClear()
    const h = harness()
    const { req, pulled } = streamedRequest('/wechat/mp?signature=a&timestamp=1&nonce=2', 1024 * 1024)
    expect((await h.app.request(req)).status).toBe(503)
    expect(pulled()).toBeLessThanOrEqual(2 * CHUNK)
    expect(handleWechatMessage).not.toHaveBeenCalled()
  })

  it('passes a signed message on, and still limits a signed body to 256 KB', async () => {
    const { h, signed } = setup()
    const xml = '<xml><MsgType><![CDATA[text]]></MsgType></xml>'
    const ok = await h.req('POST', `/wechat/mp?${signed()}&openid=o1`, { csrf: false, body: xml, headers: { 'Content-Type': 'text/xml' } })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe(`len ${xml.length}`)
    expect(handleWechatMessage).toHaveBeenCalledTimes(1)

    const { req, pulled } = streamedRequest(`/wechat/mp?${signed(undefined, 'n2')}`, 1024 * 1024, { 'Content-Type': 'text/xml' })
    expect((await h.app.request(req)).status).toBe(413)
    expect(pulled()).toBeLessThanOrEqual(256 * 1024 + 2 * CHUNK)
    expect(handleWechatMessage).toHaveBeenCalledTimes(1)
  })
})
