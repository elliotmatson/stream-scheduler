import { SDK_API_VERSION, validateConfig } from '@scheduler/plugin-sdk'
import type { ConfigField, ConfigValues, PluginDefinition } from '@scheduler/plugin-sdk'

export class UnknownPluginError extends Error {
  constructor(id: string, known: string[]) {
    super(
      `No plugin with id "${id}". Loaded plugins: ${known.length > 0 ? known.join(', ') : 'none'}.`,
    )
    this.name = 'UnknownPluginError'
  }
}

export class IncompatiblePluginError extends Error {
  constructor(id: string, found: string) {
    super(
      `Plugin "${id}" targets SDK API version ${found}, but this build speaks ${SDK_API_VERSION}. ` +
        `Refusing to load it rather than failing in some subtler way later.`,
    )
    this.name = 'IncompatiblePluginError'
  }
}

export class ConfigInvalidError extends Error {
  readonly issues: { field: string; message: string }[]
  constructor(pluginId: string, issues: { field: string; message: string }[]) {
    super(
      `Configuration for "${pluginId}" is not valid: ${issues.map((i) => i.message).join('; ')}`,
    )
    this.name = 'ConfigInvalidError'
    this.issues = issues
  }
}

/**
 * The set of loaded plugins.
 *
 * Core never imports a plugin directly — it discovers them here — which is
 * what keeps "extendable" true rather than aspirational. A CI dependency rule
 * enforces the same thing at the module level.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, PluginDefinition>()

  register(plugin: PluginDefinition): this {
    if (plugin.apiVersion !== SDK_API_VERSION)
      throw new IncompatiblePluginError(plugin.id, plugin.apiVersion)
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin "${plugin.id}" is already registered.`)
    this.plugins.set(plugin.id, plugin)
    return this
  }

  get(id: string): PluginDefinition {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new UnknownPluginError(id, [...this.plugins.keys()])
    return plugin
  }

  has(id: string): boolean {
    return this.plugins.has(id)
  }

  list(): PluginDefinition[] {
    return [...this.plugins.values()]
  }

  configSchema(id: string): ConfigField[] {
    return this.get(id).configSchema
  }

  /** Validates a device's config against its plugin's declared fields. */
  assertValidConfig(id: string, values: ConfigValues): void {
    const issues = validateConfig(this.get(id).configSchema, values)
    if (issues.length > 0) throw new ConfigInvalidError(id, issues)
  }
}
