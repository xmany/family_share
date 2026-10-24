// `npm run family -- <command>`: family setup from the terminal, on the same database as the server.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import webpush from 'web-push'
import type { Family, Member, MemberRole } from '../../shared/types'
import { Bus } from '../bus'
import type { Config } from '../config'
import type { AppContext } from '../context'
import type { Db } from '../db/db'
import { openDb } from '../db/db'
import { createDomain } from '../domain/index'
import type { Domain } from '../domain/types'
import { DomainError } from '../domain/types'
import { sendTestNotification } from '../http/actions'
import { createInvite, sessionCounts } from '../http/auth'
import { revokeMemberAccess } from '../http/revoke'
import { Outbox } from '../notify/outbox'
import { pruneRecordings } from '../recordings'
import { createStt, mimeForExt, SttError } from '../stt/index'
import type { SttProvider } from '../stt/index'
import type { Clock } from '../time'
import { isValidTimezone, systemClock } from '../time'
import type { ParsedArgs } from './args'
import { CliError, parseArgs, requireFlag, splitList, stringFlag } from './args'

export const USAGE = `family_share 管理命令 (npm run family -- <command>)

  init --name <家名> --timezone <IANA>     create the family (or update its name/timezone)
                                           e.g. init --name 我们家 --timezone Australia/Sydney
  add --name <名字> [--aliases 她,媳妇] [--role adult|kid|relative]
                                           add a member and print their invite link
  invite --member <id 或名字>               new invite link (e.g. for a new phone)
  revoke --member <id 或名字>               lost phone: sign out everywhere, remove push devices, unbind WeChat,
                                           cancel their WeChat links and every invite they created
  list                                     family, members, sessions, push devices
  vapid                                    print a new VAPID key pair for .env (web push)
  test-notify --member <名字>               send a test notification to every device of a member
  stt-test [--file <录音>]                  check speech-to-text: transcribes the file, or (macOS) a Mandarin sentence
                                           spoken by the built-in Chinese voice; the first local-whisper run may download
                                           the model
  prune-audio --days <天数> [--dry-run]     delete voice recordings older than that from DATA_DIR/audio (transcripts
                                           stay); scripts/backup.sh runs it nightly when AUDIO_KEEP_DAYS is set

Invite links look like \${PUBLIC_URL}/join#token=… — open them on the member's phone
(Safari on iPhone, Chrome on Android; not inside WeChat). Each works up to 5 times within 7 days.`

const ROLES: readonly MemberRole[] = ['adult', 'kid', 'relative']

export interface CliDeps {
  config: Config
  out: (line: string) => void
  err: (line: string) => void
  clock?: Clock
  /** Use this database instead of opening config.dbPath (tests). It is not closed. */
  db?: Db
  /** Full context for test-notify (defaults to buildContext from ../app) */
  buildContext?: (config: Config) => AppContext
  /** stt-test: provider factory (defaults to createStt) */
  createStt?: (config: Config) => SttProvider | null
}

interface Light {
  db: Db
  domain: Domain
  clock: Clock
  close: () => void
}

function openLight(deps: CliDeps, opts: { ensureFamily: boolean }): Light {
  const db = deps.db ?? openDb(deps.config.dbPath)
  const clock = deps.clock ?? systemClock
  const bus = new Bus()
  const outbox = new Outbox(db, clock, bus)
  const domain = createDomain({ db, clock, bus, outbox, config: deps.config })
  if (opts.ensureFamily) domain.ensureFamily(deps.config.familyName, deps.config.familyTimezone)
  return { db, domain, clock, close: () => (deps.db ? undefined : db.close()) }
}

function familyOrNull(domain: Domain): Family | null {
  try {
    return domain.getFamily()
  } catch (e) {
    if (e instanceof DomainError && e.code === 'not_found') return null
    throw e
  }
}

/** Finds a member by id, exact name or alias (case-insensitive for ASCII). */
export function findMember(members: readonly Member[], key: string): Member | null {
  const k = key.trim()
  const lower = k.toLowerCase()
  return (
    members.find(m => m.id === k) ??
    members.find(m => m.name === k) ??
    members.find(m => m.name.toLowerCase() === lower) ??
    members.find(m => m.aliases.includes(k)) ??
    null
  )
}

