# 06 — Templating and secrets

## Name templating

Every user-entered name supports templates: broadcast title, description,
recording filename, playlist selection, and the run label.

### Engine

A small token-substitution engine with formatters — **not** a general-purpose
template language. Handlebars helpers, `eval`, or anything Turing-complete is an
unnecessary code-execution surface in an app that already holds OAuth tokens and
stream keys, and the expressive power buys nothing here.

```
{{event.name}}                                   → Sunday Service
{{date "EEEE, MMMM d, yyyy"}}                    → Sunday, March 8, 2026
{{date "yyyy-MM-dd"}}                            → 2026-03-08
{{date "yyyy-MM-dd" offset="-1d"}}               → 2026-03-07
{{time "h:mm a"}}                                → 9:00 AM
{{series.name}} · {{occurrence.index}}           → Sunday Service · 42
{{encoder.label}}
{{counter "sermons" pad=3}}                      → 007
```

Backed by `date-fns` format tokens, which are well documented and which users can
look up.

### The rule that matters

**Templates render against the occurrence's scheduled start, expressed in the
series' timezone — never against the server's clock at render time.**

Two failures this prevents:

- A 9:00 AM Sunday service prepared at 8:30 AM renders "Sunday, March 8". Trivial
  — until preparation crosses a midnight boundary, or the schedule is at 00:15,
  and the title says the wrong day.
- The same app in a Docker container running UTC renders yesterday's date for any
  evening event in the Americas. This is the single most common bug in
  scheduling tools and it is fully avoided by rendering from
  `occurrence.scheduled_start` + `event_series.timezone`, which is why
  `occurrence.local_date` is a stored column.

### Live preview

The template editor renders the result for the **next three occurrences**,
live, as the user types. Cheap to build and it catches essentially every template
mistake before it ships — including the timezone ones, because a user seeing
"Saturday" where they expected "Sunday" notices immediately.

### Filenames

Recording filenames get an extra pass: filesystem-illegal characters stripped,
length capped, plus the target device's own constraints (HyperDeck filename rules
are narrower than a filesystem's). Collision handling appends a suffix rather than
overwriting — an accidental overwrite of a recorded service is unrecoverable.

## Secrets

Stream keys and OAuth refresh tokens are the two things in this app whose leak
actually hurts: a stream key lets a stranger broadcast on the user's channel.

### At rest

Envelope encryption. Secrets are AES-256-GCM encrypted with a data key; the master
key comes from a platform-appropriate backend:

| Platform | Master key source |
|---|---|
| macOS | Keychain, via Electron `safeStorage` |
| Windows | DPAPI, via Electron `safeStorage` |
| Linux desktop | libsecret where available |
| Docker / headless | a key file, or a key derived from a required `SCHEDULER_SECRET` env var |

`secret.key_id` records which master key encrypted each row, so rotation is a
background re-encrypt rather than a migration.

**Headless must not silently fall back to plaintext.** If no key source is
configured, the app refuses to start and prints how to fix it. A container that
quietly stores stream keys in plaintext next to a database file that people
casually back up to Dropbox is the wrong default, and "secure unless you didn't
notice" is not a security posture.

### In transit, in the UI, in logs

- Secrets are write-only from the UI's perspective: `POST` a new value, never
  `GET` the existing one. The UI shows a masked placeholder and a "replace" action.
- A **central log scrubber** holds a registry of live secret values and redacts
  them at the pino transport level. Doing this centrally rather than at each call
  site is the only version that actually works — every leak in this class comes
  from the one log line someone forgot.
- `run_step.request` / `run_step.response` go through the same scrubber before
  being persisted, so the debugging timeline is safe to screenshot and attach to
  a bug report.

### Sources of stream keys

`stream_credential.source` discriminates:

- `manual` — typed in, for a generic RTMP destination.
- `youtube-reusable` — read once from a reusable `liveStream`, stable forever.
- `youtube-per-event` — fetched fresh during each run's prepare phase and never
  persisted beyond the run.

### Network reality

The Blackmagic control protocols are all unauthenticated and unencrypted: the ATEM
protocol, Web Presenter on TCP 9977, HyperDeck on TCP 9993. Anyone on the control
network can take over the hardware regardless of what this app does. Two
consequences:

- Document the expectation plainly: **put the gear and this app on a trusted
  control VLAN.** The app cannot fix this and should not pretend to.
- Don't make it worse. The web UI binds to `127.0.0.1` by default. Binding to
  `0.0.0.0` is an explicit opt-in, and turning it on requires setting an admin
  password first — an unauthenticated web UI on a production LAN that can start
  broadcasts and read stream keys is a strictly worse hole than the protocols
  themselves.
