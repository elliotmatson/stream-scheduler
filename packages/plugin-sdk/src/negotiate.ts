import type { Port, Transport } from './types.js'

export type LinkRejectionCode =
  'wrong-direction' | 'no-common-transport' | 'source-port-full' | 'target-port-full'

export type LinkNegotiation =
  { ok: true; transport: Transport } | { ok: false; code: LinkRejectionCode; reason: string }

export interface LinkUsage {
  /** Links already attached to the source port, excluding the one being tested. */
  fromLinks: number
  toLinks: number
}

/**
 * Decides whether an output port can feed an input port.
 *
 * This is what makes "extendable" structural rather than a promise: adding a
 * destination means declaring a port, and every incompatibility is caught when
 * the user draws the link instead of at 09:59 on a Sunday.
 */
export function negotiateLink(
  from: Port,
  to: Port,
  usage: LinkUsage = { fromLinks: 0, toLinks: 0 },
): LinkNegotiation {
  if (from.direction !== 'out' || to.direction !== 'in') {
    return {
      ok: false,
      code: 'wrong-direction',
      reason: 'A link must run from an output port to an input port.',
    }
  }

  const shared = from.transport.filter((t) => to.transport.includes(t))
  const transport = shared[0]
  if (transport === undefined) {
    return {
      ok: false,
      code: 'no-common-transport',
      reason: `${from.label} emits ${from.transport.join('/')} but ${to.label} accepts ${to.transport.join('/')}.`,
    }
  }

  if (usage.fromLinks >= from.maxLinks) {
    return {
      ok: false,
      code: 'source-port-full',
      reason:
        from.maxLinks === 1
          ? `${from.label} has a single output. Insert a relay to feed more than one destination.`
          : `${from.label} supports at most ${from.maxLinks} outputs.`,
    }
  }

  if (usage.toLinks >= to.maxLinks) {
    return {
      ok: false,
      code: 'target-port-full',
      reason: `${to.label} accepts at most ${to.maxLinks} ${to.maxLinks === 1 ? 'input' : 'inputs'}.`,
    }
  }

  return { ok: true, transport }
}