function requireMember(domain: Domain, key: string): Member {
  const members = domain.listMembers()
  const m = findMember(members, key)
  if (!m) {
    const known = members.map(x => `${x.name} (${x.id})`).join(', ') || 'none — use `add` first'
    throw new CliError(`no member "${key}". Members: ${known}`)
  }
  return m
}

function printInvite(deps: CliDeps, member: Member, url: string, expiresAt: string) {
  deps.out(`成员 ${member.name} (${member.id}, ${member.role})`)
  deps.out(`邀请链接（7 天内有效，可用 5 次）/ invite link:`)
  deps.out(`  ${url}`)
  deps.out(`  expires ${expiresAt}`)
}

function cmdInit(args: ParsedArgs, deps: CliDeps) {
  const name = stringFlag(args, 'name')?.trim()
  const tz = stringFlag(args, 'timezone')?.trim()
  if (tz && !isValidTimezone(tz)) throw new CliError(`invalid --timezone "${tz}" (use an IANA name like Australia/Sydney)`)
  const l = openLight(deps, { ensureFamily: false })
  try {
    const existing = familyOrNull(l.domain)
    if (!existing) {
      const f = l.domain.ensureFamily(name || deps.config.familyName, tz || deps.config.familyTimezone)
      deps.out(`已创建家庭 / family created: ${f.name} · ${f.timezone}`)
    } else {
      if (name && name !== existing.name) l.db.prepare('UPDATE family SET name = ? WHERE id = 1').run(name)
      if (tz && tz !== existing.timezone) l.domain.setTimezone(tz)
      const f = l.domain.getFamily()
      deps.out(`家庭 / family: ${f.name} · ${f.timezone}${name || tz ? ' (updated)' : ''}`)
    }
    if (l.domain.listMembers().length === 0) deps.out('下一步 / next: npm run family -- add --name 老公 --aliases 他,孩子爸')
  } finally {
    l.close()
  }
}

function cmdAdd(args: ParsedArgs, deps: CliDeps) {
  const name = requireFlag(args, 'name', '<名字>, e.g. --name 老婆')
  const role = (stringFlag(args, 'role')?.trim() || 'adult') as MemberRole
  if (!ROLES.includes(role)) throw new CliError(`--role must be one of ${ROLES.join(', ')}`)
  const aliases = splitList(stringFlag(args, 'aliases'))
  const l = openLight(deps, { ensureFamily: true })
  try {
    const member = l.domain.createMember({ name, aliases, role })
    const inv = createInvite(l.db, l.clock, deps.config.publicUrl, member.id, null)
    printInvite(deps, member, inv.inviteUrl, inv.expiresAt)
  } finally {
    l.close()
  }
}

function cmdInvite(args: ParsedArgs, deps: CliDeps) {
  const key = requireFlag(args, 'member', '<id 或名字>')
  const l = openLight(deps, { ensureFamily: true })
  try {
    const member = requireMember(l.domain, key)
    const inv = createInvite(l.db, l.clock, deps.config.publicUrl, member.id, null)
    printInvite(deps, member, inv.inviteUrl, inv.expiresAt)
  } finally {
    l.close()
  }
}

function cmdRevoke(args: ParsedArgs, deps: CliDeps) {
  const key = requireFlag(args, 'member', '<id 或名字>')
  const l = openLight(deps, { ensureFamily: true })
  try {
    const member = requireMember(l.domain, key)
    const r = revokeMemberAccess(l.db, l.clock, member.id)
    deps.out(
      `${member.name}: ${r.sessions} session(s) signed out, ${r.invites} invite link(s) cancelled, ${r.pushDevices} push device(s) removed, ` +
        `WeChat ${r.wechatUnbound ? 'unbound' : 'not bound'}${r.bindCodes ? ` (${r.bindCodes} bind code(s) cancelled)` : ''}, links sent to WeChat (/t/…) cancelled.`,
    )
    if (r.createdInvites.length) {
      const names = new Map(l.domain.listMembers().map(m => [m.id, m.name]))
      deps.out(`Invite links ${member.name} created for others in the last 30 days (check each one; open ones are now cancelled):`)
      for (const inv of r.createdInvites) {
        deps.out(`  ${inv.createdAt}  for ${names.get(inv.memberId) ?? '?'} (${inv.memberId})  used ${inv.useCount}x${inv.cancelled ? '  → cancelled' : ''}`)
      }
      deps.out('  Used by a stranger, or a member you did not add: revoke that member too. Needed again: invite --member <名字>')
    }
    deps.out(`Send ${member.name} a new invite with: invite --member ${member.name} (then bind WeChat and turn on notifications again)`)
  } finally {
    l.close()
  }
}

