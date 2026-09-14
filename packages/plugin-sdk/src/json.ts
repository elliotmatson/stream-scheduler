/** The only shapes allowed to cross the plugin boundary. See docs/plan/04-plugin-sdk.md. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/**
 * True when `value` survives a structured clone with its meaning intact.
 *
 * The plugin API is defined as message-passing shaped so that moving plugins
 * from in-process (v1) to child processes (v2) is a transport swap rather than
 * an API change. That only holds if nothing non-serializable ever crosses, so
 * the test harness runs every call through this check.
 */
export function isSerializable(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      return false
  }
  if (seen.has(value)) return false // a cycle survives structuredClone but not JSON transports
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.every((item) => isSerializable(item, seen))
    // A class instance carries behaviour that will not survive the boundary.
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(value as Record<string, unknown>).every((v) => isSerializable(v, seen))
  } finally {
    seen.delete(value)
  }
}
