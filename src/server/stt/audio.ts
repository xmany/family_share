// Small, dependency-free helpers shared by the STT providers and the voice upload route.

/** Upload size limit for one voice note (SPEC §5). */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024

/** Container extensions we accept for uploads (and hand to ffmpeg / OpenAI as the file name). */
const MIME_TO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}

const EXT_TO_MIME: Record<string, string> = {
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
}

/** "audio/webm;codecs=opus" → "audio/webm" */
export function baseMime(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * File extension for an upload from its MIME type (parameters ignored), falling back to the file name's
 * extension. Returns null when neither names an audio container we know.
 */
export function audioExtFor(mimeType: string | null | undefined, fileName?: string | null): string | null {
  const fromMime = MIME_TO_EXT[baseMime(mimeType)]
  if (fromMime) return fromMime
  const m = /\.([a-z0-9]{2,5})$/i.exec(fileName ?? '')
  const ext = m?.[1]?.toLowerCase()
  return ext && EXT_TO_MIME[ext] ? ext : null
}

/** Canonical MIME type for an extension (used when the browser sent none). */
export function mimeForExt(ext: string): string {
  return EXT_TO_MIME[ext] ?? 'application/octet-stream'
}

/** Only short alphanumeric extensions ever reach the file system or ffmpeg's argv. */
export function safeExt(ext: string): string {
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin'
}

/** Max keywords sent to a provider and max length of one keyword. */
export const MAX_KEYWORDS = 50
const MAX_KEYWORD_LEN = 64

/**
 * Cleans recognition keywords (OpenAI rejects the whole request on an invalid keyword): strips `<` and `>`,
 * turns CR, LF and other control characters into spaces, collapses whitespace, drops empties and duplicates,
 * and caps the list at 50.
 */
export function sanitizeKeywords(words: readonly (string | null | undefined)[] | undefined, max = MAX_KEYWORDS): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const w of words ?? []) {
    if (typeof w !== 'string') continue
    const clean = w
      .replace(/[<>]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_KEYWORD_LEN)
      .trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= max) break
  }
  return out
}

/** Duration of a 16 kHz mono 16-bit PCM WAV (what ffmpeg produces), from its size. */
export function wavDurationMs(wav: Buffer): number | undefined {
  if (wav.length <= 44) return undefined
  return Math.round(((wav.length - 44) / (16000 * 2)) * 1000)
}
