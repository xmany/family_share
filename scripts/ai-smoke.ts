// One-minute live smoke test of the interpreter's request shape.
//
//   ANTHROPIC_API_KEY=… npx tsx scripts/ai-smoke.ts
//
// 1. Sends the real request (frozen system + 10 strict tools + fallbacks beta) once: confirms the API
//    accepts it (strict tool grammar compiles, effort/fallback/cache fields are valid) — a 400 here is a bug.
// 2. Repeats the identical request: cache_read_input_tokens must be > 0.
// 3. Sends a different utterance: the shared tools+system prefix must still be read from cache.
// 4. Runs one full interpret() on an in-memory board and prints the reply and changes.
// Does nothing (exit 0) when ANTHROPIC_API_KEY is not set.

import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { loadConfig } from '../src/server/config'
import { createInterpreter } from '../src/server/ai/index'
import { createAnthropicClient, messagesApiFrom } from '../src/server/ai/client'
import { buildRequest, loopConfigFrom, usageOf } from '../src/server/ai/loop'
import { gatherSnapshot, renderTurnInput } from '../src/server/ai/snapshot'
import { createTestContext } from '../src/server/testing'

function show(label: string, res: BetaMessage): void {
  const u = usageOf(res)
  const blocks = res.content.map(b => (b.type === 'tool_use' ? `tool_use:${b.name}` : b.type)).join(', ')
  console.log(
    `${label}: stop=${res.stop_reason} model=${res.model}${u.servedByFallback ? ' (fallback)' : ''} input=${u.inputTokens} cache_write=${u.cacheWriteTokens} cache_read=${u.cacheReadTokens} output=${u.outputTokens} request_id=${u.requestId ?? '-'}`,
  )
  console.log(`  blocks: ${blocks || '(none)'}`)
  for (const b of res.content) {
    if (b.type === 'tool_use') console.log(`  ${b.name} ${JSON.stringify(b.input)}`)
    if (b.type === 'text' && b.text.trim()) console.log(`  text: ${b.text.trim()}`)
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.anthropic.apiKey) {
    console.log('ANTHROPIC_API_KEY is not set — skipping the live smoke test.')
    return
  }
  const api = messagesApiFrom(createAnthropicClient(config))
  const cfg = loopConfigFrom(config)
  console.log(`model ${cfg.model}, effort ${cfg.effort}, fallbacks ${cfg.fallbacks ? 'default' : 'off'}\n`)

  const t = createTestContext()
  t.domain.createItem(t.as(t.wife), { kind: 'task', title: '卖旧柜子' })
  const turn = (text: string): BetaMessageParam[] => {
    const u = t.domain.createUtterance(t.wife.id, 'text', text)
    const input = renderTurnInput(gatherSnapshot(t.domain, { now: t.clock.now(), speaker: t.wife, text, source: 'text', currentUtteranceId: u.id }))
    return [{ role: 'user', content: [{ type: 'text', text: input }] }]
  }

  let failed = false
  const first = turn('让老公明天下班顺路把牛奶买了')
  let r1: BetaMessage
  try {
    r1 = await api.create(buildRequest(cfg, first, cfg.maxTokens))
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError) {
      console.error(`FAIL: the API rejected the request shape (400): ${e.message} (${e.requestID ?? 'no request id'})`)
    } else {
      console.error('FAIL: request error', e)
    }
    process.exit(1)
  }
  show('1 first request', r1)
  if (r1.stop_reason !== 'tool_use') console.log('  note: expected a send_request tool_use for this utterance')

  const r2 = await api.create(buildRequest(cfg, first, cfg.maxTokens))
  show('2 identical request', r2)
  if ((r2.usage.cache_read_input_tokens ?? 0) > 0) console.log('  PASS cache read on the repeat')
  else {
    console.log('  FAIL no cache read on an identical repeat (silent invalidator, or prefix under the minimum)')
    failed = true
  }

  const r3 = await api.create(buildRequest(cfg, turn('明天交水费'), cfg.maxTokens))
  show('3 different utterance', r3)
  if ((r3.usage.cache_read_input_tokens ?? 0) > 0) console.log('  PASS tools+system prefix shared across utterances')
  else {
    console.log('  FAIL the tools+system prefix was not read from cache for a new utterance')
    failed = true
  }

  console.log('\n4 full interpret()')
  const interpreter = createInterpreter({ config: { ...t.config, anthropic: config.anthropic }, domain: t.domain, clock: t.clock, api })
  const res = await interpreter.interpret({ memberId: t.husband.id, text: '我九点有个会，明天早上你能带孩子出去吗', source: 'voice' })
  console.log(`  status=${res.utterance.status} reply=${res.utterance.reply ?? ''}`)
  for (const c of res.utterance.changes) console.log(`  change: ${c.summary}`)
  if (res.utterance.status === 'error') failed = true

  console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE OK')
  if (failed) process.exitCode = 1
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
