// GET /api/stream — Server-Sent Events: `hello`, then every Bus `server_event`, plus `ping` every 25 s.
// Events use the default event name ("message"); data is the ServerEvent JSON.
// The session is re-checked before every event and ping: a revoked or expired session (lost phone,
// `npm run family -- revoke`) ends the stream instead of receiving the family's utterances indefinitely.

import type { ServerEvent } from '../../shared/api'
import type { Bus } from '../bus'
import type { Clock } from '../time'

export const SSE_PING_MS = 25_000

/** Tracks open streams so a graceful shutdown can end them (they would otherwise keep the server open). */
export class StreamRegistry {
  private closers = new Set<() => void>()
  add(close: () => void): () => void {
    this.closers.add(close)
    return () => this.closers.delete(close)
  }
  get size(): number {
    return this.closers.size
  }
  closeAll(): void {
    for (const close of [...this.closers]) close()
    this.closers.clear()
  }
}

const encoder = new TextEncoder()
const frame = (e: ServerEvent) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`)

export function sseResponse(opts: {
  bus: Bus
  clock: Clock
  signal?: AbortSignal
  registry?: StreamRegistry
  pingMs?: number
  headers?: Headers
  /** Re-checked before each event and ping; returning false ends the stream */
  isAuthorized?: () => boolean
}): Response {
  let cleanup: (() => void) | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const authorized = () => {
        try {
          return opts.isAuthorized ? opts.isAuthorized() : true
        } catch {
          return false
        }
      }
      const send = (e: ServerEvent) => {
        if (closed) return
        if (e.type !== 'hello' && !authorized()) {
          stop()
          return
        }
        try {
          controller.enqueue(frame(e))
        } catch {
          stop()
        }
      }
      const onEvent = (e: ServerEvent) => send(e)
      const timer = setInterval(() => send({ type: 'ping' }), opts.pingMs ?? SSE_PING_MS)
      timer.unref?.()
      let unregister: (() => void) | null = null
      const stop = (closeController = true) => {
        if (closed) return
        closed = true
        clearInterval(timer)
        opts.bus.off('server_event', onEvent)
        opts.signal?.removeEventListener('abort', onAbort)
        unregister?.()
        if (closeController) {
          try {
            controller.close()
          } catch {
            // already closed or cancelled
          }
        }
      }
      const onAbort = () => stop()
      cleanup = () => stop(false)
      opts.bus.on('server_event', onEvent)
      opts.signal?.addEventListener('abort', onAbort)
      unregister = opts.registry?.add(() => stop()) ?? null
      // reconnect hint for EventSource, then hello
      controller.enqueue(encoder.encode('retry: 5000\n\n'))
      send({ type: 'hello', serverTime: opts.clock.now().toISOString() })
      if (opts.signal?.aborted) stop()
    },
    cancel() {
      cleanup?.()
    },
  })
  return new Response(stream, { status: 200, headers: sseHeaders(opts.headers) })
}

export function sseHeaders(init?: Headers): Headers {
  const headers = new Headers(init)
  headers.set('Content-Type', 'text/event-stream; charset=utf-8')
  headers.set('Cache-Control', 'no-cache, no-transform')
  headers.set('Connection', 'keep-alive')
  headers.set('X-Accel-Buffering', 'no')
  return headers
}
