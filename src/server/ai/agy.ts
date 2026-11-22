// Headless Antigravity CLI (`agy`) backend for Gemini 4 Neon with native MCP tool calls.
//
// Each utterance runs in a completely isolated temporary workspace (`mkdtemp`, mode 0700) with:
//   - `--sandbox` and NO `--dangerously-skip-permissions` (headless `request-review` mode fails closed
//     on every built-in write/shell/web/MCP tool by default),
//   - `--settings <workdir>/.agents/settings.json` allow-listing ONLY our 11 `mcp(family_board/<tool>)`
//     permissions (fail-closed even if hooks never loaded),
//   - `.agents/mcp_config.json` pointing to a per-turn localhost Streamable HTTP MCP server
//     (127.0.0.1:0 + random Bearer token) with all 11 board tools marked `eager: true`,
//   - `.agents/agents/family-board.md` carrying SYSTEM_PROMPT,
//   - `.agents/hooks.json` + `.agents/guard.mjs` (fail-closed PreToolUse hook) denying every tool except
//     those 11 `family_board` MCP tools (blocking even read-only tools like read_file/list_dir and any
//     global MCP servers), and writing a per-turn marker so the server can verify the hook ran, and
//   - `--input-format stream-json --output-format stream-json` passing the prompt over stdin (a private
//     pipe, invisible to `ps`) instead of command-line argv.
//
// After each utterance finishes, `cleanupAgyConversation()` removes the conversation files `agy` writes
// under `~/.gemini/antigravity-cli/` (brain, conversations, annotations, and conversation_summaries.db rows)
// so disk usage stays flat and private 助手 chats do not linger on disk.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { AGY_DEFAULT_MODEL, type Config } from '../config'
import type { CallUsage, LoopErrorCode, LoopResult, ToolOutcomeLike } from './loop'
import { createMcpTurnSession, MCP_SERVER_NAME, MCP_TOOLS, startMcpServer, type McpServerHandle } from './mcp'
import { SYSTEM_PROMPT } from './prompt'
import type { BoardCall } from './tools'

export { AGY_DEFAULT_MODEL }
export const AGY_AGENT_NAME = 'family-board'
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANCEL_POLL_MS = 250
const DEFAULT_CLOSE_GRACE_MS = 1000
const STDERR_TAIL_MAX = 4000
const GUARD_MARKER_NAME = '.guard_verified'
const SQLITE_RETRY_DELAYS_MS = [50, 100, 200, 400] as const

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

/** Command-line arguments for a single non-interactive `agy` turn (prompt travels on stdin, never argv). */
export function buildAgyArgs(cfg: AgyConfig, settingsPath: string, logFilePath: string): string[] {
  const timeoutSec = Math.max(5, Math.ceil(cfg.deadlineMs / 1000))
  return [
    '--agent',
    AGY_AGENT_NAME,
    '--model',
    cfg.model,
    ...(hasEffortSuffix(cfg.model) ? [] : ['--effort', cfg.effort]),
    '--sandbox',
    '--settings',
    settingsPath,
    '--log-file',
    logFilePath,
    '--disable-slash-commands',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--print-timeout',
    `${timeoutSec}s`,
  ]
}

