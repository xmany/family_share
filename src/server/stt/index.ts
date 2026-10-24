// Speech-to-text (SPEC §7): normalize the upload with ffmpeg once, try the primary provider, then the
// fallback, and return Simplified text for Mandarin speakers (OpenCC t2s; rawText keeps the original).

import type { Config } from '../config'
import { toSimplified } from '../domain/normalize'
import { audioExtFor, baseMime, mimeForExt } from './audio'
import { createFfmpegRunner } from './ffmpeg'
import type { FfmpegRunner } from './ffmpeg'
import type { Backend, PreparedAudio } from './providers'
import { createBackend } from './providers'
import type { SttProvider, TranscribeOptions, Transcript } from './types'
import { SttError } from './types'
import { createWhisperBackend } from './whisper'
import type { WhisperWorkerOptions } from './whisper'

export { audioExtFor, MAX_AUDIO_BYTES, mimeForExt, sanitizeKeywords } from './audio'
export { createFfmpegRunner, ffmpegArgs } from './ffmpeg'
export type { FfmpegRunner } from './ffmpeg'
export { OPENAI_DEFAULT_MODEL, QWEN_DEFAULT_BASE_URL, QWEN_DEFAULT_MODEL } from './providers'
export { WHISPER_DEFAULT_MODEL, cleanWhisperText, createWhisperBackend, whisperLanguage, whisperPrompt } from './whisper'
export { SttError } from './types'
export type { SttProvider, TranscribeOptions, Transcript } from './types'

/** TranscribeOptions plus the script choice. Extra fields are optional, so any SttProvider accepts this. */
export interface SttOptions extends TranscribeOptions {
  /** Convert Traditional → Simplified (default true; false for zh-TW / zh-HK speakers) */
  simplify?: boolean
}

export interface CreateSttOptions {
  fetch?: typeof fetch
  runFfmpeg?: FfmpegRunner
  /** Tests: per-attempt timeout and the pause before the single retry */
  timeoutMs?: number
  retryDelayMs?: number
  log?: (msg: string) => void
  /** Tests: fake the local Whisper process */
  whisperSpawn?: WhisperWorkerOptions['spawnImpl']
  whisperTimeoutMs?: number
}

/** Wraps primary → fallback backends behind one SttProvider. */
export function createSttFromBackends(backends: Backend[], runFfmpeg: FfmpegRunner, log: (msg: string) => void = m => console.warn(m)): SttProvider {
  if (!backends.length) throw new Error('createSttFromBackends: no backends')
  return {
    name: backends.map(b => b.name).join(' → '),
    dispose() {
      for (const b of backends) b.dispose?.()
    },
    async transcribe(audio: Buffer, mimeType: string, opts: SttOptions = {}): Promise<Transcript> {
      if (!audio.length) throw new SttError('没有录到声音')
      const ext = audioExtFor(mimeType) ?? 'webm'
      const mime = baseMime(mimeType) || mimeForExt(ext)
      // A WAV upload is still resampled when possible; without ffmpeg it is used as is.
      const wav = (await runFfmpeg(audio, ext)) ?? (ext === 'wav' ? audio : null)
      const prepared: PreparedAudio = { original: audio, mimeType: mime, ext, wav }
      const errors: string[] = []
      let retryable = false
      for (const backend of backends) {
        try {
          const raw = await backend.transcribe(prepared, opts)
          const rawText = raw.text.trim()
          const text = opts.simplify === false ? rawText : toSimplified(rawText)
          return {
            text,
            rawText: raw.text,
            detectedLanguages: raw.detectedLanguages,
            durationMs: raw.durationMs,
            provider: backend.name,
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          errors.push(`${backend.name}: ${msg}`)
          if (e instanceof SttError && e.retryable) retryable = true
          log(`[stt] ${backend.name} failed: ${msg}`)
        }
      }
      throw new SttError(`语音识别失败（${errors.join('；')}）`, retryable)
    },
  }
}

/**
 * Builds the configured provider chain, or null when speech-to-text is off (no STT key and no local whisper,
 * STT_PROVIDER=none, or only unknown provider names).
 */
export function createStt(config: Config, opts: CreateSttOptions = {}): SttProvider | null {
  const log = opts.log ?? ((m: string) => console.warn(m))
  const deps = { fetch: opts.fetch ?? globalThis.fetch, timeoutMs: opts.timeoutMs, retryDelayMs: opts.retryDelayMs }
  const backends: Backend[] = []
  for (const cfg of [config.stt.primary, config.stt.fallback]) {
    if (!cfg) continue
    const b =
      cfg.provider === 'whisper'
        ? createWhisperBackend(cfg, config.stt.whisper, { log, spawnImpl: opts.whisperSpawn, timeoutMs: opts.whisperTimeoutMs })
        : createBackend(cfg, deps)
    if (b) backends.push(b)
    else log(`[stt] unknown provider "${cfg.provider}" (use openai, qwen or whisper); ignored`)
  }
  if (!backends.length) return null
  const runFfmpeg = opts.runFfmpeg ?? createFfmpegRunner(config.stt.ffmpegPath, { log })
  return createSttFromBackends(backends, runFfmpeg, log)
}
