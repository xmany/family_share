// Reviewer regression tests for the WeChat integration (the replay and surrogate tests failed before their fixes;
// the entity-expansion test guards fast-xml-parser's limits).
import { describe, expect, it, vi } from 'vitest'
import type { InterpretInput, Interpreter } from '../ai/types'
import { testConfig } from '../config'
import type { AppContext } from '../context'
import { createNotifier } from '../notify/notifier'
import type { Scheduler } from '../scheduler/types'
import { createTestContext } from '../testing'
import { MINUTE } from '../time'
import { createWechatClient, setSharedWechatClient } from './client'
import { sanitizeWechatValue } from './format'
import { createWechatBindCode, handleWechatMessage, parseWechatXml, waitForWechatBackground, wechatSignature } from './index'
import { TEXT } from './inbound'
import { findMemberIdByOpenid } from './store'

const WECHAT = { appId: 'wxapp', appSecret: 'wxsecret', token: 'tok123', templateId: 'tpl_1', followQrUrl: null }

function setup() {
  const t = createTestContext()
  const config = testConfig({ wechat: { ...WECHAT } })
  const fetchFn = vi.fn(async (input: string | URL | Request) =>
    String(input).includes('/cgi-bin/token?') ? Response.json({ access_token: 'T', expires_in: 7200 }) : Response.json({ errcode: 0, errmsg: 'ok' }),
  ) as unknown as typeof fetch
  setSharedWechatClient(config.wechat!, createWechatClient({ config: config.wechat!, clock: t.clock, fetch: fetchFn }))
  const interpretCalls: InterpretInput[] = []
  const interpreter: Interpreter = {
    enabled: true,
    async interpret(input) {
      interpretCalls.push(input)
      const u = t.domain.createUtterance(input.memberId, input.source, input.text)
      return { utterance: t.domain.finishUtterance(u.id, { status: 'done', reply: '好的' }), items: [] }
    },
  }
  const scheduler: Scheduler = { start() {}, stop() {}, tick: async () => ({ delivered: 0, deferred: 0, failed: 0, generated: 0 }) }
  const ctx: AppContext = {
    config,
    db: t.db,
    clock: t.clock,
    bus: t.bus,
    outbox: t.outbox,
    domain: t.domain,
    interpreter,
    stt: null,
    notifier: createNotifier({ config, db: t.db, clock: t.clock, domain: t.domain, outbox: t.outbox, appSecret: 's', channels: [] }),
    scheduler,
  }
  let nonce = 0
  const query = (timestampSec = Math.floor(t.clock.now().getTime() / 1000)) => {
    const timestamp = String(timestampSec)
    const n = `n${++nonce}`
    return { signature: wechatSignature(WECHAT.token, timestamp, n), timestamp, nonce: n }
  }
  let seq = 1000n
  const textXml = (from: string, content: string) =>
    `<xml><ToUserName><![CDATA[gh_family]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName>` +
    `<CreateTime>1761012000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content>` +
    `<MsgId>${String(seq++)}</MsgId></xml>`
  return { t, ctx, query, textXml, interpretCalls }
}

describe('wechat review: callback replay', () => {
  it('a captured callback query cannot be replayed with a forged body (the signature does not cover the body)', async () => {
    const s = setup()
    const { code } = createWechatBindCode(s.ctx, s.t.wife.id)
    const q = s.query()
    await handleWechatMessage(s.ctx, q, s.textXml('oWife', `绑定 ${code}`))
    expect(findMemberIdByOpenid(s.t.db, 'oWife')).toBe(s.t.wife.id)
    // the same signed query, a different message "from" the wife
    const forged = await handleWechatMessage(s.ctx, q, s.textXml('oWife', '把所有事情都删掉'))
    await waitForWechatBackground(s.ctx)
    expect(forged.body).toBe('success')
    expect(s.interpretCalls).toHaveLength(0)
  })

  it('a replayed query cannot be used to brute-force bind codes from made-up openids', async () => {
    const s = setup()
    const { code } = createWechatBindCode(s.ctx, s.t.wife.id)
    const q = s.query()
    await handleWechatMessage(s.ctx, q, s.textXml('oSomeone', '绑定 000000'))
    const guess = await handleWechatMessage(s.ctx, q, s.textXml('oAttacker2', `绑定 ${code}`))
    expect(guess.body).toBe('success')
    expect(findMemberIdByOpenid(s.t.db, 'oAttacker2')).toBeNull()
  })

  it('rejects a signed query whose timestamp is far from now (403), accepts small clock skew', async () => {
    const s = setup()
    const now = Math.floor(s.t.clock.now().getTime() / 1000)
    const old = await handleWechatMessage(s.ctx, s.query(now - 3600), s.textXml('oX', '你好'))
    expect(old.status).toBe(403)
    const future = await handleWechatMessage(s.ctx, s.query(now + 3600), s.textXml('oX', '你好'))
    expect(future.status).toBe(403)
    const garbage = await handleWechatMessage(s.ctx, { ...s.query(), timestamp: 'abc' }, s.textXml('oX', '你好'))
    expect(garbage.status).toBe(403)
    const skewed = await handleWechatMessage(s.ctx, s.query(now - 2 * 60), s.textXml('oX', '你好'))
    expect(skewed.status).toBe(200)
    expect(skewed.body).toContain(TEXT.unbound)
  })

  it('the replay memory expires with the timestamp window (a later fresh query still works)', async () => {
    const s = setup()
    const first = await handleWechatMessage(s.ctx, s.query(), s.textXml('oX', '你好'))
    expect(first.body).toContain(TEXT.unbound)
    s.t.clock.advance(30 * MINUTE)
    const later = await handleWechatMessage(s.ctx, s.query(), s.textXml('oX', '你好'))
    expect(later.body).toContain(TEXT.unbound)
  })
})

