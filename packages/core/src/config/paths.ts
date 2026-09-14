import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * One directory holds everything: database, logs, key file, plugin data.
 * A single zip of it is the backup, which is the whole recovery story.
 */
export interface Paths {
  configDir: string
  databaseFile: string
  logDir: string
  keyFile: string
}

export function resolveConfigDir(explicit?: string): string {
  const fromArg = explicit ?? argValue('--config-dir') ?? process.env.SCHEDULER_CONFIG_DIR
  if (fromArg) return fromArg

  const home = homedir()
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'StreamScheduler')
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'StreamScheduler')
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'stream-scheduler')
  }
}

export function resolvePaths(explicit?: string): Paths {
  const configDir = resolveConfigDir(explicit)
  const paths: Paths = {
    configDir,
    databaseFile: join(configDir, 'scheduler.db'),
    logDir: join(configDir, 'logs'),
    keyFile: join(configDir, 'master.key'),
  }
  mkdirSync(paths.configDir, { recursive: true })
  mkdirSync(paths.logDir, { recursive: true })
  return paths
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}
