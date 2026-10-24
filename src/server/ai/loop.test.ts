// The loop in isolation: a scripted Messages API and a fake executor (no domain).
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { messagesApiFrom } from './client'
import { classifyApiError, type LoopConfig, runLoop, type ToolOutcomeLike } from './loop'
import { SYSTEM_PROMPT } from './prompt'
import { msg, ScriptedApi, text, thinking, toolUse } from './testing'
import type { BoardCall } from './tools'

const cfg: LoopConfig = {
  model: 'claude-opus-5-5',
  effort: 'medium',
  fallbacks: true,
  maxIterations: 6,
  maxTokens: 8000,
  maxTokensRetry: 16000,
}

class FakeBoard {
  ran: BoardCall[] = []
  constructor(private impl: (c: BoardCall) => ToolOutcomeLike = () => ({ ok: true, result: {} })) {}
  execute = (call: BoardCall) => {
    this.ran.push(call)
    return this.impl(call)
  }
}

const HUSBAND = 'm_bbbbbbbbbb'
const MILK = 'i_cccccccccc'
const turnInput = '<board_snapshot>…</board_snapshot>\n<utterance source="voice">让老公明天买牛奶</utterance>'

describe('runLoop', () => {
  it('runs a tool round, appends the full content verbatim (thinking included), then returns the reply', async () => {
    const first = msg('tool_use', [
      thinking,
      toolUse('toolu_1', 'send_request', { to_member_id: HUSBAND, title: '买牛奶', due_date: '2026-10-22', priority: 'normal', allow_duplicate: false }),
    ])
    const api = new ScriptedApi([first, msg('end_turn', [thinking, text('好的，已请老公明天买牛奶，等他确认。')])])
    const board = new FakeBoard(() => ({ ok: true, result: { item: { id: MILK, title: '买牛奶', owner: '老公', due: '明天' } } }))

    const r = await runLoop({ api, cfg, turnInput, execute: board.execute })

    expect(r).toMatchObject({ status: 'done', reply: '好的，已请老公明天买牛奶，等他确认。' })
    expect(board.ran[0]).toMatchObject({ name: 'send_request', input: { to_member_id: HUSBAND } })
    const second = api.calls[1]!
    expect(second.messages[0]).toEqual(api.calls[0]!.messages[0]) // append-only: the first message never changes
    expect(second.messages[1]).toEqual({ role: 'assistant', content: first.content })
    expect(second.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: expect.stringContaining('"ok":true') }],
    })
    expect(r.usage).toHaveLength(2)
    expect(r.toolCalls).toEqual([expect.objectContaining({ id: 'toolu_1', name: 'send_request', ok: true })])
  })

  it('answers parallel tool calls in one user message, in order, with is_error for failures', async () => {
    const api = new ScriptedApi([
      msg('tool_use', [
        toolUse('t1', 'complete_item', { item_id: MILK, resolution: 'done' }),
        toolUse('t2', 'add_note', { item_id: 'i_zzzzzzzzzz', text: '买了两盒' }),
      ]),
      msg('end_turn', [text('好的，牛奶标记为已买。')]),
    ])
    const board = new FakeBoard(c => (c.name === 'add_note' ? { ok: false, code: 'not_found', message: '找不到这个事项' } : { ok: true, result: {} }))
    await runLoop({ api, cfg, turnInput, execute: board.execute })
    const results = api.toolResults(1)
    expect(results.map(b => b.tool_use_id)).toEqual(['t1', 't2'])
    expect(results[0]!.is_error).toBeUndefined()
    expect(results[1]).toMatchObject({ is_error: true, body: { ok: false, code: 'not_found' } })
    expect(api.calls[1]!.messages).toHaveLength(3) // ONE user message carries both results
  })

  it('rejects schema-invalid input before it reaches the executor', async () => {
    const api = new ScriptedApi([msg('tool_use', [toolUse('t1', 'complete_item', { item_id: 'milk', resolution: 'done' })]), msg('end_turn', [text('哪一条？')])])
    const board = new FakeBoard()
    const r = await runLoop({ api, cfg, turnInput, execute: board.execute })
    expect(board.ran).toHaveLength(0)
    expect(api.toolResults(1)[0]).toMatchObject({ is_error: true, body: { code: 'invalid_input' } })
    expect(r.toolCalls[0]).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('turns an executor exception into an internal is_error result instead of crashing', async () => {
    const api = new ScriptedApi([msg('tool_use', [toolUse('t1', 'add_note', { item_id: MILK, text: 'x' })]), msg('end_turn', [text('出错了')])])
    const r = await runLoop({
      api,
      cfg,
      turnInput,
      execute: () => {
        throw new Error('db is locked')
      },
    })
    expect(r.status).toBe('done')
    expect(api.toolResults(1)[0]).toMatchObject({ is_error: true, body: { code: 'internal', message: 'db is locked' } })
  })

  it('ask_clarification alone ends the turn (options trimmed, deduplicated, at most 4)', async () => {
    const api = new ScriptedApi([
      msg('tool_use', [toolUse('t2', 'ask_clarification', { question: '是改原来那条还是新建？', options: ['改原来那条', '新建', '', ' 新建 ', 'a', 'b'] })]),
    ])
    const board = new FakeBoard()
    const r = await runLoop({ api, cfg, turnInput, execute: board.execute })
    expect(r).toMatchObject({ status: 'clarify', clarification: { question: '是改原来那条还是新建？', options: ['改原来那条', '新建', 'a', 'b'] } })
    expect(board.ran).toHaveLength(0)
    expect(api.calls).toHaveLength(1)
    expect(r.toolCalls.map(t => [t.name, t.ok, t.code])).toEqual([['ask_clarification', true, undefined]])
  })

  it('ask_clarification mixed with other calls runs nothing and answers every call with an error', async () => {
    const api = new ScriptedApi([
      msg('tool_use', [
        toolUse('t1', 'create_item', { kind: 'task', title: '买牛奶', explicit_assignment: false, priority: 'normal', allow_duplicate: false }),
        toolUse('t2', 'ask_clarification', { question: '是改原来那条还是新建？', options: ['改原来那条', '新建'] }),
      ]),
      msg('tool_use', [toolUse('t3', 'ask_clarification', { question: '是改原来那条还是新建？', options: ['改原来那条', '新建'] })]),
    ])
    const board = new FakeBoard()
    const r = await runLoop({ api, cfg, turnInput, execute: board.execute })
    expect(board.ran).toHaveLength(0)
    expect(api.toolResults(1).map(x => [x.tool_use_id, x.is_error, x.body.code])).toEqual([
      ['t1', true, 'not_run'],
      ['t2', true, 'not_alone'],
    ])
    expect(api.calls[1]!.messages).toHaveLength(3) // append-only: assistant turn + ONE user message with both results
    expect(r).toMatchObject({ status: 'clarify' })
    expect(r.toolCalls.map(t => [t.name, t.ok, t.code])).toEqual([
      ['create_item', false, 'not_run'],
      ['ask_clarification', false, 'not_alone'],
      ['ask_clarification', true, undefined],
    ])
  })

  it('an invalid ask_clarification is answered with errors for every call in the response, and the loop goes on', async () => {
    const api = new ScriptedApi([
      msg('tool_use', [
        toolUse('t1', 'add_note', { item_id: MILK, text: 'x' }),
        toolUse('t2', 'ask_clarification', { question: '', options: [] }),
      ]),
      msg('tool_use', [toolUse('t3', 'ask_clarification', { question: '哪一条？', options: ['牛奶', '面包'] })]),
    ])
    const board = new FakeBoard()
    const r = await runLoop({ api, cfg, turnInput, execute: board.execute })
    expect(board.ran).toHaveLength(0)
    expect(api.toolResults(1).map(x => [x.tool_use_id, x.is_error, x.body.code])).toEqual([
      ['t1', true, 'not_run'],
      ['t2', true, 'invalid_input'],
    ])
    expect(r).toMatchObject({ status: 'clarify', clarification: { question: '哪一条？' } })
  })

  it('never executes tools from a refused response', async () => {
    const api = new ScriptedApi([
      msg('refusal', [toolUse('t1', 'add_note', { item_id: MILK, text: 'x' })], {
        stop_details: { type: 'refusal', category: 'bio', explanation: null, recommended_model: null, fallback_credit_token: null, fallback_has_prefill_claim: null },
      }),
    ])
    const board = new FakeBoard()
    const r = await runLoop({ api, cfg, turnInput, execute: board.execute })
    expect(r).toMatchObject({ status: 'error', code: 'refusal', detail: 'bio' })
    expect(board.ran).toHaveLength(0)
  })

  it('does not run a tool cut off by max_tokens; retries once with the larger budget and identical messages', async () => {
    const api = new ScriptedApi([
      msg('max_tokens', [thinking, toolUse('t1', 'create_item', { kind: 'task', title: '买', explicit_assignment: false, priority: 'normal', allow_duplicate: false })]),
      msg('end_turn', [text('好的。')]),
    ])
    const board = new FakeBoard()
    await runLoop({ api, cfg, turnInput, execute: board.execute })
    expect(board.ran).toHaveLength(0)
    expect(api.calls.map(c => c.max_tokens)).toEqual([8000, 16000])
    expect(api.calls[1]!.messages).toEqual(api.calls[0]!.messages)
  })

  it('gives up after a second max_tokens', async () => {
    const api = new ScriptedApi([msg('max_tokens', []), msg('max_tokens', [])])
    const r = await runLoop({ api, cfg, turnInput, execute: new FakeBoard().execute })
    expect(r).toMatchObject({ status: 'error', code: 'truncated' })
  })

  it('stops at the iteration cap', async () => {
    let n = 0
    const loop = () => msg('tool_use', [toolUse(`t${n++}`, 'search_items', { query: '牛奶', include_closed: true })])
    const api = new ScriptedApi(Array.from({ length: 10 }, loop))
    const r = await runLoop({ api, cfg: { ...cfg, maxIterations: 3 }, turnInput, execute: new FakeBoard().execute })
    expect(r).toMatchObject({ status: 'error', code: 'iteration_cap' })
    expect(api.calls).toHaveLength(3)
  })

  it('stops before the next model call when cancelled', async () => {
    let cancelled = false
    const api = new ScriptedApi([msg('tool_use', [toolUse('t1', 'add_note', { item_id: MILK, text: 'x' })]), msg('end_turn', [text('好')])])
    const r = await runLoop({
      api,
      cfg,
      turnInput,
      execute: () => {
        cancelled = true
        return { ok: true, result: {} }
      },
      isCancelled: () => cancelled,
    })
    expect(r).toMatchObject({ status: 'error', code: 'cancelled' })
    expect(api.calls).toHaveLength(1)
  })

  it('maps SDK errors to codes', async () => {
    const r = await runLoop({ api: new ScriptedApi([new Anthropic.APIConnectionTimeoutError()]), cfg, turnInput, execute: new FakeBoard().execute })
    expect(r).toMatchObject({ status: 'error', code: 'timeout' })
    const h = new Headers()
    expect(classifyApiError(new Anthropic.APIConnectionError({ message: 'reset' })).code).toBe('network')
    expect(classifyApiError(new Anthropic.APIUserAbortError()).code).toBe('aborted')
    expect(classifyApiError(Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } }, 'x', h)).code).toBe('bad_request')
    expect(classifyApiError(Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, 'x', h)).code).toBe('auth')
    expect(classifyApiError(Anthropic.APIError.generate(404, { type: 'error', error: { type: 'not_found_error', message: 'x' } }, 'x', h)).code).toBe('model_not_found')
    expect(classifyApiError(Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, 'x', h)).code).toBe('rate_limited')
    expect(classifyApiError(Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 'x', h)).code).toBe('overloaded')
    expect(classifyApiError(Anthropic.APIError.generate(500, { type: 'error', error: { type: 'api_error', message: 'x' } }, 'x', h)).code).toBe('server_error')
    expect(classifyApiError(Anthropic.APIError.generate(402, { type: 'error', error: { type: 'billing_error', message: 'x' } }, 'x', h)).code).toBe('billing')
    expect(classifyApiError(new TypeError('boom')).code).toBe('internal')
  })

  it('sends the Opus 5.5-safe request shape', async () => {
    const api = new ScriptedApi([msg('end_turn', [text('好')])])
    await runLoop({ api, cfg, turnInput, execute: new FakeBoard().execute })
    const body = api.calls[0]! as unknown as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      tool_choice: { type: 'auto' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    })
    for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'stream']) expect(body).not.toHaveProperty(k)
    const system = body.system as Array<{ text: string; cache_control: unknown }>
    expect(system).toHaveLength(1)
    expect(system[0]).toEqual({ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } })
    const messages = body.messages as Array<{ role: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user') // no assistant prefill
  })

  it('omits fallbacks and the beta header when disabled in config', async () => {
    const api = new ScriptedApi([msg('end_turn', [text('好')])])
    await runLoop({ api, cfg: { ...cfg, fallbacks: false, effort: 'low' }, turnInput, execute: new FakeBoard().execute })
    const body = api.calls[0]! as unknown as Record<string, unknown>
    expect(body).not.toHaveProperty('fallbacks')
    expect(body).not.toHaveProperty('betas')
    expect(body.output_config).toEqual({ effort: 'low' })
  })

  it('records usage including cache reads and the fallback-served signal', async () => {
    const api = new ScriptedApi([
      msg('end_turn', [text('好')], {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 300,
          iterations: [{ type: 'message' }, { type: 'fallback_message', model: 'claude-opus-5' }],
        },
      }),
    ])
    const r = await runLoop({ api, cfg, turnInput, execute: new FakeBoard().execute })
    expect(r.usage[0]).toMatchObject({ model: 'claude-opus-5', cacheReadTokens: 4000, cacheWriteTokens: 300, servedByFallback: true })
  })
})

describe('real SDK serialization (fake fetch, no network)', () => {
  it('sends the fallback beta header and the fallbacks field, and reads the request id', async () => {
    let seen: { headers: Headers; body: Record<string, unknown> } | undefined
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> }
      return new Response(JSON.stringify(msg('end_turn', [text('好')])), {
        status: 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
      })
    }) as typeof globalThis.fetch
    const client = new Anthropic({ apiKey: 'test-key', authToken: null, fetch, maxRetries: 0 })
    const r = await runLoop({ api: messagesApiFrom(client), cfg, turnInput, execute: new FakeBoard().execute })
    expect(r.status).toBe('done')
    expect(seen!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(seen!.headers.get('x-api-key')).toBe('test-key')
    expect(seen!.headers.get('authorization')).toBeNull()
    expect(seen!.body.fallbacks).toBe('default')
    expect(seen!.body).not.toHaveProperty('betas') // betas travel as a header, not in the body
    expect(r.usage[0]!.requestId).toBe('req_test')
  })
})
