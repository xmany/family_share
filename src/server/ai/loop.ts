// The manual agentic loop over client.beta.messages.create (beta namespace because of `fallbacks`).
//
// One utterance = one fresh, append-only conversation: [user: snapshot + utterance] → assistant →
// [user: tool_results] → … Nothing in `messages` is ever edited or removed once sent (Opus 5.5 thinking
// blocks are bound to the exact prefix that produced them), the full response.content is appended
// unmodified, and every tool_use of a response is answered in ONE user message, in order.
import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Clarification } from '../../shared/types'
import type { Config } from '../config'
import { SYSTEM_PROMPT } from './prompt'
import { type BoardCall, parseToolCall, TOOLS } from './tools'

/** The one SDK method the interpreter uses. Production wraps client.beta.messages; tests pass a scripted fake. */
export interface MessagesApi {
  create(body: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<BetaMessage>
}

export interface LoopConfig {
  model: string
  effort: Config['anthropic']['effort']
  /** Send fallbacks: "default" (beta server-side-fallback-2026-07-01) */
  fallbacks: boolean
  /** Hard cap on model calls per utterance (tool rounds, the final reply and a max_tokens retry all count) */
  maxIterations: number
  /** Thinking counts toward max_tokens on Opus 5.5, so leave room beyond the short reply */
  maxTokens: number
  /** One retry with this limit when a response stops on max_tokens */
  maxTokensRetry: number
}

export const DEFAULT_MAX_TOKENS = 8000
export const RETRY_MAX_TOKENS = 16000
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export function loopConfigFrom(config: Config): LoopConfig {
  return {
    model: config.anthropic.model,
    effort: config.anthropic.effort,
    fallbacks: config.anthropic.fallbacks,
    maxIterations: config.anthropic.maxIterations,
    maxTokens: DEFAULT_MAX_TOKENS,
    maxTokensRetry: RETRY_MAX_TOKENS,
  }
}

/** Frozen: the explicit breakpoint on the one system block caches tools + system together. */
const SYSTEM: BetaTextBlockParam[] = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]

export function buildRequest(cfg: LoopConfig, messages: BetaMessageParam[], maxTokens: number): MessageCreateParamsNonStreaming {
  return {
    model: cfg.model,
    max_tokens: maxTokens,
    system: SYSTEM, // breakpoint 1: tools + system, byte-identical for every utterance
    tools: TOOLS, // fixed order, never rebuilt per request
    tool_choice: { type: 'auto' }, // "any" / "tool" return 400 on Opus 5.5
    output_config: { effort: cfg.effort }, // thinking is always on; effort is the only dial (pinned per deployment)
    cache_control: { type: 'ephemeral' }, // breakpoint 2 (automatic): the growing conversation tail
    messages,
    ...(cfg.fallbacks ? { fallbacks: 'default' as const, betas: [FALLBACK_BETA] } : {}),
    // No thinking, temperature, top_p, top_k or assistant prefill: rejected or unnecessary on Opus 5.5.
  }
}

export interface CallUsage {
  model: string
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  servedByFallback: boolean
  requestId: string | null
}

export function usageOf(res: BetaMessage): CallUsage {
  const u = res.usage
  return {
    model: res.model,
    stopReason: res.stop_reason,
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    servedByFallback: (u?.iterations ?? []).some(it => it.type === 'fallback_message'),
    // The SDK attaches the request id as a non-enumerable `_request_id` (WithRequestID<T>).
    requestId: (res as BetaMessage & { _request_id?: string | null })._request_id ?? null,
  }
}

export type LoopErrorCode =
  | 'refusal'
  | 'truncated'
  | 'iteration_cap'
  | 'unexpected_stop'
  | 'cancelled'
  | 'aborted'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'bad_request'
  | 'auth'
  | 'permission'
  | 'model_not_found'
  | 'billing'
  | 'api_error'
  | 'internal'

export type LoopResult =
  | { status: 'done'; reply: string; usage: CallUsage[]; toolCalls: ToolCallRecord[] }
  | { status: 'clarify'; clarification: Clarification; usage: CallUsage[]; toolCalls: ToolCallRecord[] }
  | { status: 'error'; code: LoopErrorCode; detail?: string; usage: CallUsage[]; toolCalls: ToolCallRecord[] }

export type ToolOutcomeLike =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string; message: string; extra?: Record<string, unknown> }

