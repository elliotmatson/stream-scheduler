# 04 — Plugin SDK

`@scheduler/plugin-sdk` is the contract between the core and every encoder,
destination and router. It is versioned and semver'd from the first release, the
way `@companion-module/base` is, because it is the thing that has to stay stable
while everything else moves.

## The contract

```ts
export interface PluginDefinition {
  id: string                    // 'atem'
  displayName: string
  apiVersion: '1'               // SDK major; the host refuses mismatches
  configSchema: ConfigField[]   // renders the device settings form
  createDevice(ctx: DeviceContext): Promise<DeviceInstance>
}

export interface DeviceInstance {
  /** Connect, identify the model, return what this box can actually do. */
  probe(): Promise<DeviceCapabilities>
  /** Long-poll-free health; the host calls this on its own cadence. */
  health(): Promise<HealthReport>
  nodes(): NodeDefinition[]
  dispose(): Promise<void>
}

export interface NodeDefinition {
  id: string
  roles: ('source' | 'router' | 'relay' | 'sink')[]
  ports: Port[]
  actions: NodeActions
}

/** Every action is idempotent, async, and takes/returns serializable values. */
export interface NodeActions {
  applyStreamTarget?(t: { url: string; key: string }): Promise<void>
  startStreaming?(): Promise<void>
  stopStreaming?(): Promise<void>
  startRecording?(o: { filename: string }): Promise<void>
  stopRecording?(): Promise<void>
  route?(o: { input: string; output: string }): Promise<void>
  /** Read back actual state. The host verifies every write with this. */
  readState(): Promise<NodeState>
}
```

Two rules that are load-bearing:

**Everything is serializable.** No shared object references, no callbacks, no
class instances across the boundary. This is what lets plugins move from
in-process (v1) to child processes (v2) as a transport swap rather than a rewrite.
CI runs the plugin suite through a serializing in-memory transport so a violation
fails a test, not a customer's Sunday.

**Every write is verified by a read.** The host never assumes `applyStreamTarget`
worked; it calls `readState()` and compares. Blackmagic devices accept commands
they then ignore — a Web Presenter that is mid-reboot will happily take a stream
key on TCP 9977 and drop it. Verify-after-write turns that from a mystery outage
into a prepare-phase failure at T−30m.

## Config fields

Declarative, like Companion's, so no one hand-writes a settings form:

```ts
[
  { type: 'textinput', id: 'host', label: 'IP address', required: true,
    regex: IPV4 },
  { type: 'number',    id: 'port', label: 'Port', default: 9977 },
  { type: 'dropdown',  id: 'model', label: 'Model',
    choices: [...], default: 'auto',
    tooltip: 'Leave on auto — the model is probed on connect.' },
  { type: 'secret',    id: 'password', label: 'Password' },  // routed to the vault
]
```

`type: 'secret'` is handled by the core: stored encrypted, never returned to the
UI in plaintext, never written to a log, never included in a run step's recorded
request. A plugin cannot accidentally mishandle a secret because it never sees the
storage path.

## Phase 1 plugins

### `plugin-atem` — ATEM Mini Pro / Extreme, and larger ATEMs

Built on [`atem-connection`](https://www.npmjs.com/package/atem-connection), the
Sofie project's TypeScript implementation of the ATEM protocol. Relevant surface:

- `setStreamingService({ serviceName, url, key })` — push the target
- `startStreaming()` / `stopStreaming()`
- `requestStreamingDuration()`, plus streaming status and bitrate in the state
- `startRecording()` / `stopRecording()` on models with a disk recorder
- aux output routing, for the `router` role

Capabilities are **probed, not declared**. The ATEM family's streaming and
recording support varies by model and firmware — a Mini Pro streams and records to
USB, a plain Mini does neither, a Television Studio HD8 does both differently, and
Constellation models differ again. The adapter maps the probed model to a feature
matrix and the UI only offers what the box actually has.

*Risk:* the ATEM protocol is reverse-engineered, not published. Firmware updates
have historically broken libraries. Mitigation: pin the library, test against a
recorded-state fake in CI, and treat a protocol version mismatch as a loud,
named error at probe time rather than a silent failure at showtime.

### `plugin-webpresenter` — Web Presenter HD / 4K

The [Web Presenter Ethernet Protocol](https://documents.blackmagicdesign.com/DeveloperManuals/WebPresenterEthernetProtocol.pdf)
is a documented, line-oriented text protocol on **TCP 9977** — telnet-like, with
no TLS. On connect, the device dumps its full state as blocks: an identifying
header, a colon, then lines until a blank line, LF-separated.

That shape makes both the client and a faithful fake straightforward. The adapter
parses the initial dump into state, then applies incremental block updates, and
exposes stream target, start/stop and status/bitrate.

### `plugin-hyperdeck` — HyperDeck Studio / Extreme / Shuttle

The [HyperDeck Ethernet Protocol](https://documents.blackmagicdesign.com/DeveloperManuals/HyperDeckEthernetProtocol.pdf)
on **TCP 9993**, via
[`hyperdeck-connection`](https://www.npmjs.com/package/hyperdeck-connection) —
again the Sofie library. `RecordCommand('filename')`, transport state, slot and
media status.

This is the `sink` for the recording half of the product. The filename comes from
the template engine, run through a filesystem sanitizer plus the HyperDeck's own
filename constraints.

Testing gets a gift here:
[`hyperdeck-server-connection`](https://www.npmjs.com/package/hyperdeck-server-connection)
already emulates a HyperDeck at the protocol level, so integration tests need no
hardware.

### `plugin-youtube` — see [05](./05-youtube.md)

### `plugin-rtmp` — generic RTMP/RTMPS/SRT sink

A URL and a key. Deliberately trivial, and it exists in Phase 1 to prove the sink
abstraction isn't secretly YouTube-shaped. If adding a dumb RTMP target requires
touching the core, the abstraction is wrong and we find out early.

### `plugin-mock`

Fake source, sink, router and a fake that fails on demand. Lets the entire
scheduling engine be developed and tested with no hardware, and lets a prospective
user evaluate the app before buying anything.

## Adding a plugin later

The intended experience, and the test of whether the design held:

1. `npm create @scheduler/plugin` scaffolds a package against the SDK.
2. Declare `configSchema`, implement `probe()` and the actions the device supports.
3. Declare ports and roles.
4. Nothing in `core`, the scheduler, the calendar, or the template engine changes.

A `dependency-cruiser` rule in CI enforces the one-way dependency: plugins import
`plugin-sdk` only, and `core` never imports a specific plugin.

## Out-of-tree plugins (v2)

v1 bundles first-party plugins in the monorepo. v2 adds loading a plugin by npm
package name and version into a child process with a resource budget. The SDK
contract does not change — that is the point of freezing it now.

No plugin marketplace. Companion's experience is that a store is a large ongoing
maintenance commitment, and this project does not need one to be extensible.
