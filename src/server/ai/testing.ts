// Test helpers for the interpreter: scripted Messages API responses (no network).
// Used by the ai/*.test.ts files; other modules' tests may reuse ScriptedApi to fake Claude.

import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { MessagesApi } from './loop'

export type Block = Record<string, unknown>

/** A BetaMessage with the given stop_reason and content blocks. */
export function msg(stop_reason: string, content: Block[], extra: Partial<Record<string, unknown>> = {}): BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
    },
    ...extra,
  } as unknown as BetaMessage
}

/** An (omitted-display) thinking block as Opus 5.5 returns it by default. */
export const thinking: Block = { type: 'thinking', thinking: '', signature: 'sig_test' }
export const toolUse = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input })
export const text = (t: string): Block => ({ type: 'text', text: t })

export type ScriptStep = BetaMessage | Error | ((body: MessageCreateParamsNonStreaming, callIndex: number) => BetaMessage | Error)

/** Returns the scripted responses in order and records a deep copy of every request body. */
export class ScriptedApi implements MessagesApi {
  readonly calls: MessageCreateParamsNonStreaming[] = []
  constructor(private readonly script: ScriptStep[]) {}
  async create(body: MessageCreateParamsNonStreaming): Promise<BetaMessage> {
    this.calls.push(structuredClone(body))
    const step = this.script.shift()
    if (!step) throw new Error('ScriptedApi: script exhausted')
    const next = typeof step === 'function' ? step(body, this.calls.length - 1) : step
    if (next instanceof Error) throw next
    return next
  }
  /** Text of the first user message of request n (the snapshot + utterance). */
  turnInput(n = 0): string {
    const first = this.calls[n]?.messages[0]
    const content = first?.content
    if (typeof content === 'string') return content
    const block = Array.isArray(content) ? content[0] : undefined
    return block && 'text' in block ? String(block.text) : ''
  }
  /** Parsed tool results sent in request n (the last user message), in order. */
  toolResults(n: number): Array<{ tool_use_id: string; is_error?: boolean; body: Record<string, unknown> }> {
    const last = this.calls[n]?.messages.at(-1)
    if (!last || !Array.isArray(last.content)) return []
    return last.content.flatMap(b =>
      b.type === 'tool_result'
        ? [{ tool_use_id: b.tool_use_id, ...(b.is_error ? { is_error: true } : {}), body: JSON.parse(String(b.content)) as Record<string, unknown> }]
        : [],
    )
  }
}
