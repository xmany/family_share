// Hold-to-talk recorder (SPEC §7 "Browser recording").
// - MediaRecorder type chosen at runtime: Apple devices audio/mp4 first, others audio/webm;codecs=opus first
// - no timeslice (iOS produces broken fragments with one); the recorder's actual mimeType is reported
// - the mic stream is kept while the page is visible (later presses start instantly, no repeated
//   prompt on iOS) and released when the page is hidden or after 60 s idle
// - max 60 s per recording
// Pure helpers at the top are unit-tested in node; nothing here touches the DOM at import time.

import { isAppleDevice } from './platform'

export const MAX_RECORDING_MS = 60_000
export const STREAM_IDLE_MS = 60_000

/** Apple WebKit records AAC in MP4 natively; webm/opus only on recent versions. */
export const APPLE_MIME_ORDER = [
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/aac',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const

/** Chrome/Firefox/Android: Opus in WebM (Firefox: Ogg). */
export const DEFAULT_MIME_ORDER = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/aac',
] as const

/**
 * Picks the first supported MediaRecorder type for this device, or '' when none is
 * reported (then the recorder is created without a type and uses its default).
 */
export function pickMimeType(isTypeSupported: ((type: string) => boolean) | null | undefined, apple: boolean): string {
  if (!isTypeSupported) return ''
  const order = apple ? APPLE_MIME_ORDER : DEFAULT_MIME_ORDER
  for (const t of order) {
    try {
      if (isTypeSupported(t)) return t
    } catch {
      // some engines throw on unknown parameters; treat as unsupported
    }
  }
  return ''
}

/** File extension the server (and ffmpeg) expects for a recorder mime type. */
export function extensionForMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? ''
  if (m === 'audio/mp4' || m === 'video/mp4' || m === 'audio/x-m4a' || m === 'audio/m4a') return 'm4a'
  if (m === 'audio/aac') return 'aac'
  if (m === 'audio/webm' || m === 'video/webm') return 'webm'
  if (m === 'audio/ogg') return 'ogg'
  if (m === 'audio/wav' || m === 'audio/wave' || m === 'audio/x-wav') return 'wav'
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3'
  return 'bin'
}

export function fileNameForMime(mime: string): string {
  return `voice.${extensionForMime(mime)}`
}

/** The type to report when the recorder gives none: the blob's type, else the platform's usual default. */
export function resolveRecordedMime(recorderMime: string, blobType: string, chosen: string, apple: boolean): string {
  return recorderMime || blobType || chosen || (apple ? 'audio/mp4' : 'audio/webm')
}

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationMs: number
}

export type RecorderErrorCode = 'unsupported' | 'denied' | 'no_device' | 'busy' | 'failed' | 'cancelled'

export class RecorderError extends Error {
  readonly code: RecorderErrorCode
  constructor(code: RecorderErrorCode, message: string) {
    super(message)
    this.name = 'RecorderError'
    this.code = code
  }
}

function toRecorderError(e: unknown): RecorderError {
  if (e instanceof RecorderError) return e
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new RecorderError('denied', '没有麦克风权限。请在系统设置里允许使用麦克风，或用键盘上的语音输入')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new RecorderError('no_device', '没有找到麦克风')
  if (name === 'NotReadableError' || name === 'AbortError') return new RecorderError('busy', '麦克风被其他应用占用了')
  return new RecorderError('failed', '录音失败了，可以用键盘上的语音输入')
}

export function recordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  )
}

interface StartOptions {
  maxMs?: number
  /** Called when the max duration is reached; the caller should then call stop() */
  onMaxReached?: () => void
}

/**
 * One instance per page. start() → stop() resolves with the recording; cancel() discards it.
 */
export class HoldToTalkRecorder {
  private stream: MediaStream | null = null
  private streamPromise: Promise<MediaStream> | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private chosenMime = ''
  private startedAt = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private listening = false
  private generation = 0
  /** Called when the page is hidden (app switched, screen locked): any recording was discarded. */
  onInterrupted: (() => void) | null = null

  get isRecording(): boolean {
    return this.recorder?.state === 'recording'
  }

  /** ms since recording started (0 when idle) */
  elapsedMs(): number {
    return this.isRecording ? performance.now() - this.startedAt : 0
  }

