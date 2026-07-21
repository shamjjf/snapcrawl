// Client-side token store (localStorage + Bearer) and the logout choke point.
// The refresh token itself never passes through here: it lives in the backend's
// httpOnly `sc_refresh` cookie, which JS cannot read by design (FR-BE-002/003).
// The transport in lib/api.ts drives the rotation.

const KEY = "sc-token";

/**
 * Non-secret "someone is signed in here" marker, mirroring the access token so
 * the edge `middleware.ts` has something to gate on (FR-AP-002).
 *
 * Why this exists: the backend's real session cookie (`sc_refresh`) **cannot**
 * be used for route protection. It is scoped `Path=/api/v1/auth`, so the browser
 * never sends it to `/dashboard` — verified: `GET /dashboard` carries no Cookie
 * header at all. It also lives on the API's origin, not the panel's. So the edge
 * has no way to see it.
 *
 * This cookie holds **no** credential — just "1". It is deliberately readable by
 * JS, because JS is what writes it. It is NOT a security boundary and must never
 * be treated as one: it says a session *was* established, not that it is still
 * valid. Authorisation stays where it can actually be enforced — the API, which
 * validates the bearer on every request (FR-AP-072).
 *
 * Lifetime is tied to the token, not to a timer, so the two cannot disagree.
 * That matters: if the cookie said "signed in" while the token was gone (or the
 * reverse), middleware and the login page would bounce the user back and forth
 * forever. Writing both here, together, is what makes that impossible.
 */
const SESSION_COOKIE = "sc_session";

function setSessionCookie(): void {
  if (typeof document === "undefined") return;
  // Session-scoped (no Expires): it should not outlive the tab, and the token in
  // localStorage is re-checked on every load anyway. Lax so a normal top-level
  // navigation into /dashboard still carries it.
  document.cookie = `${SESSION_COOKIE}=1; path=/; SameSite=Lax`;
}

function clearSessionCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${SESSION_COOKIE}=; path=/; SameSite=Lax; Max-Age=0`;
}

export function getToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY);
}

export function setToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, token);
  // Always together — see SESSION_COOKIE.
  setSessionCookie();
}

export function clearToken(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
  clearSessionCookie();
}

/**
 * Re-sync the presence cookie with the token. Covers the one case where they can
 * drift through no fault of ours: the cookie is session-scoped, so closing and
 * reopening the browser drops it while localStorage survives. Without this the
 * user would have a perfectly good token and be bounced to login by middleware.
 */
export function syncSessionCookie(): void {
  if (getToken()) setSessionCookie();
  else clearSessionCookie();
}

/** Why the session ended, so the login page can say something accurate. */
export type LogoutReason = "expired" | "reuse";

let redirecting = false;

/**
 * Single choke point for an unrecoverable authentication failure: the access
 * token was rejected AND a silent refresh could not save it (FR-AP-004). Clears
 * the token and sends the user to login with a message and a return path.
 *
 * Loop-guarded because a revoked token family 401s every in-flight query at
 * once: they all await the one failed refresh, and all land here. Only the first
 * should navigate.
 *
 * `window.location.assign`, not router.replace: a full document load also resets
 * the guard and drops the TanStack Query cache, so the next user can't see the
 * previous one's data. A client-side nav would leave both behind.
 *
 * Does NOT call POST /auth/logout — on any refresh failure the backend has
 * already cleared the cookie, and on "reuse" it revoked the whole family too.
 */
export function forceLogout(reason: LogoutReason = "expired"): void {
  if (redirecting || typeof window === "undefined") return;
  clearToken();
  if (window.location.pathname === "/login") return;
  redirecting = true;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  // `expired=1` stays the stable contract (anything already linking here keeps
  // working); `reason` is purely additive.
  const params = `expired=1&next=${next}` + (reason === "reuse" ? "&reason=reuse" : "");
  window.location.assign(`/login?${params}`);
}

/** Test-only: reset the module-level redirect guard between cases. */
export function __resetLogoutGuard(): void {
  redirecting = false;
}
