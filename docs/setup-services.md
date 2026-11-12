# Connecting services

The same steps are shown in the app, with this install's own redirect URI
filled in. They come from `GET /api/oauth/youtube/instructions`,
`GET /api/oauth/twitch/instructions` and
`GET /api/plan-sources/planning-center/instructions`.

## YouTube

Each install uses its own Google Cloud OAuth client. Nothing is shared, and
each install gets its own 10,000 unit a day API quota.

In the [Google Cloud console](https://console.cloud.google.com):

1. Create a project, or pick an existing one.
2. Under **APIs & Services > Library**, enable the **YouTube Data API v3**.
3. Under **APIs & Services > OAuth consent screen**, set the user type to
   **External**.
4. On the same screen, set the publishing status to **In production**.
5. Under **APIs & Services > Credentials**, create an OAuth client ID of type
   **Web application**.
6. Add the authorized redirect URI. It is the address you reached the app at,
   plus `/oauth/callback`, e.g. `https://stream.example.org/oauth/callback`.
   The **Services** page shows the exact one.
7. Copy the client ID and secret into **Services > YouTube**, then connect the
   channel.

The app asks for one scope, `youtube.force-ssl`.

Things that go wrong:

- **Leaving the consent screen on "Testing".** Google expires refresh tokens
  after 7 days in that state. Every stream works for a week and then fails.
- **"In production" without verification.** That is fine for this. Google
  shows its "unverified app" screen when you connect: choose to continue. An
  unverified app is limited to 100 users, which is far more than one install
  needs.
- **User type "Internal".** A channel in a Brand Account is not in your
  Workspace, so Google refuses it with `Error 403: org_internal`.
- **A redirect URI that does not match exactly.** Google answers
  `Error 400: redirect_uri_mismatch`. Scheme, host, port and path must all
  match. Register every address you will connect from.
- **Plain `http://` on anything but localhost.** Google will not register it.
  Reach the app over HTTPS, through Tailscale Serve or a reverse proxy, or set
  up the client while on `127.0.0.1`.

## Twitch

1. Turn on two-factor authentication for the Twitch account. The developer
   console will not open without it.
2. Open [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) and
   choose **Register Your Application**.
3. Give it a name. Names are unique across all of Twitch, so add your
   organisation's name.
4. Add the OAuth redirect URL shown on the **Services** page. It ends in
   `/oauth/callback`.
5. Pick any category. "Website Integration" fits. Set the client type to
   **Confidential**.
6. Open the app with **Manage**. Copy the client ID, then press **New Secret**
   and copy that.
7. Paste both into **Services > Twitch**, then connect the account.

The app asks for two scopes: `channel:manage:broadcast` and
`channel:read:stream_key`.

Things that go wrong:

- **Client type "Public".** It gets no usable refresh token, and the setting
  cannot be changed later. Register a new app.
- **A new client secret.** It invalidates every token issued with the old
  one. Reconnect every account afterwards.
- **Plain `http://` on anything but localhost.** Twitch will not accept it
  either.

## Planning Center

Planning Center uses a Personal Access Token, not OAuth. A token is an
Application ID and a Secret.

1. Sign in to Planning Center as somebody with access to Services, who can see
   the service types you want to schedule.
2. Open
   [api.planningcenteronline.com/personal_access_tokens](https://api.planningcenteronline.com/personal_access_tokens).
3. Create a token. Describe it, e.g. "Stream scheduler".
4. Copy the Application ID and the Secret into **Settings**. The app checks the
   token straight away.

The token has its creator's permissions. It stops working if their account is
deactivated, so make it from an account that will outlast you. The secret is
shown once. If you lose it, make a new token.

## Alerts

Add a channel under **Notifications**, then send a test.

**Google Chat.** In the space, open **Apps & integrations > Webhooks > Add
webhooks** and copy the URL. Options: keep each event in one thread (on by
default), and send formatted cards (on by default; turn off for plain text).

**Slack.** Copy the URL from the Slack app's **Incoming Webhooks** page.

**Webhook.** A JSON `POST` to any URL. An optional bearer token is sent as an
`Authorization` header.

**Email**, over SMTP:

| Field        | Notes                                                   |
| ------------ | ------------------------------------------------------- |
| SMTP server  | Required                                                |
| Port         | Default 587                                             |
| Implicit TLS | On for port 465. Leave off for 587, which uses STARTTLS |
| Username     | Optional                                                |
| Password     | Optional. For Google Workspace, an app password         |
| From address | Required                                                |
| To addresses | Required. Comma separated                               |

Webhook URLs, tokens and passwords are stored encrypted and never shown again.
