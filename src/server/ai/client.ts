import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config'
import type { MessagesApi } from './loop'

export const REQUEST_TIMEOUT_MS = 60_000

/**
 * The SDK client. The key comes from config (ANTHROPIC_API_KEY), server-side only. authToken is forced to
 * null: if ANTHROPIC_AUTH_TOKEN were also set in the environment the SDK would send both headers (401).
 * The SDK already retries connection errors, 408, 409, 429 and >= 500 twice with backoff.
 */
export function createAnthropicClient(config: Pick<Config, 'anthropic'>, opts: { fetch?: typeof fetch } = {}): Anthropic {
  return new Anthropic({
    apiKey: config.anthropic.apiKey,
    authToken: null,
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
}

/** The one method the interpreter needs, wrapped so tests can inject a scripted fake instead. */
export function messagesApiFrom(client: Anthropic): MessagesApi {
  return { create: (body, options) => client.beta.messages.create(body, options) }
}
