export interface TranscribeOptions {
  /** Language hints, e.g. ["zh", "en"] (gpt-transcribe `languages[]`; "yue" for Cantonese speakers) */
  languages?: string[]
  /** Literal terms to bias recognition: member names/aliases, open item titles (no < > CR LF; cap ~50) */
  keywords?: string[]
  /** Short context sentence in Simplified Chinese */
  prompt?: string
}

export interface Transcript {
  /** Normalized transcript: Traditional characters converted to Simplified (OpenCC t2s) for zh-CN members */
  text: string
  /** Text exactly as the provider returned it */
  rawText: string
  detectedLanguages?: string[]
  durationMs?: number
  provider: string
}

export interface SttProvider {
  readonly name: string
  transcribe(audio: Buffer, mimeType: string, opts?: TranscribeOptions): Promise<Transcript>
  /** Stops background helpers (the local Whisper process). Optional: hosted providers have none. */
  dispose?(): void
}

export class SttError extends Error {
  constructor(message: string, public readonly retryable = false) {
    super(message)
    this.name = 'SttError'
  }
}
