import type { UtteranceResponse } from '../../shared/api'
import type { UtteranceSource } from '../../shared/types'

export interface InterpretInput {
  memberId: string
  text: string
  source: UtteranceSource
  /** When answering a clarification question: the utterance that asked it */
  replyToUtteranceId?: string | null
  audioPath?: string | null
}

/**
 * Turns one utterance into board changes. Always records an Utterance (even on failure),
 * applies changes through the Domain with actor { type: 'ai', memberId, utteranceId },
 * and never throws for model/tool problems — those end as status 'error' with a Chinese message.
 */
export interface Interpreter {
  readonly enabled: boolean
  interpret(input: InterpretInput): Promise<UtteranceResponse>
}