/** NDJSON user turn envelope sent over stdin to `agy --input-format stream-json`. */
export function renderStreamJsonInput(turnInput: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: turnInput } })}\n`
}

/**
 * Session-only settings that override global user preferences (e.g. `agentMode: "auto"`) so `agy` stays
 * strictly fail-closed even without the PreToolUse hook: `request-review` auto-denies every shell/write/
 * web/browser/MCP tool in headless mode except our 11 explicit `mcp(family_board/<tool>)` allow rules
 * (`strict` would override `permissions.allow` and block our MCP tools too), `allowNonWorkspaceAccess: false`
 * blocks reading files like `.env` outside the empty temp workspace, and `deny` blocks shell/file/web tools.
 */
export function renderAgySettings(): string {
  return JSON.stringify(
    {
      agentMode: '',
      toolPermission: 'request-review',
      enableTerminalSandbox: true,
      allowNonWorkspaceAccess: false,
      permissions: {
        allow: MCP_TOOLS.map(t => `mcp(${MCP_SERVER_NAME}/${t.name})`),
        deny: ['command(*)', 'read_file(*)', 'write(*)', 'web(*)'],
      },
    },
    null,
    2,
  )
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
 * (including read_file, list_dir, run_command, write_to_file, search_web, browser_*, etc.) and every
 * global MCP server. When `markerPath` is provided, writes a marker line whenever the hook runs.
 */
export function renderGuardHookScript(markerPath?: string): string {
  const allowedNames = JSON.stringify(MCP_TOOLS.map(t => t.name))
  const prefix = `mcp_${MCP_SERVER_NAME}_`
  const markerBlock = markerPath
    ? `function mark(name, allowed) {
  try { appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ name, allowed }) + '\\n', { mode: 0o600 }) } catch {}
}`
    : `function mark() {}`
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'

const ALLOWED = new Set(${allowedNames})
const SERVER = ${JSON.stringify(MCP_SERVER_NAME)}
const PREFIX = ${JSON.stringify(prefix)}

${markerBlock}

function allow(name) {
  mark(name, true)
  process.stdout.write(JSON.stringify({ decision: 'allow' }))
}

function deny(name, reason) {
  mark(name, false)
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }))
}

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'))
  const tc = payload && typeof payload === 'object' ? payload.toolCall : null
  const name = tc && typeof tc.name === 'string' ? tc.name : ''
  const args = tc && tc.args && typeof tc.args === 'object' ? tc.args : {}
  if (name.startsWith(PREFIX) && ALLOWED.has(name.slice(PREFIX.length))) {
    allow(name)
  } else if (name === 'call_mcp_tool') {
    const serverName = args.ServerName ?? args.serverName ?? args.server_name
    const toolName = args.ToolName ?? args.toolName ?? args.tool_name
    if (serverName === SERVER && typeof toolName === 'string' && ALLOWED.has(toolName)) {
      allow(name)
    } else {
      deny(name, 'Only family_board MCP tools are allowed.')
    }
  } else {
    deny(name, 'Only family_board MCP tools are allowed.')
  }
} catch {
  deny('invalid', 'Guard hook failed to parse payload.')
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

export function defaultAgyAppDataDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Deletes the per-conversation state `agy` persists on disk (`brain/<id>`, `conversations/<id>*`,
 * `annotations/<id>*`, and rows in `conversation_summaries.db`) so disk usage does not grow with
 * every utterance and private 助手 conversations do not remain on disk.
 *
 * Uses `timeout: 0` with short async retries on SQLITE_BUSY so cleanup never blocks the server's
 * event loop waiting on a lock.
 */
export async function cleanupAgyConversation(conversationId: string | null, appDataDir: string = defaultAgyAppDataDir()): Promise<void> {
  if (!conversationId || !UUID_RE.test(conversationId)) return

  await rm(join(appDataDir, 'brain', conversationId), { recursive: true, force: true }).catch(() => undefined)

  for (const subdir of ['conversations', 'annotations']) {
    const dir = join(appDataDir, subdir)
    const entries = await readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      if (entry === conversationId || entry.startsWith(`${conversationId}.`)) {
        await rm(join(dir, entry), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  const summariesDbPath = join(appDataDir, 'conversation_summaries.db')
  if (!existsSync(summariesDbPath)) return

  const tables = ['conversation_summaries', 'conversations_fts', 'conversation_parents'] as const
  const remaining = new Set<string>(tables)
  for (let attempt = 0; attempt <= SQLITE_RETRY_DELAYS_MS.length && remaining.size > 0; attempt++) {
    if (attempt > 0) await delay(SQLITE_RETRY_DELAYS_MS[attempt - 1]!)
    let db: Database.Database | null = null
    let sawBusy = false
    try {
      db = new Database(summariesDbPath, { fileMustExist: true, timeout: 0 })
      for (const table of [...remaining]) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`).run(conversationId)
          remaining.delete(table)
        } catch (err) {
          if (isSqliteBusy(err)) sawBusy = true
          else remaining.delete(table) // table may not exist in older/newer agy versions
        }
      }
    } catch (err) {
      if (isSqliteBusy(err)) sawBusy = true
      else return
    } finally {
      try {
        db?.close()
      } catch {
        // already closed
      }
    }
    if (!sawBusy) break
  }
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

export interface StreamEventInfo {
  agentResponses: number
  stepType?: 'agent_response' | 'tool' | 'other'
  stepState?: string
  toolName?: string
  activeTools: number
}

