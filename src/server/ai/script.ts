// The speaker's script (SPEC §4: "The reply uses the speaker's script"). Text is stored and matched in
// Simplified; everything the interpreter sends back to a member (Claude's reply, the clarification, the
// fixed error and fallback texts) is converted to that member's script here.
import { Converter } from 'opencc-js/cn2t'
import type { Member } from '../../shared/types'
import { toSimplified } from '../domain/normalize'

export type ReplyScript = 'simplified' | 'traditional'

/** zh-TW / zh-HK / zh-MO / zh-Hant → Traditional; everything else (zh-CN default) → Simplified. */
export function replyScriptFor(member: Pick<Member, 'language'>): ReplyScript {
  const l = (member.language || 'zh-CN').toLowerCase()
  return /^zh-(tw|hk|mo|hant)/.test(l) ? 'traditional' : 'simplified'
}

let toTw: ((s: string) => string) | null = null
let toHk: ((s: string) => string) | null = null

/** Converts outbound text to the member's script (character-level OpenCC; English passes through). */
export function toSpeakerScript(text: string, member: Pick<Member, 'language'>): string {
  if (!text) return text
  if (replyScriptFor(member) === 'simplified') return toSimplified(text)
  if (/^zh-(hk|mo)/i.test(member.language)) {
    toHk ??= Converter({ from: 'cn', to: 'hk' })
    return toHk(text)
  }
  toTw ??= Converter({ from: 'cn', to: 'tw' })
  return toTw(text)
}
