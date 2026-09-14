import { mockPlugin } from '@scheduler/plugin-mock'
import type { PluginDefinition } from '@scheduler/plugin-sdk'

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
  return [mockPlugin()]
}
