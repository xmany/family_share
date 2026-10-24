// Local speech-to-text with OpenAI's open-source Whisper (the `openai-whisper` Python package), STT_PROVIDER=whisper.
// One long-lived Python process keeps the model in memory between voice notes: loading `turbo` takes ~3 s, after which
// a 10 s Mandarin note takes ~1.5 s on an Apple Silicon CPU. The process exits after WHISPER_IDLE_MINUTES without work
// to give its ~2-3 GB of RAM back, and is started again by the next note.

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SttProviderConfig } from '../config'
import { sanitizeKeywords, wavDurationMs } from './audio'
import type { Backend } from './providers'
import type { TranscribeOptions } from './types'
import { SttError } from './types'

export const WHISPER_DEFAULT_MODEL = 'turbo'
/** One request, including loading the model when the process has to start first */
export const WHISPER_TIMEOUT_MS = 90_000
export const WHISPER_DEFAULT_PROMPT = '以下是普通话的句子，可能夹杂英文。'
/** Whisper only reads the end of a long prompt (~224 tokens); stay well inside it. */
const PROMPT_MAX_CHARS = 160

export interface WhisperSettings {
  /** Python interpreter that has openai-whisper installed */
  python: string
  /** torch device: "cpu" (works everywhere) or "cuda" */
  device: string
  /** Unload the model after this long without work */
  idleMs: number
}

/**
 * The worker, passed to `python -u -c`. Protocol: one JSON object per line on stdin
 * ({id, wav, language, prompt}) and stdout ({ready} once the model is loaded, {fatal} if it can't load,
 * then {id, text, language} or {id, error} per request). It exits when stdin closes.
 */
export const WHISPER_WORKER_SOURCE = String.raw`
import json, sys, warnings
warnings.filterwarnings("ignore")

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

model_name, device = sys.argv[1], sys.argv[2]
try:
    import whisper
    model = whisper.load_model(model_name, device=device)
except Exception as e:
    send({"fatal": "%s: %s" % (type(e).__name__, e)})
    sys.exit(2)
send({"ready": True})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except ValueError:
        continue
    rid = req.get("id")
    try:
        result = model.transcribe(
            req["wav"],
            language=req.get("language") or None,
            initial_prompt=req.get("prompt") or None,
            fp16=(device != "cpu"),
            condition_on_previous_text=False,
            verbose=None,
        )
        send({"id": rid, "text": (result.get("text") or "").strip(), "language": result.get("language")})
    except Exception as e:
        send({"id": rid, "error": "%s: %s" % (type(e).__name__, e)})
`

export interface WorkerRequest {
  wav: string
  language?: string
  prompt?: string
}

export interface WorkerResult {
  text: string
  language: string | null
}

export interface WhisperWorkerOptions {
  command: string
  args: string[]
  idleMs: number
  timeoutMs: number
  log: (msg: string) => void
  /** Tests: a different spawn */
  spawnImpl?: (command: string, args: string[]) => ChildProcessWithoutNullStreams
}

