import { createHash, randomBytes } from 'node:crypto'
import type { Fetch, TokenSource } from './api.js'

export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

/**
 * Only what is needed to create and manage broadcasts and add them to a
 * playlist. Every extra scope makes a future verification review harder, so
 * this list should stay exactly this short.
 */
export const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl']

export class ReauthRequiredError extends Error {
  readonly code = 'reauth-required'
  readonly retryable = false
  readonly remediation: string

  constructor(detail: string) {
    super(`YouTube rejected the stored authorization: ${detail}`)
    this.name = 'ReauthRequiredError'
    // By far the most common cause, and it is invisible until a week after
    // setup, so the message names it first.
    this.remediation =
      'Reconnect the account. If this happened about a week after connecting, the Google Cloud OAuth ' +
      'consent screen is probably still set to "Testing", which expires refresh tokens after 7 days — ' +
      'set it to "In production" and reconnect.'
  }
}

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

/** The authorization-code-with-PKCE flow for an installed app. */
export interface PendingAuthorization {
  url: string
  codeVerifier: string
  state: string
  redirectUri: string
}

export function beginAuthorization(client: OAuthClient, redirectUri: string): PendingAuthorization {
  const codeVerifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest())
  const state = base64Url(randomBytes(16))

  const url = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // Required to get a refresh token at all, and `consent` forces Google to
    // re-issue one even if the user has authorized this client before.
    access_type: 'offline',
    prompt: 'consent',
  }).toString()}`

  return { url, codeVerifier, state, redirectUri }
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
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
      code_verifier: pending.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: pending.redirectUri,
    }).toString(),
  })

  const text = await response.text()
  if (!response.ok) throw new ReauthRequiredError(describeTokenError(text))

  const tokens = JSON.parse(text) as TokenResponse
  if (!tokens.refresh_token) {
    throw new ReauthRequiredError(
      'Google did not return a refresh token, so the connection would stop working as soon as the ' +
        "access token expired. Remove this app from the account's third-party access and connect again.",
    )
  }
  return tokens
}

/**
 * Holds an access token and refreshes it when it is close to expiring.
 *
 * Refreshing early rather than on a 401 matters here: the alternative is
 * discovering the credential is dead in the middle of a prepare phase.
 */
export class RefreshingTokenSource implements TokenSource {
  private accessTokenValue: string | undefined
  private expiresAt = 0

  constructor(
    private readonly client: OAuthClient,
    private readonly refreshToken: string,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
  ) {}

  async accessToken(): Promise<string> {
    // 60 seconds of slack, so a token cannot expire between the check and
    // the call it was fetched for.
    if (this.accessTokenValue && this.now() < this.expiresAt - 60_000) return this.accessTokenValue

    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    })

    const text = await response.text()
    if (!response.ok) throw new ReauthRequiredError(describeTokenError(text))

    const tokens = JSON.parse(text) as TokenResponse
    this.accessTokenValue = tokens.access_token
    this.expiresAt = this.now() + tokens.expires_in * 1000
    return this.accessTokenValue
  }
}

function describeTokenError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string; error_description?: string }
    const error = parsed.error ?? 'unknown_error'
    return parsed.error_description ? `${error} (${parsed.error_description})` : error
  } catch {
    return text || 'no detail'
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
