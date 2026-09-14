import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Several suites manipulate process-wide state (env vars for the key backend,
    // fake timers for the scheduler), so files get their own process.
    pool: 'forks',
    testTimeout: 20_000,
  },
})
