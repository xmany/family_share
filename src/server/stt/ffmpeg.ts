// Normalizes any upload (iOS MP4/AAC, Android WebM/Opus, …) to 16 kHz mono PCM WAV with ffmpeg.
// The upload is written to a temp file first: MP4 from stdin can fail because it isn't seekable.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeExt } from './audio'

export type FfmpegRunner = (input: Buffer, ext: string) => Promise<Buffer | null>

export const FFMPEG_TIMEOUT_MS = 20_000

export function ffmpegArgs(inPath: string, outPath: string): string[] {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', inPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', outPath]
}

/**
 * Returns a runner that converts audio to WAV, or resolves null when ffmpeg is missing, times out or
 * fails (the caller then sends the original bytes, or refuses for providers that need WAV).
 */
export function createFfmpegRunner(ffmpegPath: string, opts: { timeoutMs?: number; log?: (msg: string) => void } = {}): FfmpegRunner {
  const timeoutMs = opts.timeoutMs ?? FFMPEG_TIMEOUT_MS
  const log = opts.log ?? ((msg: string) => console.warn(msg))
  let missingLogged = false

  return async (input, ext) => {
    let dir: string | null = null
    try {
      dir = await mkdtemp(join(tmpdir(), 'family-share-stt-'))
      const inPath = join(dir, `in.${safeExt(ext)}`)
      const outPath = join(dir, 'out.wav')
      await writeFile(inPath, input)
      const result = await new Promise<{ ok: true } | { ok: false; missing: boolean; message: string }>(resolve => {
        execFile(
          ffmpegPath,
          ffmpegArgs(inPath, outPath),
          { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true },
          (err, _stdout, stderr) => {
            if (!err) return resolve({ ok: true })
            const code = (err as NodeJS.ErrnoException).code
            const missing = code === 'ENOENT' || code === 'EACCES'
            const message = (err as { killed?: boolean }).killed
              ? `timed out after ${timeoutMs} ms`
              : String(stderr || err.message).trim().slice(0, 300)
            resolve({ ok: false, missing, message })
          },
        )
      })
      if (!result.ok) {
        if (result.missing) {
          if (!missingLogged) log(`[stt] ffmpeg not found at "${ffmpegPath}"; uploads are sent without normalization`)
          missingLogged = true
        } else {
          log(`[stt] ffmpeg failed: ${result.message}`)
        }
        return null
      }
      const wav = await readFile(outPath)
      return wav.length > 44 ? wav : null
    } catch (e) {
      log(`[stt] ffmpeg error: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
