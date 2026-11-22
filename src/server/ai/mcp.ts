// Ephemeral localhost Streamable HTTP MCP server for one utterance turn.
//
// Exposes the 11 board tools from ./tools over JSON-RPC 2.0 (MCP Streamable HTTP transport) on
// 127.0.0.1:0 with a per-turn Bearer secret. Every tool call runs through parseToolCall + executeCall
// in the server process, so domain rules, undo events, touched item tracking and cancellation checks
// work identically to the direct Anthropic loop.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Clarification } from '../../shared/types'
import { newSecret } from '../ids'
import type { ToolCallRecord, ToolOutcomeLike } from './loop'
import { type BoardCall, parseToolCall, TOOLS } from './tools'

export const MCP_SERVER_NAME = 'family_board'
export const MCP_PATH = '/mcp'
export const MCP_PROTOCOL_VERSION = '2025-11-25'
const MAX_BODY_BYTES = 1024 * 1024

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Single source of truth: derived directly from TOOLS in ./tools. */
export const MCP_TOOLS: readonly McpToolDefinition[] = TOOLS.map(t => ({
  name: t.name,
  description: t.description ?? '',
  inputSchema: t.input_schema as unknown as Record<string, unknown>,
}))

export interface McpTurnSessionOptions {
  execute: (call: BoardCall, toolUseId: string) => ToolOutcomeLike | Promise<ToolOutcomeLike>
  isCancelled?: () => boolean
  /** Called when a tool call discovers the utterance was undone so the runner can stop agy promptly. */
  onCancel?: () => void
  /** Hard safety cap on total MCP tool calls in a single utterance. */
  maxToolCalls?: number
}

export interface McpTurnSession {
  readonly sessionId: string
  readonly toolCalls: ToolCallRecord[]
  clarification: Clarification | null
  cancelled: boolean
  readonly execute: McpTurnSessionOptions['execute']
  readonly isCancelled?: () => boolean
  readonly onCancel?: () => void
  readonly maxToolCalls: number
  nextCallSeq: number
}

export function createMcpTurnSession(opts: McpTurnSessionOptions): McpTurnSession {
  return {
    sessionId: newSecret(),
    toolCalls: [],
    clarification: null,
    cancelled: false,
    execute: opts.execute,
    isCancelled: opts.isCancelled,
    onCancel: opts.onCancel,
    maxToolCalls: opts.maxToolCalls ?? 24,
    nextCallSeq: 1,
  }
}

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  params?: Record<string, unknown>
}

export interface McpRpcResponse {
  status: number
  body?: Record<string, unknown>
}

function rpcResult(id: string | number | null, result: Record<string, unknown>): McpRpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } }
}

function rpcError(id: string | number | null, code: number, message: string, httpStatus = 200): McpRpcResponse {
  return { status: httpStatus, body: { jsonrpc: '2.0', id, error: { code, message } } }
}

function mcpToolResult(payload: Record<string, unknown>, isError: boolean): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError,
  }
}

