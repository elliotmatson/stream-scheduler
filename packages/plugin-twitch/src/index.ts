import { SDK_API_VERSION } from '@scheduler/plugin-sdk'
import type {
  ConfigField,
  DestinationContext,
  DestinationInstance,
  DestinationMetadata,
  DestinationProvider,
  DestinationStatus,
  PrepareInput,
  PrepareResult,
} from '@scheduler/plugin-sdk'
import { MAX_TITLE, RateLimitedError, TwitchApi, type Fetch } from './api.js'
import {
  beginAuthorization,
  exchangeCode,
  ReauthRequiredError,
  RefreshingTokenSource,
  SCOPES,
} from './oauth.js'

/**
 * Twitch as a destination.
 *
 * **There is no broadcast to create.** A Twitch channel has one stream key
 * that never changes, and going live is just pushing to it. So this
 * provider is not YouTube's shape and pretending otherwise would be the
 * whole mistake: `prepare` creates nothing, `discard` has nothing to undo,
 * and `finalize` has nothing to close.
 *
 * What it does instead is the part people do by hand every week — set the
 * channel's title, and its category, from the event's own templates before
 * the service starts — and hand back the key it read rather than one
 * somebody pasted into a form a year ago.
 *
 * That makes two things true that were not before: the title on Twitch
 * matches the title everywhere else without anybody typing it twice, and a
 * rotated stream key fixes itself.
 */

const configSchema: ConfigField[] = [
  {
    type: 'static-text',
    id: 'about',
    label: 'How this works',
    value:
      'Twitch has no per-broadcast object: your channel has one stream key and going live is just ' +
      'pushing to it. So this sets the channel title and category from the event before it starts, ' +
      'and reads the key for you. There is no separate video created for each service.',
  },
  {
    type: 'textinput',
    id: 'category',
    label: 'Category',
    tooltip:
      'The Twitch category to put the channel in, by name — “Talk Shows & Podcasts” or “Music”, for ' +
      'example. Left blank, whatever the channel is already set to is kept. A name Twitch does not ' +
      'know is reported and otherwise ignored, so it can never stop a service going out.',
  },
  {
    type: 'textinput',
    id: 'language',
    label: 'Language',
    tooltip: 'A two-letter code such as en. Left blank, the channel keeps whatever it is set to.',
  },
]

class TwitchDestination implements DestinationInstance {
  constructor(
    private readonly ctx: DestinationContext,
    private readonly api: TwitchApi,
    /** The connected channel: its numeric id for the API, and its login name
     *  because that — not the id — is what twitch.tv/… takes.
     *
     *  Resolved on first use rather than at construction. Opening a
     *  destination must not reach Twitch: a dead grant has to surface
     *  through `status` as something the operator can act on, and it cannot
     *  if building the instance throws first. */
    private readonly channel: () => Promise<{ id: string; login: string }>,
    private readonly options: { category: string | undefined; language: string | undefined },
  ) {}

  /**
   * Points the channel at this service and returns where to push.
   *
   * Safe to run twice by construction rather than by bookkeeping: setting a
   * title to the value it already has is not an event, and the stream key
   * is read rather than issued. That is why `reconcile` can simply call
   * this — there is no half-created thing to find.
   */
  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const title = titleFor(input.metadata)
    const channel = await this.channel()
    const gameId = await this.categoryId()

    await this.ctx.quota.record('channels.modify', 1)
    await this.api.modifyChannel(channel.id, {
      // Twitch refuses an empty title, so a template that renders to nothing
      // would fail the service outright. Leaving last week's title up is a
      // far smaller problem than not going live.
      ...(title === '' ? {} : { title }),
      ...(gameId === undefined ? {} : { gameId }),
      ...(this.options.language ? { language: this.options.language } : {}),
    })

    await this.ctx.quota.record('streams.key', 1)
    const key = await this.api.streamKey(channel.id)
    const ingest = await this.api.ingest(key)

