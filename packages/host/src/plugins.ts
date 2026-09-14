import { atemPlugin } from '@scheduler/plugin-atem'
import { youtubeProvider } from '@scheduler/plugin-youtube'
import { hyperdeckPlugin } from '@scheduler/plugin-hyperdeck'
import { mockPlugin } from '@scheduler/plugin-mock'
import { streamingEncoderPlugin } from '@scheduler/plugin-streaming-encoder'
import type { DestinationProvider, PluginDefinition } from '@scheduler/plugin-sdk'

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
  return [atemPlugin(), hyperdeckPlugin(), streamingEncoderPlugin(), mockPlugin()]
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
): DestinationProvider[] {
  return [youtubeProvider({ resolveClient })]
}
