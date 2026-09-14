# 04 — Plugin SDK

`@scheduler/plugin-sdk` is the contract between the core and every encoder,
destination and router. It is versioned and semver'd from the first release, the
way `@companion-module/base` is, because it is the thing that has to stay stable
while everything else moves.

## The contract

```ts
export interface PluginDefinition {
  id: string // 'atem'
  displayName: string
  apiVersion: '1' // SDK major; the host refuses mismatches
  configSchema: ConfigField[] // renders the device settings form
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
  /** `quality` is a profile the device already has, by name. Absent leaves
   *  the device on whatever it is set to. */
  applyStreamTarget?(t: { url: string; key: string; quality?: string }): Promise<void>
  startStreaming?(): Promise<void>
  stopStreaming?(): Promise<void>
  /** `slot` picks the card. Absent records onto whichever the deck is on. */
  startRecording?(o: { filename: string; slot?: number }): Promise<void>
  stopRecording?(): Promise<void>
  route?(o: { input: string; output: string }): Promise<void>
  /** Erase a card, in the two steps the deck's own protocol uses: called
   *  without a token it returns one and erases nothing, and only that token
   *  coming back erases. The handshake is the device's, not one invented
   *  here, so the token is as short-lived as the deck makes it. */
  formatStorage?(o: { slot: number; confirm?: string }): Promise<{ confirm?: string }>
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

- `setStreamingService({ serviceName, url, key, bitrates })` — push the target,
  and the encoder bitrate as a `[low, high]` pair in bits per second
- `startStreaming()` / `stopStreaming()`
- `requestStreamingDuration()`, plus streaming status and bitrate in the state
- `startRecording()` / `stopRecording()` on models with a disk recorder
- `setRecordingSettings({ filename, workingSet1DiskId, ... })` — note what is
  _not_ there: no quality, codec or bitrate. An ATEM has one H.264 encoder and
  it serves both the stream and the recording, so `bitrates` above is the
  recording's quality as well. That is why the adapter offers quality on the
  recorder node too, applies it through the streaming service, and why two
  outputs on one ATEM asking for different qualities is reported as a clash.
  There are no named profiles to enumerate: "Streaming High", "HyperDeck
  1080p50" and the rest live in a `Streaming.xml` on the computer running ATEM
  Software Control, not in the switcher, so the adapter speaks in Mb/s
- aux output routing, for the `router` role — implemented and tested, but
  see **Routing** below for what drives it

Capabilities are **probed, not declared**. The ATEM family's streaming and
recording support varies by model and firmware — a Mini Pro streams and records to
USB, a plain Mini does neither, a Television Studio HD8 does both differently, and
Constellation models differ again. The adapter maps the probed model to a feature
matrix and the UI only offers what the box actually has.

_Risk:_ the ATEM protocol is reverse-engineered, not published. Firmware updates
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

Quality here is the recording codec, set with `configuration: file format:`
before the record command. The protocol has no "what do you support", and the
set differs by model and firmware, so the adapter reports the codec the deck is
on, offers the documented spellings as suggestions, and turns the deck's refusal
of one it does not have into a message naming both that codec and the current
one. Rollover is _not_ settable: there is only the one-shot `RecordSpillCommand`,
the deck spilling onto the next mounted card being its own behaviour, so it is
reported rather than offered.

A **REST API** exists for current decks (firmware 8.4 and later) at
`/control/api/v1/`, with a websocket at `/control/api/v1/event/websocket` pushing
property changes. It is not what this adapter uses, deliberately: TCP 9993 works
on every deck ever shipped, Blackmagic still maintains it, and it is the one with
a protocol-level emulator to test against. REST would buy enumerable codecs and
video formats, `supportedVideoFormats`, and NAS media — worth adding as a second
transport for decks that have it, not worth losing the older ones over.

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

A fake source, a fake sink, and a fake that fails on demand. Lets the entire
scheduling engine be developed and tested with no hardware, and lets a prospective
user evaluate the app before buying anything.

No fake router: nothing above the plugin layer drives routing, so a fake one
would exercise nothing. See **Routing** below.

## Routing

`route` is a real part of the contract and the ATEM adapter implements it
against aux busses, with the mapping read back afterwards like every other
write. **Nothing above the plugin layer calls it**, and that is deliberate
rather than unfinished.

What is on an aux bus during a service is a live-production decision, made at
the desk second by second. A scheduler's job is that a thing starts at 09:00
and stops at 10:15; those are different clocks, and reaching through the
scheduler to set a crosspoint would be answering a question nobody asked. Its
arguments are the device's own vocabulary too — the ATEM wants numeric source
and bus ids — and the SDK has no way for a plugin to say what its inputs are
called, so there is nothing an operator would recognise to put in a form.

Concretely, as a result:

- `EventOutput` has no crosspoint field and `OutputKind` is `'stream' |
'recording'`, so a scheduled run cannot emit a route step.
- The manual device controls do not offer it; `POST
/api/devices/:id/nodes/:nodeId/route` is refused, and a test pins that.
- `GET /api/devices/:id/nodes/:nodeId/state` does return the live `routing`
  map, and the Devices page shows it. Reading is useful; writing is not ours.

The shape worth building, if any, is a **pre-flight assertion** — "the aux
feeding the chapel encoder is still on source 3", checked the evening before
alongside the token and the encoder. That is a check, not an action, and it
is a few lines whenever somebody actually wants it.

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