/** Every tool call the model made, with what happened (for logs, usage and the eval script). */
export interface ToolCallRecord {
  id: string
  name: string
  input: unknown
  ok: boolean
  code?: string
}

export interface LoopArgs {
  api: MessagesApi
  cfg: LoopConfig
  /** renderTurnInput(...) output: the single first user message */
  turnInput: string
  /** Applies one validated call (synchronously or not). Must not throw; a throw becomes an "internal" error result. */
  execute: (call: BoardCall, toolUseId: string) => ToolOutcomeLike | Promise<ToolOutcomeLike>
  /** Checked before every model call; true stops the loop (e.g. the utterance was undone meanwhile). */
  isCancelled?: () => boolean
  signal?: AbortSignal
}

function replyText(res: BetaMessage): string {
  return res.content
    .flatMap(b => (b.type === 'text' ? [b.text] : []))
    .join('')
    .trim()
}

const isToolUse = (b: BetaMessage['content'][number]): b is BetaToolUseBlock => b.type === 'tool_use'

export async function runLoop(a: LoopArgs): Promise<LoopResult> {
  const messages: BetaMessageParam[] = [{ role: 'user', content: [{ type: 'text', text: a.turnInput }] }]
  const usage: CallUsage[] = []
  const toolCalls: ToolCallRecord[] = []
  let maxTokens = a.cfg.maxTokens
  const fail = (code: LoopErrorCode, detail?: string): LoopResult => ({
    status: 'error',
    code,
    ...(detail === undefined ? {} : { detail }),
    usage,
    toolCalls,
  })

  for (let call = 0; call < a.cfg.maxIterations; call++) {
    if (a.isCancelled?.()) return fail('cancelled')
    let res: BetaMessage
    try {
      res = await a.api.create(buildRequest(a.cfg, messages, maxTokens), a.signal ? { signal: a.signal } : undefined)
    } catch (err) {
      const e = classifyApiError(err)
      return fail(e.code, e.detail)
    }
    usage.push(usageOf(res))

    switch (res.stop_reason) {
      case 'refusal':
        // HTTP 200 with empty or partial content: never read it, never run its tools. With fallbacks:"default"
        // this means the whole fallback chain declined. Changes from earlier rounds stay applied.
        return fail('refusal', res.stop_details?.category ?? 'null')

      case 'max_tokens':
        // A tool_use cut off here can still parse as a valid partial object: never execute it.
        // Re-send the same, unchanged messages once with a larger budget.
        if (maxTokens < a.cfg.maxTokensRetry) {
          maxTokens = a.cfg.maxTokensRetry
          continue
        }
        return fail('truncated')

      case 'pause_turn':
        // Only happens with server tools (there are none). Resume by echoing the turn back unchanged.
        messages.push({ role: 'assistant', content: res.content })
        continue

      case 'end_turn':
      case 'stop_sequence':
        return { status: 'done', reply: replyText(res), usage, toolCalls }

      case 'tool_use': {
        const toolUses = res.content.filter(isToolUse)
        if (toolUses.length === 0) return { status: 'done', reply: replyText(res), usage, toolCalls }

        // Append the FULL content (thinking, text, fallback and tool_use blocks), unmodified.
        messages.push({ role: 'assistant', content: res.content })

        const clarify = toolUses.find(t => t.name === 'ask_clarification')
        if (clarify) {
          // A valid ask_clarification ALONE ends the turn. The dangling tool_use is fine: this conversation
          // is discarded, and the answer starts a fresh one with <answering_clarification> context.
          const parsed = parseToolCall(clarify.name, clarify.input)
          // Read-only siblings (search_items) lose nothing when skipped; anything else must not be dropped.
          const alone = toolUses.every(tu => tu === clarify || tu.name === 'search_items')
          if (alone && parsed.ok && parsed.call.name === 'ask_clarification') {
            for (const tu of toolUses) toolCalls.push({ id: tu.id, name: tu.name, input: tu.input, ok: tu === clarify, ...(tu === clarify ? {} : { code: 'skipped' }) })
            const options = [...new Set(parsed.call.input.options.map(o => o.trim()).filter(Boolean))].slice(0, 4)
            return { status: 'clarify', clarification: { question: parsed.call.input.question.trim(), options }, usage, toolCalls }
          }
          // An unusable question, or one asked together with other calls: run NOTHING and answer every
          // tool_use with an error so the model can redo it properly. (Ending the turn here would silently
          // drop the sibling changes the speaker asked for — and the question may even claim they were made.)
          const results: BetaToolResultBlockParam[] = toolUses.map(tu => {
            let code: string
            let message: string
            if (tu.name === 'ask_clarification') {
              const p = tu === clarify ? parsed : parseToolCall(tu.name, tu.input)
              code = p.ok ? 'not_alone' : 'invalid_input'
              message = p.ok
                ? 'Not asked: ask_clarification must be the only tool call in its response. Make the changes that do not depend on the answer first (call those tools again), then ask in a separate response.'
                : p.message
            } else {
              code = 'not_run'
              message = 'Not run (nothing was applied): ask_clarification was in the same response. Call this tool again if it is still needed, then ask alone.'
            }
            toolCalls.push({ id: tu.id, name: tu.name, input: tu.input, ok: false, code })
            return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ ok: false, code, message }) }
          })
          messages.push({ role: 'user', content: results })
          continue
        }

        // Every tool_use gets exactly one tool_result, in order, all in ONE user message.
        const results: BetaToolResultBlockParam[] = []
        for (const tu of toolUses) results.push(await runTool(tu, a, toolCalls))
        messages.push({ role: 'user', content: results })
        continue
      }

      default:
        // 'compaction' | 'model_context_window_exceeded' | null: not expected at these sizes.
        return fail('unexpected_stop', String(res.stop_reason))
    }
  }
  return fail('iteration_cap')
}

