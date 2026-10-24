// Runs eval cases against a Messages API (live in scripts/ai-eval.ts; scripted in harness.test.ts).
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Item, Member, UtteranceStatus } from '../../../shared/types'
import type { Config } from '../../config'
import { toSimplified } from '../../domain/normalize'
import { createTestContext, type TestContext } from '../../testing'
import { addDaysToDate, localDate, zonedToUtc } from '../../time'
import { createInterpreter } from '../index'
import type { CallUsage, MessagesApi } from '../loop'
import { usageOf } from '../loop'
import type { EvalCase, ExpectedCall, MemberKey, SeedItem } from './cases'

/** USD per million tokens. Unknown models are priced like Opus 5.5 and flagged as estimates. */
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
}

export function costOf(calls: CallUsage[]): { usd: number; estimated: boolean } {
  let usd = 0
  let estimated = false
  for (const c of calls) {
    const p = PRICES[c.model] ?? (Object.entries(PRICES).find(([k]) => c.model.startsWith(k))?.[1] ?? null)
    const price = p ?? PRICES['claude-opus-5-5']!
    if (!p) estimated = true
    usd += (c.inputTokens * price.input + c.outputTokens * price.output + c.cacheWriteTokens * price.cacheWrite + c.cacheReadTokens * price.cacheRead) / 1e6
  }
  return { usd, estimated }
}

/** Wraps a Messages API and records every request body and response. */
export class RecordingApi implements MessagesApi {
  readonly requests: MessageCreateParamsNonStreaming[] = []
  readonly responses: BetaMessage[] = []
  constructor(private readonly inner: MessagesApi) {}
  async create(body: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<BetaMessage> {
    this.requests.push(structuredClone(body))
    const res = await this.inner.create(body, options)
    this.responses.push(res)
    return res
  }
}

export interface ObservedCall {
  name: string
  input: Record<string, unknown>
  /** ok = the server applied it; 'not_run' = never answered (ask_clarification turn, error) */
  result: 'ok' | 'error' | 'not_run'
  code?: string
}

/** Pairs each tool_use with the tool_result sent in the following request. */
export function observedCalls(rec: RecordingApi): ObservedCall[] {
  const out: ObservedCall[] = []
  rec.responses.forEach((res, i) => {
    const next = rec.requests[i + 1]
    const last = next?.messages.at(-1)
    const results = new Map<string, { is_error?: boolean; content?: unknown }>()
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      for (const b of last.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b)
    }
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue
      const r = results.get(b.id)
      const input = (b.input ?? {}) as Record<string, unknown>
      if (!r) {
        out.push({ name: b.name, input, result: b.name === 'ask_clarification' && res.stop_reason === 'tool_use' ? 'ok' : 'not_run' })
        continue
      }
      let code: string | undefined
      try {
        code = (JSON.parse(String(r.content)) as { code?: string }).code
      } catch {
        code = undefined
      }
      out.push({ name: b.name, input, result: r.is_error ? 'error' : 'ok', ...(r.is_error && code ? { code } : {}) })
    }
  })
  return out
}

export interface CaseRun {
  case: EvalCase
  status: UtteranceStatus
  reply: string | null
  calls: ObservedCall[]
  usage: CallUsage[]
  failures: string[]
  costUsd: number
  costEstimated: boolean
  ms: number
  /** id → readable name (members and seeded items), for printing */
  names: Map<string, string>
}

function seedItems(t: TestContext, seed: SeedItem[], member: (k: MemberKey) => Member, resolveDate: (d: string) => string): Map<string, Item> {
  const tz = t.family.timezone
  const out = new Map<string, Item>()
  for (const s of seed) {
    const date = s.dueDate ? resolveDate(s.dueDate) : null
    const dueAt = date && s.dueTime ? zonedToUtc(date, s.dueTime, tz).toISOString() : null
    const dueDate = date && !s.dueTime ? date : null
    let item: Item
    if (s.kind === 'request') {
      if (!s.owner || !s.requestedBy) throw new Error(`seed ${s.key}: a request needs owner and requestedBy`)
      item = t.domain.sendRequest(t.as(member(s.requestedBy)), { toMemberId: member(s.owner).id, title: s.title, dueAt, dueDate })
    } else {
      const creator = s.owner ? member(s.owner) : t.wife
      item = t.domain.createItem(t.as(creator), { kind: s.kind, title: s.title, ownerId: s.owner ? member(s.owner).id : null, dueAt, dueDate })
    }
    const ownerActor = t.as(s.owner ? member(s.owner) : t.wife)
    for (const n of s.notes ?? []) t.domain.addNote(ownerActor, item.id, n)
    for (const r of s.reminders ?? []) {
      const to = r.member ? member(r.member) : s.owner ? member(s.owner) : t.wife
      const fireAt = zonedToUtc(resolveDate(r.date), r.time, tz).toISOString()
      t.domain.setReminder(ownerActor, { itemId: item.id, memberId: to.id, fireAt, message: s.title })
    }
    switch (s.status) {
      case undefined:
      case 'open':
      case 'pending':
        break
      case 'accepted':
      case 'declined':
        t.domain.respondToRequest(ownerActor, item.id, s.status === 'accepted' ? 'accept' : 'decline')
        break
      case 'done':
        t.domain.completeItem(ownerActor, item.id)
        break
      default:
        t.domain.updateItem(ownerActor, item.id, { status: s.status })
    }
    out.set(s.key, t.domain.getItem(item.id)!)
  }
  return out
}

