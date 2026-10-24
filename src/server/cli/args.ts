// Tiny argv parser for `npm run family -- <command> [--flag value] [--flag=value] [--bool]`.

export interface ParsedArgs {
  command: string | null
  flags: Record<string, string | true>
  positionals: string[]
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {}
  const positionals: string[] = []
  let command: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !(next.startsWith('-') && next.length > 1)) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
      continue
    }
    if (a === '-h') {
      flags.help = true
      continue
    }
    if (command === null) command = a
    else positionals.push(a)
  }
  return { command, flags, positionals }
}

/** A string flag value, or undefined when absent. A bare `--name` (no value) is an error. */
export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name]
  if (v === undefined) return undefined
  if (v === true) throw new CliError(`--${name} needs a value`)
  return v
}

export function requireFlag(args: ParsedArgs, name: string, hint: string): string {
  const v = stringFlag(args, name)?.trim()
  if (!v) throw new CliError(`missing --${name} ${hint}`)
  return v
}

/** "她,媳妇，孩子妈、老婆" → ["她", "媳妇", "孩子妈", "老婆"] (ASCII/full-width commas, 、 and ;). */
export function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[,，、;；]/)
    .map(s => s.trim())
    .filter(Boolean)
}

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}
