// Live eval of the interpreter on ~30 family utterances (src/server/ai/eval/cases.ts).
//
//   AI_PROVIDER=agy npx tsx scripts/ai-eval.ts                     # headless agy + Gemini 4 Neon (via MCP)
//   ANTHROPIC_API_KEY=… npx tsx scripts/ai-eval.ts                 # Anthropic Claude API
//   npx tsx scripts/ai-eval.ts --only milk,cabinet --effort low    # a subset, another effort
//   npx tsx scripts/ai-eval.ts --provider agy --model gemini-4-neon --effort high
//
// Each case runs in a fresh in-memory board (Wed 2026-10-21 12:00 Sydney, members 老公/老婆) and
// makes real model calls. Prints pass/fail per case with the tool calls made.
// Does nothing (exit 0) when AI is not configured.

import { AGY_DEFAULT_MODEL, ANTHROPIC_DEFAULT_MODEL, loadConfig, type Config } from '../src/server/config'
import { createAnthropicClient, messagesApiFrom } from '../src/server/ai/client'
import { CASES } from '../src/server/ai/eval/cases'
import { describeExpected, formatCall, runCase, runCaseWithAgy, type CaseRun } from '../src/server/ai/eval/harness'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const PROVIDERS = ['agy', 'anthropic'] as const

