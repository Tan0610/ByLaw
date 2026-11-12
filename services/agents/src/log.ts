export type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Structured JSON logs, one object per line. Never pass secrets in `extra`. */
export function createLogger(fields: Record<string, unknown> = {}, sink: LogSink = (l) => console.log(l), minLevel: Level = 'info'): Logger {
  const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const write = (level: Level, msg: string, extra?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, ...fields, msg, ...(extra ?? {}) }));
  };
  return {
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    debug: (m, e) => write('debug', m, e),
    child: (f) => createLogger({ ...fields, ...f }, sink, minLevel),
  };
}

export const silentLogger: Logger = createLogger({}, () => {});

/** Errors to loggable text (no stack with secrets; messages only). */
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