function cmdList(deps: CliDeps) {
  const l = openLight(deps, { ensureFamily: true })
  try {
    const f = l.domain.getFamily()
    deps.out(`家庭 / family: ${f.name} · ${f.timezone}`)
    const members = l.domain.listMembers()
    if (!members.length) {
      deps.out('还没有成员 / no members yet: npm run family -- add --name <名字>')
      return
    }
    const sessions = sessionCounts(l.db)
    const pushRows = l.db.prepare('SELECT member_id, COUNT(*) AS n FROM push_subscriptions GROUP BY member_id').all() as { member_id: string; n: number }[]
    const push = new Map(pushRows.map(r => [r.member_id, r.n]))
    for (const m of members) {
      const aliases = m.aliases.length ? ` [${m.aliases.join('、')}]` : ''
      deps.out(
        `  ${m.id}  ${m.name}${aliases}  ${m.role}  sessions ${sessions.get(m.id) ?? 0}  push ${push.get(m.id) ?? 0}  quiet ${m.quietStart}-${m.quietEnd}  digest ${m.digestTime ?? 'off'}`,
      )
    }
  } finally {
    l.close()
  }
}

function cmdVapid(deps: CliDeps) {
  const keys = webpush.generateVAPIDKeys()
  deps.out('# add to .env (keep the private key secret; changing keys invalidates every push subscription)')
  deps.out(`VAPID_PUBLIC_KEY=${keys.publicKey}`)
  deps.out(`VAPID_PRIVATE_KEY=${keys.privateKey}`)
}

async function cmdTestNotify(args: ParsedArgs, deps: CliDeps) {
  const key = requireFlag(args, 'member', '<名字>')
  const build = deps.buildContext ?? (await import('../app')).buildContext
  const ctx = build(deps.config)
  try {
    const member = requireMember(ctx.domain, key)
    const channels = ctx.notifier.channels()
    deps.out(`channels configured on this server: ${channels.length ? channels.join(', ') : 'none'}`)
    // direct: the server may be running on this database; never run a scheduler tick from here
    const r = await sendTestNotification(ctx, member, { direct: true })
    deps.out(`test notification ${r.notificationId} → ${member.name}: status ${r.status}, reached ${r.delivered} device(s)`)
    const rows = ctx.db.prepare('SELECT channel, ok, error FROM deliveries WHERE notification_id = ? ORDER BY id').all(r.notificationId) as {
      channel: string
      ok: number
      error: string | null
    }[]
    for (const d of rows) deps.out(`  ${d.channel}: ${d.ok ? 'ok' : `failed${d.error ? ` (${d.error})` : ''}`}`)
    const n = ctx.outbox.get(r.notificationId)
    if (n?.lastError) deps.out(`  last error: ${n.lastError}`)
  } finally {
    ctx.scheduler.stop()
    if (!deps.db) ctx.db.close()
  }
}

const STT_SAMPLE = '明天早上你能带孩子出去吗？我九点有个会。旧柜子记得挂到 Facebook Marketplace 上，八十块。'

/** A 16 kHz WAV of STT_SAMPLE from macOS `say`, or null where there is no Chinese voice (or no `say`). */
function speakSample(dir: string): Buffer | null {
  const out = join(dir, 'sample.wav')
  for (const voice of ['Tingting', 'Meijia', 'Flo (Chinese (China mainland))']) {
    const r = spawnSync('say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@16000', '-o', out, STT_SAMPLE], { timeout: 30_000 })
    if (r.status === 0) {
      try {
        return readFileSync(out)
      } catch {
        return null
      }
    }
  }
  return null
}