interface Pending {
  resolve: (r: WorkerResult) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Owns the Python process. Requests run one at a time; a crash or timeout fails the request and the next one restarts it. */
export class WhisperWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private fatal: string | null = null
  private stdoutBuf = ''
  private stderrTail = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private chain: Promise<unknown> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: WhisperWorkerOptions) {}

  /** True while the Python process is running (model loaded or loading). */
  get running(): boolean {
    return this.proc !== null
  }

  transcribe(req: WorkerRequest): Promise<WorkerResult> {
    const run = () => this.send(req)
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => undefined)
    return p
  }

  /** Stops the process now (shutdown). */
  dispose(): void {
    this.clearIdle()
    this.stop()
  }

  private send(req: WorkerRequest): Promise<WorkerResult> {
    this.clearIdle()
    const proc = this.ensureProcess()
    const id = this.nextId++
    return new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        const loading = this.ready ? '' : '（还在加载模型；第一次运行会下载模型，可以先运行 npm run family -- stt-test）'
        reject(new SttError(`whisper: ${Math.round(this.opts.timeoutMs / 1000)} 秒内没有结果${loading}`, true))
        // a stuck process would block every later note: start fresh next time
        this.stop()
      }, this.opts.timeoutMs)
      this.pending.set(id, {
        timer,
        resolve: r => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      proc.stdin.write(`${JSON.stringify({ id, ...req })}\n`)
    })
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc
    const spawnImpl = this.opts.spawnImpl ?? ((command: string, args: string[]) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }))
    const proc = spawnImpl(this.opts.command, this.opts.args)
    this.proc = proc
    this.ready = false
    this.fatal = null
    this.stdoutBuf = ''
    this.stderrTail = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onStdout(proc, chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    // EPIPE when the process has died: the 'exit' handler reports it
    proc.stdin.on('error', () => undefined)
    proc.on('error', err => this.onExit(proc, `无法启动 ${this.opts.command}（${err.message}）`))
    proc.on('exit', (code, signal) => this.onExit(proc, `进程退出（${signal ?? code}）`))
    return proc
  }

  private onStdout(proc: ChildProcessWithoutNullStreams, chunk: string): void {
    if (proc !== this.proc) return
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (line) this.onMessage(line)
    }
  }

  private onMessage(line: string): void {
    let msg: { ready?: unknown; fatal?: unknown; id?: unknown; text?: unknown; language?: unknown; error?: unknown }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      return // stray output from a library
    }
    if (msg.ready === true) {
      this.ready = true
      this.opts.log('[stt] whisper model loaded')
      return
    }
    if (typeof msg.fatal === 'string') {
      this.fatal = msg.fatal
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (typeof msg.error === 'string') p.reject(new SttError(`whisper: ${msg.error}`))
    else p.resolve({ text: typeof msg.text === 'string' ? msg.text : '', language: typeof msg.language === 'string' ? msg.language : null })
    if (this.pending.size === 0) this.armIdle()
  }

  private onExit(proc: ChildProcessWithoutNullStreams, reason: string): void {
    if (proc !== this.proc) return
    this.proc = null
    this.ready = false
    this.clearIdle()
    const lastStderr = this.stderrTail.trim().split('\n').filter(Boolean).pop()
    const why = this.fatal ?? lastStderr ?? reason
    if (this.fatal) this.opts.log(`[stt] whisper could not load the model: ${this.fatal}`)
    for (const p of this.pending.values()) p.reject(new SttError(`whisper: ${why}`, !this.fatal))
    this.pending.clear()
  }

  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.stop()
    }, this.opts.idleMs)
    this.idleTimer.unref()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private stop(reason = '已停止'): void {
    const proc = this.proc
    if (!proc) return
    // detach first: the next request must start a fresh process, not write to this dying one
    this.proc = null
    this.ready = false
    this.clearIdle()
    for (const p of this.pending.values()) p.reject(new SttError(`whisper: ${reason}`, true))
    this.pending.clear()
    // closing stdin ends the worker's read loop; the kill covers a process stuck inside transcribe()
    proc.stdin.end()
    proc.kill('SIGTERM')
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }, 2000).unref()
  }
}

/** Whisper takes one language. The family speaks Mandarin, which keeps English words as spoken. */
export function whisperLanguage(languages: readonly string[] | undefined): string {
  const list = (languages ?? []).map(l => l.toLowerCase())
  if (list.some(l => l === 'yue' || l.startsWith('zh-hk') || l.startsWith('yue'))) return 'yue'
  if (!list.length || list.some(l => l === 'zh' || l === 'cmn' || l.startsWith('zh'))) return 'zh'
  return list[0]!.split('-')[0]!
}

