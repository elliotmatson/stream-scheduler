import type { Db } from '../db/index.js'

/**
 * When the scheduler decides something is worth saying.
 *
 * These were constants, which is fine until somebody's uplink normally sits
 * at eighty-five per cent, or a church records to a card that never holds
 * more than forty minutes. Then a fixed threshold is either a siren nobody
 * can switch off or a warning that never comes.
 *
 * Kept in the `setting` table rather than a file: there is one place this
 * app keeps its configuration and it is the database, which is also what
 * makes a backup a backup.
 */

export interface NotificationThresholds {
  /** A device's cache this full, while it is on air, is worth saying. */
  cacheWarningPercent: number
  /** Recording time left on the slot in use, below which it is worth saying. */
  mediaWarningMinutes: number
}

export const DEFAULT_THRESHOLDS: NotificationThresholds = {
  // Eighty rather than a hundred: at a hundred the stream has already gone.
  cacheWarningPercent: 80,
  // An hour is a service and a bit, so a card below it will not see the
  // morning out.
  mediaWarningMinutes: 60,
}

const KEYS: Record<keyof NotificationThresholds, string> = {
  cacheWarningPercent: 'notify_cache_warning_percent',
  mediaWarningMinutes: 'notify_media_warning_minutes',
}

/** Bounds that keep a typo from switching the warnings off altogether. */
const LIMITS: Record<keyof NotificationThresholds, { min: number; max: number }> = {
  cacheWarningPercent: { min: 1, max: 100 },
  mediaWarningMinutes: { min: 1, max: 24 * 60 },
}

export class Thresholds {
  private readonly db: Db

  constructor(init: { db: Db }) {
    this.db = init.db
  }

  get(): NotificationThresholds {
    return {
      cacheWarningPercent: this.read('cacheWarningPercent'),
      mediaWarningMinutes: this.read('mediaWarningMinutes'),
    }
  }

  /** Same shape, in the units the rest of the app works in. */
  get mediaWarningMs(): number {
    return this.read('mediaWarningMinutes') * 60_000
  }

  set(input: Partial<NotificationThresholds>): NotificationThresholds {
    for (const key of Object.keys(KEYS) as (keyof NotificationThresholds)[]) {
      const value = input[key]
      if (value === undefined) continue
      const { min, max } = LIMITS[key]
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${key} has to be between ${min} and ${max}.`)
      }
      this.db
        .prepare(
          `INSERT INTO setting (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(KEYS[key], String(value))
    }
    return this.get()
  }

  private read(key: keyof NotificationThresholds): number {
    const row = this.db.prepare('SELECT value FROM setting WHERE key = ?').get(KEYS[key]) as
      { value: string } | undefined
    const parsed = row === undefined ? Number.NaN : Number(row.value)
    // A setting nobody has touched, or one that somehow got written as
    // nonsense, falls back rather than switching a warning off.
    return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLDS[key]
  }
}