/** Accumulates NDJSON events from `agy --output-format stream-json`. */
export class AgyStreamParser {
  model: string
  conversationId: string | null = null
  status: 'SUCCESS' | 'ERROR' | null = null
  responseText: string | null = null
  errorText: string | null = null
  finishedReason: string | null = null
  deniedActions: Array<{ action?: string; display_name?: string }> = []
  readonly calls: CallUsage[] = []
  private readonly deltas = new Map<number, string>()
  private readonly activeToolSteps = new Set<number>()
  private lastResponseStepIndex = -1
  private totalUsage: RawUsage | null = null

  constructor(requestedModel: string) {
    this.model = requestedModel
  }

  feedLine(line: string): StreamEventInfo {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      return { agentResponses: this.calls.length, activeTools: this.activeToolSteps.size }
    }
    if (typeof ev.conversation_id === 'string') this.conversationId = ev.conversation_id

    if (ev.event === 'init' && ev.init && typeof ev.init === 'object') {
      const init = ev.init as Record<string, unknown>
      if (typeof init.model === 'string' && init.model.trim()) this.model = init.model.trim()
      return { agentResponses: this.calls.length, activeTools: this.activeToolSteps.size }
    }

    if (ev.event === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
      const su = ev.step_update as Record<string, unknown>
      if (typeof su.conversation_id === 'string') this.conversationId = su.conversation_id
      const state = typeof su.state === 'string' ? su.state : undefined
      const idx = typeof su.step_index === 'number' ? su.step_index : this.lastResponseStepIndex + 1

      if (su.step_type === 'tool') {
        if (state === 'ACTIVE') this.activeToolSteps.add(idx)
        else if (state === 'DONE' || state === 'ERROR') this.activeToolSteps.delete(idx)
        let toolName = typeof su.tool_name === 'string' ? su.tool_name : undefined
        if (toolName === 'call_mcp_tool' && su.tool_info && typeof su.tool_info === 'object') {
          const params = (su.tool_info as { parameters?: Record<string, unknown> }).parameters
          const inner = params?.ToolName ?? params?.toolName ?? params?.tool_name
          if (typeof inner === 'string') toolName = `mcp_${MCP_SERVER_NAME}_${inner}`
        }
        return { agentResponses: this.calls.length, stepType: 'tool', stepState: state, toolName, activeTools: this.activeToolSteps.size }
      }

      if (su.step_type === 'agent_response') {
        if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
          this.deltas.set(idx, (this.deltas.get(idx) ?? '') + su.text_delta)
          this.lastResponseStepIndex = idx
        }
        if (state === 'DONE') {
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
        return { agentResponses: this.calls.length, stepType: 'agent_response', stepState: state, activeTools: this.activeToolSteps.size }
      }
      return { agentResponses: this.calls.length, stepType: 'other', stepState: state, activeTools: this.activeToolSteps.size }
    }

    if (ev.event === 'result' && ev.result && typeof ev.result === 'object') {
      const res = ev.result as Record<string, unknown>
      if (typeof res.conversation_id === 'string') this.conversationId = res.conversation_id
      if (res.status === 'SUCCESS' || res.status === 'ERROR') this.status = res.status
      if (typeof res.response === 'string') this.responseText = res.response
      if (typeof res.error === 'string' && res.error.trim()) this.errorText = res.error.trim()
      if (typeof res.finished_reason === 'string' && res.finished_reason.trim()) this.finishedReason = res.finished_reason.trim()
      if (Array.isArray(res.denied_actions)) {
        this.deniedActions = res.denied_actions.filter((x): x is { action?: string; display_name?: string } => !!x && typeof x === 'object')
      }
      if (res.usage && typeof res.usage === 'object') this.totalUsage = res.usage as RawUsage
    }
    return { agentResponses: this.calls.length, activeTools: this.activeToolSteps.size }
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

export interface AgyStderrError {
  message: string
  status?: string
  retryable?: boolean
}

/** Extracts structured error details from an `AGY_ERROR: {...}` stderr line if present. */
export function extractAgyStderrError(stderr: string): AgyStderrError | null {
  const lines = stderr.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line.startsWith('AGY_ERROR:')) {
      const jsonStr = line.slice('AGY_ERROR:'.length).trim()
      try {
        const parsed = JSON.parse(jsonStr) as { short_error?: unknown; message?: unknown; status?: unknown; retryable?: unknown }
        const message =
          (typeof parsed.short_error === 'string' && parsed.short_error.trim()) ||
          (typeof parsed.message === 'string' && parsed.message.trim()) ||
          jsonStr
        return {
          message,
          ...(typeof parsed.status === 'string' && parsed.status.trim() ? { status: parsed.status.trim() } : {}),
          ...(typeof parsed.retryable === 'boolean' ? { retryable: parsed.retryable } : {}),
        }
      } catch {
        return { message: jsonStr || line }
      }
    }
  }
  const nonEmpty = lines.map(l => l.trim()).filter(Boolean)
  const last = nonEmpty.at(-1)
  return last ? { message: last } : null
}

