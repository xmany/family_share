// Tests for the ephemeral localhost Streamable HTTP MCP server (pure JSON-RPC + real HTTP transport).
import { describe, expect, it } from 'vitest'
import { createMcpTurnSession, handleMcpJsonRpc, MCP_PATH, MCP_SERVER_NAME, MCP_TOOLS, startMcpServer } from './mcp'
import { TOOLS } from './tools'

const MILK_ITEM = 'i_abcdefghij'

describe('MCP JSON-RPC handler', () => {
  it('exposes all 11 board tools from TOOLS as a single source of truth', () => {
    expect(MCP_TOOLS.map(t => t.name)).toEqual(TOOLS.map(t => t.name))
    expect(MCP_TOOLS).toHaveLength(11)
  })

  it('handles initialize, notifications/initialized, ping, tools/list and unknown methods', async () => {
    const session = createMcpTurnSession({ execute: () => ({ ok: true, result: {} }) })

    const init = await handleMcpJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      session,
    )
    expect(init.status).toBe(200)
    expect(init.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '0.1.0' },
      },
    })

    const notif = await handleMcpJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, session)
    expect(notif).toEqual({ status: 202 })

    const ping = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, session)
    expect(ping.body).toEqual({ jsonrpc: '2.0', id: 2, result: {} })

    const list = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, session)
    expect((list.body?.result as { tools: unknown[] }).tools).toHaveLength(11)

    // agy probes server/discover before initialize; returning -32601 makes it fall back cleanly.
    const discover = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 4, method: 'server/discover' }, session)
    expect(discover.body).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32601, message: 'Method not found: server/discover' },
    })
  })

  it('validates tool inputs with Zod, invokes execute, and reports executor errors as isError', async () => {
    const ran: Array<{ name: string; input: unknown }> = []
    const session = createMcpTurnSession({
      execute: call => {
        ran.push({ name: call.name, input: call.input })
        if (call.name === 'add_note') return { ok: false, code: 'not_found', message: '找不到这个事项' }
        return { ok: true, result: { item: { id: MILK_ITEM, title: '买牛奶' } } }
      },
    })

    // invalid input never reaches execute
    const bad = await handleMcpJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'complete_item', arguments: { item_id: 'bad', resolution: 'done' } } },
      session,
    )
    const badRes = bad.body!.result as { isError: boolean; content: Array<{ text: string }> }
    expect(badRes.isError).toBe(true)
    expect(JSON.parse(badRes.content[0]!.text)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(ran).toHaveLength(0)

    // valid call succeeds
    const ok = await handleMcpJsonRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'create_item',
          arguments: { kind: 'task', title: '买牛奶', explicit_assignment: false, priority: 'normal', allow_duplicate: false },
        },
      },
      session,
    )
    const okRes = ok.body!.result as { isError: boolean; content: Array<{ text: string }> }
    expect(okRes.isError).toBe(false)
    expect(JSON.parse(okRes.content[0]!.text)).toMatchObject({ ok: true, item: { id: MILK_ITEM } })
    expect(ran).toHaveLength(1)

    // domain failure surfaces as isError
    const nf = await handleMcpJsonRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_note', arguments: { item_id: MILK_ITEM, text: '两盒' } } },
      session,
    )
    const nfRes = nf.body!.result as { isError: boolean; content: Array<{ text: string }> }
    expect(nfRes.isError).toBe(true)
    expect(JSON.parse(nfRes.content[0]!.text)).toEqual({ ok: false, code: 'not_found', message: '找不到这个事项' })

    expect(session.toolCalls.map(c => [c.name, c.ok, c.code])).toEqual([
      ['complete_item', false, 'invalid_input'],
      ['create_item', true, undefined],
      ['add_note', false, 'not_found'],
    ])
  })

  it('catches thrown exceptions from execute and returns internal isError', async () => {
    const session = createMcpTurnSession({
      execute: () => {
        throw new Error('db locked')
      },
    })
    const res = await handleMcpJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_note', arguments: { item_id: MILK_ITEM, text: 'hi' } } },
      session,
    )
    const out = res.body!.result as { isError: boolean; content: Array<{ text: string }> }
    expect(out.isError).toBe(true)
    expect(JSON.parse(out.content[0]!.text)).toEqual({ ok: false, code: 'internal', message: 'db locked' })
  })

  it('records ask_clarification (trimming/deduping options to 4) and blocks later tool calls', async () => {
    const ran: string[] = []
    const session = createMcpTurnSession({
      execute: c => {
        ran.push(c.name)
        return { ok: true, result: {} }
      },
    })

    const ask = await handleMcpJsonRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ask_clarification', arguments: { question: ' 哪一个？ ', options: ['修柜门', ' ', '修柜门', '装窗帘', 'a', 'b', 'c'] } },
      },
      session,
    )
    const askRes = ask.body!.result as { isError: boolean; content: Array<{ text: string }> }
    expect(askRes.isError).toBe(false)
    expect(session.clarification).toEqual({ question: '哪一个？', options: ['修柜门', '装窗帘', 'a', 'b'] })

    const after = await handleMcpJsonRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'create_item', arguments: { kind: 'task', title: '买牛奶', explicit_assignment: false, priority: 'normal', allow_duplicate: false } },
      },
      session,
    )
    const afterRes = after.body!.result as { isError: boolean; content: Array<{ text: string }> }
    expect(afterRes.isError).toBe(true)
    expect(JSON.parse(afterRes.content[0]!.text)).toMatchObject({ ok: false, code: 'clarification_pending' })
    expect(ran).toEqual([])
  })

  it('rejects calls when cancelled and triggers onCancel', async () => {
    let cancelHookFired = false
    const session = createMcpTurnSession({
      execute: () => ({ ok: true, result: {} }),
      isCancelled: () => true,
      onCancel: () => {
        cancelHookFired = true
      },
    })
    const res = await handleMcpJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_items', arguments: { query: '牛奶', include_closed: false } } },
      session,
    )
    const out = res.body!.result as { isError: boolean; content: Array<{ text: string }> }
    expect(out.isError).toBe(true)
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(cancelHookFired).toBe(true)
    expect(session.cancelled).toBe(true)
  })
})