/** Scene sentence plus the family's own words (names, open item titles): this is what fixes 柜子 vs 贵子. */
export function whisperPrompt(opts: TranscribeOptions): string {
  const base = opts.prompt?.trim() || WHISPER_DEFAULT_PROMPT
  const words: string[] = []
  let prompt = base
  for (const w of sanitizeKeywords(opts.keywords)) {
    const next = `${base}常用词：${[...words, w].join('、')}。`
    if (next.length > PROMPT_MAX_CHARS) break
    words.push(w)
    prompt = next
  }
  return prompt
}

/**
 * Whisper invents text for silence and noise, mostly subtitle credits from its training data. A family member
 * never says these to a to-do app, so sentences that match are dropped.
 */
const HALLUCINATIONS = [
  // "请不吝点赞 订阅 转发 打赏…": two of these together (one alone can be real: 取消Netflix订阅)
  /(点赞|订阅|转发|打赏).*(点赞|订阅|转发|打赏)/,
  /字幕(由|提供|制作|志愿者|组)/,
  /amara\.org/i,
  /明镜与点点|优优独播剧场|yoyo television/i,
  /^(谢谢|感谢)(观看|收看|大家观看)$/,
]

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff'
const FULL_WIDTH: Record<string, string> = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；', '.': '。' }

/** Drops hallucinated sentences and gives Chinese text Chinese punctuation (Whisper writes "吗?我九点有个会,"). */
export function cleanWhisperText(text: string, prompt = ''): string {
  const sentences = text.trim().match(/[^。！？!?\n]+[。！？!?]*/g) ?? []
  const kept = sentences.filter(s => {
    const bare = s.replace(/[\s\p{P}]/gu, '')
    if (!bare) return false
    if (HALLUCINATIONS.some(re => re.test(bare))) return false
    return true
  })
  let out = kept.join('').trim()
  // on silence Whisper sometimes just repeats its prompt back
  const bareOut = out.replace(/[\s\p{P}]/gu, '')
  if (bareOut.length >= 4 && prompt.replace(/[\s\p{P}]/gu, '').includes(bareOut)) return ''
  out = out.replace(new RegExp(`(?<=[${CJK}])[,?!:;.]`, 'g'), c => FULL_WIDTH[c] ?? c)
  return out
}

export interface WhisperBackend extends Backend {
  dispose(): void
}

export function createWhisperBackend(
  cfg: SttProviderConfig,
  settings: WhisperSettings,
  deps: { timeoutMs?: number; log?: (msg: string) => void; spawnImpl?: WhisperWorkerOptions['spawnImpl'] } = {},
): WhisperBackend {
  const model = cfg.model ?? WHISPER_DEFAULT_MODEL
  const log = deps.log ?? ((m: string) => console.warn(m))
  const worker = new WhisperWorker({
    command: settings.python,
    args: ['-u', '-c', WHISPER_WORKER_SOURCE, model, settings.device],
    idleMs: settings.idleMs,
    timeoutMs: deps.timeoutMs ?? WHISPER_TIMEOUT_MS,
    log,
    spawnImpl: deps.spawnImpl,
  })
  return {
    name: `whisper:${model}`,
    async transcribe(audio, opts) {
      if (!audio.wav) throw new SttError('whisper: needs ffmpeg to convert the recording (install ffmpeg or set FFMPEG_PATH)')
      const dir = await mkdtemp(join(tmpdir(), 'family-share-whisper-'))
      try {
        const wav = join(dir, 'in.wav')
        await writeFile(wav, audio.wav)
        const prompt = whisperPrompt(opts)
        const r = await worker.transcribe({ wav, language: whisperLanguage(opts.languages), prompt })
        const text = cleanWhisperText(r.text, prompt)
        if (!text) throw new SttError('没听清，请再说一次')
        return { text, detectedLanguages: r.language ? [r.language] : undefined, durationMs: wavDurationMs(audio.wav) }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    dispose: () => worker.dispose(),
  }
}
