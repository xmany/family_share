// Test helpers for the HTTP layer: a real in-memory domain (createTestContext) plus small fakes for the
// interpreter, notifier, scheduler and STT, and a request helper with cookie + CSRF handling.
// Test files that use createApp must also `vi.mock('../wechat/index', …)` themselves.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelSetting, PushSubscribeBody, UtteranceResponse } from '../../shared/api'
import type { Member, ScheduledNotification } from '../../shared/types'
import type { InterpretInput, Interpreter } from '../ai/types'
import type { Config } from '../config'
import type { AppContext } from '../context'
import { newId } from '../ids'
import type { DeliveryResult, Notifier } from '../notify/types'
import type { Scheduler, TickReport } from '../scheduler/types'
import type { SttProvider } from '../stt/types'
import type { TestContext } from '../testing'
import { createTestContext } from '../testing'
import type { AppOptions } from './app'
import { createApp } from './app'
import { SESSION_COOKIE, createInvite, createSession } from './auth'

export class FakeInterpreter implements Interpreter {
  readonly enabled = true
  calls: InterpretInput[] = []
  constructor(private t: TestContext) {}
  async interpret(input: InterpretInput): Promise<UtteranceResponse> {
    this.calls.push(input)
    const d = this.t.domain
    const u = d.createUtterance(input.memberId, input.source, input.text, {
      replyTo: input.replyToUtteranceId ?? null,
      audioPath: input.audioPath ?? null,
    })
    const item = d.createItem({ type: 'ai', memberId: input.memberId, utteranceId: u.id }, { kind: 'task', title: input.text.slice(0, 50) })
    d.finishUtterance(u.id, { status: 'done', reply: '好的，记下了' })
    return { utterance: d.getUtterance(u.id)!, items: [d.getItem(item.id)!] }
  }
}

export class FakeNotifier implements Notifier {
  memberChannels = new Map<string, ChannelSetting[]>()
  constructor(private t: TestContext) {}
  channels() {
    return ['webpush']
  }
  async deliver(_n: ScheduledNotification): Promise<DeliveryResult[]> {
    return []
  }
  vapidPublicKey() {
    return 'BFakeVapidPublicKey'
  }
  savePushSubscription(memberId: string, sub: PushSubscribeBody['subscription'], userAgent?: string | null) {
    this.t.db
      .prepare(
        `INSERT INTO push_subscriptions (id, member_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id`,
      )
      .run(newId('ps'), memberId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent ?? null, this.t.clock.now().toISOString())
  }
  removePushSubscription(endpoint: string) {
    this.t.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }
  pushSubscriptionCount(memberId: string) {
    return (this.t.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?').get(memberId) as { n: number }).n
  }
  getMemberChannels(memberId: string): ChannelSetting[] {
    return this.memberChannels.get(memberId) ?? [{ channel: 'webpush', enabled: true, config: {} }]
  }
  setMemberChannels(memberId: string, settings: ChannelSetting[]): ChannelSetting[] {
    this.memberChannels.set(memberId, settings)
    return settings
  }
}

/** Delivers every due row: records `endpoints` successful webpush deliveries and marks it sent. */
export class FakeScheduler implements Scheduler {
  ticks = 0
  endpoints = 2
  constructor(private t: TestContext) {}
  start() {}
  stop() {}
  async tick(): Promise<TickReport> {
    this.ticks++
    const due = this.t.outbox.due(this.t.clock.now())
    for (const n of due) {
      for (let i = 0; i < this.endpoints; i++) this.t.outbox.recordDelivery(n.id, 'webpush', true)
      this.t.outbox.markSent(n.id)
    }
    return { delivered: due.length, deferred: 0, failed: 0, generated: 0 }
  }
}

export interface Harness {
  t: TestContext
  ctx: AppContext
  app: ReturnType<typeof createApp>
  interpreter: FakeInterpreter
  notifier: FakeNotifier
  scheduler: FakeScheduler
  /** Session cookie header value for a member (creates a session directly) */
  cookieFor(member: Member): string
  /** Raw invite token for a member */
  inviteFor(member: Member): string
  req(method: string, path: string, opts?: ReqOpts): Promise<Response>
  /** req() + JSON body */
  json<T = any>(method: string, path: string, opts?: ReqOpts): Promise<{ status: number; body: T; res: Response }>
}

export interface ReqOpts {
  as?: Member
  cookie?: string
  body?: unknown
  /** Send the X-Family-Share header (default true) */
  csrf?: boolean
  headers?: Record<string, string>
  form?: FormData
}

export function harness(
  opts: { stt?: SttProvider | null; config?: Partial<Config>; app?: AppOptions; now?: string; timezone?: string } = {},
): Harness {
  const t = createTestContext({ ...(opts.now ? { now: opts.now } : {}), ...(opts.timezone ? { timezone: opts.timezone } : {}) })
  const dataDir = mkdtempSync(join(tmpdir(), 'family-share-http-'))
  const config: Config = { ...t.config, dataDir, audioDir: join(dataDir, 'audio'), ...opts.config }
  const interpreter = new FakeInterpreter(t)
  const notifier = new FakeNotifier(t)
  const scheduler = new FakeScheduler(t)
  const ctx: AppContext = {
    config,
    db: t.db,
    clock: t.clock,
    bus: t.bus,
    outbox: t.outbox,
    domain: t.domain,
    interpreter,
    stt: opts.stt === undefined ? null : opts.stt,
    notifier,
    scheduler,
  }
  const app = createApp(ctx, { webDir: null, log: () => undefined, ...opts.app })
  const cookies = new Map<string, string>()
  const cookieFor = (m: Member) => {
    let c = cookies.get(m.id)
    if (!c) {
      c = `${SESSION_COOKIE}=${createSession(t.db, t.clock, m.id, 'vitest')}`
      cookies.set(m.id, c)
    }
    return c
  }
  const req = (method: string, path: string, o: ReqOpts = {}) => {
    const headers: Record<string, string> = { ...o.headers }
    if (o.csrf !== false && method !== 'GET' && !('X-Family-Share' in headers)) headers['X-Family-Share'] = '1'
    const cookie = o.cookie ?? (o.as ? cookieFor(o.as) : undefined)
    if (cookie) headers.Cookie = cookie
    let body: FormData | string | undefined
    if (o.form) body = o.form
    else if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
    }
    return Promise.resolve(app.request(path, { method, headers, body }))
  }
  return {
    t,
    ctx,
    app,
    interpreter,
    notifier,
    scheduler,
    cookieFor,
    inviteFor: m => createInvite(t.db, t.clock, config.publicUrl, m.id, null).token,
    req,
    async json(method, path, o) {
      const res = await req(method, path, o)
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null, res }
    },
  }
}
