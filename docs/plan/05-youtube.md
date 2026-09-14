# 05 — YouTube integration

Two constraints shape this entire component, and both are Google's, not ours:

1. **An OAuth app in "Testing" publishing status has its refresh tokens expired
   after 7 days.** An unattended scheduler whose auth dies every week is not a
   product. This has to be handled in onboarding, not discovered in production.
2. **The default quota is 10,000 units/day per Google Cloud project**, and a
   single scheduled event costs roughly 200–260 units before polling. Polling is
   what actually kills you.

## Authentication

### Bring-your-own OAuth client (v1)

Each install supplies its own OAuth client ID and secret from its own Google Cloud
project. This is the standard pattern for self-hosted tools, and it solves three
problems at once: no client secret is embedded in a distributed desktop binary,
the project is not blocked on Google's verification review for sensitive YouTube
scopes, and each install gets its own 10,000 unit/day budget instead of sharing
one.

The cost is onboarding friction, so the setup wizard does the work: a step-by-step
walkthrough with the exact console URLs, the exact APIs to enable, the exact
redirect URI to paste, and a "Test connection" button at the end.

**The wizard must explicitly require setting the consent screen to
"In production".** Not mention it — require it, with a check. Left on "Testing",
every scheduled stream will work fine for a week and then start failing with a
generic `invalid_grant`. This is the single most likely support burden in the
whole project, and it is entirely preventable at setup time.

**The redirect URI is derived from how the browser reached the app**, not
hardcoded: `X-Forwarded-Proto` and `X-Forwarded-Host` before the request's own
`Host`, so an install behind Tailscale Serve or any TLS-terminating proxy
advertises the `https://` address a browser actually uses rather than the
`http://` one this process sees — which matters because Google will not
register a plain-HTTP callback for anything but localhost. The same derivation
feeds the URI the instructions tell the operator to paste, so what is shown and
what is sent cannot drift apart. A mismatch is `Error 400:
redirect_uri_mismatch`, which says nothing about what Google expected, so the
instructions say to paste it exactly and warn when the address in hand is one
Google will refuse.

There is deliberately no setting for this. A proxy that sets neither forwarded
header could want one, but an address configured once and then stale fails the
same opaque way, and connecting from more than one address is already answered
by Google taking a list of redirect URIs.

**The user type must be "External", even for a single church.** A YouTube
channel that lives in a Brand Account — which most organisation channels do — is
not a member of any Google Workspace, so an "Internal" client refuses it at the
consent screen with `Error 403: org_internal`. The trap is that the person
setting it up connects their *own* channel without trouble and only finds out
when they try to add the one that matters. Nothing in this app can detect it:
the refusal happens on Google's own page, before the redirect back.

The app also detects the other one at runtime: a refresh failing with `invalid_grant` is
mapped to a named, actionable error — "YouTube authorization expired. If your
Google Cloud OAuth consent screen is set to Testing, tokens expire after 7 days;
set it to In production." — not a stack trace.

### Hosted client (later)

The `account` table carries `oauth_client_ref` so a verified, project-owned client
can be added as a second credential source without a schema change. Shipping it
requires passing Google's verification for sensitive scopes; that is a v2+
decision, not a v1 blocker.

### Flow

OAuth 2.0 authorization code **with PKCE**, loopback redirect to
`http://127.0.0.1:<port>/oauth/callback`. This is the correct flow for an
installed app. The out-of-band (`urn:ietf:wg:oauth:2.0:oob`) copy-paste flow is
deprecated and must not be used.

Scopes: `youtube.force-ssl` (create and manage broadcasts, insert playlist items)
plus `youtube.readonly`. Nothing else — every additional scope makes a future
verification harder.

Docker needs care: the loopback redirect has to reach a browser on the user's
machine, not inside the container. The wizard detects a container environment and
switches to a "open this URL on your computer, then paste the code back" flow
against the same loopback listener published on the container's port.

## Broadcast lifecycle

Per run, during `preparing`:

1. `liveBroadcasts.insert` — title, description, scheduled start/end, privacy,
   `contentDetails.enableAutoStart`, `enableAutoStop`, latency preference.
