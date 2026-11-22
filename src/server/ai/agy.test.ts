// Tests for the headless `agy` CLI (Gemini 4 Neon + MCP) backend.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGY_DEFAULT_MODEL, loadConfig, testConfig } from '../config'
import { createTestContext } from '../testing'
import {
  AGY_AGENT_NAME,
  AgyStreamParser,
  agyConfigFrom,
  buildAgyArgs,
  classifyAgyError,
  extractAgyStderrError,
  hasEffortSuffix,
  renderAgentMarkdown,
  renderGuardHookScript,
  renderMcpConfig,
  runAgyLoop,
  type AgySpawnImpl,
} from './agy'
import { CASES } from './eval/cases'
import { runCaseWithAgy } from './eval/harness'
import { createInterpreter, REPLIES } from './index'
import { MCP_SERVER_NAME, MCP_TOOLS } from './mcp'
import { SYSTEM_PROMPT } from './prompt'

/** Builds a spawnImpl that runs inline Node JS in place of `agy`, receiving `(cwd, agyArgs)`. */
function fakeAgySpawn(scriptSource: string, captured: { cwd?: string; args?: string[] } = {}): AgySpawnImpl {
  return (_cmd, args, opts) => {
    captured.cwd = opts.cwd
    captured.args = args
    return spawn(process.execPath, ['-e', scriptSource, '--', ...args], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  }
}

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

describe('agy CLI arg builder, workspace templates and PreToolUse guard', () => {
  it('passes --effort for base models and omits it when the model already has an effort suffix', () => {
    const baseCfg = agyConfigFrom(testConfig({ ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'high', maxIterations: 6 } }), 60_000)
    const baseArgs = buildAgyArgs(baseCfg, '- leading dash\nhello\0world')
    expect(baseArgs).toContain('--agent')
    expect(baseArgs).toContain(AGY_AGENT_NAME)
    expect(baseArgs).toContain('--model')
    expect(baseArgs).toContain('gemini-4-neon')
    expect(baseArgs).toContain('--effort')
    expect(baseArgs).toContain('high')
    expect(baseArgs).toContain('--print=- leading dash\nhelloworld')
    expect(baseArgs).toContain('--disable-slash-commands')
    expect(baseArgs).toContain('--dangerously-skip-permissions')
    expect(baseArgs).toContain('--print-timeout')
    expect(baseArgs).toContain('60s')

    const suffixed = agyConfigFrom(testConfig({ ai: { provider: 'agy', model: 'gemini-4-neon-xhigh', effort: 'medium', maxIterations: 6 } }))
    expect(hasEffortSuffix('gemini-4-neon-xhigh')).toBe(true)
    expect(hasEffortSuffix('gemini-4-neon')).toBe(false)
    expect(buildAgyArgs(suffixed, 'hi')).not.toContain('--effort')
  })

  it('marks all 11 board tools as eager in mcp_config.json and embeds SYSTEM_PROMPT in the agent', () => {
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

  it('PreToolUse guard hook allows only our 11 family_board MCP tools and denies everything else (fail-closed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'family-share-guard-test-'))
    try {
      const guardPath = join(dir, 'guard.mjs')
      await writeFile(guardPath, renderGuardHookScript())
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
    } finally {
      await rm(dir, { recursive: true, force: true })
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

  it('extracts AGY_ERROR from stderr and classifies common failures', () => {
    expect(extractAgyStderrError('noise\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED: quota exceeded"}\n')).toBe('RESOURCE_EXHAUSTED: quota exceeded')
    expect(classifyAgyError('RESOURCE_EXHAUSTED: quota exceeded')).toBe('spend_limit')
    expect(classifyAgyError('429 rate limit exceeded')).toBe('rate_limited')
    expect(classifyAgyError('503 service unavailable')).toBe('overloaded')
    expect(classifyAgyError('UNAUTHENTICATED: not logged in')).toBe('auth')
    expect(classifyAgyError('unknown model "gemini-99"')).toBe('model_not_found')
    expect(classifyAgyError('DEADLINE_EXCEEDED: timed out')).toBe('timeout')
    expect(classifyAgyError('ECONNRESET')).toBe('network')
    expect(classifyAgyError('safety policy blocked')).toBe('refusal')
  })
})

describe('runAgyLoop + createInterpreter end to end (fake agy subprocess + real localhost MCP)', () => {
  it('runs a full tool-calling turn over localhost MCP, records usage, and cleans up the temp workspace', async () => {
    const t = createTestContext()
    const captured: { cwd?: string; args?: string[] } = {}
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      (async () => {
        const mcpCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8'));
        const srv = mcpCfg.mcpServers.family_board;
        const promptArg = process.argv.find(a => a.startsWith('--print='));
        const husbandId = /- (m_\\w+) \\| 老公/.exec(promptArg)[1];
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
        console.log(JSON.stringify({ event: 'init', conversation_id: 'c_1', init: { model: 'gemini-4-neon-medium' } }));
        console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c_1', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 3100, output_tokens: 120, cache_read_tokens: 0 } } }));
        console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c_1', step_index: 3, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 2100, output_tokens: 45, cache_read_tokens: 1500 } } }));
        console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c_1', status: 'SUCCESS', response: '好的，已请老公明天 18:30 买牛奶，等他确认。' } }));
      })().catch(e => { console.error(e); process.exit(1); });
    `

    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      agyRunner: args => runAgyLoop({ ...args, spawnImpl: fakeAgySpawn(fakeScript, captured) }),
    })

    expect(interpreter.enabled).toBe(true)
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '让老公明天下班顺路买牛奶', source: 'voice' })

    expect(r.utterance).toMatchObject({
      memberId: t.wife.id,
      source: 'voice',
      status: 'done',
      reply: '好的，已请老公明天 18:30 买牛奶，等他确认。',
      error: null,
    })
    expect(r.utterance.changes).toEqual([expect.objectContaining({ type: 'request_sent', itemTitle: '买牛奶' })])
    expect(r.items[0]).toMatchObject({ kind: 'request', status: 'pending', ownerId: t.husband.id, requestedBy: t.wife.id, dueAt: '2026-10-22T07:30:00.000Z' })

    const row = t.db.prepare('SELECT model, usage FROM utterances WHERE id = ?').get(r.utterance.id) as { model: string; usage: string }
    expect(row.model).toBe('gemini-4-neon-medium')
    expect(JSON.parse(row.usage)).toMatchObject({
      provider: 'agy',
      requestedModel: 'gemini-4-neon',
      effort: 'medium',
      tools: [{ name: 'send_request', ok: true }],
      totals: { inputTokens: 5200, outputTokens: 165, cacheReadTokens: 1500, cacheWriteTokens: 0 },
    })
    // isolated temp workspace must be deleted after the turn
    expect(captured.cwd).toBeTruthy()
    expect(existsSync(captured.cwd!)).toBe(false)
  })

  it('ends with status clarify when ask_clarification is called over MCP', async () => {
    const t = createTestContext()
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      (async () => {
        const srv = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.family_board;
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
        console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c_2', status: 'SUCCESS', response: '是哪一个弄好了？' } }));
      })().catch(e => { console.error(e); process.exit(1); });
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      agyRunner: args => runAgyLoop({ ...args, spawnImpl: fakeAgySpawn(fakeScript) }),
    })
    const r = await interpreter.interpret({ memberId: t.husband.id, text: '那个弄好了', source: 'voice' })
    expect(r.utterance).toMatchObject({
      status: 'clarify',
      reply: '是哪一个弄好了？',
      clarification: { question: '是哪一个弄好了？', options: ['修柜门', '装窗帘'] },
    })
  })

  it('uses the provider-neutral quota message when agy reports RESOURCE_EXHAUSTED', async () => {
    const t = createTestContext()
    const fakeScript = `
      console.error('AGY_ERROR: ' + JSON.stringify({ short_error: 'RESOURCE_EXHAUSTED: quota exceeded' }));
      console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota exceeded' } }));
      process.exit(3);
    `
    const config = testConfig({ familyTimezone: t.family.timezone, ai: { provider: 'agy', model: 'gemini-4-neon', effort: 'medium', maxIterations: 6 } })
    const interpreter = createInterpreter({
      config,
      domain: t.domain,
      clock: t.clock,
      agyRunner: args => runAgyLoop({ ...args, spawnImpl: fakeAgySpawn(fakeScript) }),
    })
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '明天买牛奶', source: 'text' })
    expect(r.utterance).toMatchObject({ status: 'error', error: REPLIES.agySpendLimit, reply: REPLIES.agySpendLimit })
    expect(r.utterance.error).not.toContain('Anthropic')
  })

  it('kills a hanging agy process at the utterance deadline and preserves applied changes', async () => {
    const t = createTestContext()
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      (async () => {
        const srv = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')).mcpServers.family_board;
        await fetch(srv.serverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...srv.headers },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'create_item', arguments: { kind: 'task', title: '买牛奶', explicit_assignment: false, priority: 'normal', allow_duplicate: false } },
          }),
        });
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
    expect(r.items.map(i => i.title)).toEqual(['买牛奶'])
    const usage = JSON.parse((t.db.prepare('SELECT usage FROM utterances WHERE id = ?').get(r.utterance.id) as { usage: string }).usage)
    expect(usage.error.code).toBe('timeout')
  })

  it('stops a running agy process when the utterance is undone mid-turn', async () => {
    const t = createTestContext()
    let undone = false
    const fakeScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      (async () => {
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
