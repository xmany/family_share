import { customAlphabet } from 'nanoid'
import { createHash, randomBytes } from 'node:crypto'

const shortId = customAlphabet('0123456789abcdefghijkmnpqrstuvwxyz', 10)

/** Prefixed ids: m_ member, i_ item, n_ note, u_ utterance, nt_ notification, ps_ push subscription */
export function newId(prefix: 'm' | 'i' | 'n' | 'u' | 'nt' | 'ps'): string {
  return `${prefix}_${shortId()}`
}

/** Random URL-safe secret for invites and sessions (never stored raw). */
export function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
