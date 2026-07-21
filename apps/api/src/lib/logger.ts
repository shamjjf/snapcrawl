import { AsyncLocalStorage } from "node:async_hooks";

// Structured JSON logging with request correlation (FR-BE-071).
//
// The request id rides in AsyncLocalStorage rather than being threaded through
// every function signature: a crawl failure surfaces in a service or a
// background task far from the handler, and those are exactly the logs you need
// correlated. ALS survives awaits, so anything downstream of the middleware
// picks up the id for free.

interface Store {
  requestId: string;
}

const als = new AsyncLocalStorage<Store>();

/** Run `fn` (and everything it awaits) tagged with `requestId`. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return als.run({ requestId }, fn);
}

/** The current request's id, or undefined outside a request (boot, timers). */
export function currentRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

/** One JSON object per line — the shape log shippers expect (FR-BE-071). */
export function formatLine(
  level: LogLevel,
  msg: string,
  fields: LogFields,
  requestId: string | undefined,
  now: Date,
): string {
  return JSON.stringify({
    ts: now.toISOString(),
    level,
    msg,
    ...(requestId ? { requestId } : {}),
    ...fields,
  });
}

function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const line = formatLine(level, msg, fields, currentRequestId(), new Date());
  // eslint-disable-next-line no-console
  if (level === "error") console.error(line);
  // eslint-disable-next-line no-console
  else if (level === "warn") console.warn(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

/** Render an unknown throwable into loggable fields — never the whole object,
 *  which can carry credentials (an S3 error embeds the signed request). */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { err: err.message, errName: err.name, stack: err.stack };
  }
  return { err: String(err) };
}

export const log = {
  info: (msg: string, fields?: LogFields) => {
    emit("info", msg, fields);
  },
  warn: (msg: string, fields?: LogFields) => {
    emit("warn", msg, fields);
  },
  error: (msg: string, fields?: LogFields) => {
    emit("error", msg, fields);
  },
};
