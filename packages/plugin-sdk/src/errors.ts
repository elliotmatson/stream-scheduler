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

/** The device reported a state that does not match what we just wrote. */
export class VerificationError extends DeviceError {
  constructor(what: string, expected: string, actual: string) {
    super('verification-failed', `${what} did not take effect: expected ${expected}, device reports ${actual}.`, {
      retryable: true,
      remediation: 'Check the device is not busy or rebooting, then retry.',
    })
    this.name = 'VerificationError'
  }
}