/**
 * Maps an agy CLI / gRPC / model error to the interpreter's LoopErrorCode taxonomy.
 * Google uses `RESOURCE_EXHAUSTED` for both short burst rate limits and exhausted quota:
 * retryable errors, rate-limit phrasing, or bare RESOURCE_EXHAUSTED map to `rate_limited` ("busy"),
 * while explicit non-retryable quota/billing/credit exhaustion maps to `spend_limit`.
 */
export function classifyAgyError(detail: string, meta: { status?: string; retryable?: boolean } = {}): LoopErrorCode {
  const s = detail.toLowerCase()
  const grpcStatus = (meta.status ?? '').toUpperCase()
  const isRateLimitText = /rate.?limit|too many requests|\b429\b|requests per|per.?minute|\brpm\b|\btpm\b|burst|try again (?:in|later|shortly)/.test(s)
  const isSpendLimitText = /usage limits?\b|credit balance|spend limit|out of quota|quota (?:exceeded|exhausted|depleted)|daily (?:quota|limit)|monthly (?:quota|limit)|billing/.test(s)

  if (isRateLimitText) return 'rate_limited'
  if (grpcStatus === 'RESOURCE_EXHAUSTED' || /\bresource_exhausted\b/.test(s)) {
    if (meta.retryable === true) return 'rate_limited'
    return isSpendLimitText ? 'spend_limit' : 'rate_limited'
  }
  if (isSpendLimitText) return 'spend_limit'
  if (grpcStatus === 'UNAVAILABLE' || /overloaded|service unavailable|\bunavailable\b|\b503\b|\b529\b/.test(s)) return 'overloaded'
  if (grpcStatus === 'UNAUTHENTICATED' || /unauthenticated|not logged in|please log ?in|oauth|token expired|invalid.?credential|\b401\b/.test(s)) return 'auth'
  if (grpcStatus === 'PERMISSION_DENIED' || /permission_denied|\bforbidden\b|\b403\b/.test(s)) return 'permission'
  if (/model\b[^.\n]*not found|unknown model|invalid model|unsupported model/.test(s)) return 'model_not_found'
  if (grpcStatus === 'DEADLINE_EXCEEDED' || /deadline[_ ]exceeded|timed? ?out|\btimeout\b/.test(s)) return 'timeout'
  if (/\benoent\b|failed to construct|unknown component|flag provided but not defined|invalid flag|unknown flag|no such file or directory/.test(s)) return 'bad_request'
  if (/\brefus(?:ed|al)\b|safety (?:filter|block|policy|settings)|content policy|harmful content/.test(s)) return 'refusal'
  if (/econnrefused|econnreset|enotfound|etimedout|socket hang up|network error|connection (?:refused|reset|closed)/.test(s)) return 'network'
  return 'api_error'
}

export type AgyChildProcess = ChildProcessWithoutNullStreams

export type AgySpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: ['pipe', 'pipe', 'pipe'] },
) => AgyChildProcess