async function runTool(tu: BetaToolUseBlock, a: LoopArgs, log: ToolCallRecord[]): Promise<BetaToolResultBlockParam> {
  const err = (code: string, message: string, extra?: Record<string, unknown>): BetaToolResultBlockParam => {
    log.push({ id: tu.id, name: tu.name, input: tu.input, ok: false, code })
    return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ ok: false, code, message, ...(extra ?? {}) }) }
  }
  const parsed = parseToolCall(tu.name, tu.input)
  if (!parsed.ok) return err('invalid_input', parsed.message)
  if (parsed.call.name === 'ask_clarification') return err('not_alone', 'ask_clarification must be called alone.')
  let out: ToolOutcomeLike
  try {
    out = await a.execute(parsed.call, tu.id)
  } catch (e) {
    // A bug or DB error in our executor: tell Claude it failed instead of crashing the loop.
    return err('internal', e instanceof Error ? e.message : String(e))
  }
  if (!out.ok) return err(out.code, out.message, out.extra)
  log.push({ id: tu.id, name: tu.name, input: parsed.call.input, ok: true })
  return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ ok: true, ...out.result }) }
}

/** Most specific first: in the TS SDK every one of these extends Anthropic.APIError. */
export function classifyApiError(err: unknown): { code: LoopErrorCode; detail: string } {
  const id = err instanceof Anthropic.APIError && err.requestID ? ` (${err.requestID})` : ''
  const d = (e: Error) => `${e.name}: ${e.message}${id}`
  if (err instanceof Anthropic.APIUserAbortError) return { code: 'aborted', detail: d(err) }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { code: 'timeout', detail: d(err) }
  if (err instanceof Anthropic.APIConnectionError) return { code: 'network', detail: d(err) }
  if (err instanceof Anthropic.BadRequestError) return { code: 'bad_request', detail: d(err) } // our bug: request shape
  if (err instanceof Anthropic.AuthenticationError) return { code: 'auth', detail: d(err) } // bad/missing key
  if (err instanceof Anthropic.PermissionDeniedError) return { code: 'permission', detail: d(err) }
  if (err instanceof Anthropic.NotFoundError) return { code: 'model_not_found', detail: d(err) } // check AI_MODEL
  if (err instanceof Anthropic.RateLimitError) return { code: 'rate_limited', detail: d(err) } // after SDK retries
  if (err instanceof Anthropic.InternalServerError) {
    return { code: err.type === 'overloaded_error' ? 'overloaded' : 'server_error', detail: d(err) } // 5xx incl. 529
  }
  if (err instanceof Anthropic.APIError) return { code: err.type === 'billing_error' ? 'billing' : 'api_error', detail: d(err) }
  // Not an API error (a bug in a fake client, a TypeError …): still never escape interpret().
  return { code: 'internal', detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
}
