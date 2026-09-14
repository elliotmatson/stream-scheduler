import { createHash } from 'node:crypto'

/**
 * A short, stable fingerprint of a secret.
 *
 * Lives in the SDK because both sides need the same algorithm: the host
 * computes the fingerprint of the key it pushed, and the plugin reports the
 * fingerprint of the key the device actually holds. Verify-after-write then
 * compares them without the secret itself travelling back across the boundary.
 */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12)
}
