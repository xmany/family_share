// Integrator fixes: the per-utterance deadline, and a graceful shutdown that waits for the row being sent.

import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { describe, expect, it } from 'vitest'
import type { Member, ScheduledNotification } from '../shared/types'
import { createInterpreter } from './ai/index'
import type { MessagesApi } from './ai/index'
import { msg, toolUse } from './ai/testing'
import { buildContext, drainBackgroundWork } from './app'
import { testConfig } from './config'
import type { DeliveryResult, NotificationChannel } from './notify/types'
import { schedulerIdle } from './scheduler/index'
import { createTestContext } from './testing'
import { FixedClock } from './time'

/** First call creates an item; the second hangs until the request is aborted, like a slow model call would. */
class HangingApi implements MessagesApi {
  calls = 0
  async create(_body: MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<BetaMessage> {
    this.calls++
    if (this.calls === 1) {
      return msg('tool_use', [
        toolUse('toolu_1', 'create_item', {
          kind: 'task',
          title: '买牛奶',
          explicit_assignment: false,
          priority: 'normal',
          allow_duplicate: false,
        }),
      ])
    }
    const signal = opts?.signal
    return new Promise<BetaMessage>((_resolve, reject) => {
      if (!signal) return // would hang forever: the test then times out
      const fail = () => reject(new Anthropic.APIUserAbortError())
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
  }
}

describe('interpreter: overall deadline per utterance', () => {
  it('stops a slow loop at the deadline, keeps the changes already made and finishes with a timeout error', async () => {
    const t = createTestContext()
    const api = new HangingApi()
    const interpreter = createInterpreter({ config: t.config, domain: t.domain, clock: t.clock, api, deadlineMs: 50 })
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '记一下买牛奶', source: 'text' })
    expect(api.calls).toBe(2)
    expect(r.utterance.status).toBe('error')
    expect(r.utterance.error).toBeTruthy()
    expect(r.utterance.changes.map(c => c.type)).toEqual(['item_created'])
    expect(r.items.map(i => i.title)).toEqual(['买牛奶'])
    const row = t.db.prepare('SELECT usage FROM utterances WHERE id = ?').get(r.utterance.id) as { usage: string }
    expect(JSON.parse(row.usage).error.code).toBe('timeout')
  })
})

/** A channel whose send stays in flight until release() is called. */
class SlowChannel implements NotificationChannel {
  readonly name = 'slow'
  sent: string[] = []
  private release_: (() => void) | null = null
  started: Promise<void>
  private markStarted!: () => void
  constructor() {
    this.started = new Promise(r => (this.markStarted = r))
  }
  isConfigured() {
    return true
  }
  async deliver(_m: Member, n: ScheduledNotification): Promise<DeliveryResult[]> {
    this.markStarted()
    await new Promise<void>(r => (this.release_ = r))
    this.sent.push(n.id)
    return [{ channel: this.name, ok: true }]
  }
  release() {
    this.release_?.()
  }
}

describe('graceful shutdown waits for the scheduler', () => {
  it('schedulerIdle / drainBackgroundWork resolve only after the row being sent is recorded', async () => {
    const clock = new FixedClock('2026-10-21T01:00:00.000Z')
    const channel = new SlowChannel()
    const ctx = buildContext(testConfig({ dbPath: ':memory:' }), { clock, stt: null, channels: [channel] })
    try {
      const wife = ctx.domain.createMember({ name: '老婆', role: 'adult' })
      const n = ctx.outbox.enqueue({
        memberId: wife.id,
        kind: 'test',
        fireAt: clock.now(),
        title: '测试',
        body: '测试',
        url: '/settings',
        actions: [],
        dedupeKey: 'test:shutdown',
        respectQuietHours: false,
      })!
      const tick = ctx.scheduler.tick()
      await channel.started
      ctx.scheduler.stop()

      let drained: boolean | null = null
      const drain = drainBackgroundWork(ctx, 2000).then(ok => (drained = ok))
      await new Promise(r => setTimeout(r, 30))
      expect(drained).toBeNull() // still sending

      channel.release()
      await drain
      expect(drained).toBe(true)
      expect(ctx.outbox.get(n.id)!.status).toBe('sent')
      await tick
      await schedulerIdle(ctx.scheduler) // idle: resolves at once and starts nothing
    } finally {
      ctx.scheduler.stop()
      ctx.db.close()
    }
  })
})
