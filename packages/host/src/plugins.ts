import { atemPlugin } from '@scheduler/plugin-atem'
import { youtubeProvider } from '@scheduler/plugin-youtube'
import { hyperdeckPlugin } from '@scheduler/plugin-hyperdeck'
import { magewellPlugin } from '@scheduler/plugin-magewell'
import { mockPlugin } from '@scheduler/plugin-mock'
import { obsPlugin } from '@scheduler/plugin-obs'
import { planningCenterSource } from '@scheduler/plugin-planning-center'
import { propresenterPlugin } from '@scheduler/plugin-propresenter'
import { streamingEncoderPlugin } from '@scheduler/plugin-streaming-encoder'
import { twitchProvider } from '@scheduler/plugin-twitch'
import { vmixPlugin } from '@scheduler/plugin-vmix'
import type { DestinationProvider, PlanSource, PluginDefinition } from '@scheduler/plugin-sdk'

/**
 * The composition root's plugin list.
 *
 * This is the only place that names concrete plugins. `@scheduler/core`
 * discovers them through the registry and never imports one, which is what
 * keeps adding an encoder a matter of writing a package rather than editing
 * the scheduler. A CI dependency rule enforces it.
 *
 * v2 adds loading plugins by npm package name into child processes; the SDK
 * contract does not change, which is the point of freezing it now.
 */
export function bundledPlugins(): PluginDefinition[] {
  return [
    atemPlugin(),
    hyperdeckPlugin(),
    streamingEncoderPlugin(),
    obsPlugin(),
    propresenterPlugin(),
    vmixPlugin(),
    magewellPlugin(),
    mockPlugin(),
  ]
}

/**
 * The streaming services this build ships with.
 *
 * `resolveClient` is injected by the host so the provider never touches the
 * database or the vault: it asks for credentials and gets them.
 */
export function bundledDestinations(
  resolveClient: (accountRef: string) => Promise<{
    client: { clientId: string; clientSecret: string }
    refreshToken: string
  }>,
  /** Writes a rotated refresh token back. Twitch hands out a new one on
   *  refresh and invalidates the old, so a provider with nowhere to put it
   *  works until the first refresh and then locks the account out. */
  saveRefreshToken: (accountRef: string, refreshToken: string) => Promise<void>,
): DestinationProvider[] {
  return [youtubeProvider({ resolveClient }), twitchProvider({ resolveClient, saveRefreshToken })]
}

/**
 * The schedule sources this build ships with.
 *
 * `resolveCredentials` is injected by the host for the same reason the
 * destinations' `resolveClient` is: a source asks for its token and is
 * given one, and never learns that a vault exists.
 */
export function bundledPlanSources(
  resolveCredentials: (
    sourceId: string,
  ) => Promise<{ applicationId: string; secret: string } | undefined>,
): PlanSource[] {
  return [planningCenterSource({ resolveCredentials: () => resolveCredentials('planning-center') })]
}
