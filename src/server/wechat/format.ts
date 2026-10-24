// Formatting for WeChat test-account template messages (template fields task / from / when / note) and the signed
// /t/<token> links they open. Test-template values must not contain line breaks, control chars or emoji
// (errcode 47003) and fold after about 20 characters.

import type { Item, Member, ScheduledNotification } from '../../shared/types'
import { CLOSED_STATUSES } from '../../shared/types'
import { dueLabel, nameLookup } from '../domain/describe'
import type { LinkTokenPayload } from '../tokens'
import { signLinkToken } from '../tokens'
import { HOUR, formatInstantZh } from '../time'

export const WECHAT_VALUE_MAX = 20
export const LINK_TTL_MS = 72 * HOUR
export const WECHAT_FROM_NAME = '家庭助手'

type LinkAction = LinkTokenPayload['a'][number]

const LINE_BREAKS = /[\r\n\t\u2028\u2029\u0085]+/g
// control and format characters, plus lone surrogates (invalid UTF-8 once serialized: WeChat rejects the message)
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/gu
// emoji: pictographs, flags, skin tones, keycaps and presentation selectors
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u20E3]/gu

/**
 * Makes a template value safe: line breaks → space, control/format chars, lone surrogates and emoji removed, whitespace collapsed,
 * at most `max` characters (code points), ending with "…" when cut. Returns '' for nothing left.
 */
export function sanitizeWechatValue(value: string | null | undefined, max = WECHAT_VALUE_MAX): string {
  if (!value) return ''
  const cleaned = value.replace(LINE_BREAKS, ' ').replace(EMOJI, '').replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(cleaned)
  if (chars.length <= max) return cleaned
  return chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…'
}

/** Actions a WeChat link may perform, per notification kind (SPEC §7). */
export function linkActionsForKind(kind: ScheduledNotification['kind']): LinkAction[] {
  switch (kind) {
    case 'request_new':
    case 'request_followup':
      return ['accept', 'decline', 'view']
    case 'due':
    case 'explicit':
    case 'assigned':
    case 'stale':
      return ['done', 'view']
    default:
      return ['view']
  }
}

/** Actions for a link to an item the member just touched from WeChat (interpreter replies). */
export function linkActionsForItem(item: Item, memberId: string): LinkAction[] {
  if (CLOSED_STATUSES.includes(item.status)) return ['view']
  if (item.kind === 'request' && item.status === 'pending') return item.ownerId === memberId ? ['accept', 'decline', 'view'] : ['view']
  if (item.kind === 'request' && item.status === 'declined') return ['view']
  if (item.kind === 'idea') return ['view']
  return ['done', 'view']
}

export function signedItemUrl(
  publicUrl: string,
  appSecret: string,
  args: { itemId: string; memberId: string; allowed: LinkAction[]; now: Date },
): string {
  const token = signLinkToken(
    {
      i: args.itemId,
      m: args.memberId,
      a: args.allowed,
      e: Math.floor((args.now.getTime() + LINK_TTL_MS) / 1000),
      // issued at: `revoke` (lost phone) ends the links already sent to the member (tokens.ts)
      t: Math.floor(args.now.getTime() / 1000),
    },
    appSecret,
  )
  return `${publicUrl}/t/${token}`
}

/** Link for a notification: a signed item link, or the in-app path for item-less ones (digest, weekly …). */
export function notificationLinkUrl(publicUrl: string, appSecret: string, n: ScheduledNotification, now: Date): string {
  if (n.itemId) return signedItemUrl(publicUrl, appSecret, { itemId: n.itemId, memberId: n.memberId, allowed: linkActionsForKind(n.kind), now })
  if (/^https?:\/\//.test(n.url)) return n.url
  return `${publicUrl}${n.url.startsWith('/') ? '' : '/'}${n.url}`
}

export type TemplateData = Record<'task' | 'from' | 'when' | 'note', { value: string }>

const v = (value: string, fallback: string) => ({ value: sanitizeWechatValue(value) || fallback })

/**
 * task = notification title, from = the person behind it (requester for requests to answer, the owner for
 * answers, otherwise 家庭助手), when = the item's due label or the delivery time, note = the body.
 */
export function notificationTemplateData(
  n: Pick<ScheduledNotification, 'kind' | 'title' | 'body'>,
  ctx: { item: Item | null; members: readonly Member[]; now: Date; tz: string },
): TemplateData {
  const nameOf = nameLookup(ctx.members)
  let from = WECHAT_FROM_NAME
  if (ctx.item && (n.kind === 'request_new' || n.kind === 'request_followup') && ctx.item.requestedBy) from = nameOf(ctx.item.requestedBy)
  if (ctx.item && n.kind === 'request_answered' && ctx.item.ownerId) from = nameOf(ctx.item.ownerId)
  const due = ctx.item ? dueLabel(ctx.item, ctx.now, ctx.tz) : null
  return {
    task: v(n.title, '家庭提醒'),
    from: v(from, WECHAT_FROM_NAME),
    when: v(due ?? formatInstantZh(ctx.now, ctx.now, ctx.tz), '现在'),
    note: v(n.body, '点开查看'),
  }
}

/** Template for the assistant's answer to a text sent from WeChat. */
export function replyTemplateData(args: { reply: string; note: string | null; now: Date; tz: string }): TemplateData {
  return {
    task: v(args.reply, '好的'),
    from: v(WECHAT_FROM_NAME, WECHAT_FROM_NAME),
    when: v(formatInstantZh(args.now, args.now, args.tz), '现在'),
    note: v(args.note ?? '', '没有改动'),
  }
}
