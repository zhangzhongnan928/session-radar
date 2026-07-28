export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured lines on stderr so launchd captures them and stdout stays free for
 * machine-readable CLI output. Nothing here may log prompt or reply content.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const min = LEVEL_RANK[level];

  function write(logLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[logLevel] < min) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: logLevel,
      msg: message,
      ...(fields ?? {}),
    });
    process.stderr.write(`${line}\n`);
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/** Discards everything. Used by tests. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

export function resolveLogLevel(): LogLevel {
  const raw = (process.env['SESSION_RADAR_LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}
