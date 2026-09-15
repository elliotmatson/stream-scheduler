import { randomBytes } from 'node:crypto'
import type { Fetch, TokenSource } from './api.js'

export const AUTH_ENDPOINT = 'https://id.twitch.tv/oauth2/authorize'
export const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token'

/**
 * Exactly two, and both are needed.
 *
 * `channel:manage:broadcast` sets the title and category before a service
 * goes out, which is the whole point of this integration.
 * `channel:read:stream_key` fetches the key, so nobody has to paste one and
 * nobody has to notice when it is rotated.
 *
 * Nothing else is asked for. A scope list is read by whoever authorises,
 * and every extra line is a reason to hesitate.
 */
export const SCOPES = ['channel:manage:broadcast', 'channel:read:stream_key']

export class ReauthRequiredError extends Error {
  readonly code = 'reauth-required'
  readonly retryable = false
  readonly remediation: string

  constructor(detail: string) {
    super(`Twitch rejected the stored authorization: ${detail}`)
    this.name = 'ReauthRequiredError'
    this.remediation =
      'Reconnect the account. If the client secret was regenerated in the Twitch developer console, ' +
      'every token issued with the old one stops working and reconnecting is the only fix.'
  }
}

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export interface PendingAuthorization {
  url: string
  codeVerifier: string
  state: string
  redirectUri: string
}

/**
 * The authorization-code flow.
 *
 * No PKCE, unlike the YouTube provider: Twitch has no PKCE support for the
 * confidential clients that get non-expiring refresh tokens, and requires
 * the client secret on the exchange instead. `codeVerifier` is carried
 * anyway because the host's pending-authorization record has the field —
 * it is unused here rather than quietly meaningful.
 */
export function beginAuthorization(client: OAuthClient, redirectUri: string): PendingAuthorization {
  const state = base64Url(randomBytes(16))

  const url = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    // Without this, re-authorising an account that has already said yes
    // returns immediately with no chance to switch account — which is
    // exactly what somebody is trying to do when they reconnect.
    force_verify: 'true',
  }).toString()}`

  return { url, codeVerifier: '', state, redirectUri }
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string[] | string
  token_type?: string
}

export async function exchangeCode(
  client: OAuthClient,
  pending: PendingAuthorization,
  code: string,
  fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: pending.redirectUri,
    }).toString(),
  })

  const text = await response.text()
  if (!response.ok) throw new ReauthRequiredError(describeTokenError(text))

  const tokens = JSON.parse(text) as TokenResponse
  if (!tokens.refresh_token) {
    throw new ReauthRequiredError(
      'Twitch did not return a refresh token, so the connection would stop working within the hour. ' +
        'This happens when the app is registered as a public client; set it to confidential in the ' +
        'Twitch developer console and connect again.',
    )
  }
  return tokens
}

/**
 * Holds an access token and refreshes it before it expires.
 *
 * **Twitch rotates refresh tokens.** A refresh may hand back a new one, and
 * the old one may stop working the moment it does — so a provider that
 * ignores the new value works for exactly as long as the first token lives
 * and then dies on a Sunday. `onRotate` is how the host writes it back to
 * the vault; without it this class would be a slow-motion outage.
 */
export class RefreshingTokenSource implements TokenSource {
  private accessTokenValue: string | undefined
  private expiresAt = 0
  private refreshTokenValue: string

  constructor(
    private readonly client: OAuthClient,
    refreshToken: string,
    private readonly onRotate: (next: string) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
  ) {
    this.refreshTokenValue = refreshToken
  }

  async accessToken(): Promise<string> {
    // A minute of headroom, so a token does not expire between the check
    // and the call it was fetched for.
    if (this.accessTokenValue && this.now() < this.expiresAt - 60_000) {
      return this.accessTokenValue
    }

    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.refreshTokenValue,
      }).toString(),
    })

    const text = await response.text()
    if (!response.ok) throw new ReauthRequiredError(describeTokenError(text))

    const tokens = JSON.parse(text) as TokenResponse
    this.accessTokenValue = tokens.access_token
    this.expiresAt = this.now() + tokens.expires_in * 1000

    // The rotation. Stored before the token is handed out, so a crash
    // between the two loses an access token rather than the account.
    if (tokens.refresh_token && tokens.refresh_token !== this.refreshTokenValue) {
      this.refreshTokenValue = tokens.refresh_token
      await this.onRotate(tokens.refresh_token)
    }

    return this.accessTokenValue
  }
}

/** Twitch answers a bad grant with a JSON `message`. Anything else is
 *  reported as-is rather than swallowed. */
function describeTokenError(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: string; error?: string }
    return body.message ?? body.error ?? text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}
