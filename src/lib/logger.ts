/**
 * Simple logging utility for the frontend
 *
 * Everything goes to the browser console in development. Warnings and errors
 * also go to the log file Rust already writes, because the console can only be
 * read by someone with devtools open at the time: a bake that failed an hour
 * ago on someone else's machine has to have left something behind. Nothing
 * below `warn` is forwarded — the file is for what is worth reading after the
 * fact, not a transcript.
 */

import {
  warn as toFileWarn,
  error as toFileError,
} from '@tauri-apps/plugin-log'

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  level: LogLevel
  message: string
  timestamp: Date
  context?: Record<string, unknown>
}

class Logger {
  private isDevelopment = import.meta.env.DEV

  /**
   * Log a trace message (most verbose)
   */
  trace(message: string, context?: Record<string, unknown>): void {
    this.log('trace', message, context)
  }

  /**
   * Log a debug message (development only)
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context)
  }

  /**
   * Log an info message
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context)
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context)
  }

  /**
   * Log an error message
   */
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context)
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>
  ): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context,
    }

    // Always log to console in development
    if (this.isDevelopment) {
      this.logToConsole(entry)
    }

    if (level === 'warn' || level === 'error') {
      this.logToFile(entry)
    }
  }

  /**
   * Into the same file Rust logs to, one line, fire and forget.
   *
   * Never awaited and never allowed to throw: a log line failing to be written
   * must not take down the thing it was reporting on, and every caller here is
   * already in the middle of handling a problem.
   */
  private logToFile(entry: LogEntry): void {
    const line = entry.context
      ? `${entry.message} ${describe(entry.context)}`
      : entry.message

    const write = entry.level === 'warn' ? toFileWarn : toFileError
    void write(line).catch(() => {
      // Outside a webview — a test, or the plugin is gone. The console line
      // above is what is left, and it is enough.
    })
  }

  private logToConsole(entry: LogEntry): void {
    const timestamp = entry.timestamp.toISOString()
    const prefix = `[${timestamp}] [${entry.level.toUpperCase()}]`

    const args = entry.context
      ? [prefix, entry.message, entry.context]
      : [prefix, entry.message]

    switch (entry.level) {
      case 'trace':
      case 'debug':
        console.debug(...args)
        break
      case 'info':
        console.info(...args)
        break
      case 'warn':
        console.warn(...args)
        break
      case 'error':
        console.error(...args)
        break
    }
  }
}

/**
 * The context, as one line of text.
 *
 * `JSON.stringify` turns an `Error` into `{}` — name, message and stack are
 * all non-enumerable — so the one thing worth logging is the one thing it
 * drops. Errors are unwrapped by hand for that reason; anything unserializable
 * is named rather than allowed to throw from inside a logger.
 */
function describe(context: Record<string, unknown>): string {
  try {
    return JSON.stringify(context, (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
    )
  } catch {
    return '[context could not be serialized]'
  }
}

// Export a singleton logger instance
export const logger = new Logger()

// Export individual logging functions for convenience
export const { trace, debug, info, warn, error } = logger
