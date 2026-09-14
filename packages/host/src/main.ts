import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Application, createServer } from '@scheduler/core'
import type { LogLevel } from '@scheduler/core'
import { bundledDestinations, bundledPlugins } from './plugins.js'

/**
 * The headless entrypoint: what Docker runs, and what a Mac or PC user can
 * run from a terminal. The Electron main process builds the same
 * `Application`, so there is exactly one code path either way.
 */
export async function startHost(): Promise<{ stop: () => Promise<void>; url: string }> {
  const port = Number(process.env.SCHEDULER_PORT ?? 8500)
  const host = process.env.SCHEDULER_HOST ?? '127.0.0.1'

  const app = Application.create({
    plugins: bundledPlugins(),
    ...(process.env.SCHEDULER_LOG_LEVEL
      ? { logLevel: process.env.SCHEDULER_LOG_LEVEL as LogLevel }
      : {}),
  })

  // Registered after construction so the credential lookup can close over a
  // fully built app. Providers ask for credentials; they never reach into
  // the database or the vault themselves.
  for (const provider of bundledDestinations(async (accountRef) => {
    const { clientId, clientSecret, refreshToken } = app.destinations.resolveOAuthClient(accountRef)
    return { client: { clientId, clientSecret }, refreshToken }
  })) {
    app.destinations.register(provider)
  }

  const server = await createServer({
    app,
    port,
    host,
    webRoot: join(dirname(fileURLToPath(import.meta.url)), '..', 'web'),
  })

  await app.start()
  await server.listen({ port, host })
  const url = `http://${host}:${port}`
  app.logger.info('listening', { url })

  return {
    url,
    stop: async () => {
      await server.close()
      await app.stop()
    },
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (isDirectRun) {
  startHost()
    .then(({ stop }) => {
      const shutdown = (signal: string): void => {
        void stop().then(() => process.exit(0))
        process.stderr.write(`received ${signal}, shutting down\n`)
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
    })
    .catch((error: unknown) => {
      // Startup failures here are almost always a missing master key or an
      // unwritable config directory. Both errors name their own fix, so print
      // the message plainly rather than burying it in a stack trace.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
