import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url))

export default defineConfig({
  // Resolve workspace packages to their sources so the suite runs without a
  // build step. `tsc` still resolves them through dist, so the published
  // entrypoints stay honest.
  resolve: {
    alias: {
      '@scheduler/plugin-sdk': src('plugin-sdk'),
      '@scheduler/core': src('core'),
      '@scheduler/plugin-mock': src('plugin-mock'),
      '@scheduler/plugin-hyperdeck': src('plugin-hyperdeck'),
      '@scheduler/plugin-atem': src('plugin-atem'),
      '@scheduler/plugin-youtube': src('plugin-youtube'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Several suites manipulate process-wide state (env vars for the key
    // backend, fake timers for the scheduler), so files get their own process.
    pool: 'forks',
    testTimeout: 20_000,
  },
})
