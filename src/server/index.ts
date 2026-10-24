// Server entry: loadConfig → buildContext → createApp → listen → scheduler.start(); graceful shutdown.

import { spawnSync } from 'node:child_process'
import { serve } from '@hono/node-server'
import { buildContext, drainBackgroundWork, recoverInterruptedUtterances } from './app'
import { loadConfig } from './config'
import type { Config } from './config'
import type { AppContext } from './context'
import { createApp, StreamRegistry } from './http/app'

const SHUTDOWN_GRACE_MS = 10_000
/**
 * Time allowed to receive a whole request (Node's default is 300 s, so a client on the public Funnel URL could keep a
 * connection busy for 5 minutes by sending slowly). 90 s still fits a 60 s recording over a slow phone connection.
 * Only receiving the request counts: a slow answer (the interpreter) or an open SSE stream is not cut.
 */
const REQUEST_TIMEOUT_MS = 90_000

/** Whether FFMPEG_PATH runs (checked once at start; uploads are normalized with it; qwen and whisper need it). */
function ffmpegWorks(path: string): boolean {
  try {
    return spawnSync(path, ['-hide_banner', '-version'], { timeout: 5000, stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/** STT_PROVIDER=whisper: the Python in WHISPER_PYTHON must be able to import openai-whisper (checked once at start). */
function whisperWorks(python: string): { ok: true } | { ok: false; why: string } {
  try {
    const r = spawnSync(python, ['-c', 'import whisper'], { timeout: 60_000, encoding: 'utf8' })
    if (r.error) return { ok: false, why: r.error.message }
    if (r.status !== 0) return { ok: false, why: (r.stderr ?? '').trim().split('\n').pop() || `exit ${r.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * qwen and local whisper only take the WAV ffmpeg makes, and whisper also needs its Python. When no configured
 * provider can work, voice is switched off instead of failing every recording (the app then hides the mic and
 * keyboard dictation still works).
 */
function checkSpeech(config: Config, ctx: AppContext): string {
  if (!ctx.stt) return ''
  const ffmpeg = ffmpegWorks(config.stt.ffmpegPath)
  const providers = [config.stt.primary, config.stt.fallback].flatMap(p => (p ? [p.provider] : []))
  const problems: string[] = []
  const usable = providers.filter(p => {
    if ((p === 'qwen' || p === 'whisper') && !ffmpeg) {
      problems.push(`${p} needs ffmpeg, but "${config.stt.ffmpegPath}" does not run (install it or set FFMPEG_PATH)`)
      return false
    }
    if (p === 'whisper') {
      const w = whisperWorks(config.stt.whisper.python)
      if (!w.ok) {
        problems.push(`whisper: "${config.stt.whisper.python}" cannot import whisper (${w.why}); set WHISPER_PYTHON`)
        return false
      }
    }
    return true
  })
  for (const p of problems) console.warn(`  WARNING: ${p}.`)
  if (!usable.length) {
    console.warn('  Voice input is off; keyboard dictation still works.')
    ctx.stt.dispose?.()
    ctx.stt = null
    return `off (${problems.join('; ')})`
  }
  return ffmpeg ? ' · ffmpeg ok' : ` · ffmpeg not found at "${config.stt.ffmpegPath}" (recordings are sent as recorded)`
}

function summary(config: Config, ctx: AppContext, speechNote: string): string[] {
  const members = ctx.domain.listMembers()
  const family = ctx.domain.getFamily()
  const on = (v: boolean) => (v ? 'on' : 'off')
  const wechat = config.wechat ? (config.wechat.token ? 'on (template messages + callback /wechat/mp)' : 'on (outbound only; set WECHAT_TOKEN for the callback)') : 'off'
  return [
    `family_share listening on http://${config.host}:${config.port}`,
    `  public URL : ${config.publicUrl}${config.secureCookies ? '' : '  (not https: cookies are not Secure, push/mic need https on phones)'}`,
    `  family     : ${family.name} · ${family.timezone}`,
    `  AI         : ${ctx.interpreter.enabled ? `on (${config.anthropic.model}, effort ${config.anthropic.effort})` : 'off (set ANTHROPIC_API_KEY)'}`,
    `  speech     : ${ctx.stt ? `on (${ctx.stt.name})${speechNote}` : speechNote || 'off (keyboard dictation only; set STT_PROVIDER=whisper, STT_API_KEY or OPENAI_API_KEY)'}`,
    `  web push   : ${on(!!config.webPush)}${config.webPush ? '' : ' (run: npm run family -- vapid)'}`,
    `  WeChat     : ${wechat}`,
    `  members    : ${members.length}${members.length ? ` (${members.map(m => m.name).join('、')})` : ''}`,
  ]
}

function main(): void {
  const config = loadConfig()
  const ctx = buildContext(config)
  const recovered = recoverInterruptedUtterances(ctx)
  if (recovered) console.warn(`  ${recovered} utterance(s) interrupted by the last shutdown were marked as failed`)
  const speechNote = checkSpeech(config, ctx)
  const streams = new StreamRegistry()
  const app = createApp(ctx, { streams })

  const serverOptions = { requestTimeout: REQUEST_TIMEOUT_MS }
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host, serverOptions }, () => {
    for (const line of summary(config, ctx, speechNote)) console.log(line)
    if (ctx.domain.listMembers().length === 0) {
      console.warn('\n  WARNING: no family members yet. Add the first adult and open the printed invite link on their phone:')
      console.warn('      npm run family -- add --name 老公 --aliases 他,孩子爸 --role adult\n')
    }
    ctx.scheduler.start()
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use (set PORT).` : err)
    process.exit(1)
  })

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) {
      console.warn('Forced exit.')
      process.exit(1)
    }
    stopping = true
    console.log(`\n${signal}: shutting down…`)
    ctx.scheduler.stop()
    streams.closeAll() // SSE connections would otherwise keep the server open
    // in-flight work (an utterance being interpreted, a WeChat reply in the background) gets 10 s in total
    const deadline = Date.now() + SHUTDOWN_GRACE_MS
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      ctx.stt?.dispose?.()
      try {
        ctx.db.close()
      } catch {
        // already closed
      }
      process.exit(0)
    }
    server.close(() => {
      // HTTP is done; WeChat messages are acknowledged at once and answered in the background, and the stopped
      // scheduler may still be sending one row — let both finish before the database closes
      void drainBackgroundWork(ctx, deadline - Date.now()).then(ok => {
        if (!ok) console.warn('Background work did not finish in time; it will be marked as failed on the next start.')
        finish()
      })
    })
    if ('closeIdleConnections' in server) server.closeIdleConnections()
    setTimeout(() => {
      if ('closeAllConnections' in server) server.closeAllConnections()
      finish()
    }, SHUTDOWN_GRACE_MS).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

try {
  main()
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
