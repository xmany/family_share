// Public surface of the WeChat integration (公众号接口测试号): callback handlers for /wechat/mp, bind codes for
// POST /api/wechat/bind-code, and the binding state for the settings screen.

import type { WechatBindCodeResponse } from '../../shared/api'
import type { WechatMode } from '../../shared/types'
import type { AppContext } from '../context'
import { DomainError } from '../domain/types'
import { createBindCode, readWechatBinding } from './store'

export { handleWechatMessage, handleWechatVerify, rejectUnsignedWechatCallback, waitForWechatBackground } from './inbound'
export type { WechatHttpResult } from './inbound'

/** A fresh 6-digit code (30 min, single use) the member sends to the test account as "绑定 <code>". */
export function createWechatBindCode(ctx: AppContext, memberId: string): WechatBindCodeResponse {
  if (!ctx.config.wechat) throw new DomainError('invalid', '服务器还没有配置微信测试号')
  // binding needs the callback (the member's "绑定 <code>" message reaches us through it)
  if (!ctx.config.wechat.token) throw new DomainError('invalid', '微信测试号还没有配置接口回调（WECHAT_TOKEN），暂时不能绑定')
  if (!ctx.domain.getMember(memberId)) throw new DomainError('not_found', `找不到这个成员（${memberId}）`)
  const { code, expiresAt } = createBindCode(ctx.db, memberId, ctx.clock.now())
  return { code, expiresAt, instructions: '关注测试号后，发送：绑定 ' + code }
}

/** Whether the member has a WeChat openid bound, and their routing mode. Never returns the openid. */
export function getWechatBinding(ctx: AppContext, memberId: string): { bound: boolean; mode: WechatMode } {
  const b = readWechatBinding(ctx.db, memberId)
  return { bound: !!b.openid, mode: b.mode }
}

export { createWechatClient, setSharedWechatClient, sharedWechatClient, classifyWechatError, WECHAT_API_BASE } from './client'
export type { TemplateMessage, WechatClient, WechatClientDeps, WechatConfig, WechatSendResult } from './client'
export {
  linkActionsForKind,
  notificationLinkUrl,
  notificationTemplateData,
  replyTemplateData,
  sanitizeWechatValue,
  signedItemUrl,
  WECHAT_VALUE_MAX,
} from './format'
export {
  SIGNATURE_MAX_SKEW_MS,
  isFreshWechatTimestamp,
  parseBindCommand,
  parseWechatXml,
  passiveTextReply,
  verifyWechatSignature,
  wechatSignature,
} from './inbound'
export { BIND_CODE_TTL_MS, DEFAULT_WECHAT_MODE, WECHAT_MODES, isWechatMode } from './store'
