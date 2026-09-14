import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * One password, hashed with scrypt.
 *
 * scrypt rather than bcrypt or argon2 because it is in `node:crypto`: this
 * app is installed by people who are setting up a church A/V booth, and a
 * native module that fails to build on their machine is a worse outcome
 * than the difference between two good KDFs.
 *
 * The parameters are stored in the string, so raising them later leaves
 * existing passwords verifiable — a hash written by an older version still
 * says what it was made with.
 */

/** ~16 MB and ~100 ms on a modern machine. Well over the OWASP floor. */
const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$')
}

/**
 * Constant-time as far as it can be: a wrong-length or malformed stored hash
 * returns false without comparing, and everything else goes through
 * `timingSafeEqual`.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string]
  const cost = { N: Number(n), r: Number(r), p: Number(p) }
  if (!Number.isFinite(cost.N) || !Number.isFinite(cost.r) || !Number.isFinite(cost.p)) return false

  const want = Buffer.from(expected, 'base64')
  let got: Buffer
  try {
    got = scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, cost)
  } catch {
    // A stored hash asking for more memory than this process will give it.
    return false
  }
  return want.length === got.length && timingSafeEqual(want, got)
}

/**
 * The floor. Not a policy engine — one shared password on a LAN, where the
 * real protection is that the port is not on the internet.
 */
export const MIN_PASSWORD_LENGTH = 8

export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A password needs at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return undefined
}
