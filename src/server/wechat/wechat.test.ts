import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { InterpretInput, Interpreter } from '../ai/types'
import type { UtteranceResponse } from '../../shared/api'
import { testConfig } from '../config'
import type { AppContext } from '../context'
import { DomainError } from '../domain/types'
import { createNotifier } from '../notify/notifier'
import type { Scheduler } from '../scheduler/types'
import { createTestContext } from '../testing'
import { verifyLinkToken, getOrCreateAppSecret } from '../tokens'
import { MINUTE } from '../time'
import { createWechatClient, setSharedWechatClient } from './client'
import {
  createWechatBindCode,
  getWechatBinding,
  handleWechatMessage,
  handleWechatVerify,
  parseBindCommand,
  parseWechatXml,
  passiveTextReply,
  waitForWechatBackground,
  wechatSignature,
} from './index'
import { TEXT } from './inbound'
import { findMemberIdByOpenid, readWechatBinding } from './store'

const WECHAT = { appId: 'wxapp', appSecret: 'wxsecret', token: 'tok123', templateId: 'tpl_1', followQrUrl: null }

function setup(opts: { interpret?: (input: InterpretInput, t: ReturnType<typeof createTestContext>) => Promise<UtteranceResponse> } = {}) {
  const t = createTestContext()
  const config = testConfig({ wechat: { ...WECHAT } })
  const sends: Record<string, unknown>[] = []
  const sendCodes: number[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/cgi-bin/token?')) return Response.json({ access_token: 'TOKEN', expires_in: 7200 })
    sends.push(JSON.parse(String(init!.body)))
    const errcode = sendCodes.shift() ?? 0
    return Response.json({ errcode, errmsg: errcode ? 'err' : 'ok', msgid: 1 })
  }) as unknown as typeof fetch
  setSharedWechatClient(config.wechat!, createWechatClient({ config: config.wechat!, clock: t.clock, fetch: fetchFn }))

  const interpretCalls: InterpretInput[] = []
  const interpreter: Interpreter = {
    enabled: true,
    async interpret(input) {
      interpretCalls.push(input)
      if (opts.interpret) return opts.interpret(input, t)
      const u = t.domain.createUtterance(input.memberId, input.source, input.text)
      const item = t.domain.createItem({ type: 'ai', memberId: input.memberId, utteranceId: u.id }, { kind: 'task', title: '买牛奶', dueDate: '2026-10-22' })
      const done = t.domain.finishUtterance(u.id, { status: 'done', reply: '好的，明天买牛奶。' })
      return { utterance: done, items: [item] }
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
  const signedQuery = (extra: Record<string, string> = {}) => {
    const timestamp = String(Math.floor(t.clock.now().getTime() / 1000))
    const n = `n${++nonce}`
    return { signature: wechatSignature(WECHAT.token, timestamp, n), timestamp, nonce: n, openid: 'ignored', ...extra }
  }
  let msgSeq = 24567890123456789n
  const textXml = (from: string, content: string, msgId = String(msgSeq++)) =>
    `<xml><ToUserName><![CDATA[gh_family]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName>` +
    `<CreateTime>1761012000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content>` +
    `<MsgId>${msgId}</MsgId></xml>`
  const eventXml = (from: string, event: string, createTime = '1761012000') =>
    `<xml><ToUserName><![CDATA[gh_family]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName>` +
    `<CreateTime>${createTime}</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${event}]]></Event></xml>`
  const voiceXml = (from: string) =>
    `<xml><ToUserName><![CDATA[gh_family]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName>` +
    `<CreateTime>1761012001</CreateTime><MsgType><![CDATA[voice]]></MsgType><MediaId><![CDATA[media1]]></MediaId>` +
    `<Format><![CDATA[amr]]></Format><MsgId>${String(msgSeq++)}</MsgId></xml>`
  const post = (xml: string, query = signedQuery()) => handleWechatMessage(ctx, query, xml)
  const contentOf = (body: string) => parseWechatXml(body)!.content
  return { t, ctx, sends, sendCodes, fetchFn, interpretCalls, signedQuery, textXml, eventXml, voiceXml, post, contentOf }
}

async function bindViaWechat(s: ReturnType<typeof setup>, memberId: string, openid: string) {
  const { code } = createWechatBindCode(s.ctx, memberId)
  const res = await s.post(s.textXml(openid, `绑定 ${code}`))
  expect(s.contentOf(res.body)).toBe(TEXT.bindOk)
}

describe('GET verify', () => {
  it('echoes echostr for a valid signature, 403 otherwise, 503 when not configured', () => {
    const s = setup()
    const q = s.signedQuery({ echostr: '8261453290' })
    expect(handleWechatVerify(s.ctx, q)).toEqual({ status: 200, body: '8261453290' })
    expect(handleWechatVerify(s.ctx, { ...q, signature: 'deadbeef' }).status).toBe(403)
    expect(handleWechatVerify(s.ctx, { ...q, nonce: 'other' }).status).toBe(403)
    expect(handleWechatVerify(s.ctx, { echostr: 'x' }).status).toBe(403)
    const unconfigured = { ...s.ctx, config: testConfig() }
    expect(handleWechatVerify(unconfigured, q).status).toBe(503)
    const noToken = { ...s.ctx, config: testConfig({ wechat: { ...WECHAT, token: null } }) }
    expect(handleWechatVerify(noToken, q).status).toBe(503)
  })

  it('signature = sha1 of the sorted token, timestamp, nonce', () => {
    // sort(['tok123', '1761012000', 'abc']) = ['1761012000', 'abc', 'tok123']
    expect(wechatSignature('tok123', '1761012000', 'abc')).toBe(createHash('sha1').update('1761012000abctok123').digest('hex'))
  })
})

describe('POST messages', () => {
  it('rejects a bad signature (403) and bad XML (400)', async () => {
    const s = setup()
    expect((await s.post(s.textXml('oA', 'hi'), { ...s.signedQuery(), signature: 'nope' })).status).toBe(403)
    expect((await s.post('not xml at all')).status).toBe(400)
  })

  it('subscribe → passive reply with binding instructions (To/From swapped, CDATA)', async () => {
    const s = setup()
    const res = await s.post(s.eventXml('oNew', 'subscribe'))
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('xml')
    expect(res.body).toBe(
      `<xml><ToUserName><![CDATA[oNew]]></ToUserName><FromUserName><![CDATA[gh_family]]></FromUserName>` +
        `<CreateTime>${Math.floor(s.t.clock.now().getTime() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType>` +
        `<Content><![CDATA[${TEXT.subscribe}]]></Content></xml>`,
    )
  })

  it('bind flow: code → "绑定 123456" → openid stored → 绑定成功', async () => {
    const s = setup()
    const bc = createWechatBindCode(s.ctx, s.t.husband.id)
    expect(bc.code).toMatch(/^\d{6}$/)
    expect(bc.instructions).toBe(`关注测试号后，发送：绑定 ${bc.code}`)
    expect(bc.expiresAt).toBe(new Date(s.t.clock.now().getTime() + 30 * MINUTE).toISOString())
    expect(getWechatBinding(s.ctx, s.t.husband.id)).toEqual({ bound: false, mode: 'fallback' })

    const res = await s.post(s.textXml('oHusband', `绑定 ${bc.code}`))
    expect(s.contentOf(res.body)).toBe('绑定成功，以后提醒会发到这里。')
    expect(getWechatBinding(s.ctx, s.t.husband.id)).toEqual({ bound: true, mode: 'fallback' })
    expect(findMemberIdByOpenid(s.t.db, 'oHusband')).toBe(s.t.husband.id)
    expect(s.interpretCalls).toHaveLength(0)

    // single use
    const again = await s.post(s.textXml('oOther', `绑定 ${bc.code}`))
    expect(s.contentOf(again.body)).toBe(TEXT.bindBad)
    // subscribing again: welcome back
    expect(s.contentOf((await s.post(s.eventXml('oHusband', 'subscribe', '1761012999'))).body)).toBe(TEXT.welcomeBack)
  })

  it('accepts 绑定123456 and full-width digits; rejects expired codes', async () => {
    const s = setup()
    const a = createWechatBindCode(s.ctx, s.t.husband.id)
    const fullWidth = a.code.replace(/\d/g, d => String.fromCharCode(0xff10 + Number(d)))
    expect(s.contentOf((await s.post(s.textXml('oH', `绑定${fullWidth}`))).body)).toBe(TEXT.bindOk)
    const b = createWechatBindCode(s.ctx, s.t.wife.id)
    expect(s.contentOf((await s.post(s.textXml('oW', `绑定${b.code}`))).body)).toBe(TEXT.bindOk)
    const c = createWechatBindCode(s.ctx, s.t.wife.id)
    s.t.clock.advance(31 * MINUTE)
    expect(s.contentOf((await s.post(s.textXml('oW2', `绑定 ${c.code}`))).body)).toBe(TEXT.bindBad)
    expect(s.contentOf((await s.post(s.textXml('oW2', '绑定 12345'))).body)).toBe(TEXT.bindMalformed)
  })

  it('a new code replaces the member’s previous unused one', async () => {
    const s = setup()
    const first = createWechatBindCode(s.ctx, s.t.wife.id)
    const second = createWechatBindCode(s.ctx, s.t.wife.id)
    if (first.code !== second.code) expect(s.contentOf((await s.post(s.textXml('oW', `绑定 ${first.code}`))).body)).toBe(TEXT.bindBad)
    expect(s.contentOf((await s.post(s.textXml('oW', `绑定 ${second.code}`))).body)).toBe(TEXT.bindOk)
  })

  it('binding an openid to another member unbinds the previous one', async () => {
    const s = setup()
    await bindViaWechat(s, s.t.husband.id, 'oShared')
    await bindViaWechat(s, s.t.wife.id, 'oShared')
    expect(getWechatBinding(s.ctx, s.t.husband.id).bound).toBe(false)
    expect(getWechatBinding(s.ctx, s.t.wife.id).bound).toBe(true)
    expect(findMemberIdByOpenid(s.t.db, 'oShared')).toBe(s.t.wife.id)
  })

  it('limits failed bind attempts per openid', async () => {
    const s = setup()
    for (let i = 0; i < 5; i++) expect(s.contentOf((await s.post(s.textXml('oBrute', `绑定 00000${i}`))).body)).toBe(TEXT.bindBad)
    const real = createWechatBindCode(s.ctx, s.t.wife.id)
    expect(s.contentOf((await s.post(s.textXml('oBrute', `绑定 ${real.code}`))).body)).toBe(TEXT.bindTooMany)
    s.t.clock.advance(61 * MINUTE)
    const fresh = createWechatBindCode(s.ctx, s.t.wife.id)
    expect(s.contentOf((await s.post(s.textXml('oBrute', `绑定 ${fresh.code}`))).body)).toBe(TEXT.bindOk)
  })

  it('dedupes WeChat retries on MsgId (and events on FromUserName+CreateTime+Event)', async () => {
    const s = setup()
    await bindViaWechat(s, s.t.wife.id, 'oWife')
    const xml = s.textXml('oWife', '明天买牛奶', '99887766554433221100')
    const first = await s.post(xml)
    const retry = await s.post(xml)
    expect(s.contentOf(first.body)).toBe(TEXT.processing)
    expect(retry).toEqual({ status: 200, body: 'success', contentType: 'text/plain; charset=utf-8' })
    await waitForWechatBackground(s.ctx)
    expect(s.interpretCalls).toHaveLength(1)
    const ev = s.eventXml('oX', 'subscribe', '1761019999')
    expect((await s.post(ev)).body).toContain('CDATA')
    expect((await s.post(ev)).body).toBe('success')
  })

  it('text from a bound openid → 收到，处理中… → interpreter → template reply', async () => {
    const s = setup()
    await bindViaWechat(s, s.t.wife.id, 'oWife')
    const res = await s.post(s.textXml('oWife', '明天记得买牛奶'))
    expect(s.contentOf(res.body)).toBe('收到，处理中…')
    expect(s.interpretCalls).toHaveLength(0) // runs after the reply
    await waitForWechatBackground(s.ctx)
    expect(s.interpretCalls).toEqual([{ memberId: s.t.wife.id, text: '明天记得买牛奶', source: 'wechat', replyToUtteranceId: null }])
    expect(s.sends).toHaveLength(1)
    const sent = s.sends[0]!
    const utterance = s.t.domain.recentUtterances(1)[0]!
    expect(sent).toMatchObject({
      touser: 'oWife',
      template_id: 'tpl_1',
      client_msg_id: utterance.id,
      data: {
        task: { value: '好的，明天买牛奶。' },
        from: { value: '家庭助手' },
        when: { value: '今天 12:00' },
        note: { value: '新建待办：买牛奶（明天）' },
      },
    })
    const url = String(sent.url)
    expect(url.startsWith('https://family.test/t/')).toBe(true)
    const link = verifyLinkToken(url.slice('https://family.test/t/'.length), getOrCreateAppSecret(s.t.db), s.t.clock.now())
    expect(link).toMatchObject({ i: utterance.changes[0]!.itemId, m: s.t.wife.id, a: ['done', 'view'] })
  })

  it('a clarification goes back as question + options, and the next text answers it', async () => {
    let round = 0
    const s = setup({
      interpret: async (input, t) => {
        round++
        const u = t.domain.createUtterance(input.memberId, input.source, input.text, { replyTo: input.replyToUtteranceId ?? null })
        if (round === 1) {
          const done = t.domain.finishUtterance(u.id, {
            status: 'clarify',
            reply: '是哪一个柜子？',
            clarification: { question: '是哪一个柜子？', options: ['旧书柜', '鞋柜'] },
          })
          return { utterance: done, items: [] }
        }
        return { utterance: t.domain.finishUtterance(u.id, { status: 'done', reply: '好的' }), items: [] }
      },
    })
    await bindViaWechat(s, s.t.wife.id, 'oWife')
    await s.post(s.textXml('oWife', '那个柜子卖掉了'))
    await waitForWechatBackground(s.ctx)
    expect(s.sends[0]).toMatchObject({ data: { task: { value: '是哪一个柜子？' }, note: { value: '旧书柜 / 鞋柜' } }, url: 'https://family.test/' })
    const asked = s.t.domain.recentUtterances(1)[0]!
    await s.post(s.textXml('oWife', '旧书柜'))
    await waitForWechatBackground(s.ctx)
    expect(s.interpretCalls[1]).toMatchObject({ text: '旧书柜', source: 'wechat', replyToUtteranceId: asked.id })
  })

  it('interpreter or send failures are logged, never thrown; 43004 on reply unbinds', async () => {
    const s = setup({
      interpret: async () => {
        throw new Error('model down')
      },
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await bindViaWechat(s, s.t.wife.id, 'oWife')
    const res = await s.post(s.textXml('oWife', '你好'))
    expect(res.status).toBe(200)
    await waitForWechatBackground(s.ctx)
    expect(err).toHaveBeenCalled()
    err.mockRestore()

    const s2 = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await bindViaWechat(s2, s2.t.wife.id, 'oWife')
    s2.sendCodes.push(43004)
    await s2.post(s2.textXml('oWife', '明天买牛奶'))
    await waitForWechatBackground(s2.ctx)
    expect(readWechatBinding(s2.t.db, s2.t.wife.id).openid).toBeNull()
    warn.mockRestore()
  })

  it('text from an unbound openid → instructions; voice → hint; other types → text only', async () => {
    const s = setup()
    expect(s.contentOf((await s.post(s.textXml('oStranger', '你好'))).body)).toBe(TEXT.unbound)
    expect(s.contentOf((await s.post(s.voiceXml('oStranger'))).body)).toBe('语音请在 App 里说，或者直接发文字。')
    const image =
      `<xml><ToUserName><![CDATA[gh_family]]></ToUserName><FromUserName><![CDATA[oStranger]]></FromUserName>` +
      `<CreateTime>1761012002</CreateTime><MsgType><![CDATA[image]]></MsgType><MsgId>1234</MsgId></xml>`
    expect(s.contentOf((await s.post(image)).body)).toBe(TEXT.unsupported)
    expect(s.interpretCalls).toHaveLength(0)
  })

  it('unsubscribe unbinds the member', async () => {
    const s = setup()
    await bindViaWechat(s, s.t.wife.id, 'oWife')
    const res = await s.post(s.eventXml('oWife', 'unsubscribe', '1761013000'))
    expect(res.body).toBe('success')
    expect(getWechatBinding(s.ctx, s.t.wife.id).bound).toBe(false)
  })

  it('503 when WeChat callbacks are not configured', async () => {
    const s = setup()
    const res = await handleWechatMessage({ ...s.ctx, config: testConfig() }, s.signedQuery(), s.textXml('oA', 'hi'))
    expect(res.status).toBe(503)
  })
})

describe('helpers', () => {
  it('parseBindCommand', () => {
    expect(parseBindCommand('绑定 123456')).toBe('123456')
    expect(parseBindCommand('绑定123456')).toBe('123456')
    expect(parseBindCommand(' 绑定：１２３４５６ ')).toBe('123456')
    expect(parseBindCommand('绑定　123456')).toBe('123456') // ideographic space
    expect(parseBindCommand('绑定 1234567')).toBe('malformed')
    expect(parseBindCommand('明天买牛奶')).toBeNull()
  })

  it('passive reply escapes ]]> inside CDATA', () => {
    const xml = passiveTextReply({ toUserName: 'gh', fromUserName: 'o1' }, 'a]]>b', new Date('2026-10-21T01:00:00Z'))
    expect(xml).toContain('<Content><![CDATA[a]]]]><![CDATA[>b]]></Content>')
    expect(parseWechatXml(xml)!.content).toBe('a]]>b')
  })

  it('keeps 64-bit MsgIds as strings', () => {
    const m = parseWechatXml('<xml><ToUserName>a</ToUserName><FromUserName>b</FromUserName><MsgType>text</MsgType><MsgId>24567890123456789012</MsgId></xml>')
    expect(m!.msgId).toBe('24567890123456789012')
  })

  it('createWechatBindCode requires WeChat and a real member', () => {
    const s = setup()
    expect(() => createWechatBindCode({ ...s.ctx, config: testConfig() }, s.t.wife.id)).toThrow(DomainError)
    expect(() => createWechatBindCode({ ...s.ctx, config: testConfig({ wechat: { ...WECHAT, token: null } }) }, s.t.wife.id)).toThrow(DomainError)
    expect(() => createWechatBindCode(s.ctx, 'm_nobody')).toThrow(DomainError)
  })
})
