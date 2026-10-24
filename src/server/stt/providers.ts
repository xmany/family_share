// The two hosted STT backends (SPEC §7, docs/research/stt.md); the local one is in ./whisper.ts:
//  - openai: POST {base}/v1/audio/transcriptions, multipart, model gpt-transcribe
//  - qwen:   POST {base}/chat/completions (Alibaba Model Studio, OpenAI-compatible), model qwen3-asr-flash

import type { SttProviderConfig } from '../config'
import { MAX_AUDIO_BYTES, mimeForExt, sanitizeKeywords, wavDurationMs } from './audio'
import { SttHttpError, callProvider, joinUrl } from './request'
import type { TranscribeOptions } from './types'
import { SttError } from './types'

/** One upload, before and after ffmpeg. */
export interface PreparedAudio {
  original: Buffer
  /** MIME type of the original, parameters stripped (e.g. "audio/webm") */
  mimeType: string
  /** Extension of the original, e.g. "webm" */
  ext: string
  /** 16 kHz mono PCM WAV, or null when ffmpeg is unavailable or failed */
  wav: Buffer | null
}

export interface RawTranscript {
  text: string
  detectedLanguages?: string[]
  durationMs?: number
}

export interface Backend {
  /** e.g. "openai:gpt-transcribe" */
  readonly name: string
  transcribe(audio: PreparedAudio, opts: TranscribeOptions): Promise<RawTranscript>
  /** Stops a background helper (local whisper) */
  dispose?(): void
}

export interface BackendDeps {
  fetch: typeof fetch
  timeoutMs?: number
  retryDelayMs?: number
}

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com'
export const OPENAI_DEFAULT_MODEL = 'gpt-transcribe'
export const QWEN_DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const QWEN_DEFAULT_MODEL = 'qwen3-asr-flash'
export const DEFAULT_LANGUAGES = ['zh', 'en']

/** Qwen limits context text to 400 characters per turn (it silently truncates the rest). */
const QWEN_CONTEXT_MAX = 400

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map(x => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { code?: unknown }).code === 'string' ? (x as { code: string }).code : null))
        .filter((x): x is string => !!x)
    : []

function secondsToMs(usage: unknown): number | undefined {
  const s = usage && typeof usage === 'object' ? (usage as { seconds?: unknown }).seconds : undefined
  return typeof s === 'number' && Number.isFinite(s) ? Math.round(s * 1000) : undefined
}

