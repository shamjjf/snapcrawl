// Client-side token storage (simple slice — localStorage + Bearer). Production
// uses an httpOnly refresh cookie with rotation (SRS FR-BE-002/003).

const KEY = "sc-token";

export function getToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}

let redirecting = false;

/**
 * Single choke point for an authentication failure (a 401 with code
 * UNAUTHORIZED — an invalid/expired/revoked access token): clear the token and
 * send the user to the login page with an "expired" message and a return path,
 * loop-guarded so a burst of 401s only redirects once (FR-AP-004).
 *
 * FUTURE (silent refresh, FR-AP-004): before logging out, this is where a
 * `POST /auth/refresh` attempt (via the backend's httpOnly refresh cookie) +
 * one retry of the failed request will go. Deferred until the backend ships
 * `/auth/refresh` + the cookie — see docs coordination note.
 */
export function onUnauthorized(): void {
  if (redirecting || typeof window === "undefined") return;
  clearToken();
  if (window.location.pathname === "/login") return;
  redirecting = true;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.assign(`/login?expired=1&next=${next}`);
}