describe('MCP HTTP transport', () => {
  it('enforces Bearer auth, path, HTTP verbs and JSON-RPC over 127.0.0.1', async () => {
    const session = createMcpTurnSession({ execute: () => ({ ok: true, result: { count: 0, items: [] } }) })
    const server = await startMcpServer(session)
    try {
      const origin = server.url.slice(0, -MCP_PATH.length)
      // unknown paths (e.g. OAuth discovery probe) return 404
      expect((await fetch(`${origin}/.well-known/oauth-protected-resource`)).status).toBe(404)
      // missing or wrong Bearer token returns 401
      expect((await fetch(server.url, { method: 'POST', body: '{}' })).status).toBe(401)
      expect((await fetch(server.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401)

      const auth = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }
      // GET -> 405, DELETE -> 204
      expect((await fetch(server.url, { method: 'GET', headers: auth })).status).toBe(405)
      expect((await fetch(server.url, { method: 'DELETE', headers: auth })).status).toBe(204)
      // malformed JSON -> 400
      expect((await fetch(server.url, { method: 'POST', headers: auth, body: '{bad' })).status).toBe(400)

      // valid tools/call round trip
      const r = await fetch(server.url, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'search_items', arguments: { query: '牛奶', include_closed: true } },
        }),
      })
      expect(r.status).toBe(200)
      expect(r.headers.get('mcp-session-id')).toBe(session.sessionId)
      const json = (await r.json()) as { result: { isError: boolean; content: Array<{ text: string }> } }
      expect(json.result.isError).toBe(false)
      expect(JSON.parse(json.result.content[0]!.text)).toEqual({ ok: true, count: 0, items: [] })
    } finally {
      await server.close()
    }
  })
})
