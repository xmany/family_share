// "Is this file the process entry point?" for ESM modules that are also imported (tests, bundles).

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * True when `argv1` (process.argv[1]) names the module at `metaUrl` (import.meta.url). Node resolves symlinks for
 * import.meta.url but keeps argv[1] as typed, so both sides are compared by real path.
 */
export function isMainModule(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false
  try {
    return real(argv1) === real(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}
