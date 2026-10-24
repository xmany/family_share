// The Claude interpreter: one utterance in → board changes + a short reply out.
// See docs/SPEC.md §4 and docs/research/claude-api-brief.md.
//
//   const interpreter = createInterpreter({ config, domain, clock })            // production
//   const interpreter = createInterpreter({ config, domain, clock, api: fake })  // tests (enabled even without a key)
//   await interpreter.interpret({ memberId, text, source: 'text' })

import type { UtteranceResponse } from '../../shared/api'
import type { Change, Clarification, Item, Member, Utterance, UtteranceStatus } from '../../shared/types'
import type { Config } from '../config'
import type { Domain } from '../domain/types'
import { DomainError } from '../domain/types'
import type { Clock } from '../time'
import type { InterpretInput, Interpreter } from './types'
import { createAnthropicClient, messagesApiFrom } from './client'
import { executeCall, type ExecContext } from './executor'
import { type CallUsage, type LoopErrorCode, type LoopResult, type MessagesApi, loopConfigFrom, runLoop } from './loop'
import { toSpeakerScript } from './script'
import { gatherSnapshot, renderTurnInput } from './snapshot'

export type { MessagesApi } from './loop'
export type { InterpretInput, Interpreter } from './types'
export { createAnthropicClient, messagesApiFrom } from './client'
export { buildRequest, classifyApiError, loopConfigFrom, runLoop, usageOf } from './loop'
export type { CallUsage, LoopConfig, LoopResult, ToolCallRecord } from './loop'
export { SYSTEM_PROMPT, TIME_OF_DAY_DEFAULTS } from './prompt'
export { gatherSnapshot, lunarLabel, renderCalendar, renderTurnInput } from './snapshot'
export { replyScriptFor, toSpeakerScript } from './script'
export { TOOLS, parseToolCall } from './tools'
export { executeCall } from './executor'

export interface InterpreterDeps {
  config: Config
  domain: Domain
  clock: Clock
  /** Injected Messages API (tests, eval). When omitted, a real client is built if config.anthropic.apiKey is set. */
  api?: MessagesApi
  /** Overall budget for one utterance, all model calls included (default INTERPRET_DEADLINE_MS) */
  deadlineMs?: number
}

/**
 * Overall budget for one utterance. Each model call already has a 60 s timeout with 2 SDK retries, so without this
 * a 6-call loop could keep an HTTP request open for many minutes; the web app stops waiting after 120 s (and the
 * voice route spends part of that on speech-to-text). Changes applied before the deadline stay (and are undoable);
 * the finished utterance still reaches every phone over SSE.
 */
export const INTERPRET_DEADLINE_MS = 90_000

/** User-facing texts in Simplified Chinese; converted to the speaker's script (toSpeakerScript) before they are stored. */
export const REPLIES = {
  disabled: 'AI 还没配置（缺少 ANTHROPIC_API_KEY）。可以先用看板上的按钮。',
  refusal: '抱歉，这句我处理不了，可以换个说法吗？',
  failure: '抱歉，刚才没处理成功，请再说一次。',
  busy: 'AI 现在有点忙，请过一会儿再说一次。',
  misconfigured: 'AI 服务的配置有问题（请检查服务器设置）。可以先用看板上的按钮。',
  tooComplex: '这句有点复杂，我只做了一部分，请把剩下的分开再说一下。',
  cancelled: '这句话已经撤销了。',
  partialKept: '已经做好的改动保留了，可以在下面查看或撤销。',
  nothing: '收到。',
} as const

function errorReply(code: LoopErrorCode, changes: Change[]): string {
  let base: string
  switch (code) {
    case 'cancelled':
      return REPLIES.cancelled
    case 'refusal':
      base = REPLIES.refusal
      break
    case 'iteration_cap':
    case 'truncated':
      if (changes.length) return REPLIES.tooComplex
      base = REPLIES.failure
      break
    case 'rate_limited':
    case 'overloaded':
      base = REPLIES.busy
      break
    case 'bad_request':
    case 'auth':
    case 'permission':
    case 'model_not_found':
    case 'billing':
      base = REPLIES.misconfigured
      break
    default:
      base = REPLIES.failure
  }
  return changes.length ? `${base}${REPLIES.partialKept}` : base
}

function doneFallback(changes: Change[]): string {
  return changes.length ? `好的：${changes.map(c => c.summary).join('；')}。` : REPLIES.nothing
}

