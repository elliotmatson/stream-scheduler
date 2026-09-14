import type { Clock, QuotaRecorder } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { localDateAt } from '../schedule/zoned.js'

/**
 * Google's daily quota resets at midnight Pacific, not local midnight and not
 * UTC. Keying the ledger by any other zone makes the budget wrong for most of
 * the world for part of every day.
 */
export const QUOTA_RESET_ZONE = 'America/Los_Angeles'

export interface LedgerQuotaOptions {
  db: Db
  clock: Clock
  provider: string
  /** Per OAuth client, because the budget belongs to the Google Cloud
   *  project rather than to the app. */
  clientRef: string
  limit: number
  runId?: string
}

export class LedgerQuota implements QuotaRecorder {
  constructor(private readonly options: LedgerQuotaOptions) {}

  async record(method: string, units: number): Promise<number> {
    this.options.db
      .prepare(
        `INSERT INTO quota_ledger (provider, client_ref, day, units, method, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.options.provider,
        this.options.clientRef,
        this.today(),
        units,
        method,
        this.options.runId ?? null,
        this.options.clock.now(),
      )
    return this.usedToday()
  }

  async usedToday(): Promise<number> {
    const row = this.options.db
      .prepare(
        'SELECT COALESCE(SUM(units), 0) AS used FROM quota_ledger WHERE provider = ? AND client_ref = ? AND day = ?',
      )
      .get(this.options.provider, this.options.clientRef, this.today()) as { used: number }
    return row.used
  }

  dailyLimit(): number {
    return this.options.limit
  }

  private today(): string {
    return localDateAt(this.options.clock.now(), QUOTA_RESET_ZONE)
  }
}
