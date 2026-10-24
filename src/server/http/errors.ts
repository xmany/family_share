// Error → HTTP mapping (SPEC §5): every error body is { error: { code, message } } with a Chinese message.

import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ZodError } from 'zod'
import type { ApiError } from '../../shared/api'
import { DomainError } from '../domain/types'

export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const DOMAIN_STATUS: Record<DomainError['code'], ContentfulStatusCode> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
}

export function errorBody(code: string, message: string): ApiError {
  return { error: { code, message } }
}

export function sendError(c: Context, status: ContentfulStatusCode, code: string, message: string): Response {
  c.header('Cache-Control', 'no-store')
  return c.json(errorBody(code, message), status)
}

/** Maps anything thrown by a route to a response. Unknown errors are logged and become a 500. */
export function toErrorResponse(c: Context, err: unknown, log: (...args: unknown[]) => void): Response {
  if (err instanceof HttpError) return sendError(c, err.status, err.code, err.message)
  if (err instanceof DomainError) return sendError(c, DOMAIN_STATUS[err.code] ?? 400, err.code, err.message)
  // Hono's own HTTPException (e.g. a malformed multipart body)
  if (err instanceof HTTPException) {
    const status = err.status
    if (status === 413) return sendError(c, 413, 'too_large', '内容太大了')
    if (status >= 400 && status < 500) return sendError(c, status as ContentfulStatusCode, 'invalid', '请求格式不对')
  }
  log('[http] unhandled error', c.req.method, c.req.path, err)
  return sendError(c, 500, 'internal', '服务器出错了，请稍后再试')
}

const FIELD_ZH: Record<string, string> = {
  token: '邀请码',
  title: '标题',
  details: '说明',
  text: '内容',
  note: '备注',
  message: '留言',
  kind: '类型',
  status: '状态',
  ownerId: '负责人',
  dueAt: '时间',
  dueDate: '日期',
  priority: '优先级',
  response: '回复',
  until: '推迟到',
  preset: '推迟选项',
  source: '来源',
  replyToUtteranceId: '回复的消息',
  action: '操作',
  subscription: '推送订阅',
  endpoint: '推送地址',
  name: '名字',
  aliases: '别名',
  role: '角色',
  quietStart: '免打扰开始时间',
  quietEnd: '免打扰结束时间',
  digestTime: '每日摘要时间',
  channels: '通知渠道',
}

/** A short Chinese description of the first few zod issues, e.g. "内容有误：标题 不能为空". */
export function zodMessage(err: ZodError): string {
  const parts = err.issues.slice(0, 3).map(issue => {
    const field = issue.path.map(p => (typeof p === 'string' ? (FIELD_ZH[p] ?? p) : `#${String(p)}`)).join('.') || '请求'
    let reason: string
    switch (issue.code) {
      case 'invalid_type':
        reason = /received undefined/.test(issue.message) ? '缺少' : '类型不对'
        break
      case 'too_small':
        reason = '不能为空或太短'
        break
      case 'too_big':
        reason = '太长了'
        break
      case 'invalid_value':
        reason = '取值不对'
        break
      case 'invalid_format':
        reason = '格式不对'
        break
      case 'custom':
        return issue.message
      default:
        reason = '不对'
    }
    return `${field} ${reason}`
  })
  return `内容有误：${parts.join('；')}`
}