export function createOpenAiBackend(cfg: SttProviderConfig, deps: BackendDeps): Backend {
  const model = cfg.model ?? OPENAI_DEFAULT_MODEL
  // Accept both "https://api.openai.com" and "https://api.openai.com/v1" as the base.
  const base = (cfg.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const url = base.endsWith('/v1') ? joinUrl(base, 'audio/transcriptions') : joinUrl(base, 'v1/audio/transcriptions')
  return {
    name: `openai:${model}`,
    async transcribe(audio, opts) {
      // The WAV when ffmpeg worked; otherwise the original (OpenAI accepts webm/mp4/m4a/ogg/wav/mp3/flac).
      const bytes = audio.wav ?? audio.original
      const ext = audio.wav ? 'wav' : audio.ext
      const type = audio.wav ? 'audio/wav' : audio.mimeType || mimeForExt(audio.ext)
      if (bytes.length > 25 * 1024 * 1024) throw new SttError('openai: audio is larger than 25 MB')
      const languages = opts.languages?.length ? opts.languages : DEFAULT_LANGUAGES
      const keywords = sanitizeKeywords(opts.keywords)
      const json = await callProvider({
        fetch: deps.fetch,
        url,
        label: 'openai',
        timeoutMs: deps.timeoutMs,
        retryDelayMs: deps.retryDelayMs,
        init: () => {
          const fd = new FormData()
          fd.append('file', new Blob([new Uint8Array(bytes)], { type }), `audio.${ext}`)
          fd.append('model', model)
          // `languages[]` replaces `language`; never send both.
          for (const l of languages) fd.append('languages[]', l)
          for (const k of keywords) fd.append('keywords[]', k)
          if (opts.prompt) fd.append('prompt', opts.prompt)
          fd.append('response_format', 'json')
          return { method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: fd }
        },
      })
      const body = (json ?? {}) as { text?: unknown; languages?: unknown; usage?: unknown }
      if (typeof body.text !== 'string') throw new SttError('openai: response has no text')
      return {
        text: body.text,
        detectedLanguages: asStringArray(body.languages),
        durationMs: secondsToMs(body.usage) ?? (audio.wav ? wavDurationMs(audio.wav) : undefined),
      }
    },
  }
}

/** Context for qwen's system message: the scene description plus the literal words to expect. */
export function qwenContext(opts: TranscribeOptions): string {
  const keywords = sanitizeKeywords(opts.keywords)
  const parts = [opts.prompt?.trim() ?? '', keywords.length ? `可能出现的词：${keywords.join('、')}` : ''].filter(Boolean)
  return parts.join('\n').slice(0, QWEN_CONTEXT_MAX)
}

export function createQwenBackend(cfg: SttProviderConfig, deps: BackendDeps): Backend {
  const model = cfg.model ?? QWEN_DEFAULT_MODEL
  const url = joinUrl(cfg.baseUrl ?? QWEN_DEFAULT_BASE_URL, 'chat/completions')
  return {
    name: `qwen:${model}`,
    async transcribe(audio, opts) {
      // Qwen documents WAV/MP3 only: without ffmpeg we refuse rather than send webm/mp4.
      if (!audio.wav) throw new SttError('qwen: needs ffmpeg to convert the upload to WAV')
      const dataUrl = `data:audio/wav;base64,${audio.wav.toString('base64')}`
      if (dataUrl.length > MAX_AUDIO_BYTES) throw new SttError('qwen: audio is larger than 10 MB after base64')
      const context = qwenContext(opts)
      const languages = opts.languages ?? []
      const asrOptions: Record<string, unknown> = { enable_itn: true }
      // A single hint pins the language; mixed Mandarin/English must leave it unset.
      if (languages.length === 1) asrOptions.language = languages[0]
      const bodyFor = (withContext: boolean) =>
        JSON.stringify({
          model,
          messages: [
            ...(withContext && context ? [{ role: 'system', content: context }] : []),
            { role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUrl } }] },
          ],
          stream: false,
          asr_options: asrOptions,
        })
      const call = (payload: string) =>
        callProvider({
          fetch: deps.fetch,
          url,
          label: 'qwen',
          timeoutMs: deps.timeoutMs,
          retryDelayMs: deps.retryDelayMs,
          init: () => ({
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
            body: payload,
          }),
        })
      let json: unknown
      try {
        json = await call(bodyFor(true))
      } catch (e) {
        // Alibaba's docs never show the context (system) message's content shape. If a 400 rejects it, the
        // transcription is still worth more than the context: try once more without it.
        if (!(context && e instanceof SttHttpError && e.status === 400)) throw e
        json = await call(bodyFor(false))
      }
      const res = (json ?? {}) as {
        choices?: Array<{ message?: { content?: unknown; annotations?: Array<{ language?: unknown }> } }>
        usage?: unknown
      }
      const message = res.choices?.[0]?.message
      const content = message?.content
      // The docs show a plain string; the reference also mentions an array of parts. Accept both.
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('')
            : null
      if (text === null) throw new SttError('qwen: response has no transcript')
      const detected = (message?.annotations ?? []).map(a => a?.language).filter((l): l is string => typeof l === 'string' && !!l)
      return { text, detectedLanguages: detected, durationMs: secondsToMs(res.usage) ?? wavDurationMs(audio.wav) }
    },
  }
}

export function createBackend(cfg: SttProviderConfig, deps: BackendDeps): Backend | null {
  switch (cfg.provider) {
    case 'openai':
      return createOpenAiBackend(cfg, deps)
    case 'qwen':
    case 'dashscope':
    case 'alibaba':
      return createQwenBackend(cfg, deps)
    default:
      return null
  }
}
