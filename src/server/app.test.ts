// Integration: buildContext wires the real modules (domain, interpreter, notifier, scheduler) and the HTTP
// app serves them end to end with a fake notification channel.

import { describe, expect, it } from 'vitest'
import type { MeResponse, UtteranceResponse } from '../shared/api'
import type { Member, ScheduledNotification } from '../shared/types'
import { INTERRUPTED_REPLY, buildContext, drainBackgroundWork, recoverInterruptedUtterances } from './app'
import { testConfig } from './config'
import { createInvite } from './http/auth'
import { createApp } from './http/app'
import type { DeliveryResult, NotificationChannel } from './notify/types'
import { FixedClock } from './time'

class RecordingChannel implements NotificationChannel {
  readonly name = 'recording'
  sent: { member: Member; n: ScheduledNotification }[] = []
  isConfigured() {
    return true
  }
  async deliver(member: Member, n: ScheduledNotification): Promise<DeliveryResult[]> {
    this.sent.push({ member, n })
    return [{ channel: this.name, ok: true }]
  }
}

describe('buildContext + createApp', () => {
  it('wires every module and serves a join → board → test push round trip', async () => {
    const channel = new RecordingChannel()
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const config = testConfig({ dbPath: ':memory:', familyName: '王家', familyTimezone: 'Australia/Sydney' })
    const ctx = buildContext(config, { clock, stt: null, channels: [channel] })
    try {
      expect(ctx.domain.getFamily()).toEqual({ name: '王家', timezone: 'Australia/Sydney' })
      expect(ctx.stt).toBeNull()
      expect(ctx.interpreter.enabled).toBe(false)
      expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM kv WHERE key = 'app_secret'`).get()).toEqual({ n: 1 })

      const app = createApp(ctx, { webDir: null, log: () => undefined })
      const wife = ctx.domain.createMember({ name: '老婆', role: 'adult' })
      const { token } = createInvite(ctx.db, clock, config.publicUrl, wife.id, null)
      const join = await app.request('/api/auth/join', {
        method: 'POST',
        headers: { 'X-Family-Share': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      expect(join.status).toBe(200)
      const cookie = /fs_session=[^;]+/.exec(join.headers.get('set-cookie') ?? '')![0]

      const me = (await (await app.request('/api/me', { headers: { Cookie: cookie } })).json()) as MeResponse
      expect(me.sttEnabled).toBe(false)
      expect(me.channels).toEqual(['recording'])

      const board = await app.request('/api/board', { headers: { Cookie: cookie } })
      expect(board.status).toBe(200)

      // AI not configured: the utterance is recorded and finished with an error, not a 500
      const u = await app.request('/api/utterances', {
        method: 'POST',
        headers: { Cookie: cookie, 'X-Family-Share': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '明天买菜' }),
      })
      expect(u.status).toBe(200)
      expect(((await u.json()) as UtteranceResponse).utterance.status).toBe('error')

      const test = await app.request('/api/push/test', { method: 'POST', headers: { Cookie: cookie, 'X-Family-Share': '1' } })
      expect(test.status).toBe(200)
      expect(await test.json()).toEqual({ ok: true, delivered: 1 })
      expect(channel.sent.map(s => [s.member.id, s.n.kind])).toEqual([[wife.id, 'test']])
    } finally {
      ctx.scheduler.stop()
      ctx.db.close()
    }
  })
})

describe('server start and shutdown', () => {
  it('finishes utterances a crash or restart left in processing (they would show 处理中 forever and could not be undone)', () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const ctx = buildContext(testConfig({ dbPath: ':memory:' }), { clock, stt: null, channels: [] })
    try {
      const wife = ctx.domain.createMember({ name: '老婆', role: 'adult' })
      const stuck = ctx.domain.createUtterance(wife.id, 'wechat', '明天买菜')
      const ok = ctx.domain.createUtterance(wife.id, 'text', '周六去公园')
      ctx.domain.finishUtterance(ok.id, { status: 'done', reply: '好的' })
      // building a context (the CLI does it while the server runs) must not touch in-flight utterances
      expect(ctx.domain.getUtterance(stuck.id)!.status).toBe('processing')

      expect(recoverInterruptedUtterances(ctx)).toBe(1)
      expect(ctx.domain.getUtterance(stuck.id)).toMatchObject({ status: 'error', reply: INTERRUPTED_REPLY, error: INTERRUPTED_REPLY })
      expect(ctx.domain.getUtterance(ok.id)).toMatchObject({ status: 'done', reply: '好的' })
      expect(recoverInterruptedUtterances(ctx)).toBe(0)
    } finally {
      ctx.scheduler.stop()
      ctx.db.close()
    }
  })

  it('drainBackgroundWork waits for background work, but never longer than the timeout', async () => {
    const ctx = buildContext(testConfig({ dbPath: ':memory:' }), { stt: null, channels: [] })
    try {
      let done = false
      const slow = () => new Promise<void>(r => setTimeout(() => ((done = true), r()), 30))
      expect(await drainBackgroundWork(ctx, 1000, slow)).toBe(true)
      expect(done).toBe(true)
      const t0 = Date.now()
      expect(await drainBackgroundWork(ctx, 50, () => new Promise<void>(() => undefined))).toBe(false)
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(await drainBackgroundWork(ctx, 1000)).toBe(true) // the real WeChat tracker: nothing pending
    } finally {
      ctx.scheduler.stop()
      ctx.db.close()
    }
  })
})