async function cmdSttTest(args: ParsedArgs, deps: CliDeps) {
  const stt = deps.createStt ? deps.createStt(deps.config) : createStt(deps.config, { log: deps.err })
  if (!stt) {
    throw new CliError('speech-to-text is off: set STT_PROVIDER=whisper (with WHISPER_PYTHON), or STT_API_KEY / OPENAI_API_KEY in .env')
  }
  const file = stringFlag(args, 'file')
  const dir = mkdtempSync(join(tmpdir(), 'family-share-stt-test-'))
  try {
    let audio: Buffer
    let mime: string
    if (file) {
      audio = readFileSync(file)
      mime = mimeForExt(extname(file).slice(1).toLowerCase())
      deps.out(`audio   : ${file}`)
    } else {
      const sample = speakSample(dir)
      if (!sample) throw new CliError('no Chinese voice to make a sample (macOS `say`); record a short clip and pass --file clip.m4a')
      audio = sample
      mime = 'audio/wav'
      deps.out(`audio   : macOS voice saying「${STT_SAMPLE}」`)
    }
    deps.out(`provider: ${stt.name}`)
    const opts = {
      languages: ['zh', 'en'],
      keywords: ['老公', '老婆', '旧柜子', 'Facebook Marketplace'],
      prompt: '家庭成员之间的日常安排，普通话，可能夹杂英文。',
    }
    // twice: the first local-whisper run also loads (or downloads) the model
    for (const run of ['first run ', 'second run']) {
      const t0 = Date.now()
      const t = await stt.transcribe(audio, mime, opts)
      deps.out(`${run}: ${((Date.now() - t0) / 1000).toFixed(1)} s → ${t.text}`)
    }
  } finally {
    stt.dispose?.()
    rmSync(dir, { recursive: true, force: true })
  }
}

function cmdPruneAudio(args: ParsedArgs, deps: CliDeps) {
  const raw = requireFlag(args, 'days', '<天数>, e.g. --days 30')
  const days = Number(raw)
  if (!Number.isInteger(days) || days < 1) throw new CliError(`--days must be a whole number of days, 1 or more (got "${raw}")`)
  const dryRun = !!args.flags['dry-run']
  const db = deps.db ?? openDb(deps.config.dbPath)
  try {
    const now = (deps.clock ?? systemClock).now()
    const r = pruneRecordings(db, deps.config.audioDir, { olderThanDays: days, now, dryRun })
    const size = r.bytes < 1024 * 1024 ? `${Math.ceil(r.bytes / 1024)} KB` : `${(r.bytes / (1024 * 1024)).toFixed(1)} MB`
    const what = `${r.files} recording(s), ${size}, older than ${days} days in ${deps.config.audioDir}`
    deps.out(dryRun ? `dry run: would delete ${what}` : `deleted ${what} (transcripts kept)`)
  } finally {
    if (!deps.db) db.close()
  }
}

/** Runs one CLI invocation. Returns the process exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv)
  if (!args.command || args.flags.help || args.command === 'help') {
    deps.out(USAGE)
    return args.command && args.command !== 'help' && !args.flags.help ? 1 : 0
  }
  try {
    switch (args.command) {
      case 'init':
        cmdInit(args, deps)
        break
      case 'add':
        cmdAdd(args, deps)
        break
      case 'invite':
        cmdInvite(args, deps)
        break
      case 'revoke':
        cmdRevoke(args, deps)
        break
      case 'list':
        cmdList(deps)
        break
      case 'vapid':
        cmdVapid(deps)
        break
      case 'test-notify':
        await cmdTestNotify(args, deps)
        break
      case 'stt-test':
        await cmdSttTest(args, deps)
        break
      case 'prune-audio':
        cmdPruneAudio(args, deps)
        break
      default:
        deps.err(`unknown command "${args.command}"\n`)
        deps.out(USAGE)
        return 1
    }
    return 0
  } catch (e) {
    if (e instanceof CliError || e instanceof DomainError || e instanceof SttError) {
      deps.err(`error: ${e.message}`)
      return 1
    }
    throw e
  }
}

export { parseArgs }
