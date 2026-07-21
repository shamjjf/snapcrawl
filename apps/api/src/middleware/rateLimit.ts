import type { NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "../auth";
import { ApiError } from "../http/envelope";
import type { ExtRequest } from "./extAuth";

// Rate limiting (FR-BE-062 per-token, FR-BE-007 auth). In-memory fixed window —
// fine for a single dev instance; production needs a shared store (Redis) so
// limits hold across horizontally-scaled API instances (NFR-004). Until then a
// two-instance deployment doubles every effective limit.

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

// ── Auth endpoint limits (FR-BE-007) ────────────────────────────────────────

/** Normalise an email for use as a bucket key. Lower-cased so Victim@x.com and
 *  victim@x.com share one bucket — otherwise case alone resets the counter. */
export function emailKey(body: unknown): string {
  const email = (body as { email?: unknown } | null)?.email;
  return typeof email === "string" ? email.trim().toLowerCase().slice(0, 200) : "";
}

/** Bucket key for an IP+email pair (FR-BE-007). */
export function ipEmailKey(req: Request): string {
  return `${req.ip ?? "anon"}|${emailKey(req.body)}`;
}

/** Bucket key for the target account alone, regardless of source. */
export function identityKey(req: Request): string {
  return `email:${emailKey(req.body)}`;
}

/** Bucket key for the source alone, regardless of target. */
export function sourceKey(req: Request): string {
  return `ip:${req.ip ?? "anon"}`;
}

/** Bucket key for the AUTHENTICATED user (for limits on logged-in routes). Keys
 *  on the user id set by requireAuth — a per-user quota, so one user's abuse
 *  can't exhaust another's, and a shared office IP isn't one shared bucket.
 *  Falls back to IP only if somehow unauthenticated (it never should be here). */
export function userKey(req: Request): string {
  const user = (req as AuthedRequest).user;
  return user ? `user:${user.id}` : `ip:${req.ip ?? "anon"}`;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** What to count per. Compose several limiters when one key can't cover the
   *  threat — an IP+email pair does not stop a botnet flooding one inbox, and a
   *  per-email cap does not stop one host spraying a thousand addresses. */
  key: (req: Request) => string;
  message?: string;
}

/**
 * Generic keyed fixed-window limiter (FR-BE-007).
 *
 * Deliberately separate from perTokenRateLimit: that one keys on `extTokenId`,
 * which does not exist on an unauthenticated auth route — every caller would
 * collapse into one shared `req.ip` bucket, and it cannot key on the email at
 * all. These routes are reached BEFORE anyone has proved who they are, so the
 * key has to come from the request body.
 */
export function rateLimit({ limit, windowMs, key, message }: RateLimitOptions) {
  const buckets = new Map<string, RateWindow>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = checkWindow(buckets.get(key(req)), Date.now(), limit, windowMs);
    buckets.set(key(req), r.window);
    if (!r.allowed) {
      res.setHeader("Retry-After", String(r.retryAfterSec));
      next(
        new ApiError(
          429,
          "RATE_LIMITED",
          message ?? "Too many attempts. Please wait and try again.",
        ),
      );
      return;
    }
    next();
  };
}
