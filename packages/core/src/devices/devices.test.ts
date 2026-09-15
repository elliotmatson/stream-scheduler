import { randomUUID } from 'node:crypto'
import { fingerprint, ManualClock, SerializationViolation } from '@scheduler/plugin-sdk'
import type { ConfigValues, PluginDefinition } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db } from '../db/index.js'
import { keyFileSource, resolveMasterKey } from '../secrets/master-key.js'
import { Scrubber } from '../secrets/scrubber.js'
import { SecretVault } from '../secrets/vault.js'
import {
  ConfigInvalidError,
  IncompatiblePluginError,
  PluginRegistry,
  UnknownPluginError,
} from '../plugins/registry.js'
import { ConnectionManager, type ConnectionEvent } from './connection-manager.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: Db
let clock: ManualClock
let registry: PluginRegistry
let dir: string

beforeEach(() => {
  db = openTestDatabase()
  clock = new ManualClock('2026-03-08T12:00:00Z')
  registry = new PluginRegistry().register(mockPlugin({ now: () => clock.now() }))
  dir = mkdtempSync(join(tmpdir(), 'scheduler-devices-'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addDevice(
  config: ConfigValues = {},
  over: { pluginId?: string; enabled?: boolean } = {},
): string {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO device (id, plugin_id, label, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    over.pluginId ?? 'mock',
    'Test device',
    JSON.stringify(config),
    over.enabled === false ? 0 : 1,
    clock.now(),
  )
  return id
}

const managerFor = (over: Partial<ConstructorParameters<typeof ConnectionManager>[0]> = {}) =>
  new ConnectionManager({
    db,
    registry,
    clock,
    random: () => 0.5,
    sleep: async () => {},
    enforceSerialization: true,
    ...over,
  })

describe('PluginRegistry', () => {
  it('refuses a plugin built against a different SDK major', () => {
    const stale = { ...mockPlugin(), id: 'stale', apiVersion: '0' } as unknown as PluginDefinition
    expect(() => new PluginRegistry().register(stale)).toThrow(IncompatiblePluginError)
  })

  it('names the plugins it does know when asked for one it does not', () => {
    expect(() => registry.get('atem')).toThrow(UnknownPluginError)
    expect(() => registry.get('atem')).toThrow(/mock/)
  })

  it('validates device config against the plugin schema', () => {
    expect(() => registry.assertValidConfig('mock', { kind: 'encoder' })).not.toThrow()
    expect(() => registry.assertValidConfig('mock', { kind: 'toaster' })).toThrow(
      ConfigInvalidError,
    )
  })

  it('rejects registering the same plugin twice', () => {
    expect(() => registry.register(mockPlugin())).toThrow(/already registered/)
  })
})

describe('ConnectionManager', () => {
  it('probes capabilities on connect rather than trusting configuration', async () => {
    const id = addDevice({ kind: 'encoder' })
    const manager = managerFor()
    const connection = await manager.open(id)

    expect(connection.capabilities.model).toBe('Mock encoder')
    expect(connection.capabilities.features).toContain('streaming')
    expect(connection.capabilities.features).not.toContain('recording')

    const row = db.prepare('SELECT probed_model, health FROM device WHERE id = ?').get(id) as {
      probed_model: string
      health: string
    }
    expect(row.probed_model).toBe('Mock encoder')
    expect(row.health).toBe('connected')
    await manager.closeAll()
  })

  it('only offers nodes the probed device actually has', async () => {
    const recorder = await managerFor().open(addDevice({ kind: 'recorder' }))
    expect(recorder.nodes.map((n) => n.id)).toEqual(['record'])
  })

  it('reuses one connection per device', async () => {
    const id = addDevice()
    const manager = managerFor()
    expect(await manager.open(id)).toBe(await manager.open(id))
    await manager.closeAll()
  })

  it('records an unreachable device and backs off before retrying', async () => {
    const id = addDevice({ fault: 'unreachable' })
    const manager = managerFor()

    await expect(manager.open(id)).rejects.toThrow(/Could not reach/)
    const row = db.prepare('SELECT health, last_error FROM device WHERE id = ?').get(id) as {
      health: string
      last_error: string
    }
    expect(row.health).toBe('disconnected')
    expect(row.last_error).toMatch(/Could not reach/)

    // A tick straight away must not retry: a device down for an hour should
    // not be hammered every five seconds.
    await manager.tick()
    expect(manager.get(id)).toBeUndefined()
  })

  it('reconnects once the backoff has elapsed', async () => {
    const id = addDevice({ fault: 'unreachable' })
    const manager = managerFor()
    await expect(manager.open(id)).rejects.toThrow()

    // The fault is configuration, so clear it the way a user fixing the
    // address would, then let the backoff expire.
    db.prepare('UPDATE device SET config = ? WHERE id = ?').run(
      JSON.stringify({ fault: 'none' }),
      id,
    )
    clock.advance(60_000)
    await manager.tick()
    expect(manager.get(id)?.capabilities.model).toBe('Mock both')
    await manager.closeAll()
  })

  it('leaves disabled devices alone', async () => {
    addDevice({}, { enabled: false })
    const manager = managerFor()
    await manager.tick()
    expect(manager.list()).toHaveLength(0)
  })

  it('hands plugins the plaintext secret, never the storage reference', async () => {
    const vault = new SecretVault(
      db,
      resolveMasterKey([keyFileSource(join(dir, 'k'), { create: true })]),
      new Scrubber(),
    )
    const ref = vault.store('hunter2-the-device-password')
    const id = addDevice({ password: ref })

    let seen: ConfigValues | undefined
    const spy: PluginDefinition = {
      ...mockPlugin(),
      id: 'spy',
      createDevice: async (ctx) => {
        seen = ctx.config
        return mockPlugin().createDevice(ctx)
      },
    }
    db.prepare("UPDATE device SET plugin_id = 'spy' WHERE id = ?").run(id)
    registry.register(spy)

    const manager = managerFor({ vault })
    await manager.open(id)
    expect(seen?.password).toBe('hunter2-the-device-password')
    expect(seen?.password).not.toBe(ref)
    await manager.closeAll()
  })

  it('applies declared config defaults', async () => {
    const connection = await managerFor().open(addDevice({}))
    expect(connection.capabilities.model).toBe('Mock both') // the schema default
  })

  it('forwards telemetry to listeners', async () => {
    const id = addDevice({ kind: 'encoder' })
    const manager = managerFor()
    const events: ConnectionEvent[] = []
    manager.on((event) => events.push(event))

    await manager.invoke(id, 'stream', 'applyStreamTarget', {
      url: 'rtmps://x/live2',
      key: 'live_abcdefgh',
    })
    await manager.invoke(id, 'stream', 'startStreaming')

    const states = events.filter((e) => e.type === 'state')
    expect(states.at(-1)).toMatchObject({ deviceId: id, nodeId: 'stream' })
    await manager.closeAll()
  })

  it('keeps a healthy connection after a command-level rejection', async () => {
    // A device can reject one command and stay perfectly connected. Dropping
    // the socket every time would cause a reconnect storm mid-service.
    const id = addDevice({ kind: 'encoder' })
    const manager = managerFor()
    const before = await manager.open(id)

    await expect(manager.invoke(id, 'stream', 'startStreaming')).rejects.toThrow(/No stream target/)
    expect(manager.get(id)).toBe(before)
    await manager.closeAll()
  })

  it('keeps running when a listener throws', async () => {
    const id = addDevice()
    const manager = managerFor()
    manager.on(() => {
      throw new Error('listener is broken')
    })
    await expect(manager.open(id)).resolves.toBeDefined()
    await manager.closeAll()
  })

  it('does not let a file listing overwrite what the device is doing', async () => {
    // `listMedia` answers with a list, carried back in `raw` because the
    // transport has one shape. Remembering that as the node's state
    // replaced everything the screens read: opening a deck's Files panel
    // emptied the slot picker on the same panel, and the deck showed as
    // doing nothing until it next said otherwise.
    const id = addDevice({ kind: 'recorder' })
    const manager = managerFor()
    await manager.open(id)
    await manager.invoke(id, 'record', 'startRecording', { filename: 'service' })
    await manager.invoke(id, 'record', 'readState')

    const before = manager.lastStates(id).find((entry) => entry.nodeId === 'record')
    expect(before?.state.recording?.active).toBe(true)

    const listed = await manager.invoke(id, 'record', 'listMedia')
    expect(Array.isArray(listed?.raw?.media)).toBe(true)

    const after = manager.lastStates(id).find((entry) => entry.nodeId === 'record')
    expect(after?.state.recording?.active).toBe(true)

    await manager.closeAll()
  })
})

describe('applyAndVerify', () => {
  it('passes when the device really took the write', async () => {
    const id = addDevice({ kind: 'encoder' })
    const manager = managerFor()
    const key = 'live_abcd-1234-efgh'

    const state = await manager.applyAndVerify(
      id,
      'stream',
      'applyStreamTarget',
      { url: 'rtmps://a.rtmp.youtube.com/live2', key },
      {
        what: 'Stream key',
        expected: fingerprint(key),
        satisfiedBy: (s) => s.streaming?.keyFingerprint === fingerprint(key),
      },
    )
    expect(state.streaming?.targetUrl).toBe('rtmps://a.rtmp.youtube.com/live2')
    await manager.closeAll()
  })

  it('catches a device that accepts a command and ignores it', async () => {
    // The Web Presenter mid-reboot case: the write is accepted on the wire
    // and silently dropped. Without verification this surfaces at showtime.
    const id = addDevice({ kind: 'encoder', fault: 'ignores-writes' })
    const manager = managerFor()
    const key = 'live_abcd-1234-efgh'

    await expect(
      manager.applyAndVerify(
        id,
        'stream',
        'applyStreamTarget',
        { url: 'rtmps://a.rtmp.youtube.com/live2', key },
        {
          what: 'Stream key',
          expected: fingerprint(key),
          satisfiedBy: (s) => s.streaming?.keyFingerprint === fingerprint(key),
        },
      ),
    ).rejects.toThrow(/did not take effect/)
    await manager.closeAll()
  })

  it('waits for a device that reports a change a few reads late', async () => {
    // What real hardware does, and what a single read got wrong: an ATEM
    // told to stream reports Idle, then Connecting, then Streaming. The
    // command landed; the state had not caught up. Reading once called a
    // stream that was coming up perfectly a failure.
    const id = addDevice({ kind: 'encoder', fault: 'slow-to-settle' })
    const manager = managerFor()
    await manager.applyAndVerify(
      id,
      'stream',
      'applyStreamTarget',
      { url: 'rtmps://a.rtmp.youtube.com/live2', key: 'live_abcd-1234-efgh' },
      { what: 'Stream target', expected: 'set', satisfiedBy: () => true },
    )

    const state = await manager.applyAndVerify(
      id,
      'stream',
      'startStreaming',
      {},
      {
        what: 'Streaming',
        expected: 'active',
        satisfiedBy: (s) => s.streaming?.active === true,
      },
    )
    expect(state.streaming?.active).toBe(true)
    await manager.closeAll()
  })

  it('still gives up on a device that never gets there', async () => {
    // The settle window must not turn a wedged device into a slow one.
    const id = addDevice({ kind: 'recorder', fault: 'ignores-writes' })
    const manager = managerFor()

    await expect(
      manager.applyAndVerify(
        id,
        'record',
        'startRecording',
        { filename: 'take 1' },
        {
          what: 'Recording',
          expected: 'active',
          satisfiedBy: (s) => s.recording?.active === true,
          settleMs: 500,
        },
      ),
    ).rejects.toThrow(/did not take effect within 0.5s/)
    await manager.closeAll()
  })
})

describe('serialization discipline', () => {
  it('fails loudly if a plugin returns something that would not survive IPC', async () => {
    const leaky: PluginDefinition = {
      ...mockPlugin(),
      id: 'leaky',
      createDevice: async () => ({
        probe: async () => ({ model: 'Leaky', features: [] }),
        health: async () => ({ state: 'connected' as const, since: 0 }),
        listNodes: async () => [],
        // A Date does not survive a JSON transport, and neither would the
        // live socket object somebody will eventually try to return here.
        invoke: async () => ({ raw: { startedAt: new Date() } }) as never,
        dispose: async () => {},
      }),
    }
    registry.register(leaky)
    const id = addDevice({}, { pluginId: 'leaky' })

    const manager = managerFor()
    await expect(manager.invoke(id, 'x', 'readState')).rejects.toBeInstanceOf(
      SerializationViolation,
    )
  })
})

describe('mock plugin', () => {
  it('refuses to start streaming before a target is applied', async () => {
    const id = addDevice({ kind: 'encoder' })
    const manager = managerFor()
    await expect(manager.invoke(id, 'stream', 'startStreaming')).rejects.toThrow(/No stream target/)
  })

  it('offers discovery results that can be added as devices', async () => {
    const found = await registry.get('mock').discover?.()
    expect(found?.map((d) => d.label)).toEqual(['Mock encoder', 'Mock recorder'])
    for (const device of found ?? []) {
      expect(() => registry.assertValidConfig('mock', device.config)).not.toThrow()
    }
  })

  it('records with the filename it was given', async () => {
    const id = addDevice({ kind: 'recorder' })
    const manager = managerFor()
    await manager.invoke(id, 'record', 'startRecording', {
      filename: '2026-03-08 Sunday Service.mp4',
    })
    const state = await manager.invoke(id, 'record', 'readState')
    expect(state?.recording).toMatchObject({
      active: true,
      filename: '2026-03-08 Sunday Service.mp4',
    })
    await manager.closeAll()
  })
})
