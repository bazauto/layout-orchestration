/**
 * The hand-rolled `{info,warn,error,debug?}` logger factory (#161).
 *
 * One wiring point (`index.ts`'s `adapterLogger`) feeds every adapter and
 * service, so the level lives here rather than at each call site. `debug` is
 * OMITTED from the returned object entirely unless `level === 'debug'` — not
 * present-but-no-op — so every call site writes `this.log.debug?.(...)` and a
 * suppressed line costs nothing: no string built, no object allocated,
 * nothing reaching stdout. That matters because severity does not survive
 * into journald (`docs/deployment.md` D7): a debug line that is emitted is a
 * debug line that is retained, so suppression has to happen at source, not at
 * the journal.
 *
 * Kept dependency-free on purpose. Pino is not a dependency of any workspace.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug?(msg: string, data?: Record<string, unknown>): void;
}

function write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ level, msg, ...data }) + '\n');
}

/** Builds the shared logger. `level` is `config.log.level` — anything other than `'debug'` suppresses `debug` entirely. */
export function createLogger(level: string): Logger {
  const base: Logger = {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };

  if (level === 'debug') {
    return { ...base, debug: (msg, data) => write('debug', msg, data) };
  }

  return base;
}
