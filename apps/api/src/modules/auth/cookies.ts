import type { Request, Response } from "express";
import { isProd } from "../../config/env";

// Refresh-token cookie transport (FR-BE-002). Shared by the auth controller and
// by /users/me, which re-issues the cookie after a password change.
const REFRESH_COOKIE = "sc_refresh";
const REFRESH_PATH = "/api/v1/auth";

export function setRefreshCookie(res: Response, raw: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    // Secure only in prod so the cookie still flows over http://localhost.
    secure: isProd(),
    sameSite: "lax",
    path: REFRESH_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: REFRESH_PATH,
  });
}

/** Read the refresh cookie without pulling in cookie-parser. */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === REFRESH_COOKIE) {
      // A malformed percent-encoding must behave like an absent cookie (→ 401),
      // not throw a URIError that surfaces as a 500.
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
