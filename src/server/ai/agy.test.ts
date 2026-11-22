// Tests for the headless `agy` CLI (Gemini 4 Neon + MCP) backend.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { AGY_DEFAULT_MODEL, loadConfig, testConfig } from '../config'
import { createTestContext } from '../testing'
import {
  AGY_AGENT_NAME,
  AgyStreamParser,
  agyConfigFrom,
  buildAgyArgs,
  classifyAgyError,
  cleanupAgyConversation,
  extractAgyStderrError,
  hasEffortSuffix,
  renderAgentMarkdown,
  renderAgySettings,
  renderGuardHookScript,
  renderMcpConfig,
  renderStreamJsonInput,
  runAgyLoop,
  type AgySpawnImpl,
} from './agy'
import { CASES } from './eval/cases'
import { runCaseWithAgy } from './eval/harness'
import { createInterpreter, REPLIES } from './index'
import { MCP_SERVER_NAME, MCP_TOOLS } from './mcp'
import { SYSTEM_PROMPT } from './prompt'

/** Builds a spawnImpl that runs inline Node JS in place of `agy`, receiving `(cwd, agyArgs)` and stdin. */
function fakeAgySpawn(scriptSource: string, captured: { cwd?: string; args?: string[] } = {}): AgySpawnImpl {
  return (_cmd, args, opts) => {
    captured.cwd = opts.cwd
    captured.args = args
    return spawn(process.execPath, ['-e', scriptSource, '--', ...args], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  }
}

/** Shared helper snippet for fake agy scripts: reads the single NDJSON user turn from stdin. */
const READ_STDIN_PROMPT = `
  async function readPrompt() {
    let buf = '';
    for await (const chunk of process.stdin) buf += chunk;
    const msg = JSON.parse(buf.trim());
    return msg.message.content;
  }
`

describe('config: AI_PROVIDER=agy', () => {
  it('defaults AI_MODEL to gemini-4-neon when AI_PROVIDER=agy', () => {
    const c = loadConfig({ AI_PROVIDER: 'agy' } as NodeJS.ProcessEnv, { loadDotEnv: false })
    expect(c.ai).toEqual({ provider: 'agy', model: AGY_DEFAULT_MODEL, effort: 'medium', maxIterations: 6 })
    expect(c.agy).toEqual({ path: 'agy' })
  })

  it('respects explicit AI_MODEL, AI_EFFORT, AI_MAX_ITERATIONS and AGY_PATH', () => {
    const c = loadConfig(
      { AI_PROVIDER: 'agy', AI_MODEL: 'gemini-4-neon-xhigh', AI_EFFORT: 'high', AI_MAX_ITERATIONS: '4', AGY_PATH: '/opt/bin/agy' } as NodeJS.ProcessEnv,
      { loadDotEnv: false },
    )
    expect(c.ai).toEqual({ provider: 'agy', model: 'gemini-4-neon-xhigh', effort: 'high', maxIterations: 4 })
    expect(c.agy).toEqual({ path: '/opt/bin/agy' })
  })

  it('keeps anthropic as automatic default when ANTHROPIC_API_KEY is set, and lets AI_PROVIDER=none override it', () => {
    const auto = loadConfig({ ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv, { loadDotEnv: false })
    expect(auto.ai.provider).toBe('anthropic')
    expect(auto.ai.model).toBe('claude-opus-5-5')

    const off = loadConfig({ AI_PROVIDER: 'none', ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv, { loadDotEnv: false })
    expect(off.ai.provider).toBe('none')
  })
})

describe('agy CLI arg builder, fail-closed settings, workspace templates and PreToolUse guard', () => {
  it('never passes --dangerously-skip-permissions or prompt text in argv; enables --sandbox, --settings, --log-file and stdin stream-json', () => {
    const baseCfg = agyConfigFrom(testConfig({ ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'high', maxIterations: 6 } }), 60_000)
    const args = buildAgyArgs(baseCfg, '/tmp/ws/.agents/settings.json', '/tmp/ws/agy.log')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args.some(a => a.startsWith('--print='))).toBe(false)
    expect(args).toContain('--sandbox')
    expect(args).toContain('--settings')
    expect(args).toContain('/tmp/ws/.agents/settings.json')
    expect(args).toContain('--log-file')
    expect(args).toContain('/tmp/ws/agy.log')
    expect(args).toContain('--input-format')
    expect(args).toContain('--output-format')
    expect(args).toContain('--agent')
    expect(args).toContain(AGY_AGENT_NAME)
    expect(args).toContain('--model')
    expect(args).toContain('gemini-4-neon')
    expect(args).toContain('--effort')
    expect(args).toContain('high')
    expect(args).toContain('--disable-slash-commands')
    expect(args).toContain('--print-timeout')
    expect(args).toContain('60s')

    const suffixed = agyConfigFrom(testConfig({ ai: { provider: 'agy', model: 'gemini-4-neon-xhigh', effort: 'medium', maxIterations: 6 } }))
    expect(hasEffortSuffix('gemini-4-neon-xhigh')).toBe(true)
    expect(hasEffortSuffix('gemini-4-neon')).toBe(false)
    expect(buildAgyArgs(suffixed, '/tmp/s.json', '/tmp/a.log')).not.toContain('--effort')

    const ndjson = renderStreamJsonInput('私聊秘密内容')
    expect(ndjson.endsWith('\n')).toBe(true)
    expect(JSON.parse(ndjson)).toEqual({ event: 'user', message: { content: '私聊秘密内容' } })
  })

  it('overrides global agentMode/toolPermission to fail closed, allow-lists only our 11 MCP tools, and embeds SYSTEM_PROMPT', () => {
    const settings = JSON.parse(renderAgySettings()) as {
      agentMode: string
      toolPermission: string
      enableTerminalSandbox: boolean
      allowNonWorkspaceAccess: boolean
      permissions: { allow: string[]; deny: string[] }
    }
    expect(settings).toEqual({
      agentMode: '',
      toolPermission: 'request-review',
      enableTerminalSandbox: true,
      allowNonWorkspaceAccess: false,
      permissions: {
        allow: MCP_TOOLS.map(t => `mcp(${MCP_SERVER_NAME}/${t.name})`),
        deny: ['command(*)', 'read_file(*)', 'write(*)', 'web(*)'],
      },
    })

    const cfg = JSON.parse(renderMcpConfig('http://127.0.0.1:9999/mcp', 'secret')) as {
      mcpServers: Record<string, { serverUrl: string; headers: Record<string, string>; tools: Record<string, { eager: boolean }> }>
    }
    const srv = cfg.mcpServers[MCP_SERVER_NAME]!
    expect(srv.serverUrl).toBe('http://127.0.0.1:9999/mcp')
    expect(srv.headers.Authorization).toBe('Bearer secret')
    expect(Object.keys(srv.tools)).toEqual(MCP_TOOLS.map(t => t.name))
    for (const v of Object.values(srv.tools)) expect(v).toEqual({ eager: true })

    const md = renderAgentMarkdown()
    expect(md).toContain(`name: ${AGY_AGENT_NAME}`)
    expect(md).toContain(SYSTEM_PROMPT)
  })

  it('PreToolUse guard hook allows only our 11 family_board MCP tools, writes verification marker, and fails closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'family-share-guard-test-'))
    try {
      const guardPath = join(dir, 'guard.mjs')
      const markerPath = join(dir, '.guard_verified')
      await writeFile(guardPath, renderGuardHookScript(markerPath))
      const runGuard = (input: string) => {
        const r = spawnSync(process.execPath, [guardPath], { input, encoding: 'utf8' })
        expect(r.status).toBe(0)
        return JSON.parse(r.stdout) as { decision: string; reason?: string }
      }

      // eager MCP tool name -> allow
      expect(runGuard(JSON.stringify({ toolCall: { name: 'mcp_family_board_create_item', args: { title: 'x' } } }))).toEqual({ decision: 'allow' })
      expect(runGuard(JSON.stringify({ toolCall: { name: 'mcp_family_board_ask_clarification', args: {} } }))).toEqual({ decision: 'allow' })
      // fallback call_mcp_tool on family_board -> allow
      expect(
        runGuard(JSON.stringify({ toolCall: { name: 'call_mcp_tool', args: { ServerName: 'family_board', ToolName: 'send_request', Arguments: {} } } })),
      ).toEqual({ decision: 'allow' })

      // built-in tools -> deny
      expect(runGuard(JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } } })).decision).toBe('deny')
      expect(runGuard(JSON.stringify({ toolCall: { name: 'read_file', args: { Path: '/etc/passwd' } } })).decision).toBe('deny')
      expect(runGuard(JSON.stringify({ toolCall: { name: 'write_to_file', args: {} } })).decision).toBe('deny')
      expect(runGuard(JSON.stringify({ toolCall: { name: 'search_web', args: {} } })).decision).toBe('deny')
      // other MCP servers (e.g. user's global mcp_config.json) -> deny
      expect(runGuard(JSON.stringify({ toolCall: { name: 'call_mcp_tool', args: { ServerName: 'github', ToolName: 'create_issue' } } })).decision).toBe('deny')
      expect(runGuard(JSON.stringify({ toolCall: { name: 'mcp_github_create_issue', args: {} } })).decision).toBe('deny')
      // unknown tool on family_board -> deny
      expect(runGuard(JSON.stringify({ toolCall: { name: 'mcp_family_board_delete_all', args: {} } })).decision).toBe('deny')
      // malformed JSON -> fail closed
      expect(runGuard('not-json').decision).toBe('deny')

      const markerLines = (await readFile(markerPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { name: string; allowed: boolean })
      expect(markerLines.some(m => m.name === 'mcp_family_board_create_item' && m.allowed)).toBe(true)
      expect(markerLines.some(m => m.name === 'run_command' && !m.allowed)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('conversation disk cleanup', () => {
  it('deletes brain, conversations, annotations and conversation_summaries.db rows for only that UUID', async () => {
    const appData = await mkdtemp(join(tmpdir(), 'family-share-appdata-'))
    const targetId = '11111111-2222-3333-4444-555555555555'
    const otherId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    try {
      await mkdir(join(appData, 'brain', targetId), { recursive: true })
      await mkdir(join(appData, 'brain', otherId), { recursive: true })
      await mkdir(join(appData, 'conversations'), { recursive: true })
      await mkdir(join(appData, 'annotations'), { recursive: true })
      await writeFile(join(appData, 'brain', targetId, 'transcript.jsonl'), 'private chat')
      await writeFile(join(appData, 'brain', otherId, 'transcript.jsonl'), 'keep me')
      await writeFile(join(appData, 'conversations', `${targetId}.db`), 'db')
      await writeFile(join(appData, 'conversations', `${targetId}.db-wal`), 'wal')
      await writeFile(join(appData, 'conversations', `${otherId}.db`), 'keep')
      await writeFile(join(appData, 'annotations', `${targetId}.pb`), 'ann')

      const db = new Database(join(appData, 'conversation_summaries.db'))
      db.exec(`
        CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, preview TEXT);
        CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, user_body);
        CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT);
      `)
      db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(targetId, 'secret private chat')
      db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(otherId, 'user own work')
      db.prepare('INSERT INTO conversations_fts VALUES (?, ?)').run(targetId, 'secret private chat')
      db.prepare('INSERT INTO conversations_fts VALUES (?, ?)').run(otherId, 'user own work')
      db.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(targetId, otherId)
      db.close()

      // ignores non-UUID / traversal strings safely
      await cleanupAgyConversation('../etc/passwd', appData)
      expect(existsSync(join(appData, 'brain', targetId))).toBe(true)

      await cleanupAgyConversation(targetId, appData)

      expect(existsSync(join(appData, 'brain', targetId))).toBe(false)
      expect(existsSync(join(appData, 'conversations', `${targetId}.db`))).toBe(false)
      expect(existsSync(join(appData, 'conversations', `${targetId}.db-wal`))).toBe(false)
      expect(existsSync(join(appData, 'annotations', `${targetId}.pb`))).toBe(false)
      // untouched other conversation
      expect(existsSync(join(appData, 'brain', otherId, 'transcript.jsonl'))).toBe(true)
      expect(existsSync(join(appData, 'conversations', `${otherId}.db`))).toBe(true)

      const verifyDb = new Database(join(appData, 'conversation_summaries.db'), { readonly: true })
      expect(verifyDb.prepare('SELECT conversation_id FROM conversation_summaries').all()).toEqual([{ conversation_id: otherId }])
      expect(verifyDb.prepare('SELECT conversation_id FROM conversations_fts').all()).toEqual([{ conversation_id: otherId }])
      expect(verifyDb.prepare('SELECT conversation_id FROM conversation_parents').all()).toEqual([])
      verifyDb.close()
    } finally {
      await rm(appData, { recursive: true, force: true })
    }
  })

  it('retries asynchronously without blocking the event loop when conversation_summaries.db is briefly locked', async () => {
    const appData = await mkdtemp(join(tmpdir(), 'family-share-appdata-lock-'))
    const targetId = '33333333-4444-5555-6666-777777777777'
    try {
      const dbPath = join(appData, 'conversation_summaries.db')
      const holder = new Database(dbPath)
      holder.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY);')
      holder.prepare('INSERT INTO conversation_summaries VALUES (?)').run(targetId)
      holder.exec('BEGIN EXCLUSIVE')

      let timerTicks = 0
      const tick = setInterval(() => timerTicks++, 10)
      setTimeout(() => holder.exec('COMMIT'), 70)

      try {
        await cleanupAgyConversation(targetId, appData)
      } finally {
        clearInterval(tick)
        holder.close()
      }

      // Event loop stayed responsive while waiting for the lock to clear
      expect(timerTicks).toBeGreaterThanOrEqual(2)
      const check = new Database(dbPath, { readonly: true })
      expect(check.prepare('SELECT conversation_id FROM conversation_summaries').all()).toEqual([])
      check.close()
    } finally {
      await rm(appData, { recursive: true, force: true })
    }
  })
})

describe('stream-json parser and error classification', () => {
  it('parses init, step_update usage, text deltas and result events', () => {
    const p = new AgyStreamParser('gemini-4-neon')
    p.feedLine('not json at all')
    p.feedLine(JSON.stringify({ event: 'init', conversation_id: 'conv_1', init: { model: 'gemini-4-neon-medium' } }))
    p.feedLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv_1',
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          usage: { input_tokens: 3000, output_tokens: 150, thinking_tokens: 100, cache_read_tokens: 0 },
        },
      }),
    )
    p.feedLine(
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: 'conv_1', step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '好的，' },
      }),
    )
    p.feedLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv_1',
          step_index: 3,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: '记好了。',
          usage: { input_tokens: 2000, output_tokens: 40, cache_read_tokens: 1500 },
        },
      }),
    )
    p.feedLine(
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'conv_1', status: 'SUCCESS', response: '好的，记好了。\n', usage: { input_tokens: 5000, output_tokens: 190, cache_read_tokens: 1500 } },
      }),
    )
    expect(p.model).toBe('gemini-4-neon-medium')
    expect(p.status).toBe('SUCCESS')
    expect(p.finalReply()).toBe('好的，记好了。')
    expect(p.usageList()).toHaveLength(2)
    expect(p.usageList()[1]).toMatchObject({ model: 'gemini-4-neon-medium', inputTokens: 2000, outputTokens: 40, cacheReadTokens: 1500, requestId: 'conv_1' })
  })

  it('distinguishes burst rate limits (RESOURCE_EXHAUSTED) from exhausted quota and avoids broad false positives', () => {
    const burst = extractAgyStderrError('noise\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED: too many requests","status":"RESOURCE_EXHAUSTED","retryable":true}\n')
    expect(burst).toEqual({ message: 'RESOURCE_EXHAUSTED: too many requests', status: 'RESOURCE_EXHAUSTED', retryable: true })
    expect(classifyAgyError(burst!.message, burst!)).toBe('rate_limited')

    // retryable RESOURCE_EXHAUSTED even if text says "quota" is a short rate limit, not an exhausted allowance
    expect(classifyAgyError('RESOURCE_EXHAUSTED: quota exceeded per minute', { status: 'RESOURCE_EXHAUSTED', retryable: true })).toBe('rate_limited')
    // bare RESOURCE_EXHAUSTED without billing/quota wording defaults to rate_limited (busy)
    expect(classifyAgyError('RESOURCE_EXHAUSTED', { status: 'RESOURCE_EXHAUSTED' })).toBe('rate_limited')
    // explicit non-retryable quota / usage limit maps to spend_limit
    expect(classifyAgyError('RESOURCE_EXHAUSTED: daily quota exhausted', { status: 'RESOURCE_EXHAUSTED', retryable: false })).toBe('spend_limit')
    expect(classifyAgyError('You have reached your usage limits', { retryable: false })).toBe('spend_limit')

    expect(classifyAgyError('429 rate limit exceeded')).toBe('rate_limited')
    expect(classifyAgyError('503 service unavailable')).toBe('overloaded')
    expect(classifyAgyError('UNAUTHENTICATED: not logged in')).toBe('auth')
    expect(classifyAgyError('unknown model "gemini-99"')).toBe('model_not_found')
    expect(classifyAgyError('DEADLINE_EXCEEDED: timed out')).toBe('timeout')
    expect(classifyAgyError('context deadline exceeded')).toBe('timeout')
    expect(classifyAgyError('ECONNRESET')).toBe('network')
    expect(classifyAgyError('response refused by safety filter')).toBe('refusal')

    // tightened patterns must NOT misclassify unrelated errors
    expect(classifyAgyError('conversation 123 not found')).toBe('api_error')
    expect(classifyAgyError('request blocked by corporate proxy')).toBe('api_error')
  })
})

