// The eval harness itself, with scripted responses (the live run is scripts/ai-eval.ts).
import { describe, expect, it } from 'vitest'
import { testConfig } from '../../config'
import { msg, ScriptedApi, text, toolUse } from '../testing'
import { CASES } from './cases'
import { costOf, formatCall, runCase } from './harness'

const anthropic = testConfig().anthropic
const byId = (id: string) => CASES.find(c => c.id === id)!

describe('eval harness', () => {
  it('has ~30 uniquely named cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(28)
    expect(new Set(CASES.map(c => c.id)).size).toBe(CASES.length)
  })

  it('passes a case when the expected call is made, and resolves member ids and relative dates', async () => {
    const api = new ScriptedApi([
      body => {
        const husband = /- (m_\w+) \| 老公/.exec(JSON.stringify(body.messages))![1]
        return msg('tool_use', [
          toolUse('t1', 'send_request', { to_member_id: husband, title: '买牛奶', due_date: '2026-10-22', due_time: '18:30', priority: 'normal', allow_duplicate: false }),
        ])
      },
      msg('end_turn', [text('好的，已请老公明天 18:30 下班顺路买牛奶，等他确认。')]),
    ])
    const run = await runCase(byId('request-milk-after-work'), api, anthropic)
    expect(run.failures).toEqual([])
    expect(run.calls).toEqual([expect.objectContaining({ name: 'send_request', result: 'ok' })])
    expect(formatCall(run.calls[0]!, run.names)).toContain('to_member_id=老公')
    expect(run.costUsd).toBeGreaterThan(0)
  })

  it('reports missing, forbidden and wrong-outcome failures', async () => {
    const api = new ScriptedApi([
      msg('tool_use', [toolUse('t1', 'create_item', { kind: 'task', title: '买牛奶', explicit_assignment: false, priority: 'normal', allow_duplicate: false })]),
      msg('end_turn', [text('好的')]),
    ])
    const run = await runCase(byId('request-milk-after-work'), api, anthropic)
    expect(run.failures).toEqual([
      'missing send_request(member=husband, titleIncludes=牛奶, date=+1, time=18:30)',
      'forbidden call create_item',
      'reply does not match /18:30|六点半/',
    ])
  })

  it('seeds items (incl. declined requests) and matches item references', async () => {
    const api = new ScriptedApi([
      body => {
        const s = JSON.stringify(body.messages)
        const swim = /- (i_\w+) \| request \| declined \| 带孩子游泳/.exec(s)![1]
        const husband = /- (m_\w+) \| 老公/.exec(s)![1]
        return msg('tool_use', [
          toolUse('t1', 'send_request', { to_member_id: husband, title: '带孩子游泳', existing_item_id: swim, due_date: '2026-10-25', priority: 'normal', allow_duplicate: false }),
        ])
      },
      msg('end_turn', [text('好，已改到周日再问他。')]),
    ])
    const run = await runCase(byId('resend-declined-request'), api, anthropic)
    expect(run.failures).toEqual([])
  })

  it('treats a clarification turn as outcome clarify', async () => {
    const api = new ScriptedApi([msg('tool_use', [toolUse('t1', 'ask_clarification', { question: '哪一个？', options: ['修柜门', '装窗帘'] })])])
    const run = await runCase(byId('ambiguous-that-one-done'), api, anthropic)
    expect(run.status).toBe('clarify')
    expect(run.failures).toEqual([])
  })

  it('prices usage per model', () => {
    const call = { stopReason: 'end_turn', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, servedByFallback: false, requestId: null }
    expect(costOf([{ ...call, model: 'claude-opus-5-5' }])).toEqual({ usd: 4, estimated: false })
    expect(costOf([{ ...call, model: 'claude-unknown' }]).estimated).toBe(true)
  })
})
