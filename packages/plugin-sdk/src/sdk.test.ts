import { describe, expect, it } from 'vitest'
import { applyConfigDefaults, validateConfig } from './config-fields.js'
import type { ConfigField } from './config-fields.js'
import { isSerializable } from './json.js'
import { negotiateLink } from './negotiate.js'
import type { Port } from './types.js'
import { defineDevice } from './define.js'
import { SerializationViolation, withSerializingTransport } from './testing.js'
import { ManualClock } from './clock.js'

const out = (over: Partial<Port> = {}): Port => ({
  id: 'stream',
  direction: 'out',
  label: 'Stream output',
  transport: ['rtmp', 'rtmps'],
  maxLinks: 1,
  ...over,
})
const inp = (over: Partial<Port> = {}): Port => ({
  id: 'ingest',
  direction: 'in',
  label: 'YouTube ingest',
  transport: ['rtmps'],
  maxLinks: 1,
  requiresCredential: 'stream-key',
  ...over,
})

describe('negotiateLink', () => {
  it('accepts a link and reports the transport both ends share', () => {
    expect(negotiateLink(out(), inp())).toEqual({ ok: true, transport: 'rtmps' })
  })

  it('rejects a recorder as the source of a stream', () => {
    const hyperdeckFileOut = out({ label: 'Recording', transport: ['file'] })
    const result = negotiateLink(hyperdeckFileOut, inp())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('no-common-transport')
  })

  it('points at a relay when a single-output encoder is asked to fan out', () => {
    const result = negotiateLink(out(), inp(), { fromLinks: 1, toLinks: 0 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('source-port-full')
    expect(result.ok === false && result.reason).toMatch(/relay/i)
  })

  it('refuses a backwards link', () => {
    const result = negotiateLink(inp(), out())
    expect(result.ok === false && result.code).toBe('wrong-direction')
  })
})

describe('validateConfig', () => {
  const fields: ConfigField[] = [
    { type: 'textinput', id: 'host', label: 'IP address', required: true, regex: '^\\d{1,3}(\\.\\d{1,3}){3}$' },
    { type: 'number', id: 'port', label: 'Port', default: 9977, min: 1, max: 65535 },
    { type: 'dropdown', id: 'model', label: 'Model', choices: [{ id: 'auto', label: 'Auto' }], default: 'auto' },
  ]

  it('passes a well-formed config', () => {
    expect(validateConfig(fields, { host: '10.0.0.5', port: 9977, model: 'auto' })).toEqual([])
  })

  it('flags a missing required field and a malformed address', () => {
    expect(validateConfig(fields, {})).toEqual([{ field: 'host', message: 'IP address is required' }])
    expect(validateConfig(fields, { host: 'not-an-ip' })[0]?.message).toMatch(/expected format/)
  })

  it('flags an out-of-range port and an unknown dropdown choice', () => {
    expect(validateConfig(fields, { host: '10.0.0.5', port: 99999 })[0]?.message).toMatch(/at most 65535/)
    expect(validateConfig(fields, { host: '10.0.0.5', model: 'mini-pro' })[0]?.message).toMatch(/available choices/)
  })

  it('applies declared defaults but never invents a secret', () => {
    const withSecret: ConfigField[] = [...fields, { type: 'secret', id: 'password', label: 'Password' }]
    const filled = applyConfigDefaults(withSecret, { host: '10.0.0.5' })
    expect(filled).toEqual({ host: '10.0.0.5', port: 9977, model: 'auto' })
  })
})

describe('isSerializable', () => {
  it('accepts plain JSON shapes', () => {
    expect(isSerializable({ a: 1, b: [true, null, { c: 'x' }] })).toBe(true)
  })

  it('rejects the things that quietly break an IPC boundary', () => {
    expect(isSerializable({ fn: () => 1 })).toBe(false)
    expect(isSerializable({ when: new Date() })).toBe(false)
    expect(isSerializable({ missing: undefined })).toBe(false)
    expect(isSerializable({ n: Number.NaN })).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isSerializable(cyclic)).toBe(false)
  })
})

function deviceReturning(state: unknown) {
  return defineDevice({
    probe: async () => ({ model: 'Fake', features: [] }),
    health: async () => ({ state: 'connected' as const, since: 0 }),
    listNodes: async () => [],
    actionsFor: () => ({ readState: async () => state as never }),
    dispose: async () => {},
  })
}

describe('withSerializingTransport', () => {
  it('lets a well-behaved device through', async () => {
    const device = withSerializingTransport(deviceReturning({ streaming: { active: true, bitrateBps: 6_000_000 } }))
    await expect(device.invoke('n', 'readState')).resolves.toEqual({
      streaming: { active: true, bitrateBps: 6_000_000 },
    })
  })

  it('fails the test when a device returns something that would not survive IPC', async () => {
    const device = withSerializingTransport(deviceReturning({ startedAt: new Date() }))
    await expect(device.invoke('n', 'readState')).rejects.toBeInstanceOf(SerializationViolation)
  })

  it('rejects a non-serializable argument before it reaches the device', () => {
    const device = withSerializingTransport(deviceReturning({}))
    expect(() => device.invoke('n', 'applyStreamTarget', { cb: (() => {}) as never })).toThrow(SerializationViolation)
  })
})

describe('defineDevice', () => {
  it('reports an unsupported action instead of silently doing nothing', async () => {
    const device = deviceReturning({})
    await expect(device.invoke('n', 'startStreaming')).rejects.toThrow(/not supported/)
  })

  it('validates action arguments', async () => {
    const device = defineDevice({
      probe: async () => ({ model: 'Fake', features: [] }),
      health: async () => ({ state: 'connected' as const, since: 0 }),
      listNodes: async () => [],
      actionsFor: () => ({ readState: async () => ({}), startRecording: async () => {} }),
      dispose: async () => {},
    })
    await expect(device.invoke('n', 'startRecording', { filename: '' })).rejects.toThrow(/non-empty string/)
    await expect(device.invoke('n', 'startRecording', { filename: 'svc.mp4' })).resolves.toBeNull()
  })
})

describe('ManualClock', () => {
  it('only moves when a test moves it', () => {
    const clock = new ManualClock('2026-03-08T14:00:00Z')
    expect(clock.now()).toBe(Date.parse('2026-03-08T14:00:00Z'))
    clock.advance(60_000)
    expect(clock.now()).toBe(Date.parse('2026-03-08T14:01:00Z'))
  })
})
