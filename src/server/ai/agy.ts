// Headless Antigravity CLI (`agy`) backend for Gemini 4 Neon with native MCP tool calls.
//
// Each utterance runs in a completely isolated temporary workspace (`mkdtemp`) with:
//   - `.agents/mcp_config.json` pointing to a per-turn localhost Streamable HTTP MCP server
//     (127.0.0.1:0 + random Bearer token) with all 11 board tools marked `eager: true`,
//   - `.agents/agents/family-board.md` carrying SYSTEM_PROMPT, and
//   - `.agents/hooks.json` + `.agents/guard.mjs` (PreToolUse hook) hard-denying every tool except
//     our 11 board tools on the `family_board` MCP server (defense in depth against prompt injection
//     and any global MCP servers or workspace tools on the host machine).
//
// Running a fresh `agy --print=...` process per utterance keeps family and private chats strictly
// isolated (no shared conversation history) and mirrors the single-turn contract in SPEC §4.

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { Config } from '../config'
import type { CallUsage, LoopErrorCode, LoopResult, ToolOutcomeLike } from './loop'
import { createMcpTurnSession, MCP_SERVER_NAME, MCP_TOOLS, startMcpServer, type McpServerHandle } from './mcp'
import { SYSTEM_PROMPT } from './prompt'
import type { BoardCall } from './tools'

export const AGY_DEFAULT_MODEL = 'gemini-4-neon'
export const AGY_AGENT_NAME = 'family-board'
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i
const CANCEL_POLL_MS = 250
const STDERR_TAIL_MAX = 4000

export interface AgyConfig {
  /** Path to the `agy` binary (default "agy") */
  path: string
  /** Model id passed to `--model` (e.g. "gemini-4-neon" or "gemini-4-neon-high") */
  model: string
  /** Reasoning effort passed to `--effort` unless the model name already ends with an effort suffix */
  effort: Config['ai']['effort']
  /** Maximum LLM turns allowed per utterance */
  maxIterations: number
  /** Overall deadline in ms (passed to `--print-timeout` as well as enforced by AbortSignal) */
  deadlineMs: number
}

export function agyConfigFrom(config: Config, deadlineMs = 90_000): AgyConfig {
  return {
    path: config.agy.path,
    model: config.ai.model,
    effort: config.ai.effort,
    maxIterations: config.ai.maxIterations,
    deadlineMs,
  }
}

export function hasEffortSuffix(model: string): boolean {
  return EFFORT_SUFFIX_RE.test(model.trim())
}

/** Command-line arguments for a single non-interactive `agy` turn. */
export function buildAgyArgs(cfg: AgyConfig, turnInput: string): string[] {
  const timeoutSec = Math.max(5, Math.ceil(cfg.deadlineMs / 1000))
  // Node's child_process rejects NUL bytes in argv; strip defensively.
  const prompt = turnInput.replace(/\0/g, '')
  const args = [
    '--agent',
    AGY_AGENT_NAME,
    '--model',
    cfg.model,
    ...(hasEffortSuffix(cfg.model) ? [] : ['--effort', cfg.effort]),
    '--output-format',
    'stream-json',
    '--disable-slash-commands',
    '--dangerously-skip-permissions',
    '--print-timeout',
    `${timeoutSec}s`,
    `--print=${prompt}`,
  ]
  return args
}

/** Custom agent definition carrying SYSTEM_PROMPT plus MCP tool-name guidance. */
export function renderAgentMarkdown(): string {
  return [
    '---',
    `name: ${AGY_AGENT_NAME}`,
    'description: 家庭助手 — family_share shared board interpreter',
    'mainAgent: true',
    '---',
    '',
    SYSTEM_PROMPT,
    '',
    '# MCP tools',
    `Your board tools are exposed by the "${MCP_SERVER_NAME}" MCP server (prefixed \`mcp_${MCP_SERVER_NAME}_\`, e.g. \`mcp_${MCP_SERVER_NAME}_create_item\`, or via \`call_mcp_tool\` on server \`${MCP_SERVER_NAME}\`). Use ONLY those 11 board tools. Never call filesystem, shell, browser, web, or any other tools.`,
    '',
  ].join('\n')
}

/** Workspace `.agents/mcp_config.json` registering every board tool as eager so schemas load upfront. */
export function renderMcpConfig(url: string, token: string): string {
  const tools = Object.fromEntries(MCP_TOOLS.map(t => [t.name, { eager: true }]))
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          serverUrl: url,
          headers: { Authorization: `Bearer ${token}` },
          timeoutSeconds: 60,
          tools,
        },
      },
    },
    null,
    2,
  )
}

