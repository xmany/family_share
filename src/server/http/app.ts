// The HTTP server (SPEC §5): every route in src/shared/api.ts, the WeChat callback, /healthz and, in
// production, the built web app from dist/web.
//
// Order of checks for /api/*: CSRF header on mutations → session (except join, logout and the signed
// /api/t/:token links) → body size limit → route. The cheap checks come first because the size limit has to buffer
// a body sent without Content-Length (chunked, or HTTP/2 through Funnel) before it can pass it on: in front of the
// session check it let anyone on the public URL make the server hold 1–10.5 MB per connection. POST /wechat/mp
// likewise checks its signature (query only) before the body is read. Every error body is { error: { code, message } }.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { z } from 'zod'
import type {
  InviteResponse,
  ItemResponse,
  JoinResponse,
  LinkViewResponse,
  MeResponse,
  SettingsResponse,
  UtteranceResponse,
} from '../../shared/api'
import type { Item, Member, WechatMode } from '../../shared/types'
import { ACTIVE_STATUSES } from '../../shared/types'
import type { AppContext } from '../context'
import type { Actor } from '../domain/types'
import { newId } from '../ids'
import { MAX_AUDIO_BYTES, audioExtFor, baseMime, mimeForExt } from '../stt/audio'
import { SttError } from '../stt/types'
import { isPushHealthy } from '../notify/webpush'
import { resolveSnoozePreset } from '../time'
import type { LinkTokenPayload } from '../tokens'
import { getOrCreateAppSecret, isLinkTokenRevoked, verifyLinkToken } from '../tokens'
import {
  createWechatBindCode,
  getWechatBinding,
  handleWechatMessage,
  handleWechatVerify,
  rejectUnsignedWechatCallback,
} from '../wechat/index'
import { sendTestNotification, sttOptionsFor } from './actions'
import type { SessionInfo } from './auth'
import {
  INVITE_PROBLEM_ZH,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  createInvite,
  createSession,
  findSession,
  redeemInvite,
  revokeSession,
  touchSession,
} from './auth'
import { HttpError, sendError, toErrorResponse, zodMessage } from './errors'
import {
  completeSchema,
  createItemSchema,
  joinSchema,
  linkActionSchema,
  newMemberSchema,
  noteSchema,
  notificationActionSchema,
  parseInstant,
  pushSubscribeSchema,
  pushUnsubscribeSchema,
  respondSchema,
  settingsSchema,
  snoozeSchema,
  updateItemSchema,
  utteranceSchema,
} from './schemas'
import { StreamRegistry, sseHeaders, sseResponse } from './sse'
import { createStaticServer, defaultWebDir } from './static'

export { StreamRegistry } from './sse'

export interface AppOptions {
  /** Built web app to serve. undefined = auto-detect dist/web; null = serve no static files. */
  webDir?: string | null
  /** Open SSE streams, so a graceful shutdown can end them */
  streams?: StreamRegistry
  /** SSE ping interval (default 25 s) */
  pingIntervalMs?: number
  log?: (...args: unknown[]) => void
}

type Vars = { member: Member; session: SessionInfo }
type Env = { Variables: Vars }
type C = Context<Env>

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const JSON_LIMIT = 1024 * 1024
const VOICE_LIMIT = MAX_AUDIO_BYTES + 512 * 1024 // multipart overhead + durationMs field
/** join / logout / signed-link actions run without a session: their bodies are tiny (a link action's message ≤ 4000 chars) */
const PUBLIC_LIMIT = 32 * 1024
const WECHAT_LIMIT = 256 * 1024
const MAX_VOICE_MS = 90_000
const MAX_BUS_LISTENERS = 200
/** Paths under /api that work without a session */
const PUBLIC_API = /^\/api\/(?:auth\/(?:join|logout)|t\/[^/]+(?:\/action)?)$/

