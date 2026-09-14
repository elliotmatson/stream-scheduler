import { DeviceError } from './errors.js'
import type { JsonObject } from './json.js'
import type {
  DeviceCapabilities,
  DeviceInstance,
  HealthReport,
  InvokableAction,
  NodeActions,
  NodeDefinition,
  NodeState,
  StreamTarget,
} from './types.js'

export interface DeviceSpec {
  probe(): Promise<DeviceCapabilities>
  health(): Promise<HealthReport>
  listNodes(): Promise<NodeDefinition[]>
  /** Actions for one node. Called per invoke, so a plugin can look up live
   *  per-node handlers rather than building them all up front. */
  actionsFor(nodeId: string): NodeActions | undefined
  dispose(): Promise<void>
}

/**
 * Turns the ergonomic `NodeActions` shape into the wire-shaped `DeviceInstance`
 * the host consumes. Plugin authors write methods; the host gets `invoke`.
 */
export function defineDevice(spec: DeviceSpec): DeviceInstance {
  return {
    probe: () => spec.probe(),
    health: () => spec.health(),
    listNodes: () => spec.listNodes(),
    dispose: () => spec.dispose(),
    async invoke(
      nodeId: string,
      action: InvokableAction,
      args: JsonObject = {},
    ): Promise<NodeState | null> {
      const actions = spec.actionsFor(nodeId)
      if (!actions) {
        throw new DeviceError('unknown-node', `This device has no node "${nodeId}".`)
      }

      if (action === 'readState') return actions.readState()

      // The one action that answers with something other than state. It is
      // kept off the NodeState path deliberately: a format token is a
      // one-shot capability, not a property of the device.
      if (action === 'formatStorage') {
        if (!actions.formatStorage) {
          throw new DeviceError('unsupported-action', `"${nodeId}" cannot format its storage.`)
        }
        const slot = args.slot
        if (typeof slot !== 'number' || !Number.isInteger(slot)) {
          throw new DeviceError('bad-argument', '"slot" must be a slot number.')
        }
        const result = await actions.formatStorage({
          slot,
          ...(typeof args.confirm === 'string' && args.confirm ? { confirm: args.confirm } : {}),
        })
        return { raw: result.confirm === undefined ? {} : { confirm: result.confirm } }
      }

      const handler = actions[action]
      if (!handler) {
        throw new DeviceError(
          'unsupported-action',
          `"${action}" is not supported by node "${nodeId}".`,
          {
            remediation: 'The device model was probed as not having this capability.',
          },
        )
      }

      switch (action) {
        case 'applyStreamTarget':
          await actions.applyStreamTarget!(readStreamTarget(args))
          break
        case 'startRecording':
          await actions.startRecording!({
            filename: readString(args, 'filename'),
            ...(typeof args.slot === 'number' ? { slot: args.slot } : {}),
            // A recorder may share its encoder with the streaming side, in
            // which case the quality has to be set on the way in rather
            // than with a stream target the recording does not have.
            ...(typeof args.quality === 'string' && args.quality ? { quality: args.quality } : {}),
          })
          break
        case 'selectSlot': {
          const slot = args.slot
          if (typeof slot !== 'number' || !Number.isInteger(slot)) {
            throw new DeviceError('bad-argument', '"slot" must be a slot number.')
          }
          await actions.selectSlot!({ slot })
          break
        }
        case 'route':
          await actions.route!({
            input: readString(args, 'input'),
            output: readString(args, 'output'),
          })
          break
        case 'startStreaming':
        case 'stopStreaming':
        case 'stopRecording':
          await (handler as () => Promise<void>)()
          break
      }
      return null
    },
  }
}

function readString(args: JsonObject, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') {
    throw new DeviceError('bad-argument', `"${key}" must be a non-empty string.`)
  }
  return value
}

function readStreamTarget(args: JsonObject): StreamTarget {
  return {
    url: readString(args, 'url'),
    key: readString(args, 'key'),
    ...(typeof args.quality === 'string' && args.quality ? { quality: args.quality } : {}),
  }
}
