import type { NextFunction, Response } from "express";
import { ApiError } from "../http/envelope";
import type { ExtRequest } from "./extAuth";

// Per-token rate limiting (FR-BE-062). In-memory fixed window — fine for a
// single dev instance; production needs a shared store (Redis) so limits hold
// across horizontally-scaled API instances (NFR-004).

export interface RateWindow {
  count: number;
  resetAt: number;
}

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  window: RateWindow;
}

/** Pure fixed-window accounting — unit-tested without touching the clock/Map. */
export function checkWindow(
  prev: RateWindow | undefined,
  now: number,
  limit: number,
  windowMs: number,
): RateResult {
  const w: RateWindow =
    !prev || now >= prev.resetAt ? { count: 0, resetAt: now + windowMs } : { ...prev };
  w.count += 1;
  return {
    allowed: w.count <= limit,
    remaining: Math.max(0, limit - w.count),
    retryAfterSec: Math.max(0, Math.ceil((w.resetAt - now) / 1000)),
    window: w,
  };
}

/** Express middleware: limit requests per extension token (default 300/min). */
export function perTokenRateLimit(limit: number, windowMs = 60_000) {
  const buckets = new Map<string, RateWindow>();
  return (req: ExtRequest, res: Response, next: NextFunction): void => {
    const key = req.extTokenId ?? req.ip ?? "anon";
    const r = checkWindow(buckets.get(key), Date.now(), limit, windowMs);
    buckets.set(key, r.window);
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(r.remaining));
    if (!r.allowed) {
      res.setHeader("Retry-After", String(r.retryAfterSec));
      next(new ApiError(429, "RATE_LIMITED", "Too many requests; slow down."));
      return;
    }
    next();
  };
}
