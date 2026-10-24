import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { isValidTimezone } from './time'

const bool = z
  .string()
  .optional()
  .transform(v => (v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  /** Public origin the phones use, e.g. https://my-mac.tail1234.ts.net — used in invite links and notification URLs */
  PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  DATA_DIR: z.string().default('./data'),
  FAMILY_NAME: z.string().default('我们家'),
  /** Initial family timezone (stored in the DB on first run; change later in the DB/CLI) */
  FAMILY_TIMEZONE: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  // AI_* rather than CLAUDE_*: Claude Code sets CLAUDE_EFFORT (and may set others) in its own terminals, which would
  // silently override .env when the server is started from one.
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  /** Server-side refusal fallbacks (beta). On by default. */
  AI_FALLBACKS: bool,
  /** Max model calls per utterance */
  AI_MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(6),

  /** Speech-to-text: "openai" (gpt-transcribe), "qwen" (qwen3-asr-flash, Alibaba intl), "whisper" (open-source Whisper
   *  running on this machine, no key needed), or "none" (keyboard dictation only).
   *  Defaults to "openai" when STT_API_KEY or OPENAI_API_KEY is set, else "none". */
  STT_PROVIDER: z.string().optional(),
  STT_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  STT_MODEL: z.string().optional(),
  STT_BASE_URL: z.string().url().optional(),
  /** Optional second provider tried when the first fails */
  STT_FALLBACK_PROVIDER: z.string().optional(),
  STT_FALLBACK_API_KEY: z.string().optional(),
  STT_FALLBACK_MODEL: z.string().optional(),
  STT_FALLBACK_BASE_URL: z.string().url().optional(),
  /** Path to ffmpeg; audio is normalized to 16 kHz mono WAV before transcription when available */
  FFMPEG_PATH: z.string().default('ffmpeg'),
  /** STT_PROVIDER=whisper: a Python that has the openai-whisper package (pip install openai-whisper) */
  WHISPER_PYTHON: z.string().default('python3'),
  /** STT_PROVIDER=whisper: torch device. "cpu" works everywhere; "mps" crashes in openai-whisper on Apple Silicon */
  WHISPER_DEVICE: z.string().default('cpu'),
  /** STT_PROVIDER=whisper: unload the model after this many idle minutes (it holds ~2-3 GB of RAM while loaded) */
  WHISPER_IDLE_MINUTES: z.coerce.number().positive().default(15),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Contact for push services; use a real mailto: or https: URL */
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),

  /** WeChat Official Account sandbox test account (公众号接口测试号) — see docs/research/wechat.md */
  WECHAT_APPID: z.string().optional(),
  WECHAT_APPSECRET: z.string().optional(),
  /** Token you set in 接口配置信息 (used to verify callback signatures) */
  WECHAT_TOKEN: z.string().optional(),
  /** Test template with fields 事项/来自/时间/备注: {{task.DATA}} {{from.DATA}} {{when.DATA}} {{note.DATA}} */
  WECHAT_TEMPLATE_ID: z.string().optional(),
  /** Optional image URL of the test account's follow QR code, shown in settings */
  WECHAT_FOLLOW_QR_URL: z.string().url().optional(),

  SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  REQUEST_FOLLOWUP_MIN: z.coerce.number().int().positive().default(120),
  REQUEST_NOREPLY_MIN: z.coerce.number().int().positive().default(360),
})

export interface SttProviderConfig {
  /** "openai" | "qwen" | "whisper" */
  provider: string
  /** Empty for providers that need no key (whisper) */
  apiKey: string
  model: string | null
  baseUrl: string | null
}

export interface Config {
  port: number
  host: string
  publicUrl: string
  /** true when publicUrl is https (cookies get Secure) */
  secureCookies: boolean
  dataDir: string
  dbPath: string
  audioDir: string
  familyName: string
  familyTimezone: string
  anthropic: {
    apiKey: string | null
    model: string
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    fallbacks: boolean
    maxIterations: number
  }
  stt: {
    primary: SttProviderConfig | null
    fallback: SttProviderConfig | null
    ffmpegPath: string
    /** Settings for the local "whisper" provider (used only when it is the primary or fallback) */
    whisper: { python: string; device: string; idleMs: number }
  }
  webPush: { publicKey: string; privateKey: string; subject: string } | null
  wechat: {
    appId: string
    appSecret: string
    /** null = outbound only (no callback configured) */
    token: string | null
    templateId: string
    followQrUrl: string | null
  } | null
  scheduler: {
    intervalMs: number
    requestFollowupMin: number
    requestNoreplyMin: number
  }
}

