// CLI entry: `npm run family -- <command>` (see USAGE in ./commands). Uses loadConfig() and the same
// SQLite database as the server, so it can run while the server is up.

import { loadConfig } from '../config'
import { runCli } from './commands'
import { isMainModule } from './main'

export { findMember, runCli, USAGE } from './commands'
export { parseArgs, splitList } from './args'

async function main(): Promise<void> {
  let code: number
  try {
    const config = loadConfig()
    code = await runCli(process.argv.slice(2), {
      config,
      out: line => console.log(line),
      err: line => console.error(line),
    })
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    code = 1
  }
  process.exit(code)
}

if (isMainModule(process.argv[1], import.meta.url)) void main()