describe('runAgyLoop + createInterpreter end to end (fake agy subprocess + real localhost MCP)', () => {
  it('reads prompt over stdin (never argv), runs tool calls over localhost MCP, cleans up workspace and appData conversation', async () => {
    const t = createTestContext()
    const fakeAppData = await mkdtemp(join(tmpdir(), 'family-share-fake-appdata-'))
    const convId = '22222222-3333-4444-5555-666666666666'
    const captured: { cwd?: string; args?: string[] } = {}
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      ${READ_STDIN_PROMPT}
      (async () => {
        const prompt = await readPrompt();
        const mcpCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8'));
        const srv = mcpCfg.mcpServers.family_board;
        const husbandId = /- (m_\\w+) \\| 老公/.exec(prompt)[1];
        // Simulate agy writing conversation state to appData
        fs.mkdirSync(path.join(${JSON.stringify(fakeAppData)}, 'brain', ${JSON.stringify(convId)}), { recursive: true });
        fs.mkdirSync(path.join(${JSON.stringify(fakeAppData)}, 'conversations'), { recursive: true });
        fs.writeFileSync(path.join(${JSON.stringify(fakeAppData)}, 'conversations', ${JSON.stringify(`${convId}.db`)}), 'persisted');
        const post = async (body) => {
          const r = await fetch(srv.serverUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...srv.headers },
            body: JSON.stringify(body),
          });
          return r.status === 202 ? null : r.json();
        };
        await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
        await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        if (list.result.tools.length !== 11) throw new Error('expected 11 tools');
        const call = await post({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'send_request',
            arguments: { to_member_id: husbandId, title: '买牛奶', due_date: '2026-10-22', due_time: '18:30', priority: 'normal', allow_duplicate: false },
          },
        });
        if (call.result.isError) throw new Error('tool call failed: ' + call.result.content[0].text);
        console.log(JSON.stringify({ event: 'init', conversation_id: ${JSON.stringify(convId)}, init: { model: 'gemini-4-neon-medium' } }));
        console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(convId)}, step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 3100, output_tokens: 120, cache_read_tokens: 0 } } }));
        console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(convId)}, step_index: 3, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 2100, output_tokens: 45, cache_read_tokens: 1500 } } }));
        // Last line without trailing newline: verifies waiting on 'close' never drops it
        process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: ${JSON.stringify(convId)}, status: 'SUCCESS', response: '好的，已请老公明天 18:30 买牛奶，等他确认。' } }));
      })().catch(e => { console.error(e); process.exit(1); });
    `

    try {
      const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
      const interpreter = createInterpreter({
        config,
        domain: t.domain,
        clock: t.clock,
        agyRunner: args => runAgyLoop({ ...args, appDataDir: fakeAppData, spawnImpl: fakeAgySpawn(fakeScript, captured) }),
      })

      expect(interpreter.enabled).toBe(true)
      const r = await interpreter.interpret({ memberId: t.wife.id, text: '让老公明天下班顺路买牛奶', source: 'voice', visibility: 'private' })

      expect(r.utterance).toMatchObject({
        memberId: t.wife.id,
        source: 'voice',
        visibility: 'private',
        status: 'done',
        reply: '好的，已请老公明天 18:30 买牛奶，等他确认。',
        error: null,
      })
      expect(r.utterance.changes).toEqual([expect.objectContaining({ type: 'request_sent', itemTitle: '买牛奶' })])
      expect(r.items[0]).toMatchObject({ kind: 'request', status: 'pending', ownerId: t.husband.id, requestedBy: t.wife.id, dueAt: '2026-10-22T07:30:00.000Z' })

      // Private utterance text must NEVER appear in process argv (visible to ps)
      expect(captured.args?.join(' ')).not.toContain('买牛奶')
      expect(captured.args).not.toContain('--dangerously-skip-permissions')
      expect(captured.args).toContain('--sandbox')

      const row = t.db.prepare('SELECT model, usage FROM utterances WHERE id = ?').get(r.utterance.id) as { model: string; usage: string }
      expect(row.model).toBe('gemini-4-neon-medium')
      expect(JSON.parse(row.usage)).toMatchObject({
        provider: 'agy',
        requestedModel: 'gemini-4-neon',
        effort: 'medium',
        tools: [{ name: 'send_request', ok: true }],
        totals: { inputTokens: 5200, outputTokens: 165, cacheReadTokens: 1500, cacheWriteTokens: 0 },
      })
      // Isolated temp workspace AND agy's persisted conversation files must both be deleted
      expect(existsSync(captured.cwd!)).toBe(false)
      expect(existsSync(join(fakeAppData, 'brain', convId))).toBe(false)
      expect(existsSync(join(fakeAppData, 'conversations', `${convId}.db`))).toBe(false)
    } finally {
      await rm(fakeAppData, { recursive: true, force: true })
    }
  })

  it('stops agy when the next model response starts after ask_clarification and preserves the question if a follow-up hangs', async () => {
    const t = createTestContext()
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      ${READ_STDIN_PROMPT}
      (async () => {
        await readPrompt();
        const srv = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.family_board;
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 2000, output_tokens: 60 } } }));
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'mcp_family_board_ask_clarification' } }));
        await fetch(srv.serverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...srv.headers },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'ask_clarification', arguments: { question: '是哪一个弄好了？', options: ['修柜门', '装窗帘'] } },
          }),
        });
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'mcp_family_board_ask_clarification' } }));
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '是哪一个' } }));
        // Even if the 2nd response hangs, stopWith('clarified') stops it promptly and returns the question.
        setInterval(() => {}, 1000);
      })().catch(e => { console.error(e); process.exit(1); });
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      deadlineMs: 10_000,
      agyRunner: args => runAgyLoop({ ...args, spawnImpl: fakeAgySpawn(fakeScript) }),
    })
    const t0 = Date.now()
    const r = await interpreter.interpret({ memberId: t.husband.id, text: '那个弄好了', source: 'voice' })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.utterance).toMatchObject({
      status: 'clarify',
      reply: '是哪一个弄好了？',
      clarification: { question: '是哪一个弄好了？', options: ['修柜门', '装窗帘'] },
    })
  })

  it('mixed ask_clarification + slow sibling create_item (120 ms later) cancels the question so nothing is silently dropped', async () => {
    const t = createTestContext()
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      ${READ_STDIN_PROMPT}
      (async () => {
        await readPrompt();
        const srv = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.family_board;
        const call = (id, name, args) => fetch(srv.serverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...srv.headers },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        }).then(r => r.json());
        // Round 1: ask_clarification finishes first, then a slow sibling create_item arrives 120 ms later (simulating guard hook startup)
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1000, output_tokens: 40 } } }));
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'mcp_family_board_ask_clarification' } }));
        await call(1, 'ask_clarification', { question: '柜子是哪一个？', options: ['卖旧柜子', '修柜门'] });
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'mcp_family_board_ask_clarification' } }));
        await new Promise(r => setTimeout(r, 120));
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'mcp_family_board_create_item' } }));
        const sib = await call(2, 'create_item', { kind: 'task', title: '交水费', explicit_assignment: false, priority: 'normal', allow_duplicate: false });
        if (!sib.result.isError) throw new Error('sibling create_item should have been rejected');
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'mcp_family_board_create_item' } }));
        // Round 2: model sees the error and applies create_item first
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1200, output_tokens: 40 } } }));
        const created = await call(3, 'create_item', { kind: 'task', title: '交水费', explicit_assignment: false, priority: 'normal', allow_duplicate: false });
        if (created.result.isError) throw new Error('round 2 create_item should succeed');
        // Round 3: model asks clarification alone
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 6, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1300, output_tokens: 40 } } }));
        await call(4, 'ask_clarification', { question: '水费记好了。柜子是哪一个？', options: ['卖旧柜子', '修柜门'] });
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '水费记好了。柜子是哪一个？' } }));
      })().catch(e => { console.error(e); process.exit(1); });
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      agyRunner: args => runAgyLoop({ ...args, spawnImpl: fakeAgySpawn(fakeScript) }),
    })
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '记得交水费，还有柜子改一下', source: 'text' })
    expect(r.utterance.status).toBe('clarify')
    expect(r.utterance.clarification).toEqual({ question: '水费记好了。柜子是哪一个？', options: ['卖旧柜子', '修柜门'] })
    expect(t.domain.listActiveItems().map(i => i.title)).toEqual(['交水费'])
  })

  it('disables the agy backend fail-closed if MCP tool calls ran without the PreToolUse guard hook firing', async () => {
    const t = createTestContext()
    let spawns = 0
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      ${READ_STDIN_PROMPT}
      (async () => {
        await readPrompt();
        const srv = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.family_board;
        await fetch(srv.serverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...srv.headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_items', arguments: { query: '牛奶', include_closed: true } } }),
        });
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '没有找到。' } }));
      })();
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      agyRunner: args => {
        spawns++
        return runAgyLoop({ ...args, verifyGuard: true, spawnImpl: fakeAgySpawn(fakeScript) })
      },
    })
    expect(interpreter.enabled).toBe(true)
    const first = await interpreter.interpret({ memberId: t.wife.id, text: '牛奶呢', source: 'text' })
    expect(first.utterance).toMatchObject({ status: 'error', error: REPLIES.misconfigured })
    expect(interpreter.enabled).toBe(false)
    expect(spawns).toBe(1)

    // Subsequent utterance refuses to spawn agy at all
    const second = await interpreter.interpret({ memberId: t.wife.id, text: '明天买菜', source: 'text' })
    expect(second.utterance).toMatchObject({ status: 'error', error: REPLIES.misconfigured })
    expect(spawns).toBe(1)
  })

  it('does not hang forever if a grandchild process keeps stdout open after agy exits', async () => {
    const t = createTestContext()
    const fakeScript = `
      const { spawn } = require('node:child_process');
      ${READ_STDIN_PROMPT}
      (async () => {
        await readPrompt();
        // Spawn a grandchild inheriting stdout/stderr that stays open for 5 s, then exit immediately
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 1, 2], detached: true });
        child.unref();
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '收到。' } }));
        process.exit(0);
      })();
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      agyRunner: args => runAgyLoop({ ...args, closeGraceMs: 100, spawnImpl: fakeAgySpawn(fakeScript) }),
    })
    const t0 = Date.now()
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '你好', source: 'text' })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r.utterance).toMatchObject({ status: 'done', reply: '收到。' })
  })

  it('reports retryable RESOURCE_EXHAUSTED as busy, and non-retryable quota exhaustion as agySpendLimit', async () => {
    const t = createTestContext()
    const runWithErr = async (agyErr: Record<string, unknown>) => {
      const fakeScript = `
        ${READ_STDIN_PROMPT}
        (async () => {
          await readPrompt();
          console.error('AGY_ERROR: ' + ${JSON.stringify(JSON.stringify(agyErr))});
          console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: ${JSON.stringify(String(agyErr.short_error))} } }));
          process.exit(3);
        })();
      `
      const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
      const interpreter = createInterpreter({
        config,
        domain: t.domain,
        clock: t.clock,
        agyRunner: args => runAgyLoop({ ...args, spawnImpl: fakeAgySpawn(fakeScript) }),
      })
      return interpreter.interpret({ memberId: t.wife.id, text: '明天买牛奶', source: 'text' })
    }

    const burst = await runWithErr({ short_error: 'RESOURCE_EXHAUSTED: rate limit', status: 'RESOURCE_EXHAUSTED', retryable: true })
    expect(burst.utterance).toMatchObject({ status: 'error', error: REPLIES.busy, reply: REPLIES.busy })

    const quota = await runWithErr({ short_error: 'RESOURCE_EXHAUSTED: daily quota exhausted', status: 'RESOURCE_EXHAUSTED', retryable: false })
    expect(quota.utterance).toMatchObject({ status: 'error', error: REPLIES.agySpendLimit, reply: REPLIES.agySpendLimit })
    expect(quota.utterance.error).not.toContain('Anthropic')
  })

  it('enforces maxIterations strictly (never running a 3rd model call or post-cap mutation when maxIterations=2)', async () => {
    const t = createTestContext()
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      ${READ_STDIN_PROMPT}
      (async () => {
        await readPrompt();
        const srv = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.family_board;
        const call = (id, name, args) => fetch(srv.serverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...srv.headers },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        }).then(r => r.json()).catch(() => null);
        // Model call 1 -> search_items (allowed)
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1000, output_tokens: 20 } } }));
        await call(1, 'search_items', { query: '牛奶', include_closed: true });
        // Model call 2 finishes -> tries to call create_item (which would require call 3!) -> MUST be rejected!
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1000, output_tokens: 20 } } }));
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'mcp_family_board_create_item' } }));
        await call(2, 'create_item', { kind: 'task', title: '越界事项', explicit_assignment: false, priority: 'normal', allow_duplicate: false });
        setInterval(() => {}, 1000);
      })().catch(() => {});
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 2 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      agyRunner: args => runAgyLoop({ ...args, spawnImpl: fakeAgySpawn(fakeScript) }),
    })
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '查一下牛奶', source: 'text' })
    expect(r.utterance.status).toBe('error')
    expect(t.domain.listActiveItems()).toEqual([])
    const usage = JSON.parse((t.db.prepare('SELECT usage FROM utterances WHERE id = ?').get(r.utterance.id) as { usage: string }).usage)
    expect(usage.calls).toHaveLength(2)
    expect(usage.error.code).toBe('iteration_cap')
  })

  it('kills a hanging agy process at the deadline, preserves earlier changes, and blocks late mutations during shutdown', async () => {
    const t = createTestContext()
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      ${READ_STDIN_PROMPT}
      (async () => {
        await readPrompt();
        const srv = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.family_board;
        const post = (id, title) => fetch(srv.serverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...srv.headers },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'create_item', arguments: { kind: 'task', title, explicit_assignment: false, priority: 'normal', allow_duplicate: false } },
          }),
        }).catch(() => null);
        // Trap SIGTERM and try to slip in a late board mutation during shutdown!
        process.on('SIGTERM', async () => {
          await post(2, '超时后的偷渡事项');
          process.exit(0);
        });
        await post(1, '买牛奶');
        setInterval(() => {}, 1000);
      })();
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      deadlineMs: 300,
      agyRunner: args => runAgyLoop({ ...args, spawnImpl: fakeAgySpawn(fakeScript) }),
    })
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '记一下买牛奶', source: 'text' })
    expect(r.utterance.status).toBe('error')
    expect(r.utterance.changes.map(c => c.type)).toEqual(['item_created'])
    expect(t.domain.listActiveItems().map(i => i.title)).toEqual(['买牛奶'])
    const usage = JSON.parse((t.db.prepare('SELECT usage FROM utterances WHERE id = ?').get(r.utterance.id) as { usage: string }).usage)
    expect(usage.error.code).toBe('timeout')
  })

  it('stops a running agy process when the utterance is undone mid-turn', async () => {
    const t = createTestContext()
    let undone = false
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      ${READ_STDIN_PROMPT}
      (async () => {
        await readPrompt();
        const srv = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.family_board;
        const call = async (id, title) => fetch(srv.serverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...srv.headers },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'create_item', arguments: { kind: 'task', title, explicit_assignment: false, priority: 'normal', allow_duplicate: false } },
          }),
        });
        await call(1, '买地毯');
        await new Promise(r => setTimeout(r, 80));
        await call(2, '买窗帘');
        setInterval(() => {}, 1000);
      })().catch(() => {});
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      agyRunner: args =>
        runAgyLoop({
          ...args,
          execute: (call, id) => {
            const out = args.execute(call, id)
            if (!undone) {
              undone = true
              const u = t.domain.recentUtterances(1)[0]!
              t.domain.undoUtterance(t.as(t.wife), u.id)
            }
            return out
          },
          spawnImpl: fakeAgySpawn(fakeScript),
        }),
    })
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '买地毯和窗帘', source: 'text' })
    expect(r.utterance.status).toBe('undone')
    expect(t.domain.listActiveItems()).toHaveLength(0)
  })

  it('handles missing agy binary (ENOENT) without throwing', async () => {
    const t = createTestContext()
    const config = testConfig({
      familyTimezone: t.family.timezone,
      ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 },
      agy: { path: '/nonexistent/path/to/agy-binary-missing' },
    })
    const interpreter = createInterpreter({ config, domain: t.domain, clock: t.clock })
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '明天买牛奶', source: 'text' })
    expect(r.utterance).toMatchObject({ status: 'error', error: REPLIES.misconfigured })
  })

  it('supports eval harness runCaseWithAgy', async () => {
    const c = CASES.find(x => x.id === 'request-milk-after-work')!
    const run = await runCaseWithAgy(
      c,
      { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 },
      { path: 'agy' },
      {
        agyRunner: async a => {
          const husbandId = /- (m_\w+) \| 老公/.exec(a.turnInput)![1]!
          const out = await a.execute(
            { name: 'send_request', input: { to_member_id: husbandId, title: '买牛奶', due_date: '2026-10-22', due_time: '18:30', priority: 'normal', allow_duplicate: false } },
            'mcp_1',
          )
          return {
            status: 'done',
            reply: '好的，已请老公明天 18:30 下班顺路买牛奶，等他确认。',
            usage: [{ model: 'gemini-4-neon-medium', stopReason: 'agent_response', inputTokens: 2000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, servedByFallback: false, requestId: 'c_eval' }],
            toolCalls: [{ id: 'mcp_1', name: 'send_request', input: { to_member_id: husbandId, title: '买牛奶', due_date: '2026-10-22', due_time: '18:30', priority: 'normal', allow_duplicate: false }, ok: out.ok }],
          }
        },
      },
    )
    expect(run.failures).toEqual([])
    expect(run.costUsd).toBe(0)
    expect(run.calls).toEqual([expect.objectContaining({ name: 'send_request', result: 'ok' })])
  })
})
