import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { log, runWithRequestId } from "../lib/logger";

// Request correlation (FR-BE-071): every request gets an id, the id comes back
// in X-Request-Id, and every log line emitted while serving it carries the id.

export const REQUEST_ID_HEADER = "X-Request-Id";

/** Accept an inbound id only if it is short and boring. It is attacker-supplied
 *  and gets echoed into a response header and into log lines, so anything with
 *  CRLF, quotes or unbounded length is a header-injection / log-forging vector.
 *  Rejecting just means we mint our own — no request is ever refused for it. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function resolveRequestId(inbound: unknown, generate: () => string = randomUUID): string {
  return typeof inbound === "string" && SAFE_ID.test(inbound) ? inbound : generate();
}

/**
 * Tag the request, echo the id, and log one line when it completes.
 *
 * Logs `req.path`, never the full URL: the SSE stream authenticates via
 * `?token=<login JWT>` (see auth.ts), so logging query strings would write live
 * credentials into the log — the one place they are most likely to be shipped
 * somewhere else and kept.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.headers["x-request-id"]);
  res.setHeader(REQUEST_ID_HEADER, id);

  runWithRequestId(id, () => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        method: req.method,
        path: req.path, // NOT originalUrl — see above.
        status: res.statusCode,
        durationMs: Math.round(ms * 10) / 10,
      };
      if (res.statusCode >= 500) log.error("request failed", fields);
      else log.info("request", fields);
    });
    next();
  });
}