function parseArgs(argv: string[]) {
  const out: {
    only: string[]
    provider?: (typeof PROVIDERS)[number]
    model?: string
    effort?: (typeof EFFORTS)[number]
    fallbacks?: boolean
    verbose: boolean
  } = { only: [], verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => {
      const v = argv[++i]
      if (!v) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--only') out.only.push(...next().split(',').map(s => s.trim()).filter(Boolean))
    else if (a === '--provider') {
      const p = next()
      if (!(PROVIDERS as readonly string[]).includes(p)) throw new Error(`--provider must be one of ${PROVIDERS.join(', ')}`)
      out.provider = p as (typeof PROVIDERS)[number]
    } else if (a === '--model') out.model = next()
    else if (a === '--effort') {
      const e = next()
      if (!(EFFORTS as readonly string[]).includes(e)) throw new Error(`--effort must be one of ${EFFORTS.join(', ')}`)
      out.effort = e as (typeof EFFORTS)[number]
    } else if (a === '--no-fallbacks') out.fallbacks = false
    else if (a === '--verbose' || a === '-v') out.verbose = true
    else if (a === '--help' || a === '-h') {
      console.log('usage: npx tsx scripts/ai-eval.ts [--provider agy|anthropic] [--only id,id] [--model m] [--effort e] [--no-fallbacks] [--verbose]')
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  return out
}

function printRun(run: CaseRun, verbose: boolean, provider: 'agy' | 'anthropic'): void {
  const c = run.case
  const tokens = run.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0)
  const cacheRead = run.usage.reduce((n, u) => n + u.cacheReadTokens, 0)
  const head = run.failures.length ? 'FAIL' : 'PASS'
  const costStr = provider === 'agy' ? '' : `, $${run.costUsd.toFixed(4)}${run.costEstimated ? ' est.' : ''}`
  console.log(`${head} ${c.id}  (${run.usage.length} calls, ${(run.ms / 1000).toFixed(1)}s, ${tokens} tok, cache read ${cacheRead}${costStr})`)
  console.log(`  ${c.speaker === 'husband' ? '老公' : '老婆'}: ${c.text}`)
  for (const call of run.calls) console.log(`  → ${formatCall(call, run.names)}`)
  console.log(`  ← [${run.status}] ${run.reply ?? ''}`)
  for (const f of run.failures) console.log(`  ✗ ${f}`)
  if (run.failures.length || verbose) {
    console.log(`    why: ${c.why}`)
    if (c.expect.length) console.log(`    expected: ${c.expect.map(describeExpected).join('; ')}`)
    if (verbose) console.log(`    models: ${[...new Set(run.usage.map(u => u.model))].join(', ')}${run.usage.some(u => u.servedByFallback) ? ' (fallback served)' : ''}`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let config: Config
  try {
    config = loadConfig()
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(2)
  }
  const provider = args.provider ?? (config.ai.provider === 'none' ? null : config.ai.provider)
  if (!provider) {
    console.log('AI is not configured (set AI_PROVIDER=agy or ANTHROPIC_API_KEY) — skipping the live interpreter eval.')
    return
  }
  if (provider === 'anthropic' && !config.anthropic.apiKey) {
    console.log('ANTHROPIC_API_KEY is not set — skipping the live interpreter eval.')
    return
  }
  const cases = args.only.length ? CASES.filter(c => args.only.some(o => c.id.includes(o))) : CASES
  if (!cases.length) {
    console.log('no cases match --only')
    process.exit(2)
  }

  const ai: Config['ai'] = {
    ...config.ai,
    provider,
    model: args.model ?? (provider === config.ai.provider ? config.ai.model : provider === 'agy' ? AGY_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL),
    ...(args.effort ? { effort: args.effort } : {}),
  }
  const anthropic: Config['anthropic'] = {
    ...config.anthropic,
    model: ai.model,
    effort: ai.effort,
    ...(args.fallbacks === false ? { fallbacks: false } : {}),
  }
  const api = provider === 'anthropic' ? messagesApiFrom(createAnthropicClient({ anthropic })) : null

  console.log(
    provider === 'agy'
      ? `Interpreter eval (agy): ${cases.length} cases, model ${ai.model}, effort ${ai.effort}, bin ${config.agy.path}\n`
      : `Interpreter eval (anthropic): ${cases.length} cases, model ${anthropic.model}, effort ${anthropic.effort}, fallbacks ${anthropic.fallbacks ? 'default' : 'off'}\n`,
  )

  const runs: CaseRun[] = []
  for (const c of cases) {
    try {
      const run = provider === 'agy' ? await runCaseWithAgy(c, ai, config.agy) : await runCase(c, api!, anthropic)
      runs.push(run)
      printRun(run, args.verbose, provider)
    } catch (e) {
      console.log(`FAIL ${c.id}  (harness error: ${e instanceof Error ? e.message : String(e)})`)
      runs.push({ case: c, status: 'error', reply: null, calls: [], usage: [], failures: ['harness error'], costUsd: 0, costEstimated: false, ms: 0, names: new Map() })
    }
    console.log('')
  }

  const passed = runs.filter(r => r.failures.length === 0).length
  const cost = runs.reduce((s, r) => s + r.costUsd, 0)
  const calls = runs.reduce((s, r) => s + r.usage.length, 0)
  const ms = runs.map(r => r.ms).sort((a, b) => a - b)
  const p50 = ms[Math.floor(ms.length / 2)] ?? 0
  const p95 = ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] ?? 0
  const sum = (f: (u: CaseRun['usage'][number]) => number) => runs.reduce((s, r) => s + r.usage.reduce((n, u) => n + f(u), 0), 0)
  console.log(`${passed}/${runs.length} passed · ${calls} model calls · latency p50 ${(p50 / 1000).toFixed(1)}s p95 ${(p95 / 1000).toFixed(1)}s`)
  console.log(
    `tokens: input ${sum(u => u.inputTokens)}, cache write ${sum(u => u.cacheWriteTokens)}, cache read ${sum(u => u.cacheReadTokens)}, output ${sum(u => u.outputTokens)}`,
  )
  if (provider === 'anthropic') {
    console.log(`total cost $${cost.toFixed(4)}${runs.some(r => r.costEstimated) ? ' (partly estimated)' : ''} · $${(cost / Math.max(1, runs.length)).toFixed(4)} per utterance`)
  }
  if (passed < runs.length) process.exitCode = 1
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
