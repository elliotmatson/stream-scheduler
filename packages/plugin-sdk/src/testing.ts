import { isSerializable } from './json.js'
import type { JsonObject } from './json.js'
import type { DeviceInstance, InvokableAction, NodeState } from './types.js'

export class SerializationViolation extends Error {
  constructor(where: string) {
    super(
      `${where} is not serializable. Everything crossing the plugin boundary must survive a ` +
        `structured clone, or plugins cannot move into child processes. See docs/plan/04-plugin-sdk.md.`,
    )
    this.name = 'SerializationViolation'
  }
}

/**
 * Wraps a device so every argument and return value is checked and then
 * round-tripped through a clone, the way a real IPC transport would.
 *
 * CI runs the whole plugin suite through this, so a non-serializable value
 * fails a test long before it fails on someone's Sunday morning.
 */
export function withSerializingTransport(device: DeviceInstance): DeviceInstance {
  return {
    probe: () => guard('probe() result', device.probe()),
    health: () => guard('health() result', device.health()),
    listNodes: () => guard('listNodes() result', device.listNodes()),
    dispose: () => device.dispose(),
    invoke(
      nodeId: string,
      action: InvokableAction,
      args: JsonObject = {},
    ): Promise<NodeState | null> {
      if (!isSerializable(args))
        throw new SerializationViolation(`invoke(${nodeId}, ${action}) arguments`)
      return guard(
        `invoke(${nodeId}, ${action}) result`,
        device.invoke(nodeId, action, clone(args)),
      )
    },
  }
}

async function guard<T>(where: string, promise: Promise<T>): Promise<T> {
  const value = await promise
  if (value !== undefined && !isSerializable(value)) throw new SerializationViolation(where)
  return value === undefined ? value : clone(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