/** Loads .env (if present) then validates process.env. Throws with a readable message on bad config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { loadDotEnv?: boolean } = {}): Config {
  if (opts.loadDotEnv !== false && env === process.env && existsSync('.env')) {
    process.loadEnvFile('.env')
    warnRenamedSettings(readFileSync('.env', 'utf8'))
  }
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n  ')
    throw new Error(`Invalid configuration:\n  ${issues}`)
  }
  const e = parsed.data
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const tz = e.FAMILY_TIMEZONE ?? systemTz
  if (!isValidTimezone(tz)) throw new Error(`Invalid FAMILY_TIMEZONE: ${tz}`)
  const dataDir = resolve(e.DATA_DIR)
  const publicUrl = e.PUBLIC_URL.replace(/\/+$/, '')
  const blank = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null)

  const vapidPublic = blank(e.VAPID_PUBLIC_KEY)
  const vapidPrivate = blank(e.VAPID_PRIVATE_KEY)

  return {
    port: e.PORT,
    host: e.HOST,
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    dataDir,
    dbPath: resolve(dataDir, 'family.db'),
    audioDir: resolve(dataDir, 'audio'),
    familyName: e.FAMILY_NAME,
    familyTimezone: tz,
    anthropic: {
      apiKey: blank(e.ANTHROPIC_API_KEY),
      model: e.AI_MODEL,
      effort: e.AI_EFFORT,
      fallbacks: e.AI_FALLBACKS ?? true,
      maxIterations: e.AI_MAX_ITERATIONS,
    },
    stt: {
      primary: sttPrimary(e, blank),
      fallback: sttFallback(e, blank),
      ffmpegPath: e.FFMPEG_PATH,
      whisper: { python: e.WHISPER_PYTHON, device: e.WHISPER_DEVICE, idleMs: Math.round(e.WHISPER_IDLE_MINUTES * 60_000) },
    },
    webPush: vapidPublic && vapidPrivate ? { publicKey: vapidPublic, privateKey: vapidPrivate, subject: e.VAPID_SUBJECT } : null,
    wechat:
      blank(e.WECHAT_APPID) && blank(e.WECHAT_APPSECRET) && blank(e.WECHAT_TEMPLATE_ID)
        ? {
            appId: blank(e.WECHAT_APPID)!,
            appSecret: blank(e.WECHAT_APPSECRET)!,
            token: blank(e.WECHAT_TOKEN),
            templateId: blank(e.WECHAT_TEMPLATE_ID)!,
            followQrUrl: blank(e.WECHAT_FOLLOW_QR_URL),
          }
        : null,
    scheduler: {
      intervalMs: e.SCHEDULER_INTERVAL_MS,
      requestFollowupMin: e.REQUEST_FOLLOWUP_MIN,
      requestNoreplyMin: e.REQUEST_NOREPLY_MIN,
    },
  }
}

const RENAMED: Record<string, string> = {
  CLAUDE_MODEL: 'AI_MODEL',
  CLAUDE_EFFORT: 'AI_EFFORT',
  CLAUDE_FALLBACKS: 'AI_FALLBACKS',
  CLAUDE_MAX_ITERATIONS: 'AI_MAX_ITERATIONS',
}

/** Old setting names in .env are ignored now; say so instead of silently using the defaults. */
export function warnRenamedSettings(dotEnv: string, warn: (msg: string) => void = m => console.warn(m)): string[] {
  const found = Object.keys(RENAMED).filter(k => new RegExp(`^\\s*${k}\\s*=`, 'm').test(dotEnv))
  for (const k of found) warn(`  WARNING: .env setting ${k} was renamed to ${RENAMED[k]}; ${k} is ignored.`)
  return found
}

/** Providers that run on this machine and need no API key. */
const KEYLESS_STT = new Set(['whisper'])

function sttPrimary(e: z.infer<typeof EnvSchema>, blank: (v: string | undefined) => string | null): SttProviderConfig | null {
  const key = blank(e.STT_API_KEY) ?? blank(e.OPENAI_API_KEY)
  const provider = (blank(e.STT_PROVIDER) ?? (key ? 'openai' : 'none')).toLowerCase()
  if (provider === 'none') return null
  if (KEYLESS_STT.has(provider)) return { provider, apiKey: '', model: blank(e.STT_MODEL), baseUrl: null }
  if (!key) return null
  return { provider, apiKey: key, model: blank(e.STT_MODEL), baseUrl: blank(e.STT_BASE_URL) }
}

function sttFallback(e: z.infer<typeof EnvSchema>, blank: (v: string | undefined) => string | null): SttProviderConfig | null {
  const provider = blank(e.STT_FALLBACK_PROVIDER)?.toLowerCase()
  if (!provider || provider === 'none') return null
  if (KEYLESS_STT.has(provider)) return { provider, apiKey: '', model: blank(e.STT_FALLBACK_MODEL), baseUrl: null }
  const key = blank(e.STT_FALLBACK_API_KEY)
  if (!key) return null
  return { provider, apiKey: key, model: blank(e.STT_FALLBACK_MODEL), baseUrl: blank(e.STT_FALLBACK_BASE_URL) }
}

/** Config for tests: in-memory paths, no external services. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'https://family.test',
    secureCookies: true,
    dataDir: '/tmp/family-share-test',
    dbPath: ':memory:',
    audioDir: '/tmp/family-share-test/audio',
    familyName: '测试家',
    familyTimezone: 'Australia/Sydney',
    anthropic: { apiKey: null, model: 'claude-opus-5-5', effort: 'medium', fallbacks: true, maxIterations: 6 },
    stt: { primary: null, fallback: null, ffmpegPath: 'ffmpeg', whisper: { python: 'python3', device: 'cpu', idleMs: 900_000 } },
    webPush: null,
    wechat: null,
    scheduler: { intervalMs: 30_000, requestFollowupMin: 120, requestNoreplyMin: 360 },
    ...overrides,
  }
}
