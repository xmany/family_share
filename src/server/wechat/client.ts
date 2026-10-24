// WeChat Official Account (公众号接口测试号) API client: access-token cache + template message send.
// docs/research/wechat.md §4.1. fetch is injectable; tests never touch the network.

import type { Config } from '../config'
import type { Clock } from '../time'
import { MINUTE } from '../time'

export type WechatConfig = NonNullable<Config['wechat']>

export const WECHAT_API_BASE = 'https://api.weixin.qq.com'
/** Refresh the cached token this long before WeChat says it expires. */
export const TOKEN_REFRESH_EARLY_MS = 10 * MINUTE
const REQUEST_TIMEOUT_MS = 10_000

/** errcodes that mean "the access token is bad": refresh once and retry. */
const TOKEN_ERRORS = new Set([40001, 40014, 42001])
/** The recipient no longer follows the account / the openid is wrong: stop sending to them. */
const UNBIND_ERRORS = new Set([43004, 40003])
/** Rate limit / system busy: retry later. */
const TRANSIENT_ERRORS = new Set([-1, 45009, 45011])
/** Configuration or formatting problems that retrying cannot fix. */
const PERMANENT_ERRORS = new Set([40013, 40037, 40125, 40164, 43116, 47003, 47001, 48001, 40036])

export interface TemplateMessage {
  touser: string
  template_id: string
  url?: string
  client_msg_id?: string
  data: Record<string, { value: string }>
}

export interface WechatSendResult {
  ok: boolean
  errcode: number
  errmsg: string
  msgid?: string
  /** retrying will not help */
  permanent: boolean
  /** the member's binding is dead (43004 / 40003): unbind them */
  unbind: boolean
}

export interface WechatClient {
  getAccessToken(forceRefresh?: boolean): Promise<string>
  sendTemplate(msg: TemplateMessage): Promise<WechatSendResult>
}

export class WechatApiError extends Error {
  constructor(
    public readonly errcode: number,
    public readonly errmsg: string,
  ) {
    super(`wechat ${errcode}: ${errmsg}`)
    this.name = 'WechatApiError'
  }
}

export function classifyWechatError(errcode: number): { permanent: boolean; unbind: boolean } {
  if (UNBIND_ERRORS.has(errcode)) return { permanent: true, unbind: true }
  if (PERMANENT_ERRORS.has(errcode)) return { permanent: true, unbind: false }
  if (TRANSIENT_ERRORS.has(errcode)) return { permanent: false, unbind: false }
  // unknown codes: retry (bounded by the scheduler's max attempts)
  return { permanent: false, unbind: false }
}

export interface WechatClientDeps {
  config: WechatConfig
  clock: Clock
  fetch?: typeof fetch
  log?: Pick<Console, 'warn' | 'error'>
}

interface WechatJson {
  errcode?: number
  errmsg?: string
  access_token?: string
  expires_in?: number
  msgid?: number | string
}

export function createWechatClient(deps: WechatClientDeps): WechatClient {
  const { config, clock } = deps
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  let cached: { token: string; refreshAt: number } | null = null
  let inflight: Promise<string> | null = null

  async function requestJson(url: string, init?: RequestInit): Promise<WechatJson> {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) throw new WechatApiError(-1, `http ${res.status}`)
    const text = await res.text()
    try {
      return JSON.parse(text) as WechatJson
    } catch {
      throw new WechatApiError(-1, 'invalid json from wechat')
    }
  }

  async function fetchToken(): Promise<string> {
    const url =
      `${WECHAT_API_BASE}/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(config.appId)}&secret=${encodeURIComponent(config.appSecret)}`
    let json: WechatJson
    try {
      json = await requestJson(url)
    } catch (e) {
      if (e instanceof WechatApiError) throw e
      throw new WechatApiError(-1, `network: ${(e as Error).message ?? String(e)}`)
    }
    if (!json.access_token) throw new WechatApiError(json.errcode ?? -1, json.errmsg ?? 'no access_token')
    const ttlMs = (typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 7200) * 1000
    // never cache for less than a minute, even when WeChat hands out a very short token
    cached = { token: json.access_token, refreshAt: clock.now().getTime() + Math.max(MINUTE, ttlMs - TOKEN_REFRESH_EARLY_MS) }
    return json.access_token
  }

  async function getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && cached && clock.now().getTime() < cached.refreshAt) return cached.token
    if (forceRefresh) cached = null
    if (!inflight) {
      inflight = fetchToken().finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  async function postTemplate(token: string, msg: TemplateMessage): Promise<WechatJson> {
    return requestJson(`${WECHAT_API_BASE}/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(msg),
    })
  }

  function failure(errcode: number, errmsg: string): WechatSendResult {
    return { ok: false, errcode, errmsg, ...classifyWechatError(errcode) }
  }

  async function sendTemplate(msg: TemplateMessage): Promise<WechatSendResult> {
    try {
      let token = await getAccessToken()
      let json = await postTemplate(token, msg)
      if (typeof json.errcode === 'number' && TOKEN_ERRORS.has(json.errcode)) {
        token = await getAccessToken(true)
        json = await postTemplate(token, msg)
      }
      const errcode = typeof json.errcode === 'number' ? json.errcode : 0
      if (errcode === 0) {
        return { ok: true, errcode: 0, errmsg: json.errmsg ?? 'ok', msgid: json.msgid === undefined ? undefined : String(json.msgid), permanent: false, unbind: false }
      }
      if (errcode === 47003) log.error('[wechat] template payload rejected (47003):', json.errmsg, JSON.stringify(msg.data))
      return failure(errcode, json.errmsg ?? 'error')
    } catch (e) {
      if (e instanceof WechatApiError) return failure(e.errcode, e.errmsg)
      return failure(-1, `network: ${(e as Error).message ?? String(e)}`)
    }
  }

  return { getAccessToken, sendTemplate }
}

// ---------------------------------------------------------------------------------------------
// One client (= one token cache) per WeChat config object, shared by the notifier's channel and the callback
// handler: two caches would keep invalidating each other's tokens.

const shared = new WeakMap<WechatConfig, WechatClient>()

export function sharedWechatClient(config: WechatConfig, clock: Clock): WechatClient {
  let c = shared.get(config)
  if (!c) {
    c = createWechatClient({ config, clock })
    shared.set(config, c)
  }
  return c
}

/** Installs the client used for this config (tests inject one with a fake fetch). */
export function setSharedWechatClient(config: WechatConfig, client: WechatClient): void {
  shared.set(config, client)
}
