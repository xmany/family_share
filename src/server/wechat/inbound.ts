// WeChat callback (接口配置信息 URL, `GET|POST /wechat/mp`): signature check, XML parsing, passive replies,
// openid binding with "绑定 123456", and text → interpreter → template reply. docs/research/wechat.md §2.1, §4.1.
// WeChat waits 5 s for the reply and retries up to 3 times; everything slow runs after the reply.

import { createHash, timingSafeEqual } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import type { AppContext } from '../context'
import type { UtteranceResponse } from '../../shared/api'
import { getOrCreateAppSecret } from '../tokens'
import { MINUTE } from '../time'
import { sharedWechatClient } from './client'
import { linkActionsForItem, replyTemplateData, signedItemUrl } from './format'
import {
  bindAttemptsExhausted,
  bindWechatOpenid,
  clearBindFailures,
  consumeBindCode,
  findMemberIdByOpenid,
  recordBindFailure,
  recordInbound,
  unbindWechat,
  unbindWechatOpenid,
} from './store'

export const TEXT = {
  subscribe: '欢迎关注家庭助手！请在 App「设置 → 绑定微信」里拿到 6 位绑定码，然后在这里发送：绑定 123456（换成你的绑定码）。',
  welcomeBack: '欢迎回来！提醒会继续发到这里，也可以直接发文字给我。',
  unbound: '还没有绑定家人账号。请在 App「设置 → 绑定微信」里拿到绑定码，然后发送：绑定 123456（换成你的绑定码）。',
  bindOk: '绑定成功，以后提醒会发到这里。',
  bindBad: '绑定码不对或已过期，请在 App「设置 → 绑定微信」里重新获取。',
  bindMalformed: '绑定码是 6 位数字，例如：绑定 123456',
  bindTooMany: '尝试次数太多了，请一小时后再试。',
  processing: '收到，处理中…',
  voice: '语音请在 App 里说，或者直接发文字。',
  unsupported: '目前只能处理文字消息，请直接发文字。',
} as const

const MAX_BODY_BYTES = 64 * 1024
/** Template reply when interpreting a WeChat text failed outright */
const INTERPRET_FAILED = '没处理成功，请在 App 里再试一次'
/**
 * WeChat's callback signature covers only token + timestamp + nonce, not the body. A query seen once (in a proxy
 * log, a browser history, …) would otherwise let anyone post any XML "from" any openid forever — e.g. text as a
 * bound member, or bind-code guesses from made-up openids (sidestepping the per-openid cap). So the timestamp must
 * be recent and each signed query is accepted once.
 */
export const SIGNATURE_MAX_SKEW_MS = 5 * MINUTE

/** True when the signed `timestamp` (unix seconds) is within SIGNATURE_MAX_SKEW_MS of now. */
export function isFreshWechatTimestamp(timestamp: string | undefined, now: Date): boolean {
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) return false
  return Math.abs(now.getTime() - Number(timestamp) * 1000) <= SIGNATURE_MAX_SKEW_MS
}
/** A clarification asked this recently is answered by the member's next WeChat text. */
const CLARIFICATION_WINDOW_MS = 30 * MINUTE

export interface WechatHttpResult {
  status: number
  body: string
  contentType: string
}

const plain = (status: number, body: string): WechatHttpResult => ({ status, body, contentType: 'text/plain; charset=utf-8' })
/** "success" = ack without a message (WeChat stops retrying). */
const ack = (): WechatHttpResult => plain(200, 'success')

// ---------------------------------------------------------------------------------------------
// Signature and XML

/** signature === sha1(sort([token, timestamp, nonce]).join('')) */
export function wechatSignature(token: string, timestamp: string, nonce: string): string {
  return createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
}

export function verifyWechatSignature(token: string, query: Record<string, string | undefined>): boolean {
  const { signature, timestamp, nonce } = query
  if (typeof signature !== 'string' || typeof timestamp !== 'string' || typeof nonce !== 'string') return false
  if (!signature || !timestamp || !nonce) return false
  const expected = Buffer.from(wechatSignature(token, timestamp, nonce))
  const given = Buffer.from(signature.toLowerCase())
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export interface WechatInbound {
  toUserName: string
  fromUserName: string
  createTime: string
  msgType: string
  content: string
  msgId: string | null
  event: string | null
  eventKey: string | null
  mediaId: string | null
}

// parseTagValue: false keeps MsgId (a 64-bit number) and everything else as strings
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true, htmlEntities: false })

