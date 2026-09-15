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
  /**
   * Where scheduled backups are written.
   *
   * Separate from `configDir`, and settable with `SCHEDULER_BACKUP_DIR`,
   * because the point of a backup is to not be on the thing that failed.
   * In Docker this is a second volume, so where it really lives is a
   * compose decision; the app only needs somewhere to put files.
   */
  backupDir: string
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
    backupDir: resolveBackupDir(configDir),
  }
  mkdirSync(paths.configDir, { recursive: true })
  mkdirSync(paths.logDir, { recursive: true })
  // Deliberately not created here. On a mounted volume this directory is
  // the mount, and making it eagerly would hide a mount that failed behind
  // an empty directory on the container's own disk.
  return paths
}

export function resolveBackupDir(configDir: string): string {
  const fromEnv = argValue('--backup-dir') ?? process.env.SCHEDULER_BACKUP_DIR
  // Under the config directory by default, which is honest about what it
  // protects: a bad restore or a mistaken bulk delete, not a dead disk.
  // Pointing it elsewhere is one environment variable.
  return fromEnv?.trim() ? fromEnv.trim() : join(configDir, 'backups')
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}
