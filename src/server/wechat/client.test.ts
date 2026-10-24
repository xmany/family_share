import { describe, expect, it, vi } from 'vitest'
import { FixedClock, MINUTE } from '../time'
import { classifyWechatError, createWechatClient } from './client'

const CONFIG = { appId: 'wxAPP', appSecret: 'S3CRET', token: 'tok', templateId: 'tpl_1', followQrUrl: null }

interface Call {
  url: string
  body: Record<string, unknown> | null
}

/** Scripted WeChat API: token endpoint hands out T1, T2, …; send endpoint answers from `sendCodes` in order. */
function fakeWechat(opts: { sendCodes?: number[]; tokenExpiresIn?: number; tokenError?: { errcode: number; errmsg: string } } = {}) {
  const calls: Call[] = []
  let tokens = 0
  const sendCodes = [...(opts.sendCodes ?? [])]
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.startsWith('https://api.weixin.qq.com/cgi-bin/token?')) {
      if (opts.tokenError) return Response.json(opts.tokenError)
      tokens++
      return Response.json({ access_token: `T${tokens}`, expires_in: opts.tokenExpiresIn ?? 7200 })
    }
    if (url.startsWith('https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=')) {
      const errcode = sendCodes.length ? sendCodes.shift()! : 0
      return Response.json({ errcode, errmsg: errcode ? `err ${errcode}` : 'ok', msgid: 200228332 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return { calls, fetchFn, tokenCalls: () => calls.filter(c => c.url.includes('/cgi-bin/token?')).length }
}

const MSG = {
  touser: 'oWife',
  template_id: 'tpl_1',
  url: 'https://family.test/t/abc',
  client_msg_id: 'nt_1',
  data: { task: { value: '取快递' }, from: { value: '老婆' }, when: { value: '今天 18:00' }, note: { value: '丰巢柜3号' } },
}

describe('wechat client', () => {
  it('fetches the token with appid/secret, caches it, and sends the exact template body', async () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const w = fakeWechat()
    const client = createWechatClient({ config: CONFIG, clock, fetch: w.fetchFn })
    const r1 = await client.sendTemplate(MSG)
    const r2 = await client.sendTemplate(MSG)
    expect(r1).toEqual({ ok: true, errcode: 0, errmsg: 'ok', msgid: '200228332', permanent: false, unbind: false })
    expect(r2.ok).toBe(true)
    expect(w.tokenCalls()).toBe(1)
    expect(w.calls[0]!.url).toBe('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=wxAPP&secret=S3CRET')
    expect(w.calls[1]!.url).toBe('https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=T1')
    expect(w.calls[1]!.body).toEqual(MSG)
  })

  it('refreshes the token 10 minutes before it expires', async () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const w = fakeWechat()
    const client = createWechatClient({ config: CONFIG, clock, fetch: w.fetchFn })
    expect(await client.getAccessToken()).toBe('T1')
    clock.advance(109 * MINUTE)
    expect(await client.getAccessToken()).toBe('T1')
    clock.advance(2 * MINUTE) // 111 min: within the last 10 min of 120
    expect(await client.getAccessToken()).toBe('T2')
    expect(w.tokenCalls()).toBe(2)
  })

  it('shares one in-flight token request between concurrent callers', async () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const w = fakeWechat()
    const client = createWechatClient({ config: CONFIG, clock, fetch: w.fetchFn })
    const [a, b] = await Promise.all([client.getAccessToken(), client.getAccessToken()])
    expect([a, b]).toEqual(['T1', 'T1'])
    expect(w.tokenCalls()).toBe(1)
  })

  it('on 40001 / 42001 refreshes the token and retries once', async () => {
    for (const code of [40001, 42001]) {
      const clock = new FixedClock('2026-10-21T01:00:00.000Z')
      const w = fakeWechat({ sendCodes: [code] })
      const client = createWechatClient({ config: CONFIG, clock, fetch: w.fetchFn })
      const r = await client.sendTemplate(MSG)
      expect(r.ok).toBe(true)
      expect(w.tokenCalls()).toBe(2)
      const sends = w.calls.filter(c => c.url.includes('/template/send'))
      expect(sends.map(s => s.url.split('access_token=')[1])).toEqual(['T1', 'T2'])
    }
  })

  it('retries only once: a second token error is reported', async () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const w = fakeWechat({ sendCodes: [40001, 40001] })
    const client = createWechatClient({ config: CONFIG, clock, fetch: w.fetchFn })
    const r = await client.sendTemplate(MSG)
    expect(r).toMatchObject({ ok: false, errcode: 40001, permanent: false })
    expect(w.calls.filter(c => c.url.includes('/template/send'))).toHaveLength(2)
  })

  it('classifies errors: 43004/40003 unbind, 45009/-1 transient, 47003 permanent and logged', async () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const log = { warn: vi.fn(), error: vi.fn() }
    const w = fakeWechat({ sendCodes: [43004, 40003, 45009, -1, 47003] })
    const client = createWechatClient({ config: CONFIG, clock, fetch: w.fetchFn, log })
    expect(await client.sendTemplate(MSG)).toMatchObject({ ok: false, errcode: 43004, permanent: true, unbind: true })
    expect(await client.sendTemplate(MSG)).toMatchObject({ ok: false, errcode: 40003, permanent: true, unbind: true })
    expect(await client.sendTemplate(MSG)).toMatchObject({ ok: false, errcode: 45009, permanent: false, unbind: false })
    expect(await client.sendTemplate(MSG)).toMatchObject({ ok: false, errcode: -1, permanent: false, unbind: false })
    expect(await client.sendTemplate(MSG)).toMatchObject({ ok: false, errcode: 47003, permanent: true, unbind: false })
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(String(log.error.mock.calls[0]!.slice(1).join(' '))).toContain('取快递')
    expect(classifyWechatError(40037)).toEqual({ permanent: true, unbind: false })
  })

  it('network failures and HTTP errors are transient', async () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const boom = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const r = await createWechatClient({ config: CONFIG, clock, fetch: boom }).sendTemplate(MSG)
    expect(r).toMatchObject({ ok: false, errcode: -1, permanent: false })
    expect(r.errmsg).toContain('fetch failed')
    const http500 = vi.fn(async () => new Response('oops', { status: 502 })) as unknown as typeof fetch
    expect(await createWechatClient({ config: CONFIG, clock, fetch: http500 }).sendTemplate(MSG)).toMatchObject({ ok: false, permanent: false })
  })

  it('a token error (bad secret) is permanent', async () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const w = fakeWechat({ tokenError: { errcode: 40125, errmsg: 'invalid appsecret' } })
    const r = await createWechatClient({ config: CONFIG, clock, fetch: w.fetchFn }).sendTemplate(MSG)
    expect(r).toMatchObject({ ok: false, errcode: 40125, permanent: true })
  })
})