    return {
      // The channel, because there is nothing else to name. Stable across
      // every run, which is correct: every run points at the same place.
      externalId: channel.id,
      ingest: { url: ingest.url, key: ingest.key },
      // The channel, not a per-service video. Twitch has no such link until
      // the VOD exists, and it does not exist yet.
      watchUrl: `https://twitch.tv/${channel.login}`,
      detail: {
        ...(title === '' ? { titleUnchanged: true } : { title }),
        ingestServer: ingest.server,
        ...(gameId === undefined ? {} : { categoryId: gameId }),
        ...(this.options.category && gameId === undefined
          ? { categoryUnknown: this.options.category }
          : {}),
        // Said out loud, because somebody reading a run timeline expecting
        // a YouTube-style broadcast should find out here rather than by
        // going looking for a video that was never made.
        note: 'Twitch has no per-broadcast object. The channel title and category were set.',
      },
    }
  }

  /**
   * Nothing can be half-done, so this just does it again.
   *
   * An interrupted prepare on Twitch leaves no orphan: either the title was
   * set or it was not, and setting it again is the same operation. The
   * contract wants an answer about a previous attempt; the honest one here
   * is "it does not matter".
   */
  async reconcile(input: PrepareInput): Promise<PrepareResult | undefined> {
    return this.prepare(input)
  }

  /** Nothing was created, so there is nothing to remove. Deliberately not
   *  reverting the title: the previous one is not ours to remember, and
   *  guessing at it would be worse than leaving the last one up. */
  async discard(): Promise<void> {}

  /** Twitch closes the stream itself when the encoder stops. */
  async finalize(): Promise<void> {}

  async status(): Promise<DestinationStatus> {
    try {
      // Deliberately the live call rather than the memoised channel: this
      // method exists to say whether the credential works *now*, and one
      // that answered from a cache would report ok for a token that stopped
      // working an hour ago.
      await this.api.me()
      return { state: 'ok' }
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        return { state: 'reauth_required', message: error.message }
      }
      if (error instanceof RateLimitedError) {
        // Not exhausted: Twitch limits by the minute, so this clears on its
        // own and calling it quota_exhausted would read as "come back
        // tomorrow".
        return { state: 'error', message: error.message }
      }
      return { state: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async dispose(): Promise<void> {}

  /** The configured category's id, or undefined. Never throws: a category
   *  nobody can resolve is not a reason to fail a service. */
  private async categoryId(): Promise<string | undefined> {
    if (!this.options.category) return undefined
    try {
      const id = await this.api.gameIdByName(this.options.category)
      if (!id) {
        this.ctx.log('warn', 'Twitch has no category by that name, so the channel keeps its own', {
          category: this.options.category,
        })
      }
      return id
    } catch (error) {
      this.ctx.log('warn', 'could not look up the Twitch category', {
        category: this.options.category,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }
}

/**
 * The title, cut to what Twitch accepts.
 *
 * Twitch rejects anything over 140 characters outright, so a template that
 * renders long has to be shortened here — a refused PATCH would fail the
 * whole prepare over a title, which is not a trade anybody would choose.
 * The ellipsis is so the cut is visible rather than looking like the
 * template itself is broken.
 */
export function titleFor(metadata: DestinationMetadata): string {
  const title = metadata.title.trim()
  if (title.length <= MAX_TITLE) return title
  return `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`
}

export interface TwitchPluginOptions {
  now?: () => number
  fetchImpl?: Fetch
  /** Reads the client and refresh token for a connected account, and
   *  writes the refresh token back when Twitch rotates it. */
  resolveClient: (accountRef: string) => Promise<{
    client: { clientId: string; clientSecret: string }
    refreshToken: string
  }>
  saveRefreshToken: (accountRef: string, refreshToken: string) => Promise<void>
}

export function twitchProvider(options: TwitchPluginOptions): DestinationProvider {
  const now = options.now ?? Date.now

  return {
    id: 'twitch',
    displayName: 'Twitch',
    apiVersion: SDK_API_VERSION,
    configSchema,
    providesIngest: true,
    oauth: {
      begin: (client, redirectUri) =>
        beginAuthorization({ ...client, clientSecret: '' }, redirectUri),
      complete: async (client, pending, code) => {
        const tokens = await exchangeCode(client, pending, code, options.fetchImpl)

        // Name the channel, so the UI shows who was connected rather than
        // an opaque row. The token is used directly: it has not been
        // stored yet, so there is nothing to refresh from.
        const api = new TwitchApi(
          client.clientId,
          { accessToken: async () => tokens.access_token },
          options.fetchImpl,
        )
        const user = await api.me()

        return {
          externalId: user.id,
          displayName: user.display_name || user.login,
          refreshToken: tokens.refresh_token!,
          scopes: SCOPES,
        }
      },
    },
    async createDestination(ctx: DestinationContext): Promise<DestinationInstance> {
      const accountRef = String(ctx.config.accountRef ?? '')
      if (!accountRef) throw new ReauthRequiredError('no account is connected to this destination')

      const { client, refreshToken } = await options.resolveClient(accountRef)
      const tokens = new RefreshingTokenSource(
        client,
        refreshToken,
        // Twitch hands back a new refresh token on refresh and invalidates
        // the old one. Not writing it back is an outage a week later.
        (next) => options.saveRefreshToken(accountRef, next),
        now,
        options.fetchImpl,
      )
      const api = new TwitchApi(client.clientId, tokens, options.fetchImpl)

      // Asked rather than stored: the watch URL needs the login name, which
      // a channel's owner can change, and a stale one would send people to
      // somebody else's channel. Asked once per instance, not once per call.
      let channel: Promise<{ id: string; login: string }> | undefined
      const resolveChannel = async (): Promise<{ id: string; login: string }> => {
        channel ??= api.me().then((user) => ({ id: user.id, login: user.login }))
        return channel
      }

      const category = String(ctx.config.category ?? '').trim()
      const language = String(ctx.config.language ?? '').trim()

      return new TwitchDestination(ctx, api, resolveChannel, {
        category: category === '' ? undefined : category,
        language: language === '' ? undefined : language,
      })
    },
  }
}

export { MAX_TITLE, pickIngest, TwitchApi, TwitchApiError, RateLimitedError } from './api.js'
export { ReauthRequiredError, SCOPES } from './oauth.js'