const dateOf = (i: Record<string, unknown>) => (i.due_date ?? i.remind_date ?? i.until_date) as string | undefined
const timeOf = (i: Record<string, unknown>) => (i.due_time ?? i.remind_time ?? i.until_time) as string | undefined
const norm = (s: unknown) => toSimplified(String(s ?? '')).toLowerCase()

function matches(e: ExpectedCall, c: ObservedCall, ids: { member: (k: MemberKey) => string; item: (k: string) => string; date: (d: string) => string }): boolean {
  const tools = Array.isArray(e.tool) ? e.tool : [e.tool]
  if (c.result !== 'ok' || !tools.includes(c.name as never)) return false
  const i = c.input
  if (e.member) {
    const id = ids.member(e.member)
    const memberIds = Array.isArray(i.member_ids) ? (i.member_ids as string[]) : []
    if (i.to_member_id !== id && i.owner_id !== id && !memberIds.includes(id)) return false
  }
  if (e.item && i.item_id !== ids.item(e.item) && i.existing_item_id !== ids.item(e.item)) return false
  if (e.titleIncludes && !e.titleIncludes.some(s => norm(i.title).includes(norm(s)))) return false
  if (e.date) {
    if (e.date === 'none' ? dateOf(i) !== undefined : dateOf(i) !== ids.date(e.date)) return false
  }
  if (e.time) {
    if (e.time === 'none' ? timeOf(i) !== undefined : timeOf(i) !== e.time) return false
  }
  for (const k of ['kind', 'resolution', 'response', 'preset', 'status', 'priority'] as const) {
    if (e[k] !== undefined && i[k] !== e[k]) return false
  }
  if (e.textIncludes) {
    const text = norm([i.details, i.text, i.note, i.message].filter(Boolean).join(' '))
    if (!e.textIncludes.some(s => text.includes(norm(s)))) return false
  }
  return true
}

export function describeExpected(e: ExpectedCall): string {
  const { tool, ...rest } = e
  const t = Array.isArray(tool) ? tool.join('|') : tool
  const args = Object.entries(rest).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : String(v)}`)
  return `${t}(${args.join(', ')})`
}

export async function runCase(c: EvalCase, api: MessagesApi, anthropic: Config['anthropic']): Promise<CaseRun> {
  const t = createTestContext()
  const member = (k: MemberKey) => (k === 'husband' ? t.husband : t.wife)
  const today = localDate(t.clock.now(), t.family.timezone)
  const resolveDate = (d: string) => (/^[+-]\d+$/.test(d) ? addDaysToDate(today, Number(d)) : d)
  const speaker = member(c.speaker)
  if (c.speakerLanguage) t.domain.updateMember(speaker.id, { language: c.speakerLanguage })
  const seeded = seedItems(t, c.seed ?? [], member, resolveDate)

  const rec = new RecordingApi(api)
  const config = { ...t.config, anthropic }
  const interpreter = createInterpreter({ config, domain: t.domain, clock: t.clock, api: rec })
  const started = Date.now()
  const r = await interpreter.interpret({ memberId: speaker.id, text: c.text, source: c.source ?? 'text' })
  const ms = Date.now() - started

  const calls = observedCalls(rec)
  const usage = rec.responses.map(usageOf)
  const ids = {
    member: (k: MemberKey) => member(k).id,
    item: (k: string) => seeded.get(k)?.id ?? `missing-seed:${k}`,
    date: resolveDate,
  }
  const failures: string[] = []
  const outcome = c.outcome ?? 'done'
  if (r.utterance.status !== outcome) failures.push(`status ${r.utterance.status} (expected ${outcome})${r.utterance.error ? `: ${r.utterance.error}` : ''}`)
  for (const e of c.expect) if (!calls.some(call => matches(e, call, ids))) failures.push(`missing ${describeExpected(e)}`)
  for (const f of c.forbid ?? []) if (calls.some(call => call.name === f && call.result === 'ok')) failures.push(`forbidden call ${f}`)
  const reply = r.utterance.reply ?? ''
  if (c.replyMatches && !new RegExp(c.replyMatches).test(reply)) failures.push(`reply does not match /${c.replyMatches}/`)
  if (c.replyScript === 'traditional' && toSimplified(reply) === reply) failures.push('reply is not in Traditional characters')
  if (c.replyScript === 'english' && /[㐀-鿿]/.test(reply)) failures.push('reply is not in English')
  if (/\b[imu]_[0-9a-z]{10}\b/.test(reply)) failures.push('reply leaks an id')

  const names = new Map<string, string>([
    [t.husband.id, '老公'],
    [t.wife.id, '老婆'],
  ])
  for (const [k, it] of seeded) names.set(it.id, `${it.title}#${k}`)
  for (const it of r.items) if (!names.has(it.id)) names.set(it.id, it.title)
  const cost = costOf(usage)
  return { case: c, status: r.utterance.status, reply: r.utterance.reply, calls, usage, failures, costUsd: cost.usd, costEstimated: cost.estimated, ms, names }
}

/** One-line rendering of a tool call with ids replaced by names. */
export function formatCall(call: ObservedCall, names: Map<string, string>): string {
  const show = (v: unknown): string => {
    if (typeof v === 'string') return names.get(v) ?? v
    if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`
    return JSON.stringify(v)
  }
  const args = Object.entries(call.input).map(([k, v]) => `${k}=${show(v)}`)
  const result = call.result === 'ok' ? 'ok' : call.result === 'error' ? `ERROR ${call.code ?? ''}`.trim() : 'not run'
  return `${call.name}(${args.join(', ')}) → ${result}`
}