function totals(calls: CallUsage[]) {
  return calls.reduce(
    (t, c) => ({
      inputTokens: t.inputTokens + c.inputTokens,
      outputTokens: t.outputTokens + c.outputTokens,
      cacheReadTokens: t.cacheReadTokens + c.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens + c.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
}

export function createInterpreter(deps: InterpreterDeps): Interpreter {
  const { config, domain, clock } = deps
  const api: MessagesApi | null = deps.api ?? (config.anthropic.apiKey ? messagesApiFrom(createAnthropicClient(config)) : null)
  const cfg = loopConfigFrom(config)

  function startUtterance(input: InterpretInput): Utterance {
    const opts = { replyTo: input.replyToUtteranceId ?? null, audioPath: input.audioPath ?? null }
    try {
      return domain.createUtterance(input.memberId, input.source, input.text, opts)
    } catch (e) {
      // An unknown replyTo must not lose what the member said: record it without the link.
      if (e instanceof DomainError && opts.replyTo && domain.getMember(input.memberId)) {
        return domain.createUtterance(input.memberId, input.source, input.text, { ...opts, replyTo: null })
      }
      throw e
    }
  }

  function respond(utteranceId: string, touched: Iterable<string>): UtteranceResponse {
    const utterance = domain.getUtterance(utteranceId)!
    const ids = new Set<string>(touched)
    for (const c of utterance.changes) if (c.itemId) ids.add(c.itemId)
    const items = [...ids].map(id => domain.getItem(id)).filter((i): i is Item => !!i)
    return { utterance, items }
  }

  async function interpret(input: InterpretInput): Promise<UtteranceResponse> {
    const utterance = startUtterance(input)
    const id = utterance.id

    if (!api) {
      const speaker = domain.getMember(input.memberId)
      const disabled = speaker ? toSpeakerScript(REPLIES.disabled, speaker) : REPLIES.disabled
      domain.finishUtterance(id, { status: 'error', reply: disabled, error: disabled, model: null, usage: { error: { code: 'ai_disabled' } } })
      return respond(id, [])
    }

    const touched = new Set<string>()
    const deadline = new AbortController()
    const deadlineTimer = setTimeout(() => deadline.abort(), deps.deadlineMs ?? INTERPRET_DEADLINE_MS)
    deadlineTimer.unref?.()
    let result: LoopResult
    let speakerLang: Pick<Member, 'language'> = { language: 'zh-CN' }
    try {
      const speaker = domain.getMember(input.memberId)!
      speakerLang = speaker
      const now = clock.now()
      const ctx: ExecContext = {
        domain,
        clock,
        speaker,
        utteranceId: id,
        tz: domain.getFamily().timezone,
        members: domain.listMembers(),
        touched,
      }
      const turnInput = renderTurnInput(
        gatherSnapshot(domain, {
          now,
          speaker,
          text: utterance.text,
          source: input.source,
          currentUtteranceId: id,
          replyToUtteranceId: input.replyToUtteranceId ?? null,
        }),
      )
      result = await runLoop({
        api,
        cfg,
        turnInput,
        execute: call => executeCall(call, ctx),
        isCancelled: () => domain.getUtterance(id)?.status === 'undone',
        signal: deadline.signal,
      })
    } catch (e) {
      // A bug in snapshot building or the loop: the utterance must still finish (never stuck on "processing").
      console.error('[ai] interpret failed', e)
      result = { status: 'error', code: 'internal', detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e), usage: [], toolCalls: [] }
    } finally {
      clearTimeout(deadlineTimer)
    }
    if (result.status === 'error' && result.code === 'aborted' && deadline.signal.aborted) {
      result = { ...result, code: 'timeout', detail: `utterance deadline (${deps.deadlineMs ?? INTERPRET_DEADLINE_MS} ms) — ${result.detail ?? ''}` }
    }

    const changes = domain.getUtterance(id)?.changes ?? []
    // Everything the member reads back is in their script, including the fixed texts below.
    const conv = (s: string) => toSpeakerScript(s, speakerLang)
    let status: Exclude<UtteranceStatus, 'processing' | 'undone'>
    let reply: string
    let clarification: Clarification | null = null
    let error: string | null = null
    switch (result.status) {
      case 'done':
        status = 'done'
        reply = conv(result.reply || doneFallback(changes))
        break
      case 'clarify':
        status = 'clarify'
        clarification = { question: conv(result.clarification.question), options: result.clarification.options.map(conv) }
        reply = clarification.question
        break
      case 'error':
        status = 'error'
        reply = conv(errorReply(result.code, changes))
        error = reply
        if (result.code !== 'cancelled') console.warn(`[ai] utterance ${id} failed: ${result.code}${result.detail ? ` — ${result.detail}` : ''}`)
        break
    }
    const lastModel = result.usage.at(-1)?.model ?? null
    domain.finishUtterance(id, {
      status,
      reply,
      clarification,
      error,
      model: lastModel,
      usage: {
        requestedModel: cfg.model,
        effort: cfg.effort,
        calls: result.usage,
        totals: totals(result.usage),
        tools: result.toolCalls.map(t => ({ name: t.name, ok: t.ok, ...(t.code ? { code: t.code } : {}) })),
        ...(result.status === 'error' ? { error: { code: result.code, ...(result.detail ? { detail: result.detail } : {}) } } : {}),
      },
    })
    return respond(id, touched)
  }

  return { enabled: api !== null, interpret }
}