export function createApp(ctx: AppContext, opts: AppOptions = {}): Hono<Env> {
  const { config, db, clock, domain } = ctx
  const log = opts.log ?? ((...args: unknown[]) => console.error(...args))
  const streams = opts.streams ?? new StreamRegistry()
  // Every open SSE stream adds one 'server_event' listener. A family easily has more than Node's default 10
  // (several phones and tabs, plus half-open connections from sleeping phones until TCP gives up), which would
  // log a misleading "possible EventEmitter memory leak" warning.
  const maxListeners = ctx.bus.getMaxListeners()
  if (maxListeners !== 0 && maxListeners < MAX_BUS_LISTENERS) ctx.bus.setMaxListeners(MAX_BUS_LISTENERS)
  const webDir = opts.webDir === undefined ? defaultWebDir() : opts.webDir
  const serveStatic = webDir ? createStaticServer(webDir) : null
  let appSecret: string | null = null
  const secret = () => (appSecret ??= getOrCreateAppSecret(db))

  const app = new Hono<Env>()

  // ---------------------------------------------------------------- helpers

  const me = (c: C): Member => c.get('member')
  const actorOf = (c: C): Actor => ({ type: 'member', memberId: me(c).id })

  async function body<S extends z.ZodType>(c: C, schema: S): Promise<z.output<S>> {
    let raw: unknown = {}
    const text = await c.req.text()
    if (text.trim()) {
      try {
        raw = JSON.parse(text)
      } catch {
        throw new HttpError(400, 'invalid', '请求格式不对（需要 JSON）')
      }
    }
    const r = schema.safeParse(raw)
    if (!r.success) throw new HttpError(400, 'invalid', zodMessage(r.error))
    return r.data
  }

  function setSessionCookie(c: C, value: string) {
    setCookie(c, SESSION_COOKIE, value, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.secureCookies,
      maxAge: SESSION_MAX_AGE_S,
    })
  }

  function itemOr404(id: string): Item {
    const item = domain.getItem(id)
    if (!item) throw new HttpError(404, 'not_found', '找不到这件事，可能已经被删除了')
    return item
  }

  function requireAdult(c: C) {
    if (me(c).role !== 'adult') throw new HttpError(403, 'forbidden', '只有大人可以管理家庭成员')
  }

  function inviteFor(c: C, member: Member): InviteResponse {
    const inv = createInvite(db, clock, config.publicUrl, member.id, me(c).id)
    return { member, inviteUrl: inv.inviteUrl, expiresAt: inv.expiresAt }
  }

  function wechatBinding(memberId: string): { bound: boolean; mode: WechatMode } {
    try {
      return getWechatBinding(ctx, memberId)
    } catch (e) {
      log('[http] getWechatBinding failed', e)
      return { bound: false, mode: 'fallback' }
    }
  }

  function settingsFor(memberId: string): SettingsResponse {
    const member = domain.getMember(memberId)
    if (!member) throw new HttpError(404, 'not_found', '找不到这个成员')
    const binding = wechatBinding(memberId)
    return {
      me: member,
      channels: ctx.notifier.getMemberChannels(memberId),
      pushDevices: ctx.notifier.pushSubscriptionCount(memberId),
      pushHealthy: isPushHealthy(db, memberId, clock.now()),
      wechat: {
        available: !!config.wechat,
        bound: binding.bound,
        mode: binding.mode,
        followQrUrl: config.wechat?.followQrUrl ?? null,
      },
    }
  }

  // ---------------------------------------------------------------- global middleware

  app.onError((err, c) => toErrorResponse(c, err, log))

  app.use('*', async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    // Invite and link tokens live in URLs: never leak them to other sites via Referer.
    c.header('Referrer-Policy', 'same-origin')
  })

  const jsonLimit = bodyLimit({ maxSize: JSON_LIMIT, onError: c => sendError(c, 413, 'too_large', '内容太大了') })
  const voiceLimit = bodyLimit({ maxSize: VOICE_LIMIT, onError: c => sendError(c, 413, 'too_large', '录音太大了（最多 10 MB）') })
  const publicLimit = bodyLimit({ maxSize: PUBLIC_LIMIT, onError: c => sendError(c, 413, 'too_large', '内容太大了') })

  const apiGuard: MiddlewareHandler<Env> = async (c, next) => {
    if (MUTATING.has(c.req.method) && c.req.header('x-family-share') !== '1') {
      return sendError(c, 403, 'forbidden', '请求缺少安全标记，请刷新页面后再试')
    }
    if (!PUBLIC_API.test(c.req.path)) {
      const session = findSession(db, clock, getCookie(c, SESSION_COOKIE))
      const member = session ? domain.getMember(session.memberId) : null
      if (!session || !member) return sendError(c, 401, 'unauthorized', '请用家人发给你的邀请链接加入')
      c.set('session', session)
      c.set('member', member)
      // sliding renewal: refresh last_seen_at (≤ every 5 min) and the cookie's 400-day Max-Age with it
      if (touchSession(db, clock, session)) setSessionCookie(c, getCookie(c, SESSION_COOKIE)!)
    }
    await next()
    // API responses are never cached (the SSE route sets its own no-cache, no-transform)
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store')
  }

  // apiGuard first: bodyLimit reads (and keeps) a body without Content-Length before calling next(), so nothing may
  // be read before the CSRF header and the session are known good (see the top of this file).
  app.use('/api/*', apiGuard)
  app.use('/api/*', (c, next) => {
    const path = c.req.path
    if (path === '/api/utterances/voice') return voiceLimit(c, next)
    return PUBLIC_API.test(path) ? publicLimit(c, next) : jsonLimit(c, next)
  })

  // ---------------------------------------------------------------- auth

  app.post('/api/auth/join', async c => {
    const { token } = await body(c, joinSchema)
    const r = redeemInvite(db, clock, token.trim())
    if (!r.ok) return sendError(c, 401, `invite_${r.reason}`, INVITE_PROBLEM_ZH[r.reason])
    const member = domain.getMember(r.memberId)
    if (!member) return sendError(c, 401, 'invite_unknown', INVITE_PROBLEM_ZH.unknown)
    const secretValue = createSession(db, clock, member.id, c.req.header('user-agent') ?? null)
    setSessionCookie(c, secretValue)
    return c.json({ me: member } satisfies JoinResponse)
  })

  app.post('/api/auth/logout', c => {
    const session = findSession(db, clock, getCookie(c, SESSION_COOKIE))
    if (session) revokeSession(db, clock, session.tokenHash)
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: config.secureCookies, httpOnly: true, sameSite: 'Lax' })
    return c.json({ ok: true as const })
  })

  // ---------------------------------------------------------------- me & board

  app.get('/api/me', c => {
    const res: MeResponse = {
      me: me(c),
      family: domain.getFamily(),
      vapidPublicKey: ctx.notifier.vapidPublicKey(),
      sttEnabled: ctx.stt !== null,
      channels: ctx.notifier.channels(),
    }
    return c.json(res)
  })

  app.get('/api/board', c => c.json(domain.getBoard(me(c).id)))

  // ---------------------------------------------------------------- items

  app.get('/api/items/:id', c => {
    const detail = domain.getItemDetail(c.req.param('id'))
    if (!detail) throw new HttpError(404, 'not_found', '找不到这件事，可能已经被删除了')
    return c.json(detail)
  })

  app.post('/api/items', async c => {
    const b = await body(c, createItemSchema)
    const actor = actorOf(c)
    let item: Item
    if (b.kind === 'request') {
      if (!b.ownerId) throw new HttpError(400, 'invalid', '请求需要选择请谁来做')
      item = domain.sendRequest(actor, {
        toMemberId: b.ownerId,
        title: b.title,
        details: b.details,
        dueAt: b.dueAt,
        dueDate: b.dueDate,
        priority: b.priority,
      })
    } else {
      item = domain.createItem(actor, {
        kind: b.kind,
        title: b.title,
        details: b.details,
        ownerId: b.ownerId,
        dueAt: b.dueAt,
        dueDate: b.dueDate,
        priority: b.priority,
      })
    }
    return c.json({ item } satisfies ItemResponse)
  })

  app.patch('/api/items/:id', async c => {
    const b = await body(c, updateItemSchema)
    const item = domain.updateItem(actorOf(c), c.req.param('id'), b)
    return c.json({ item } satisfies ItemResponse)
  })

  app.post('/api/items/:id/respond', async c => {
    const b = await body(c, respondSchema)
    const item = domain.respondToRequest(actorOf(c), c.req.param('id'), b.response, b.message)
    return c.json({ item } satisfies ItemResponse)
  })

  app.post('/api/items/:id/complete', async c => {
    const b = await body(c, completeSchema)
    const item = domain.completeItem(actorOf(c), c.req.param('id'), b.note)
    return c.json({ item } satisfies ItemResponse)
  })

  app.post('/api/items/:id/snooze', async c => {
    const b = await body(c, snoozeSchema)
    const tz = domain.getFamily().timezone
    let until: Date
    if (b.preset) {
      until = resolveSnoozePreset(b.preset, clock.now(), tz)
    } else {
      const parsed = parseInstant(b.until!, tz)
      if (!parsed) throw new HttpError(400, 'invalid', '推迟时间格式不对（需要 ISO 8601，如 2026-10-24T08:30:00+11:00）')
      until = parsed
    }
    const item = domain.snoozeItem(actorOf(c), c.req.param('id'), until)
    return c.json({ item } satisfies ItemResponse)
  })

  app.post('/api/items/:id/notes', async c => {
    const b = await body(c, noteSchema)
    const id = c.req.param('id')
    domain.addNote(actorOf(c), id, b.text)
    return c.json({ item: itemOr404(id) } satisfies ItemResponse)
  })

  // ---------------------------------------------------------------- utterances

  app.post('/api/utterances', async c => {
    const b = await body(c, utteranceSchema)
    const res = await ctx.interpreter.interpret({
      memberId: me(c).id,
      text: b.text,
      source: b.source ?? (b.replyToUtteranceId ? 'clarification' : 'text'),
      replyToUtteranceId: b.replyToUtteranceId ?? null,
    })
    return c.json(res)
  })

  app.post('/api/utterances/voice', async c => {
    const member = me(c)
    const stt = ctx.stt
    if (!stt) throw new HttpError(422, 'stt_unavailable', '服务器没有开启语音识别，请用键盘上的语音输入')
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      throw new HttpError(400, 'invalid', '请用 multipart/form-data 上传录音（字段 audio）')
    }
    const audio = form.get('audio')
    if (!audio || typeof audio === 'string') throw new HttpError(400, 'invalid', '缺少录音（字段 audio）')
    if (audio.size === 0) throw new HttpError(400, 'invalid', '录音是空的，请再说一次')
    if (audio.size > MAX_AUDIO_BYTES) throw new HttpError(413, 'too_large', '录音太大了（最多 10 MB）')
    const durationRaw = form.get('durationMs')
    const durationMs = typeof durationRaw === 'string' && durationRaw.trim() ? Number(durationRaw) : null
    if (durationMs !== null && Number.isFinite(durationMs) && durationMs > MAX_VOICE_MS) {
      throw new HttpError(400, 'invalid', '录音太长了（最多 90 秒）')
    }
    const fileName = 'name' in audio && typeof audio.name === 'string' ? audio.name : null
    const ext = audioExtFor(audio.type, fileName)
    if (!ext) throw new HttpError(400, 'invalid', '不支持这种录音格式')
    // The STT layer only sees the MIME type (no file name), so it must name the same container as `ext`:
    // a generic type such as application/octet-stream would be read as webm there.
    const mime = audioExtFor(audio.type) === ext ? baseMime(audio.type) : mimeForExt(ext)
    const bytes = Buffer.from(await audio.arrayBuffer())

    // Keep every upload (a failed transcription can be retried later). The interpreter assigns the
    // utterance id, so the file gets its own id and the utterance records it in audio_path.
    const voiceId = newId('u').replace(/^u_/, 'v_')
    const audioPath = join(config.audioDir, `${voiceId}.${ext}`)
    // the family's voices: readable by the server's user only (mode applies when the directory is created)
    await mkdir(config.audioDir, { recursive: true, mode: 0o700 })
    await writeFile(audioPath, bytes, { mode: 0o600 })

    let transcriptText: string
    try {
      const t = await stt.transcribe(bytes, mime, sttOptionsFor(ctx, member))
      transcriptText = t.text.trim()
    } catch (e) {
      if (e instanceof SttError) {
        log(`[http] transcription failed for ${audioPath}: ${e.message}`)
        throw new HttpError(422, 'stt_failed', '没听清，请再说一次，或者用键盘上的语音输入')
      }
      throw e
    }
    if (!transcriptText) throw new HttpError(422, 'stt_failed', '没听到说话的内容，请再说一次')
    const res = await ctx.interpreter.interpret({ memberId: member.id, text: transcriptText, source: 'voice', audioPath })
    return c.json({ ...res, transcript: transcriptText } satisfies UtteranceResponse)
  })

  app.post('/api/utterances/:id/undo', c => c.json(domain.undoUtterance(actorOf(c), c.req.param('id'))))

  // ---------------------------------------------------------------- notification buttons (service worker)

  app.post('/api/notifications/:id/action', async c => {
    const { action } = await body(c, notificationActionSchema)
    const n = ctx.outbox.get(c.req.param('id'))
    // Only the recipient may act on a notification; anyone else gets the same 404 as a wrong id.
    if (!n || n.memberId !== me(c).id) throw new HttpError(404, 'not_found', '找不到这条通知')
    if (!n.itemId) throw new HttpError(400, 'invalid', '这条通知没有对应的事项')
    const item = itemOr404(n.itemId)
    const actor = actorOf(c)
    // Button taps can be repeated (retries, two devices): an already-applied action is a success.
    const already =
      (action === 'done' && item.status === 'done') ||
      (action === 'accept' && item.status === 'accepted') ||
      (action === 'decline' && item.status === 'declined')
    if (!already) {
      switch (action) {
        case 'accept':
        case 'decline':
          domain.respondToRequest(actor, item.id, action)
          break
        case 'done':
          domain.completeItem(actor, item.id)
          break
        case 'snooze_tonight':
        case 'snooze_tomorrow':
          domain.snoozeItem(
            actor,
            item.id,
            resolveSnoozePreset(action === 'snooze_tonight' ? 'tonight' : 'tomorrow', clock.now(), domain.getFamily().timezone),
          )
          break
      }
    }
    return c.json({ ok: true as const })
  })

  // ---------------------------------------------------------------- web push

  app.get('/api/push/vapid-public-key', c => c.json({ key: ctx.notifier.vapidPublicKey() }))

  app.post('/api/push/subscriptions', async c => {
    const { subscription } = await body(c, pushSubscribeSchema)
    if (!ctx.notifier.vapidPublicKey()) throw new HttpError(409, 'conflict', '服务器还没有配置推送通知')
    ctx.notifier.savePushSubscription(
      me(c).id,
      { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime ?? null, keys: subscription.keys },
      c.req.header('user-agent') ?? null,
    )
    return c.json({ ok: true as const })
  })

  app.delete('/api/push/subscriptions', async c => {
    const { endpoint } = await body(c, pushUnsubscribeSchema)
    const row = db.prepare('SELECT member_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { member_id: string } | undefined
    if (row && row.member_id !== me(c).id) throw new HttpError(404, 'not_found', '找不到这个推送订阅')
    if (row) ctx.notifier.removePushSubscription(endpoint)
    return c.json({ ok: true as const })
  })

  app.post('/api/push/test', async c => {
    const r = await sendTestNotification(ctx, me(c))
    return c.json({ ok: true as const, delivered: r.delivered })
  })

  // ---------------------------------------------------------------- settings & WeChat binding

  app.get('/api/settings', c => c.json(settingsFor(me(c).id)))

  app.put('/api/settings', async c => {
    const b = await body(c, settingsSchema)
    const id = me(c).id
    const patch = {
      ...(b.name !== undefined && { name: b.name }),
      ...(b.aliases !== undefined && { aliases: b.aliases }),
      ...(b.quietStart !== undefined && { quietStart: b.quietStart }),
      ...(b.quietEnd !== undefined && { quietEnd: b.quietEnd }),
      ...(b.digestTime !== undefined && { digestTime: b.digestTime }),
    }
    if (Object.keys(patch).length) domain.updateMember(id, patch)
    if (b.channels?.length) ctx.notifier.setMemberChannels(id, b.channels)
    return c.json(settingsFor(id))
  })

  app.post('/api/wechat/bind-code', c => {
    if (!config.wechat) throw new HttpError(409, 'conflict', '服务器还没有配置微信测试号')
    return c.json(createWechatBindCode(ctx, me(c).id))
  })

  // ---------------------------------------------------------------- family members

  app.get('/api/members', c => c.json({ members: domain.listMembers() }))

  app.post('/api/members', async c => {
    requireAdult(c)
    const b = await body(c, newMemberSchema)
    const member = domain.createMember({ name: b.name, aliases: b.aliases, role: b.role })
    return c.json(inviteFor(c, member))
  })

  app.post('/api/members/:id/invite', c => {
    requireAdult(c)
    const member = domain.getMember(c.req.param('id'))
    if (!member) throw new HttpError(404, 'not_found', '找不到这个成员')
    return c.json(inviteFor(c, member))
  })

  // ---------------------------------------------------------------- signed item links (no session)

  function verifiedLink(token: string): { p: LinkTokenPayload; item: Item } {
    const p = verifyLinkToken(token, secret(), clock.now())
    // isLinkTokenRevoked: the member's links were revoked after it was sent (lost phone)
    if (!p || isLinkTokenRevoked(db, p) || !domain.getMember(p.m)) throw new HttpError(401, 'link_invalid', '这个链接已过期或无效，请打开 App 查看')
    const item = domain.getItem(p.i)
    if (!item) throw new HttpError(404, 'not_found', '找不到这件事，可能已经被删除了')
    return { p, item }
  }

  function linkView(p: LinkTokenPayload, item: Item): LinkViewResponse {
    const active = ACTIVE_STATUSES.includes(item.status)
    const allowed = (['accept', 'decline', 'done'] as const).filter(a => {
      if (!p.a.includes(a)) return false
      if (a === 'done') return active
      return item.kind === 'request' && item.status === 'pending' && item.ownerId === p.m
    })
    return { item, members: domain.listMembers(), memberId: p.m, allowed, family: domain.getFamily() }
  }

  app.get('/api/t/:token', c => {
    const { p, item } = verifiedLink(c.req.param('token'))
    // only what the token lists (SPEC §5); every link the notifier mints includes 'view'
    if (!p.a.includes('view')) throw new HttpError(403, 'forbidden', '这个链接不能查看这件事')
    return c.json(linkView(p, item))
  })

  app.post('/api/t/:token/action', async c => {
    const { p, item } = verifiedLink(c.req.param('token'))
    const b = await body(c, linkActionSchema)
    if (!p.a.includes(b.action)) throw new HttpError(403, 'forbidden', '这个链接不能做这个操作')
    const actor: Actor = { type: 'member', memberId: p.m }
    if (b.action === 'done') domain.completeItem(actor, item.id, b.message)
    else domain.respondToRequest(actor, item.id, b.action, b.message)
    return c.json(linkView(p, itemOr404(item.id)))
  })

  // ---------------------------------------------------------------- live updates

  app.get('/api/stream', c => {
    // Hono answers HEAD with the GET handler and drops the body without cancelling it: a stream opened here would
    // keep its bus listener and ping timer forever.
    if (c.req.raw.method === 'HEAD') return new Response(null, { status: 200, headers: sseHeaders() })
    const raw = getCookie(c, SESSION_COOKIE)
    const memberId = me(c).id
    return sseResponse({
      bus: ctx.bus,
      clock,
      signal: c.req.raw.signal,
      registry: streams,
      pingMs: opts.pingIntervalMs,
      isAuthorized: () => findSession(db, clock, raw)?.memberId === memberId,
    })
  })

  // ---------------------------------------------------------------- WeChat callback (no session, no CSRF header)

  app.get('/wechat/mp', c => {
    const r = handleWechatVerify(ctx, c.req.query())
    return c.body(r.body, r.status as 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  })

  // signature and timestamp are in the query: an unsigned or stale request is answered before its body is read
  const wechatPrecheck: MiddlewareHandler<Env> = async (c, next) => {
    const r = rejectUnsignedWechatCallback(ctx, c.req.query())
    if (r) return c.body(r.body, r.status as 200, { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' })
    await next()
  }

  app.post('/wechat/mp', wechatPrecheck, bodyLimit({ maxSize: WECHAT_LIMIT, onError: c => c.text('', 413) }), async c => {
    const raw = await c.req.text()
    try {
      const r = await handleWechatMessage(ctx, c.req.query(), raw)
      return c.body(r.body, r.status as 200, { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' })
    } catch (e) {
      // WeChat retries unanswered messages; an empty 200 is an ack.
      log('[http] wechat callback failed', e)
      return c.body('', 200, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
  })

  // ---------------------------------------------------------------- health, static web app, 404

  app.get('/healthz', c => {
    c.header('Cache-Control', 'no-store')
    return c.json({ ok: true as const })
  })

  const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/') || p === '/wechat' || p.startsWith('/wechat/')

  app.get('*', async c => {
    const path = c.req.path
    if (isApiPath(path)) return sendError(c, 404, 'not_found', '没有这个接口')
    if (!serveStatic) {
      return c.text('family_share server is running. The web app is not built here: run `npm run build:web`, or use the Vite dev server (npm run dev).', 404)
    }
    const res = await serveStatic(path, c.req.method)
    return res ?? c.text('Not found', 404)
  })

  app.notFound(c => (isApiPath(c.req.path) ? sendError(c, 404, 'not_found', '没有这个接口') : c.text('Not found', 404)))

  return app
}