/** Pure JSON-RPC 2.0 handler for MCP messages (tested directly without sockets). */
export async function handleMcpJsonRpc(raw: unknown, session: McpTurnSession): Promise<McpRpcResponse> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return rpcError(null, -32600, 'Invalid Request', 400)
  }
  const msg = raw as JsonRpcRequest
  const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined
  const id = (msg.id ?? null) as string | number | null
  if (typeof msg.method !== 'string') {
    return hasId ? rpcError(id, -32600, 'Invalid Request: missing method', 400) : { status: 202 }
  }
  // Notifications carry no id and expect 202 Accepted with an empty body.
  if (!hasId) {
    return { status: 202 }
  }

  switch (msg.method) {
    case 'initialize': {
      const requestedVersion = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : MCP_PROTOCOL_VERSION
      return rpcResult(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '0.1.0' },
      })
    }

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS })

    case 'tools/call':
      return handleToolCall(id, msg.params, session)

    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`)
  }
}

async function handleToolCall(
  id: string | number | null,
  params: Record<string, unknown> | undefined,
  session: McpTurnSession,
): Promise<McpRpcResponse> {
  const name = typeof params?.name === 'string' ? params.name : ''
  const rawArgs = params?.arguments ?? {}
  const callId = `mcp_${session.nextCallSeq++}`

  const fail = (code: string, message: string, extra?: Record<string, unknown>, record = true): McpRpcResponse => {
    if (record) session.toolCalls.push({ id: callId, name: name || 'unknown', input: rawArgs, ok: false, code })
    return rpcResult(id, mcpToolResult({ ok: false, code, message, ...(extra ?? {}) }, true))
  }

  if (session.cancelled || session.isCancelled?.()) {
    session.cancelled = true
    session.onCancel?.()
    return fail('cancelled', 'Utterance was undone by the speaker. Do not call more tools; stop now.')
  }

  if (session.clarification) {
    return fail(
      'clarification_pending',
      'A clarification question has already been recorded for the speaker. Do not call any more tools; end your turn now.',
    )
  }

  if (session.toolCalls.length >= session.maxToolCalls) {
    return fail('iteration_cap', 'Maximum tool calls reached for this utterance. Stop calling tools and give a brief summary.')
  }

  const parsed = parseToolCall(name, rawArgs)
  if (!parsed.ok) {
    return fail('invalid_input', parsed.message)
  }

  if (parsed.call.name === 'ask_clarification') {
    const options = [...new Set(parsed.call.input.options.map(o => o.trim()).filter(Boolean))].slice(0, 4)
    session.clarification = { question: parsed.call.input.question.trim(), options }
    session.toolCalls.push({ id: callId, name: 'ask_clarification', input: parsed.call.input, ok: true })
    return rpcResult(
      id,
      mcpToolResult(
        {
          ok: true,
          recorded: true,
          question: session.clarification.question,
          options: session.clarification.options,
          message: 'Question recorded for the speaker. Do NOT call any more tools; reply with the question text to end your turn.',
        },
        false,
      ),
    )
  }

  let out: ToolOutcomeLike
  try {
    out = await session.execute(parsed.call, callId)
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e))
  }

  if (!out.ok) {
    return fail(out.code, out.message, out.extra)
  }

  session.toolCalls.push({ id: callId, name: parsed.call.name, input: parsed.call.input, ok: true })
  return rpcResult(id, mcpToolResult({ ok: true, ...out.result }, false))
}

function bearerMatches(header: string | undefined, expectedToken: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice('Bearer '.length))
  const want = Buffer.from(expectedToken)
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (res: { ok: true; text: string } | { ok: false; tooLarge: boolean }) => {
      if (done) return
      done = true
      resolve(res)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        finish({ ok: false, tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => finish({ ok: false, tooLarge: false }))
  })
}

export interface McpServerHandle {
  readonly url: string
  readonly token: string
  close(): Promise<void>
}

/** Starts an ephemeral localhost HTTP server serving Streamable HTTP MCP for one turn. */
export async function startMcpServer(session: McpTurnSession): Promise<McpServerHandle> {
  const token = newSecret()
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttp(req, res, token, session)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const addr = server.address() as AddressInfo
  const url = `http://127.0.0.1:${addr.port}${MCP_PATH}`
  let closed = false
  return {
    url,
    token,
    close: () =>
      new Promise<void>(resolve => {
        if (closed) {
          resolve()
          return
        }
        closed = true
        server.close(() => resolve())
        if ('closeAllConnections' in server) server.closeAllConnections()
      }),
  }
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, token: string, session: McpTurnSession): Promise<void> {
  const path = (req.url ?? '').split('?')[0]
  if (path !== MCP_PATH) {
    res.writeHead(404).end()
    return
  }
  if (!bearerMatches(req.headers.authorization, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  if (req.method === 'DELETE') {
    res.writeHead(204).end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }

  const body = await readBody(req, MAX_BODY_BYTES)
  if (!body.ok) {
    res.writeHead(body.tooLarge ? 413 : 400).end()
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    const err = rpcError(null, -32700, 'Parse error', 400)
    res.writeHead(err.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(err.body))
    return
  }

  const out = await handleMcpJsonRpc(parsed, session)
  const headers: Record<string, string> = { 'Mcp-Session-Id': session.sessionId }
  if (out.body) {
    headers['Content-Type'] = 'application/json'
    res.writeHead(out.status, headers).end(JSON.stringify(out.body))
  } else {
    res.writeHead(out.status, headers).end()
  }
}