export interface AgyLoopArgs {
  cfg: AgyConfig
  turnInput: string
  execute: (call: BoardCall, toolUseId: string) => ToolOutcomeLike | Promise<ToolOutcomeLike>
  isCancelled?: () => boolean
  signal?: AbortSignal
  /** Override agy app-data directory for conversation cleanup (tests; default ~/.gemini/antigravity-cli). */
  appDataDir?: string
  /** Called with whether the PreToolUse guard marker was written during the turn (smoke/tests). */
  onGuardVerified?: (verified: boolean, toolCallCount: number) => void
  /**
   * Whether to fail closed if MCP tool calls ran without the PreToolUse guard hook writing its marker.
   * Defaults to true in production (`!spawnImpl`), false when a fake `spawnImpl` is injected in tests.
   */
  verifyGuard?: boolean
  /** Called when the guard check fails so the interpreter can disable the agy backend. */
  onGuardFailed?: () => void
  /** Max time to wait for stdio 'close' after child 'exit' (guards against leaked grandchildren holding fds open). */
  closeGraceMs?: number
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

interface PreparedWorkspace {
  workdir: string
  settingsPath: string
  logFilePath: string
  markerPath: string
}

async function prepareWorkspace(mcpUrl: string, mcpToken: string): Promise<PreparedWorkspace> {
  const workdir = await mkdtemp(join(tmpdir(), 'family-share-agy-'))
  await chmod(workdir, 0o700)
  const agentsDir = join(workdir, '.agents')
  await mkdir(join(agentsDir, 'agents'), { recursive: true })
  const guardPath = join(agentsDir, 'guard.mjs')
  const settingsPath = join(agentsDir, 'settings.json')
  const logFilePath = join(workdir, 'agy.log')
  const markerPath = join(workdir, GUARD_MARKER_NAME)
  await Promise.all([
    writeFile(join(agentsDir, 'mcp_config.json'), renderMcpConfig(mcpUrl, mcpToken), { mode: 0o600 }),
    writeFile(settingsPath, renderAgySettings(), { mode: 0o600 }),
    writeFile(join(agentsDir, 'agents', `${AGY_AGENT_NAME}.md`), renderAgentMarkdown(), { mode: 0o600 }),
    writeFile(guardPath, renderGuardHookScript(markerPath), { mode: 0o700 }),
    writeFile(join(agentsDir, 'hooks.json'), renderHooksConfig(process.execPath, guardPath), { mode: 0o600 }),
  ])
  return { workdir, settingsPath, logFilePath, markerPath }
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
  let mcp: McpServerHandle | null = null
  let stopReason: 'cancelled' | 'aborted' | 'iteration_cap' | 'clarified' | null = null

  const session = createMcpTurnSession({
    execute: a.execute,
    isCancelled: a.isCancelled,
    maxIterations: a.cfg.maxIterations,
    onCancel: () => stopWith('cancelled'),
    onIterationCap: () => stopWith('iteration_cap'),
    maxToolCalls: Math.max(6, a.cfg.maxIterations * 6),
  })

  function stopWith(reason: 'cancelled' | 'aborted' | 'iteration_cap' | 'clarified') {
    if (!stopReason) stopReason = reason
    // Fence the MCP session IMMEDIATELY so nothing can mutate the board during shutdown.
    session.close(reason)
    if (mcp) void mcp.close().catch(() => undefined)
    if (proc) killChild(proc)
  }

  mcp = await (a.startMcp ?? startMcpServer)(session)
  let ws: PreparedWorkspace | null = null
  let cancelTimer: NodeJS.Timeout | null = null
  let closeGraceTimer: NodeJS.Timeout | null = null
  let conversationId: string | null = null
  const onAbort = () => stopWith('aborted')

  try {
    ws = await prepareWorkspace(mcp.url, mcp.token)
    const args = buildAgyArgs(a.cfg, ws.settingsPath, ws.logFilePath)
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

    const child = spawnFn(a.cfg.path, args, { cwd: ws.workdir, stdio: ['pipe', 'pipe', 'pipe'] })
    proc = child

    // Pipe the prompt over stdin so the snapshot (and private 助手 chat lines) never appear in `ps`.
    child.stdin.on('error', () => undefined)
    child.stdin.end(renderStreamJsonInput(a.turnInput))

    let stdoutBuf = ''
    let stderrTail = ''
    let spawnErr: Error | null = null

    const handleLine = (line: string) => {
      const info = parser.feedLine(line)
      if (parser.conversationId) conversationId = parser.conversationId

      if (info.stepType === 'agent_response' && info.stepState === 'DONE') {
        session.noteAgentResponse(info.agentResponses)
      }

      // Enforce maxIterations strictly: if maxIterations model calls have already completed and agy starts
      // another board tool (other than ask_clarification, which ends the turn) or another model response,
      // stop immediately (never allowing maxIterations + 1 calls).
      if (info.agentResponses >= a.cfg.maxIterations && !session.clarification) {
        if (info.agentResponses > a.cfg.maxIterations) {
          stopWith('iteration_cap')
          return
        }
        if (info.stepType === 'tool' && info.stepState === 'ACTIVE' && info.toolName !== `mcp_${MCP_SERVER_NAME}_ask_clarification`) {
          stopWith('iteration_cap')
          return
        }
        if (info.stepType === 'agent_response' && info.stepState === 'ACTIVE') {
          stopWith('iteration_cap')
          return
        }
      }

      // Stop agy only once the NEXT model response begins after a clean ask_clarification (never on a timer
      // after the tool step, which could race a slow sibling tool whose guard hook is still starting).
      if (session.clarification && info.stepType === 'agent_response' && info.stepState === 'ACTIVE') {
        stopWith('clarified')
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line) handleLine(line)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX)
    })

