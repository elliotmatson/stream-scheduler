import { SDK_API_VERSION } from '@scheduler/plugin-sdk'
import type { PlanSource, PlanSourceStatus } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { IncompatiblePluginError, UnknownPluginError } from '../plugins/registry.js'
import type { SecretVault } from '../secrets/vault.js'

/**
 * The places a schedule can come from, and the credentials for them.
 *
 * Parallel to `DestinationRegistry`, and for the same reason: core discovers
 * sources rather than importing one, so another church management system is
 * a package rather than an edit here.
 *
 * The credential half lives here rather than in the source because a plugin
 * must never touch the vault — the same rule the OAuth providers follow.
 * What is stored is a Personal Access Token: an application id and a secret,
 * the pair Planning Center issues to read your own account.
 */

/** Where the token's public half lives. The secret half is in the vault. */
export const APPLICATION_ID_KEY = (sourceId: string): string => `plan_source.${sourceId}.app_id`

/** The vault reference for the secret half. Fixed per source, so replacing a
 *  token overwrites rather than accumulating dead secrets. */
export const SECRET_REF = (sourceId: string): string => `plan_source.${sourceId}`

export interface PlanCredentials {
  applicationId: string
  secret: string
}

export class PlanSourceRegistry {
  private readonly sources = new Map<string, PlanSource>()

  constructor(
    private readonly deps: {
      db: Db
      vault: SecretVault
    },
  ) {}

  register(source: PlanSource): this {
    if (source.apiVersion !== SDK_API_VERSION) {
      throw new IncompatiblePluginError(source.id, source.apiVersion)
    }
    if (this.sources.has(source.id)) {
      throw new Error(`Plan source "${source.id}" is already registered.`)
    }
    this.sources.set(source.id, source)
    return this
  }

  get(id: string): PlanSource {
    const source = this.sources.get(id)
    if (!source) throw new UnknownPluginError(id, [...this.sources.keys()])
    return source
  }

  has(id: string): boolean {
    return this.sources.has(id)
  }

  list(): PlanSource[] {
    return [...this.sources.values()]
  }

  /**
   * The stored token for a source, or undefined.
   *
   * Both halves or neither: a saved application id with a missing secret is
   * not a usable credential, and returning it would produce a confusing
   * "rejected" where "not set up" is the truth.
   */
  credentials(sourceId: string): PlanCredentials | undefined {
    const row = this.deps.db
      .prepare('SELECT value FROM setting WHERE key = ?')
      .get(APPLICATION_ID_KEY(sourceId)) as { value: string } | undefined
    const applicationId = row?.value
    if (!applicationId) return undefined

    const ref = SECRET_REF(sourceId)
    if (!this.deps.vault.has(ref)) return undefined
    return { applicationId, secret: this.deps.vault.reveal(ref) }
  }

  /** Saves a token, replacing whatever was there. */
  saveCredentials(sourceId: string, credentials: PlanCredentials): void {
    this.deps.db
      .prepare(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(APPLICATION_ID_KEY(sourceId), credentials.applicationId)
    this.deps.vault.store(credentials.secret, SECRET_REF(sourceId))
  }

  /** Forgets a token. The secret goes from the vault, not just the index. */
  clearCredentials(sourceId: string): void {
    this.deps.db.prepare('DELETE FROM setting WHERE key = ?').run(APPLICATION_ID_KEY(sourceId))
    this.deps.vault.delete(SECRET_REF(sourceId))
  }

  /** Every source with whether it is set up and whether it works. */
  async statuses(): Promise<{ id: string; displayName: string; status: PlanSourceStatus }[]> {
    return Promise.all(
      this.list().map(async (source) => ({
        id: source.id,
        displayName: source.displayName,
        status: await source.check(),
      })),
    )
  }
}