/**
 * True when the document contains a `<!…>` declaration (DOCTYPE, ENTITY, …) outside comments and CDATA sections.
 * The parser honours a DOCTYPE anywhere, even inside <xml>; "<!DOCTYPE" a member typed inside CDATA is just text.
 * An unterminated comment or CDATA section also counts (malformed: reject it).
 */
export function hasMarkupDeclaration(raw: string): boolean {
  let i = 0
  while ((i = raw.indexOf('<!', i)) >= 0) {
    const close = raw.startsWith('<![CDATA[', i) ? ']]>' : raw.startsWith('<!--', i) ? '-->' : null
    if (!close) return true
    const end = raw.indexOf(close, i + (close === ']]>' ? 9 : 4))
    if (end < 0) return true
    i = end + 3
  }
  return false
}

export function parseWechatXml(raw: string): WechatInbound | null {
  // WeChat never sends a DTD. Refuse one outright instead of relying on the parser's entity limits: a DOCTYPE
  // entity could otherwise rewrite fields (e.g. Content) or inflate the document.
  if (hasMarkupDeclaration(raw)) return null
  let doc: unknown
  try {
    doc = parser.parse(raw)
  } catch {
    return null
  }
  const x = (doc as { xml?: unknown } | null)?.xml
  if (!x || typeof x !== 'object') return null
  const rec = x as Record<string, unknown>
  const str = (k: string): string => {
    const v = rec[k]
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
  }
  const msg: WechatInbound = {
    toUserName: str('ToUserName'),
    fromUserName: str('FromUserName'),
    createTime: str('CreateTime'),
    msgType: str('MsgType').toLowerCase(),
    content: str('Content'),
    msgId: str('MsgId') || null,
    event: str('Event') || null,
    eventKey: str('EventKey') || null,
    mediaId: str('MediaId') || null,
  }
  if (!msg.fromUserName || !msg.toUserName || !msg.msgType) return null
  return msg
}