    // Wait for 'close' so stdout/stderr flush completely, bounded by closeGraceMs after 'exit' so a
    // grandchild holding stdout/stderr open can never leave an utterance stuck on 处理中… forever.
    const closeGraceMs = a.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      let settled = false
      const done = (r: { code: number | null; signal: NodeJS.Signals | null }) => {
        if (settled) return
        settled = true
        if (closeGraceTimer) clearTimeout(closeGraceTimer)
        closeGraceTimer = null
        resolve(r)
      }
      child.once('error', err => {
        spawnErr = err
        done({ code: null, signal: null })
      })
      child.once('exit', (code, signal) => {
        closeGraceTimer = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          done({ code, signal })
        }, closeGraceMs)
        closeGraceTimer.unref()
      })
      child.once('close', (code, signal) => done({ code, signal }))
    })

    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim())

    const guardVerified = existsSync(ws.markerPath)
    a.onGuardVerified?.(guardVerified, session.toolCalls.length)
    const shouldVerifyGuard = a.verifyGuard ?? !a.spawnImpl
    if (shouldVerifyGuard && session.toolCalls.length > 0 && !guardVerified) {
      console.error('[ai] CRITICAL: agy PreToolUse guard hook did not fire during MCP tool execution; disabling agy backend')
      a.onGuardFailed?.()
      return fail('bad_request', 'PreToolUse guard hook did not run', parser.usageList(), session.toolCalls)
    }

    const usage = parser.usageList()
    const toolCalls = session.toolCalls

    if (stopReason === 'cancelled' || session.cancelled || a.isCancelled?.()) {
      return fail('cancelled', undefined, usage, toolCalls)
    }
    // Never discard a cleanly recorded clarification question even if a follow-up model turn errored/timed out
    // or we intentionally stopped agy when the next model response began.
    if (session.clarification) {
      return { status: 'clarify', clarification: session.clarification, usage, toolCalls }
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

    if (parser.status === 'SUCCESS' || (parser.status === null && exit.code === 0)) {
      const reply = parser.finalReply()
      if (!reply && parser.deniedActions.some(d => d.action === 'mcp')) {
        const names = parser.deniedActions.map(d => d.display_name ?? d.action ?? 'tool').join(', ')
        return fail('permission', `agy denied MCP tool permission (${names})`, usage, toolCalls)
      }
      return { status: 'done', reply, usage, toolCalls }
    }

    const stderrErr = extractAgyStderrError(stderrTail)
    const detail = parser.errorText ?? stderrErr?.message ?? `agy exited with ${exit.signal ?? exit.code ?? 'unknown error'}`
    return fail(classifyAgyError(detail, { status: stderrErr?.status, retryable: stderrErr?.retryable }), detail, usage, toolCalls)
  } finally {
    if (closeGraceTimer) clearTimeout(closeGraceTimer)
    if (cancelTimer) clearInterval(cancelTimer)
    a.signal?.removeEventListener('abort', onAbort)
    session.close('finished')
    await mcp.close().catch(() => undefined)
    if (ws) await rm(ws.workdir, { recursive: true, force: true }).catch(() => undefined)
    // Remove agy's persisted conversation artifacts (snapshots & private chats) after the process has exited.
    await cleanupAgyConversation(conversationId, a.appDataDir)
  }
}
