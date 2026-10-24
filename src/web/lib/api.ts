// Typed client for every route in src/shared/api.ts.
// - same-origin cookie session (fs_session), JSON in/out
// - mutations send `X-Family-Share: 1` (the server's CSRF guard)
// - errors are thrown as ApiErrorX { status, code, message } with a Chinese message
// - a 401 on an authenticated route calls the handler registered with onUnauthorized()

import type {
  ApiError,
  BoardResponse,
  CompleteBody,
  CreateItemBody,
  InviteResponse,
  ItemDetailResponse,
  ItemResponse,
  JoinResponse,
  LinkActionBody,
  LinkViewResponse,
  MeResponse,
  NewMemberBody,
  NoteBody,
  NotificationActionBody,
  PushSubscribeBody,
  RespondBody,
  SettingsBody,
  SettingsResponse,
  SnoozeBody,
  UndoResponse,
  UpdateItemBody,
  UtteranceBody,
  UtteranceResponse,
  WechatBindCodeResponse,
} from '../../shared/api'
import type { Member } from '../../shared/types'
import { fileNameForMime } from './recorder'

export class ApiErrorX extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiErrorX'
    this.status = status
    this.code = code
  }
}

export function isApiError(e: unknown): e is ApiErrorX {
  return e instanceof ApiErrorX
}

/** A user-facing Chinese message for any thrown value. */
export function errorMessage(e: unknown, fallback = '出了点问题，请稍后再试'): string {
  if (e instanceof ApiErrorX) return e.message || fallback
  return fallback
}

let unauthorizedHandler: (() => void) | null = null
/** Called whenever an authenticated request gets 401 (session missing or expired). */
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorizedHandler = fn
}

const DEFAULT_MESSAGES: Record<number, [string, string]> = {
  400: ['invalid', '内容有误，请检查后再试'],
  401: ['unauthorized', '请用家人发给你的邀请链接加入'],
  403: ['forbidden', '没有权限做这个操作'],
  404: ['not_found', '找不到这条内容，可能已经被删除了'],
  409: ['conflict', '内容已经变了，请刷新后再试'],
  413: ['too_large', '文件太大了'],
  422: ['stt_failed', '没听清，请再说一次，或者用键盘上的语音输入'],
  429: ['rate_limited', '操作太频繁了，请稍后再试'],
}

function defaultError(status: number): [string, string] {
  return DEFAULT_MESSAGES[status] ?? (status >= 500 ? ['server_error', '服务器出错了，请稍后再试'] : ['error', '请求失败了，请稍后再试'])
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface RequestOptions {
  body?: unknown
  form?: FormData
  /** false: a 401 is the caller's business (join, signed links) and does not sign the app out */
  auth?: boolean
  timeoutMs?: number
}

async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') headers['X-Family-Share'] = '1'
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, opts.timeoutMs ?? 30_000)

  let res: Response
  try {
    res = await fetch(path, { method, headers, body, credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal })
  } catch {
    throw timedOut
      ? new ApiErrorX(0, 'timeout', '等太久了，请稍后再试')
      : new ApiErrorX(0, 'network', '网络连接失败，请检查网络后再试')
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text().catch(() => '')
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const err = (data as Partial<ApiError> | null)?.error
    const [code, message] = defaultError(res.status)
    if (res.status === 401 && opts.auth !== false) unauthorizedHandler?.()
    throw new ApiErrorX(res.status, err?.code || code, err?.message || message)
  }
  return data as T
}

const enc = encodeURIComponent

/** Interpreting an utterance runs Claude (and maybe STT): give it time. */
const UTTERANCE_TIMEOUT = 120_000

export const api = {
  // ---- auth
  join: (token: string) => request<JoinResponse>('POST', '/api/auth/join', { body: { token }, auth: false }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', { auth: false }),
  me: () => request<MeResponse>('GET', '/api/me'),

  // ---- board & items
  board: () => request<BoardResponse>('GET', '/api/board'),
  item: (id: string) => request<ItemDetailResponse>('GET', `/api/items/${enc(id)}`),
  createItem: (body: CreateItemBody) => request<ItemResponse>('POST', '/api/items', { body }),
  updateItem: (id: string, body: UpdateItemBody) => request<ItemResponse>('PATCH', `/api/items/${enc(id)}`, { body }),
  respond: (id: string, body: RespondBody) => request<ItemResponse>('POST', `/api/items/${enc(id)}/respond`, { body }),
  complete: (id: string, body: CompleteBody = {}) => request<ItemResponse>('POST', `/api/items/${enc(id)}/complete`, { body }),
  snooze: (id: string, body: SnoozeBody) => request<ItemResponse>('POST', `/api/items/${enc(id)}/snooze`, { body }),
  addNote: (id: string, body: NoteBody) => request<ItemResponse>('POST', `/api/items/${enc(id)}/notes`, { body }),

  // ---- utterances
  sendUtterance: (body: UtteranceBody) =>
    request<UtteranceResponse>('POST', '/api/utterances', { body, timeoutMs: UTTERANCE_TIMEOUT }),
  sendVoice: (audio: Blob, mimeType: string, durationMs: number) => {
    const form = new FormData()
    form.append('audio', audio, fileNameForMime(mimeType))
    form.append('durationMs', String(Math.round(durationMs)))
    return request<UtteranceResponse>('POST', '/api/utterances/voice', { form, timeoutMs: UTTERANCE_TIMEOUT })
  },
  undo: (utteranceId: string) => request<UndoResponse>('POST', `/api/utterances/${enc(utteranceId)}/undo`),

  // ---- signed links (no session)
  linkView: (token: string) => request<LinkViewResponse>('GET', `/api/t/${enc(token)}`, { auth: false }),
  linkAction: (token: string, body: LinkActionBody) =>
    request<LinkViewResponse>('POST', `/api/t/${enc(token)}/action`, { body, auth: false }),

  // ---- notifications (the service worker calls this route itself; kept here for completeness)
  notificationAction: (id: string, body: NotificationActionBody) =>
    request<{ ok: true }>('POST', `/api/notifications/${enc(id)}/action`, { body }),

  // ---- web push
  vapidPublicKey: () => request<{ key: string | null }>('GET', '/api/push/vapid-public-key'),
  subscribePush: (body: PushSubscribeBody) => request<{ ok: true }>('POST', '/api/push/subscriptions', { body }),
  unsubscribePush: (endpoint: string) => request<{ ok: true }>('DELETE', '/api/push/subscriptions', { body: { endpoint } }),
  testPush: () => request<{ ok: true; delivered: number }>('POST', '/api/push/test'),

  // ---- settings
  settings: () => request<SettingsResponse>('GET', '/api/settings'),
  saveSettings: (body: SettingsBody) => request<SettingsResponse>('PUT', '/api/settings', { body }),
  wechatBindCode: () => request<WechatBindCodeResponse>('POST', '/api/wechat/bind-code'),

  // ---- family
  members: () => request<{ members: Member[] }>('GET', '/api/members'),
  createMember: (body: NewMemberBody) => request<InviteResponse>('POST', '/api/members', { body }),
  inviteMember: (id: string) => request<InviteResponse>('POST', `/api/members/${enc(id)}/invite`),
}
