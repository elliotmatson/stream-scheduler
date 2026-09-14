import type { JsonObject } from '@scheduler/plugin-sdk'
import { scrubber as defaultScrubber, type Scrubber } from './secrets/scrubber.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, data?: JsonObject): void
  info(message: string, data?: JsonObject): void
  warn(message: string, data?: JsonObject): void
  error(message: string, data?: JsonObject): void
  child(bindings: JsonObject): Logger
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface ConsoleLoggerOptions {
  level?: LogLevel
  scrubber?: Scrubber
  bindings?: JsonObject
  write?: (line: string) => void
}

/**
 * Structured logging with redaction applied at the transport, not the call
 * site. A secret cannot leak through a log line that forgot to redact,
 * because no call site does the redacting.
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const scrubber = options.scrubber ?? defaultScrubber
  const bindings = options.bindings ?? {}
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))

  const emit = (at: LogLevel, message: string, data?: JsonObject): void => {
    if (LEVEL_ORDER[at] < LEVEL_ORDER[level]) return
    const record = {
      time: new Date().toISOString(),
      level: at,
      msg: scrubber.redact(message),
      ...scrubber.redactValue({ ...bindings, ...data }),
    }
    write(JSON.stringify(record))
  }

  return {
    debug: (message, data) => emit('debug', message, data),
    info: (message, data) => emit('info', message, data),
    warn: (message, data) => emit('warn', message, data),
    error: (message, data) => emit('error', message, data),
    child: (extra) => createConsoleLogger({ ...options, bindings: { ...bindings, ...extra } }),
  }
}