const cdata = (s: string) => `<![CDATA[${s.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

/** Passive text reply: To/From swapped, CDATA everywhere. */
export function passiveTextReply(msg: Pick<WechatInbound, 'toUserName' | 'fromUserName'>, content: string, now: Date): string {
  return (
    `<xml><ToUserName>${cdata(msg.fromUserName)}</ToUserName><FromUserName>${cdata(msg.toUserName)}</FromUserName>` +
    `<CreateTime>${Math.floor(now.getTime() / 1000)}</CreateTime><MsgType>${cdata('text')}</MsgType>` +
    `<Content>${cdata(content)}</Content></xml>`
  )
}

/**
 * "绑定 123456" / "绑定123456" / "绑定：１２３４５６" → "123456"; a 绑定 command without a valid 6-digit code →
 * 'malformed'; anything else → null.
 */
export function parseBindCommand(text: string): string | 'malformed' | null {
  const t = text.normalize('NFKC').trim()
  if (!t.startsWith('绑定')) return null
  const m = /^绑定\s*[:：]?\s*(\d{6})$/.exec(t)
  return m ? m[1]! : 'malformed'
}

// ---------------------------------------------------------------------------------------------
// Background work (interpret + template reply), tracked so tests and shutdown can wait for it

const background = new WeakMap<object, Set<Promise<void>>>()

function track(ctx: AppContext, p: Promise<void>): void {
  let set = background.get(ctx)
  if (!set) {
    set = new Set()
    background.set(ctx, set)
  }
  set.add(p)
  void p.finally(() => set.delete(p))
}

/** Resolves when every interpret-and-reply started by handleWechatMessage for this context has finished. */
export async function waitForWechatBackground(ctx: AppContext): Promise<void> {
  const set = background.get(ctx)
  while (set && set.size > 0) await Promise.allSettled([...set])
}

function pendingClarification(ctx: AppContext, memberId: string): string | null {
  const now = ctx.clock.now().getTime()
  const mine = ctx.domain.recentUtterances(20).filter(u => u.memberId === memberId)
  const last = mine[mine.length - 1]
  if (!last || last.status !== 'clarify') return null
  return now - new Date(last.createdAt).getTime() <= CLARIFICATION_WINDOW_MS ? last.id : null
}

async function sendInterpretResult(ctx: AppContext, memberId: string, openid: string, res: UtteranceResponse): Promise<void> {
  const wx = ctx.config.wechat
  if (!wx) return
  const u = res.utterance
  const now = ctx.clock.now()
  const tz = ctx.domain.getFamily().timezone
  let reply: string
  let note: string | null
  if (u.status === 'error') {
    reply = u.error || u.reply || INTERPRET_FAILED
    note = u.changes[0]?.summary ?? null
  } else if (u.status === 'clarify' && u.clarification) {
    reply = u.clarification.question || u.reply || '需要再确认一下'
    note = u.clarification.options.join(' / ')
  } else {
    reply = u.reply || '好的'
    note = u.changes[0]?.summary ?? null
  }
  const itemId = u.changes.find(c => c.itemId)?.itemId ?? res.items[0]?.id ?? null
  const item = itemId ? (res.items.find(i => i.id === itemId) ?? ctx.domain.getItem(itemId)) : null
  const url = item
    ? signedItemUrl(ctx.config.publicUrl, getOrCreateAppSecret(ctx.db), {
        itemId: item.id,
        memberId,
        allowed: linkActionsForItem(item, memberId),
        now,
      })
    : `${ctx.config.publicUrl}/`
  const result = await sharedWechatClient(wx, ctx.clock).sendTemplate({
    touser: openid,
    template_id: wx.templateId,
    url,
    client_msg_id: u.id,
    data: replyTemplateData({ reply, note, now, tz }),
  })
  if (!result.ok) {
    console.warn(`[wechat] reply for utterance ${u.id} failed: ${result.errcode} ${result.errmsg}`)
    if (result.unbind) unbindWechat(ctx.db, memberId, ctx.clock.now())
  }
}

async function interpretAndReply(ctx: AppContext, memberId: string, openid: string, text: string): Promise<void> {
  let res: UtteranceResponse
  try {
    const replyToUtteranceId = pendingClarification(ctx, memberId)
    res = await ctx.interpreter.interpret({ memberId, text, source: 'wechat', replyToUtteranceId })
  } catch (e) {
    console.error('[wechat] interpreting a WeChat message failed', e)
    // the member was told "收到，处理中…": never leave them waiting for an answer that will not come
    await sendFailureNotice(ctx, memberId, openid)
    return
  }
  try {
    await sendInterpretResult(ctx, memberId, openid, res)
  } catch (e) {
    console.error('[wechat] sending the reply to a WeChat message failed', e)
  }
}

async function sendFailureNotice(ctx: AppContext, memberId: string, openid: string): Promise<void> {
  const wx = ctx.config.wechat
  if (!wx) return
  try {
    const now = ctx.clock.now()
    const result = await sharedWechatClient(wx, ctx.clock).sendTemplate({
      touser: openid,
      template_id: wx.templateId,
      url: `${ctx.config.publicUrl}/`,
      data: replyTemplateData({ reply: INTERPRET_FAILED, note: null, now, tz: ctx.domain.getFamily().timezone }),
    })
    if (!result.ok && result.unbind) unbindWechat(ctx.db, memberId, ctx.clock.now())
  } catch (e) {
    console.error('[wechat] sending the failure notice failed', e)
  }
}

// ---------------------------------------------------------------------------------------------
// Handlers

/** GET /wechat/mp — server verification: echo `echostr` when the signature matches. */
export function handleWechatVerify(ctx: AppContext, query: Record<string, string>): { status: number; body: string } {
  const token = ctx.config.wechat?.token
  if (!token) return { status: 503, body: 'wechat not configured' }
  if (!verifyWechatSignature(token, query)) return { status: 403, body: 'invalid signature' }
  return { status: 200, body: typeof query.echostr === 'string' ? query.echostr : '' }
}

/**
 * The checks of POST /wechat/mp that need only the query string: configured, signature, fresh timestamp. The HTTP
 * layer runs them before it reads the body, so an unsigned request is turned away without being buffered. Returns the
 * rejection, or null when the request may go on (the replay check still happens in handleWechatMessage).
 */
export function rejectUnsignedWechatCallback(ctx: AppContext, query: Record<string, string>): WechatHttpResult | null {
  const token = ctx.config.wechat?.token
  if (!token) return plain(503, 'wechat not configured')
  if (!verifyWechatSignature(token, query)) return plain(403, 'invalid signature')
  if (!isFreshWechatTimestamp(query.timestamp, ctx.clock.now())) {
    console.warn('[wechat] callback with a stale timestamp rejected (replay, or check the server clock)')
    return plain(403, 'stale timestamp')
  }
  return null
}

/** POST /wechat/mp — one inbound message or event. Never throws; always answers quickly. */
export async function handleWechatMessage(ctx: AppContext, query: Record<string, string>, rawBody: string): Promise<WechatHttpResult> {
  const rejected = rejectUnsignedWechatCallback(ctx, query)
  if (rejected) return rejected
  const now = ctx.clock.now()
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return plain(413, 'too large')
  if (query.encrypt_type && query.encrypt_type !== 'raw') {
    // 安全模式 (AES) is not supported; the test account uses 明文模式
    console.warn('[wechat] encrypted callback ignored; switch the account to plaintext mode')
    return ack()
  }
  try {
    // each signed query once: a replay (or WeChat re-sending the identical request) is only acknowledged
    if (!recordInbound(ctx.db, `sig:${query.signature!.toLowerCase()}`, '', 'signature', now)) return ack()
  } catch (e) {
    console.error('[wechat] recording a callback failed', e)
    return ack()
  }
  const msg = parseWechatXml(rawBody)
  if (!msg) return plain(400, 'bad xml')
  try {
    // events have no MsgId
    const key = msg.msgId ?? `${msg.fromUserName}:${msg.createTime}:${msg.event ?? msg.msgType}`
    if (!recordInbound(ctx.db, key, msg.fromUserName, msg.msgType, now)) return ack()
    return dispatch(ctx, msg, now)
  } catch (e) {
    console.error('[wechat] handling a callback failed', e)
    return ack()
  }
}

function dispatch(ctx: AppContext, msg: WechatInbound, now: Date): WechatHttpResult {
  const reply = (content: string): WechatHttpResult => ({
    status: 200,
    body: passiveTextReply(msg, content, now),
    contentType: 'application/xml; charset=utf-8',
  })
  const openid = msg.fromUserName

  switch (msg.msgType) {
    case 'event': {
      const ev = (msg.event ?? '').toLowerCase()
      if (ev === 'subscribe') return reply(findMemberIdByOpenid(ctx.db, openid) ? TEXT.welcomeBack : TEXT.subscribe)
      if (ev === 'unsubscribe') {
        // template sends would fail with 43004 from now on
        unbindWechatOpenid(ctx.db, openid, now)
        return ack()
      }
      return ack()
    }
    case 'text': {
      const bind = parseBindCommand(msg.content)
      if (bind === 'malformed') return reply(TEXT.bindMalformed)
      if (bind) {
        if (bindAttemptsExhausted(ctx.db, openid, now)) return reply(TEXT.bindTooMany)
        const memberId = consumeBindCode(ctx.db, bind, now)
        if (!memberId || !ctx.domain.getMember(memberId)) {
          recordBindFailure(ctx.db, openid, now)
          return reply(TEXT.bindBad)
        }
        bindWechatOpenid(ctx.db, memberId, openid, now)
        clearBindFailures(ctx.db, openid)
        try {
          ctx.bus.broadcast({ type: 'board_changed', itemIds: [], byMemberId: memberId })
        } catch {
          // a failing SSE listener must not break the reply
        }
        return reply(TEXT.bindOk)
      }
      const memberId = findMemberIdByOpenid(ctx.db, openid)
      if (!memberId || !ctx.domain.getMember(memberId)) return reply(TEXT.unbound)
      const text = msg.content.trim()
      if (!text) return ack()
      // start after the passive reply is on its way
      track(ctx, new Promise<void>(resolve => setImmediate(resolve)).then(() => interpretAndReply(ctx, memberId, openid, text)))
      return reply(TEXT.processing)
    }
    case 'voice':
      return reply(TEXT.voice)
    default:
      return reply(TEXT.unsupported)
  }
}
