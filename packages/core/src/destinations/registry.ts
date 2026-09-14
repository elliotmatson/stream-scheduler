import { SDK_API_VERSION, validateConfig } from '@scheduler/plugin-sdk'
import type {
  ConfigValues,
  DestinationContext,
  DestinationInstance,
  DestinationProvider,
} from '@scheduler/plugin-sdk'
import type { Clock } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { silentLogger, type Logger } from '../log.js'
import {
  ConfigInvalidError,
  IncompatiblePluginError,
  UnknownPluginError,
} from '../plugins/registry.js'
import type { SecretVault } from '../secrets/vault.js'
import { LedgerQuota } from './quota.js'

export interface DestinationRow {
  id: string
  plugin_id: string
  label: string
  account_id: string | null
  config: string
}

export interface AccountRow {
  id: string
  provider: string
  external_id: string
  display_name: string
  secret_ref: string
  oauth_client_ref: string | null
  scopes: string
  status: string
}

/** The default daily budget of a Google Cloud project. */
export const DEFAULT_QUOTA_LIMIT = 10_000

/**
 * The set of loaded streaming services, and the factory that turns a stored
 * destination row into a live instance.
 *
 * Parallel to `PluginRegistry`, and for the same reason: core discovers
 * providers here rather than importing one, so adding a service is a matter
 * of writing a package.
 */
export class DestinationRegistry {
  private readonly providers = new Map<string, DestinationProvider>()

  constructor(
    private readonly deps: {
      db: Db
      clock: Clock
      vault: SecretVault
      logger?: Logger
      quotaLimit?: number
    },
  ) {}

  register(provider: DestinationProvider): this {
    if (provider.apiVersion !== SDK_API_VERSION) {
      throw new IncompatiblePluginError(provider.id, provider.apiVersion)
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Destination provider "${provider.id}" is already registered.`)
    }
    this.providers.set(provider.id, provider)
    return this
  }

  get(id: string): DestinationProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new UnknownPluginError(id, [...this.providers.keys()])
    return provider
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }

  list(): DestinationProvider[] {
    return [...this.providers.values()]
  }

  assertValidConfig(id: string, values: ConfigValues): void {
    const issues = validateConfig(this.get(id).configSchema, values)
    if (issues.length > 0) throw new ConfigInvalidError(id, issues)
  }

  /**
   * Builds a live destination from its stored row.
   *
   * Created per use rather than held open: these are stateless HTTP clients,
   * and a long-lived one would just hold a stale access token.
   */
  async open(
    destinationId: string,
    options: { runId?: string } = {},
  ): Promise<DestinationInstance> {
    const row = this.deps.db
      .prepare('SELECT * FROM destination WHERE id = ?')
      .get(destinationId) as DestinationRow | undefined
    if (!row) throw new Error(`No destination with id "${destinationId}".`)

    const provider = this.get(row.plugin_id)
    return provider.createDestination(
      this.contextFor({
        destinationId,
        providerId: row.plugin_id,
        accountRef: row.account_id,
        config: JSON.parse(row.config) as ConfigValues,
        ...(options.runId === undefined ? {} : { runId: options.runId }),
      }),
    )
  }

  /**
   * An instance for an account that has no destination yet.
   *
   * What lets a form ask the service what it offers — a channel's playlists,
   * say — before anything has been saved. Nothing is written by opening one.
   */
  async openForAccount(providerId: string, accountRef: string): Promise<DestinationInstance> {
    const provider = this.get(providerId)
    return provider.createDestination(
      this.contextFor({
        destinationId: `account:${accountRef}`,
        providerId,
        accountRef,
        config: {},
      }),
    )
  }

  private contextFor(input: {
    destinationId: string
    providerId: string
    accountRef: string | null
    config: ConfigValues
    runId?: string
  }): DestinationContext {
    const { destinationId } = input
    const logger = (this.deps.logger ?? silentLogger).child({ destinationId })

    return {
      destinationId,
      config: { ...input.config, accountRef: input.accountRef ?? '' },
      log: (level, message, data) => logger[level](message, data),
      quota: new LedgerQuota({
        db: this.deps.db,
        clock: this.deps.clock,
        provider: input.providerId,
        // Budget belongs to the Google Cloud project behind the account, so
        // two destinations on one account share one ledger.
        clientRef: this.clientRefFor(input.accountRef),
        limit: this.deps.quotaLimit ?? DEFAULT_QUOTA_LIMIT,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      }),
      secrets: {
        read: async (ref) => (this.deps.vault.has(ref) ? this.deps.vault.reveal(ref) : undefined),
        write: async (ref, value) => {
          this.deps.vault.store(value, ref)
        },
      },
    }
  }

  /** The OAuth credentials a provider needs for an account. */
  resolveOAuthClient(accountRef: string): {
    clientId: string
    clientSecret: string
    refreshToken: string
  } {
    const account = this.deps.db.prepare('SELECT * FROM account WHERE id = ?').get(accountRef) as
      AccountRow | undefined
    if (!account) throw new Error(`No connected account with id "${accountRef}".`)
    if (!account.oauth_client_ref) {
      throw new Error(`Account "${account.display_name}" has no OAuth client; reconnect it.`)
    }

    const client = this.deps.db
      .prepare('SELECT client_id, secret_ref FROM oauth_client WHERE id = ?')
      .get(account.oauth_client_ref) as { client_id: string; secret_ref: string } | undefined
    if (!client) throw new Error('The OAuth client for this account is missing; reconnect it.')

    return {
      clientId: client.client_id,
      clientSecret: this.deps.vault.reveal(client.secret_ref),
      refreshToken: this.deps.vault.reveal(account.secret_ref),
    }
  }

  private clientRefFor(accountId: string | null): string {
    if (!accountId) return 'unattached'
    const row = this.deps.db
      .prepare('SELECT oauth_client_ref FROM account WHERE id = ?')
      .get(accountId) as { oauth_client_ref: string | null } | undefined
    return row?.oauth_client_ref ?? accountId
  }
}
