// One HTTP call to an STT provider: 15 s timeout per attempt, one retry on 5xx or a network error/timeout.

import { SttError } from './types'

export const STT_TIMEOUT_MS = 15_000

export interface CallOptions {
  fetch: typeof fetch
  url: string
  /** Called once per attempt (a fresh body each time) */
  init: () => RequestInit
  /** Provider label for error messages, e.g. "openai" */
  label: string
  timeoutMs?: number
  retryDelayMs?: number
}

/** A non-retryable HTTP error answer from the provider (4xx), with its status. */
export class SttHttpError extends SttError {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message, status === 429)
    this.name = 'SttError'
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function describe(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : e.message
  return String(e)
}

/** Returns the parsed JSON body of a 2xx response; throws SttError otherwise. */
export async function callProvider(opts: CallOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? STT_TIMEOUT_MS
  const attempts = 2
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(opts.retryDelayMs ?? 300)
    let res: Response
    try {
      res = await opts.fetch(opts.url, { ...opts.init(), signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      lastError = `${opts.label}: ${describe(e)}`
      continue // network error or timeout → retry once
    }
    if (res.status >= 500) {
      lastError = `${opts.label}: HTTP ${res.status} ${await safeText(res)}`.trim()
      continue
    }
    if (!res.ok) {
      throw new SttHttpError(`${opts.label}: HTTP ${res.status} ${await safeText(res)}`.trim(), res.status)
    }
    try {
      return await res.json()
    } catch {
      throw new SttError(`${opts.label}: response is not JSON`)
    }
  }
  throw new SttError(lastError || `${opts.label}: failed`, true)
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
  } catch {
    return ''
  }
}

/** Joins a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}