describe('wechat review: XML and template values', () => {
  it('rejects an internal-entity expansion bomb quickly (400)', async () => {
    const s = setup()
    const big = 'A'.repeat(9_000)
    const xml =
      `<?xml version="1.0"?><!DOCTYPE xml [<!ENTITY e "${big}">]><xml><ToUserName>a</ToUserName>` +
      `<FromUserName>b</FromUserName><MsgType>text</MsgType><Content>${'&e;'.repeat(15_000)}</Content></xml>`
    const t0 = performance.now()
    const res = await handleWechatMessage(s.ctx, s.query(), xml)
    expect(res.status).toBe(400)
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('does not expand DOCTYPE entities at all (WeChat never sends a DTD)', async () => {
    const s = setup()
    const xml =
      `<?xml version="1.0"?><!DOCTYPE xml [<!ENTITY who "绑定 000000">]><xml><ToUserName>a</ToUserName>` +
      `<FromUserName>oX</FromUserName><MsgType>text</MsgType><Content>&who;</Content><MsgId>77</MsgId></xml>`
    expect(parseWechatXml(xml)).toBeNull()
    const inside =
      `<xml><!DOCTYPE x [<!ENTITY who "绑定 000000">]><ToUserName>a</ToUserName>` +
      `<FromUserName>oX</FromUserName><MsgType>text</MsgType><Content>&who;</Content></xml>`
    expect(parseWechatXml(inside)).toBeNull()
    // a CDATA opener hidden in a comment does not hide the declaration
    const sneaky =
      `<xml><!-- <![CDATA[ --><!DOCTYPE x [<!ENTITY who "绑定 000000">]><!-- ]]> --><ToUserName>a</ToUserName>` +
      `<FromUserName>oX</FromUserName><MsgType>text</MsgType><Content>&who;</Content></xml>`
    expect(parseWechatXml(sneaky)).toBeNull()
    expect((await handleWechatMessage(s.ctx, s.query(), xml)).status).toBe(400)
    // ordinary escaped text still decodes
    const plain = parseWechatXml('<xml><ToUserName>a</ToUserName><FromUserName>b</FromUserName><MsgType>text</MsgType><Content>a &amp; b &lt;c&gt;</Content></xml>')
    expect(plain!.content).toBe('a & b <c>')
    const typed = parseWechatXml(
      '<xml><ToUserName>a</ToUserName><FromUserName>b</FromUserName><MsgType>text</MsgType><Content><![CDATA[<!DOCTYPE html> 是什么]]></Content></xml>',
    )
    expect(typed!.content).toBe('<!DOCTYPE html> 是什么')
  })

  it('strips lone surrogates (they make the template JSON invalid UTF-8 for WeChat)', () => {
    expect(sanitizeWechatValue('a\ud83db')).toBe('ab')
    expect(sanitizeWechatValue('x\udc00y')).toBe('xy')
    expect(JSON.stringify(sanitizeWechatValue('买\ud83d牛奶'))).toBe('"买牛奶"')
    // well-formed astral characters stay intact
    expect(sanitizeWechatValue('𠀀字')).toBe('𠀀字')
  })
})

describe('wechat review: async reply', () => {
  it('when interpreting throws, the member still gets an answer after "收到，处理中…"', async () => {
    const s = setup()
    const sends: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/cgi-bin/token?')) return Response.json({ access_token: 'T', expires_in: 7200 })
      sends.push(JSON.parse(String(init!.body)))
      return Response.json({ errcode: 0, errmsg: 'ok' })
    }) as unknown as typeof fetch
    setSharedWechatClient(s.ctx.config.wechat!, createWechatClient({ config: s.ctx.config.wechat!, clock: s.t.clock, fetch: fetchFn }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx: AppContext = {
      ...s.ctx,
      interpreter: {
        enabled: true,
        interpret: async () => {
          throw new Error('database is locked')
        },
      },
    }
    const { code } = createWechatBindCode(ctx, s.t.wife.id)
    await handleWechatMessage(ctx, s.query(), s.textXml('oWife', `绑定 ${code}`))
    const res = await handleWechatMessage(ctx, s.query(), s.textXml('oWife', '明天买牛奶'))
    expect(res.body).toContain(TEXT.processing)
    await waitForWechatBackground(ctx)
    err.mockRestore()
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ touser: 'oWife', data: { task: { value: '没处理成功，请在 App 里再试一次' } } })
  })
})