2. Ensure a `liveStream` exists (see below).
3. `liveBroadcasts.bind` — attach the ingestion stream to the broadcast.
4. Resolve the ingest URL + key and push them to the encoder.
5. `playlistItems.insert` — the broadcast already has a `videoId` at creation
   time, so the playlist insert happens now rather than after the event. Doing it
   up front means a failed insert is a prepare-phase error a human can see at
   T−30m, instead of something that quietly didn't happen after everyone left.

### Reusable vs per-event ingestion streams

A **reusable** `liveStream` keeps the same stream key forever and is bound to each
new broadcast. A **non-reusable** stream gives a fresh key per event.

Default to reusable, per encoder, because it means the encoder's configured key
never changes — a large operational win, it removes a failure mode entirely (a key
push that silently didn't land), and it saves a 50-unit `liveStreams.insert` every
event. Per-event keys remain available as a setting for anyone who wants the
isolation.

### autoStart / autoStop over explicit transitions

Setting `contentDetails.enableAutoStart` lets YouTube take the broadcast live when
it detects ingest, and `enableAutoStop` ends it when ingest stops. Preferring these
removes the `liveBroadcasts.transition` calls, which are the classic source of
`errorStreamInactive` failures when the transition races the encoder.

Keep explicit transition as a fallback: the API documents `invalidAutoStart` and
`invalidAutoStop` errors for broadcast types that don't support the setting
(notably, `enableAutoStop` cannot be modified on a permanent broadcast). The
adapter detects those at prepare time and falls back, rather than at showtime.

## Quota budget

Costs (verify against
[the current table](https://developers.google.com/youtube/v3/determine_quota_cost)
at implementation time — this list should be treated as a design estimate, not
gospel):

| Call | ~Units | Per event |
|---|---|---|
| `liveBroadcasts.insert` | 50 | 1 |
| `liveStreams.insert` | 50 | 0 if reusable |
| `liveBroadcasts.bind` | 50 | 1 |
| `playlistItems.insert` | 50 | 1 |
| `videos.update` (category, tags, thumbnail metadata) | 50 | 0–1 |
| `liveBroadcasts.list` / `liveStreams.list` | 1 | polling |
| `liveBroadcasts.transition` | 50 | 0 with autoStart/autoStop |
| `search.list` | **100** | **never** |

So roughly **150–250 units per event** plus polling. Forty events a day is
comfortable; a badly written health poll is not. Three rules:

- **Never call `search.list`.** At 100 units it is the most expensive call in the
  API and there is no case here that `liveBroadcasts.list` with known ids cannot
  serve. The fake YouTube server in the test suite fails the build if a
  `search.list` appears.
- **Budget polling.** Health polling during `live` backs off: every 10s for the
  first minute, then 30s, then 60s. A 90-minute service costs ~100 units of
  polling, not 540.
- **Keep a ledger.** Every call writes to `quota_ledger`, keyed by day in Pacific
  time (when Google resets). When the day's usage passes a threshold, the engine
  refuses non-critical calls — health polls, metadata refreshes — and protects the
  ones that make a stream happen. The UI shows the day's usage. Hitting the cap
  mid-Sunday should be a visible warning on Saturday, not a surprise.

## Failure modes worth designing for explicitly

| Symptom | Cause | Handling |
|---|---|---|
| `redirect_uri_mismatch` at the consent screen | what the app advertised is not registered on the client, often `http://` where a proxy terminated TLS | Derive it from `X-Forwarded-Proto`/`X-Forwarded-Host`/`Host`, show that exact URI in the instructions, and warn when it is one Google will not register |
| `org_internal` at the consent screen | OAuth client's user type is "Internal"; a Brand Account channel is not in the Workspace | Cannot be caught by this app — the setup instructions require "External" and say why |
| `invalid_grant` on refresh | consent screen left on Testing (7-day expiry), or the user revoked access | Named error + reconnect CTA; mark `account.status = 'reauth_required'` and alert *before* the next prepare window |
| `quotaExceeded` | day's budget gone | Ledger should have prevented it; if it happens, fail the run at prepare with a clear cause rather than half-creating things |
| `errorStreamInactive` on transition | encoder wasn't pushing yet | Avoided by autoStart; fallback path waits for ingest health before transitioning |
| Broadcast created, bind failed | crash or API error mid-prepare | Compensation deletes the orphan broadcast, or makes it private and tags it if deletion fails |
| Duplicate broadcasts | retry after a crash | Prevented by writing the idempotency key before the call and reconciling on startup — see [03](./03-scheduling-engine.md) |
