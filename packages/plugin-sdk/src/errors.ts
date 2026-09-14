/**
 * A failure with a stable code and, where possible, a remediation the operator
 * can act on. The run-detail timeline shows `remediation` verbatim — the
 * difference between "the stream didn't start" and "the refresh token was
 * rejected at 08:30, here's the reconnect button".
 */
export class DeviceError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly remediation: string | undefined

  constructor(code: string, message: string, options: { retryable?: boolean; remediation?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DeviceError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.remediation = options.remediation
  }
}

/**
 * The device still did not report what we wrote, after being given time to
 * get there.
 *
 * The wait is part of the message on purpose. Blackmagic devices transition
 * asynchronously — an ATEM goes Idle, then Connecting, then Streaming — so
 * "did not take effect" without a duration reads as "the command failed",
 * when what it means is "it had four seconds and was still not there".
 */
export class VerificationError extends DeviceError {
  constructor(what: string, expected: string, actual: string, waitedMs?: number) {
    const waited = waitedMs === undefined ? '' : ` within ${Math.round(waitedMs / 100) / 10}s`
    super(
      'verification-failed',
      `${what} did not take effect${waited}: expected ${expected}, device reports ${actual}.`,
      {
        retryable: true,
        remediation: 'Check the device is not busy or rebooting, then retry.',
      },
    )
    this.name = 'VerificationError'
  }
}