  private attachListeners() {
    if (this.listening) return
    this.listening = true
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pagehide', this.onPageHide)
  }

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.interrupt()
  }

  private onPageHide = () => this.interrupt()

  private interrupt() {
    this.cancel()
    this.releaseStream()
    this.onInterrupted?.()
  }

  private streamLive(): boolean {
    return !!this.stream && this.stream.getAudioTracks().some(t => t.readyState === 'live')
  }

  private async getStream(): Promise<MediaStream> {
    if (this.streamLive()) return this.stream!
    this.stream = null
    if (!this.streamPromise) {
      this.streamPromise = navigator.mediaDevices
        .getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        })
        .then(s => {
          this.stream = s
          return s
        })
        .finally(() => {
          this.streamPromise = null
        })
    }
    return this.streamPromise
  }

  /** Stops the mic (the iOS/Android mic indicator goes away). */
  releaseStream(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.isRecording) return
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
  }

  private scheduleIdleRelease() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.releaseStream(), STREAM_IDLE_MS)
  }

  /** Acquires the mic (may show the permission prompt) and starts recording. */
  async start(opts: StartOptions = {}): Promise<void> {
    if (!recordingSupported()) throw new RecorderError('unsupported', '这个浏览器不支持录音，可以用键盘上的语音输入')
    if (this.recorder && this.recorder.state !== 'inactive') throw new RecorderError('busy', '正在录音')
    this.attachListeners()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const gen = ++this.generation

    let stream: MediaStream
    try {
      stream = await this.getStream()
    } catch (e) {
      throw toRecorderError(e)
    }
    // cancelled (or page hidden) while waiting for the permission prompt
    if (gen !== this.generation) {
      this.scheduleIdleRelease()
      throw new RecorderError('cancelled', '已取消')
    }

    const apple = isAppleDevice()
    this.chosenMime = pickMimeType(t => MediaRecorder.isTypeSupported(t), apple)
    let rec: MediaRecorder
    try {
      const options: MediaRecorderOptions = { audioBitsPerSecond: 64_000 }
      if (this.chosenMime) options.mimeType = this.chosenMime
      rec = new MediaRecorder(stream, options)
    } catch {
      try {
        rec = new MediaRecorder(stream)
        this.chosenMime = ''
      } catch (e) {
        throw toRecorderError(e)
      }
    }
    this.chunks = []
    rec.ondataavailable = ev => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data)
    }
    this.recorder = rec
    try {
      rec.start() // no timeslice: one complete file on stop
    } catch (e) {
      this.recorder = null
      throw toRecorderError(e)
    }
    this.startedAt = performance.now()
    const maxMs = opts.maxMs ?? MAX_RECORDING_MS
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = setTimeout(() => {
      if (this.isRecording) opts.onMaxReached?.()
    }, maxMs)
  }

  /** Stops and returns the recording (null if nothing was recorded). */
  stop(): Promise<RecordingResult | null> {
    const rec = this.recorder
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null
    if (!rec || rec.state === 'inactive') {
      this.recorder = null
      return Promise.resolve(null)
    }
    const durationMs = Math.min(performance.now() - this.startedAt, MAX_RECORDING_MS + 1000)
    const apple = isAppleDevice()
    return new Promise(resolve => {
      rec.onstop = () => {
        this.recorder = null
        this.scheduleIdleRelease()
        const firstType = this.chunks[0]?.type ?? ''
        const mimeType = resolveRecordedMime(rec.mimeType, firstType, this.chosenMime, apple)
        const blob = new Blob(this.chunks, { type: mimeType })
        this.chunks = []
        resolve(blob.size > 0 ? { blob, mimeType, durationMs } : null)
      }
      try {
        rec.stop()
      } catch {
        this.recorder = null
        resolve(null)
      }
    })
  }

  /** Discards the current recording (or a pending start). Keeps the stream for the next press. */
  cancel(): void {
    this.generation++
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null
    const rec = this.recorder
    this.recorder = null
    if (rec && rec.state !== 'inactive') {
      rec.ondataavailable = null
      rec.onstop = null
      try {
        rec.stop()
      } catch {
        // already stopped
      }
    }
    this.chunks = []
    if (this.stream) this.scheduleIdleRelease()
  }

  dispose(): void {
    this.onInterrupted = null
    this.cancel()
    this.releaseStream()
    if (this.listening) {
      document.removeEventListener('visibilitychange', this.onVisibility)
      window.removeEventListener('pagehide', this.onPageHide)
      this.listening = false
    }
  }
}