/**
 * Fail-closed PreToolUse hook script written into each isolated workspace.
 * Allows ONLY our 11 board tools on the `family_board` MCP server; denies every built-in tool
 * (run_command, read_file, write_to_file, search_web, browser_*, etc.) and every global MCP server.
 */
export function renderGuardHookScript(): string {
  const allowedNames = JSON.stringify(MCP_TOOLS.map(t => t.name))
  const prefix = `mcp_${MCP_SERVER_NAME}_`
  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const ALLOWED = new Set(${allowedNames})
const SERVER = ${JSON.stringify(MCP_SERVER_NAME)}
const PREFIX = ${JSON.stringify(prefix)}

function allow() {
  process.stdout.write(JSON.stringify({ decision: 'allow' }))
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }))
}

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'))
  const tc = payload && typeof payload === 'object' ? payload.toolCall : null
  const name = tc && typeof tc.name === 'string' ? tc.name : ''
  const args = tc && tc.args && typeof tc.args === 'object' ? tc.args : {}
  if (name.startsWith(PREFIX) && ALLOWED.has(name.slice(PREFIX.length))) {
    allow()
  } else if (name === 'call_mcp_tool') {
    const serverName = args.ServerName ?? args.serverName ?? args.server_name
    const toolName = args.ToolName ?? args.toolName ?? args.tool_name
    if (serverName === SERVER && typeof toolName === 'string' && ALLOWED.has(toolName)) {
      allow()
    } else {
      deny('Only family_board MCP tools are allowed.')
    }
  } else {
    deny('Only family_board MCP tools are allowed.')
  }
} catch {
  deny('Guard hook failed to parse payload.')
}
`
}

export function renderHooksConfig(nodeExecPath: string, guardScriptPath: string): string {
  return JSON.stringify(
    {
      'family-board-guard': {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `${JSON.stringify(nodeExecPath)} ${JSON.stringify(guardScriptPath)}`,
                timeout: 5,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )
}

interface RawUsage {
  input_tokens?: unknown
  output_tokens?: unknown
  thinking_tokens?: unknown
  cache_read_tokens?: unknown
  total_tokens?: unknown
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Accumulates NDJSON events from `agy --output-format stream-json`. */
export class AgyStreamParser {
  model: string
  conversationId: string | null = null
  status: 'SUCCESS' | 'ERROR' | null = null
  responseText: string | null = null
  errorText: string | null = null
  finishedReason: string | null = null
  readonly calls: CallUsage[] = []
  private readonly deltas = new Map<number, string>()
  private lastResponseStepIndex = -1
  private totalUsage: RawUsage | null = null

  constructor(requestedModel: string) {
    this.model = requestedModel
  }

  feedLine(line: string): { agentResponses: number } {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      return { agentResponses: this.calls.length }
    }
    if (typeof ev.conversation_id === 'string') this.conversationId = ev.conversation_id

    if (ev.event === 'init' && ev.init && typeof ev.init === 'object') {
      const init = ev.init as Record<string, unknown>
      if (typeof init.model === 'string' && init.model.trim()) this.model = init.model.trim()
      return { agentResponses: this.calls.length }
    }

    if (ev.event === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
      const su = ev.step_update as Record<string, unknown>
      if (typeof su.conversation_id === 'string') this.conversationId = su.conversation_id
      if (su.step_type === 'agent_response') {
        const idx = typeof su.step_index === 'number' ? su.step_index : this.lastResponseStepIndex + 1
        if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
          this.deltas.set(idx, (this.deltas.get(idx) ?? '') + su.text_delta)
          this.lastResponseStepIndex = idx
        }
        if (su.state === 'DONE') {
          const u = (su.usage && typeof su.usage === 'object' ? su.usage : null) as RawUsage | null
          this.calls.push({
            model: this.model,
            stopReason: 'agent_response',
            inputTokens: num(u?.input_tokens),
            outputTokens: num(u?.output_tokens),
            cacheReadTokens: num(u?.cache_read_tokens),
            cacheWriteTokens: 0,
            servedByFallback: false,
            requestId: this.conversationId,
          })
        }
      }
      return { agentResponses: this.calls.length }
    }

    if (ev.event === 'result' && ev.result && typeof ev.result === 'object') {
      const res = ev.result as Record<string, unknown>
      if (typeof res.conversation_id === 'string') this.conversationId = res.conversation_id
      if (res.status === 'SUCCESS' || res.status === 'ERROR') this.status = res.status
      if (typeof res.response === 'string') this.responseText = res.response
      if (typeof res.error === 'string' && res.error.trim()) this.errorText = res.error.trim()
      if (typeof res.finished_reason === 'string' && res.finished_reason.trim()) this.finishedReason = res.finished_reason.trim()
      if (res.usage && typeof res.usage === 'object') this.totalUsage = res.usage as RawUsage
    }
    return { agentResponses: this.calls.length }
  }

  /** Final assistant text (prefers `result.response`, falling back to accumulated text deltas). */
  finalReply(): string {
    if (this.responseText !== null) return this.responseText.trim()
    if (this.lastResponseStepIndex >= 0) return (this.deltas.get(this.lastResponseStepIndex) ?? '').trim()
    return ''
  }

  /** Per-step usage list, or a single summary entry from `result.usage` when step usage wasn't emitted. */
  usageList(): CallUsage[] {
    if (this.calls.length > 0) return this.calls
    if (!this.totalUsage) return []
    const inputTokens = num(this.totalUsage.input_tokens)
    const outputTokens = num(this.totalUsage.output_tokens)
    const cacheReadTokens = num(this.totalUsage.cache_read_tokens)
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) return []
    return [
      {
        model: this.model,
        stopReason: this.finishedReason ?? (this.status === 'SUCCESS' ? 'end_turn' : 'error'),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        servedByFallback: false,
        requestId: this.conversationId,
      },
    ]
  }
}

/** Extracts the short_error field from an `AGY_ERROR: {...}` stderr line if present. */
export function extractAgyStderrError(stderr: string): string | null {
  const lines = stderr.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line.startsWith('AGY_ERROR:')) {
      const jsonStr = line.slice('AGY_ERROR:'.length).trim()
      try {
        const parsed = JSON.parse(jsonStr) as { short_error?: unknown; message?: unknown }
        if (typeof parsed.short_error === 'string' && parsed.short_error.trim()) return parsed.short_error.trim()
        if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
      } catch {
        return jsonStr || line
      }
    }
  }
  const nonEmpty = lines.map(l => l.trim()).filter(Boolean)
  return nonEmpty.at(-1) ?? null
}

/** Maps an agy CLI / gRPC / model error string to the interpreter's LoopErrorCode taxonomy. */
export function classifyAgyError(detail: string): LoopErrorCode {
  const s = detail.toLowerCase()
  if (/quota|resource_exhausted|credit|usage limit|exhausted|billing/.test(s)) return 'spend_limit'
  if (/rate.?limit|too many requests|\b429\b/.test(s)) return 'rate_limited'
  if (/overloaded|unavailable|\b503\b|\b529\b/.test(s)) return 'overloaded'
  if (/unauthenticated|not logged in|login|oauth|token expired|credential|\b401\b/.test(s)) return 'auth'
  if (/permission_denied|forbidden|\b403\b/.test(s)) return 'permission'
  if (/model.*not found|unknown model|invalid model|not_found.*model/.test(s)) return 'model_not_found'
  if (/deadline_exceeded|timed? ?out|timeout/.test(s)) return 'timeout'
  if (/enoent|not found|failed to construct|unknown component|flag provided/.test(s)) return 'bad_request'
  if (/refus|safety|blocked|policy/.test(s)) return 'refusal'
  if (/econnrefused|econnreset|enotfound|network|socket|connection/.test(s)) return 'network'
  return 'api_error'
}

export type AgyChildProcess = ChildProcessByStdio<null, Readable, Readable>

export type AgySpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: ['ignore', 'pipe', 'pipe'] },
) => AgyChildProcess

export interface AgyLoopArgs {
  cfg: AgyConfig
  turnInput: string
  execute: (call: BoardCall, toolUseId: string) => ToolOutcomeLike | Promise<ToolOutcomeLike>
  isCancelled?: () => boolean
  signal?: AbortSignal
  /** Tests: inject a fake agy subprocess */
  spawnImpl?: AgySpawnImpl
  /** Tests: inject a fake MCP server handle instead of binding a real socket */
  startMcp?: (session: ReturnType<typeof createMcpTurnSession>) => Promise<McpServerHandle>
}

export type AgyRunner = (args: AgyLoopArgs) => Promise<LoopResult>

function killChild(proc: AgyChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try {
    proc.kill('SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already exited
      }
    }
  }, 2000).unref()
}

async function prepareWorkspace(mcpUrl: string, mcpToken: string): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), 'family-share-agy-'))
  await chmod(workdir, 0o700)
  const agentsDir = join(workdir, '.agents')
  await mkdir(join(agentsDir, 'agents'), { recursive: true })
  const guardPath = join(agentsDir, 'guard.mjs')
  await Promise.all([
    writeFile(join(agentsDir, 'mcp_config.json'), renderMcpConfig(mcpUrl, mcpToken), { mode: 0o600 }),
    writeFile(join(agentsDir, 'agents', `${AGY_AGENT_NAME}.md`), renderAgentMarkdown(), { mode: 0o600 }),
    writeFile(guardPath, renderGuardHookScript(), { mode: 0o700 }),
    writeFile(join(agentsDir, 'hooks.json'), renderHooksConfig(process.execPath, guardPath), { mode: 0o600 }),
  ])
  return workdir
}

/** Runs one utterance through headless `agy` + ephemeral localhost MCP server. */
export async function runAgyLoop(a: AgyLoopArgs): Promise<LoopResult> {
  const fail = (code: LoopErrorCode, detail?: string, usage: CallUsage[] = [], toolCalls: LoopResult['toolCalls'] = []): LoopResult => ({
    status: 'error',
    code,
    ...(detail === undefined ? {} : { detail }),
    usage,
    toolCalls,
  })

  if (a.isCancelled?.()) return fail('cancelled')
  if (a.signal?.aborted) return fail('aborted')

  let proc: AgyChildProcess | null = null
  let stopReason: 'cancelled' | 'aborted' | 'iteration_cap' | null = null
  const stopWith = (reason: 'cancelled' | 'aborted' | 'iteration_cap') => {
    if (!stopReason) stopReason = reason
    if (proc) killChild(proc)
  }

  const session = createMcpTurnSession({
    execute: a.execute,
    isCancelled: a.isCancelled,
    onCancel: () => stopWith('cancelled'),
    maxToolCalls: Math.max(6, a.cfg.maxIterations * 6),
  })

  const mcp = await (a.startMcp ?? startMcpServer)(session)
  let workdir: string | null = null
  let cancelTimer: NodeJS.Timeout | null = null
  const onAbort = () => stopWith('aborted')

  try {
    workdir = await prepareWorkspace(mcp.url, mcp.token)
    const args = buildAgyArgs(a.cfg, a.turnInput)
    const spawnFn: AgySpawnImpl = a.spawnImpl ?? ((cmd, argv, opts) => spawn(cmd, argv, opts))
    const parser = new AgyStreamParser(a.cfg.model)

    if (a.signal) {
      if (a.signal.aborted) {
        stopWith('aborted')
        return fail('aborted', undefined, [], session.toolCalls)
      }
      a.signal.addEventListener('abort', onAbort, { once: true })
    }

    if (a.isCancelled) {
      cancelTimer = setInterval(() => {
        if (a.isCancelled?.()) {
          session.cancelled = true
          stopWith('cancelled')
        }
      }, CANCEL_POLL_MS)
      cancelTimer.unref()
    }

    const child = spawnFn(a.cfg.path, args, { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] })
    proc = child

    let stdoutBuf = ''
    let stderrTail = ''
    let spawnErr: Error | null = null

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        const { agentResponses } = parser.feedLine(line)
        if (agentResponses > a.cfg.maxIterations) {
          stopWith('iteration_cap')
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX)
    })

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', err => {
        spawnErr = err
        resolve({ code: null, signal: null })
      })
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })

    if (stdoutBuf.trim()) parser.feedLine(stdoutBuf.trim())

    const usage = parser.usageList()
    const toolCalls = session.toolCalls

    if (stopReason === 'cancelled' || session.cancelled || a.isCancelled?.()) {
      return fail('cancelled', undefined, usage, toolCalls)
    }
    if (stopReason === 'aborted' || a.signal?.aborted) {
      return fail('aborted', 'agy process aborted', usage, toolCalls)
    }
    if (stopReason === 'iteration_cap') {
      return fail('iteration_cap', `exceeded ${a.cfg.maxIterations} model calls`, usage, toolCalls)
    }
    if (spawnErr) {
      const err = spawnErr as NodeJS.ErrnoException
      const detail = `Failed to spawn ${a.cfg.path}: ${err.message}`
      return fail(err.code === 'ENOENT' ? 'bad_request' : 'internal', detail, usage, toolCalls)
    }

    if (session.clarification && parser.status !== 'ERROR' && exit.code === 0) {
      return { status: 'clarify', clarification: session.clarification, usage, toolCalls }
    }

    if (parser.status === 'SUCCESS' || (parser.status === null && exit.code === 0)) {
      if (session.clarification) {
        return { status: 'clarify', clarification: session.clarification, usage, toolCalls }
      }
      return { status: 'done', reply: parser.finalReply(), usage, toolCalls }
    }

    const detail = parser.errorText ?? extractAgyStderrError(stderrTail) ?? `agy exited with ${exit.signal ?? exit.code ?? 'unknown error'}`
    return fail(classifyAgyError(detail), detail, usage, toolCalls)
  } finally {
    if (cancelTimer) clearInterval(cancelTimer)
    a.signal?.removeEventListener('abort', onAbort)
    await mcp.close().catch(() => undefined)
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  }
}
