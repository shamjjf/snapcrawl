import {
  adminUserSchema,
  apiTokenSchema,
  authResponseSchema,
  dashboardSchema,
  projectAuthoriseSchema,
  errorEnvelopeSchema,
  pageSchema,
  projectSchema,
  projectMemberAddSchema,
  projectMemberListSchema,
  registerResponseSchema,
  registerSchema,
  screenSchema,
  sessionCoverageSchema,
  sessionExportSchema,
  sessionGraphSchema,
  sessionLogEntrySchema,
  sessionSchema,
  tokenCreateResponseSchema,
  type AdminUser,
  type ApiToken,
  type AuthResponse,
  type Dashboard,
  type ErrorEnvelope,
  type Page,
  type Project,
  type ProjectAuthorise,
  type ProjectCreate,
  type ProjectMember,
  type ProjectUpdate,
  type RegisterInput,
  type RegisterResponse,
  type Screen,
  type Session,
  type SessionCoverage,
  type SessionExport,
  type SessionGraph,
  type SessionStatus,
  type SessionLogEntry,
  type TokenCreate,
  type TokenCreateResponse,
  type User,
  type UserCreate,
  type UserUpdate,
} from "@snapcrawl/shared";
import * as fixtures from "./fixtures";
import { forceLogout, getToken, setToken } from "./auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ── Fixture ⇄ live toggle ───────────────────────────────────────────────────
// Fixtures are OPT-IN: you get the real API unless you explicitly ask for fake
// data with NEXT_PUBLIC_USE_FIXTURES=true.
//
// This used to default to fixtures, which was genuinely dangerous. Fixture mode
// is not obviously fake — auth, /me and /dashboard have no fixture branch, so
// you sign in for real and see real KPI counts, and only then are the projects,
// sessions and screenshots underneath them invented. A fresh clone had no way to
// know: the override lived in .env.local, which is gitignored, so the failure
// mode was "looks perfectly normal, numbers are fabricated" on any machine but
// the one that happened to have the file.
//
// Defaulting to live means a missing backend fails loudly (a NETWORK envelope)
// instead of quietly showing fiction. When fixtures ARE on, FixtureBanner makes
// it impossible to miss.
export const USE_FIXTURES = process.env.NEXT_PUBLIC_USE_FIXTURES === "true";

// Uniform error envelope, re-exported under the panel's historical name.
export type ApiError = ErrorEnvelope;

// `Page<T>` / `pageSchema` are the shared list envelope (FR-BE-073) — imported
// from @snapcrawl/shared, never redefined here.

// The dashboard shape now lives in @snapcrawl/shared (dashboardSchema) — one
// definition for the panel and the API, so drift surfaces as a parse error
// rather than a silently-wrong tile.

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Coerce any thrown value into the uniform error envelope (FR-AP-070). */
export function toEnvelope(err: unknown): ErrorEnvelope {
  const parsed = errorEnvelopeSchema.safeParse(err);
  if (parsed.success) return parsed.data;
  if (err instanceof Error) return { code: "UNKNOWN", message: err.message };
  return { code: "UNKNOWN", message: "Something went wrong." };
}

/** Fresh envelope per throw — callers must never share a mutable error object. */
const networkError = (): ErrorEnvelope => ({
  code: "NETWORK",
  message: "Could not reach the API.",
});

/**
 * Normalise any RequestInit.headers form into one mutable Headers we can
 * re-stamp when retrying after a refresh. (Also fixes a latent bug in the old
 * object-spread: spreading a `Headers` instance yields `{}`, silently dropping
 * every header.)
 */
function buildHeaders(init?: RequestInit): Headers {
  const h = new Headers(init?.headers);
  if (!h.has("Content-Type")) h.set("Content-Type", "application/json");
  return h;
}

function bearerOf(h: Headers): string | null {
  const v = h.get("Authorization");
  return v?.startsWith("Bearer ") ? v.slice(7) : null;
}

interface RawResult {
  res: Response;
  body: unknown;
}

/**
 * Exactly one fetch. No refresh, no retry, no logout — /auth/refresh, /auth/login
 * and /auth/logout call this directly, which is what makes refresh recursion
 * impossible by construction rather than by a path-string check.
 *
 * `credentials: "include"` is what lets the httpOnly `sc_refresh` cookie be
 * stored at login and sent to /auth/refresh; without it the browser discards the
 * cookie outright on a cross-origin response. It is set globally rather than per
 * call because the cookie's own `path=/api/v1/auth` scope already stops it being
 * sent anywhere else, and the API returns an exact origin +
 * Access-Control-Allow-Credentials for every non-/ext route (FR-BE-074).
 */
async function rawFetch(
  path: string,
  headers: Headers,
  init?: RequestInit,
): Promise<RawResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
  } catch {
    throw networkError();
  }
  // 204 (logout) and empty bodies parse to {} rather than throwing.
  const body: unknown = await res.json().catch(() => ({}));
  return { res, body };
}

/* ── Auth ────────────────────────────────────────────────────────── */

export type RefreshResult =
  | { ok: true; token: string }
  | { ok: false; error: ErrorEnvelope };

/** POST /auth/refresh. Never rejects — always resolves the union. */
async function postRefresh(): Promise<RefreshResult> {
  let res: Response;
  let body: unknown;
  try {
    // No body by design: the backend authenticates this purely from the
    // httpOnly sc_refresh cookie and rotates it in the response.
    ({ res, body } = await rawFetch("/api/v1/auth/refresh", buildHeaders(), {
      method: "POST",
    }));
  } catch (err) {
    // Only the network throw is caught here. Anything below is a real fault and
    // must surface, not be laundered into a "your session expired" logout.
    return { ok: false, error: toEnvelope(err) };
  }
  if (!res.ok) return { ok: false, error: toEnvelope(body) };
  // authResponseSchema is the shared contract for { user, token } — the same
  // shape login returns. Parsed, not trusted (FR-BE-070).
  const parsed = authResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "UNKNOWN", message: "Malformed refresh response." },
    };
  }
  setToken(parsed.data.token);
  // NOTE: the response also carries a fresh `user`, which we drop. A role
  // change mid-session therefore stays stale in SessionProvider until reload.
  return { ok: true, token: parsed.data.token };
}

let refreshInFlight: Promise<RefreshResult> | null = null;

/**
 * Refresh the access token at most once per burst (FR-AP-004).
 *
 * Two layers of concurrency control, because they solve different problems. The
 * backend's rotation is atomic and it revokes the ENTIRE token family when two
 * refreshes overlap in flight (reuse detection) — so a concurrent refresh isn't
 * merely wasteful, it ejects the user.
 *
 *  1. This module-level promise coalesces the intra-tab burst: a cold dashboard
 *     load fires /me and the dashboard query together, so an expired token means
 *     two simultaneous 401s but must mean only one refresh.
 *  2. `navigator.locks` serialises across TABS. Web Locks are scoped per-origin,
 *     exactly the cookie's scope, so holding one makes overlapping refreshes
 *     impossible browser-wide. This matters: two tabs share a login, so their
 *     15-minute expiries are identical and both 401 in the same tick.
 *
 * Sequential refreshes were always safe — each sends the current cookie and
 * rotates cleanly. Only overlap is fatal, so serialising is a complete fix.
 */
export function refreshAccessToken(): Promise<RefreshResult> {
  refreshInFlight ??= withRefreshLock().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function withRefreshLock(): Promise<RefreshResult> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  // Not available in non-secure contexts; degrade to single-flight only.
  if (!locks) return postRefresh();

  // Snapshot before queueing, so the double-check inside the lock can tell
  // "another tab rotated while I waited" from "nothing changed".
  const before = getToken();

  // Time-boxed so a frozen or BFCached tab holding the lock can't stall us
  // forever; on timeout we fall through and try anyway.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    return await locks.request(
      "sc-refresh",
      { signal: ctl.signal },
      async (): Promise<RefreshResult> => {
        // Double-checked: another tab may have rotated while we queued, in which
        // case its token is already in localStorage and a second rotation is
        // pointless. This is an optimisation, not a safety net — the lock is
        // what provides the safety.
        const current = getToken();
        if (current && current !== before) return { ok: true, token: current };
        return postRefresh();
      },
    );
  } catch {
    // AbortError (lock timeout) or a non-secure context — try unlocked.
    return postRefresh();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /auth/login. Deliberately bypasses request(): a login has no bearer to
 * refresh, so a 401 here must surface to the form, never trigger a rotation.
 */
export async function login(
  email: string,
  password: string,
): Promise<{ user: User; token: string }> {
  const { res, body } = await rawFetch("/api/v1/auth/login", buildHeaders(), {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw toEnvelope(body); // e.g. INVALID_CREDENTIALS
  return body as { user: User; token: string };
}

/**
 * POST /auth/register (FR-BE-001). Bypasses request() for the same reason login
 * does: there is no bearer here, so a 409 must reach the form rather than trigger
 * a token rotation.
 *
 * Normally the API returns **201 with { user, token } and sets the sc_refresh
 * cookie**, so a new account is signed in the moment it exists. But when the
 * deployment requires email verification (FR-BE-008 is now built), it returns
 * `{ user, verificationRequired: true }` and NO token — the caller must show a
 * "check your inbox" state instead of redirecting into a session that does not
 * exist yet.
 *
 * `role` is deliberately absent from the request: the server assigns `member`
 * itself, so a crafted body cannot mint an admin. Sending one would be ignored,
 * and asking for one here would imply otherwise.
 *
 * Parsed with the shared registerResponseSchema rather than cast, so a contract
 * drift surfaces here instead of as a broken session two navigations later.
 */
export async function register(input: RegisterInput): Promise<RegisterResponse> {
  const { res, body } = await rawFetch("/api/v1/auth/register", buildHeaders(), {
    method: "POST",
    body: JSON.stringify(registerSchema.parse(input)),
  });
  if (!res.ok) throw toEnvelope(body); // e.g. EMAIL_TAKEN, or 429 from the 5/hour cap
  return registerResponseSchema.parse(body);
}

/**
 * POST /auth/forgot-password (FR-AP-003 / FR-BE-005). Resolves on success.
 *
 * The API answers **204 whether or not the address exists** — deliberately, so
 * this endpoint can't be used to enumerate accounts. The page must therefore say
 * the same thing either way, and must not imply a mail was actually sent.
 *
 * Like login/logout, no fixture branch and no refresh: there is no bearer here.
 */
export async function forgotPassword(email: string): Promise<void> {
  const { res, body } = await rawFetch("/api/v1/auth/forgot-password", buildHeaders(), {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw toEnvelope(body);
}

/**
 * POST /auth/reset-password (FR-AP-003 / FR-BE-005). Resolves on success.
 *
 * The token is single-use and expires in an hour; unknown, used and expired all
 * come back the same way — 400 `INVALID_RESET_TOKEN` — so the panel cannot tell
 * them apart and shouldn't pretend to.
 *
 * There is no auto-login by design: the server returns 204 and revokes every
 * refresh token for the user, so the panel sends them to sign in, which proves
 * the new password works.
 */
export async function resetPassword(token: string, password: string): Promise<void> {
  const { res, body } = await rawFetch("/api/v1/auth/reset-password", buildHeaders(), {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok) throw toEnvelope(body); // e.g. INVALID_RESET_TOKEN
}

/**
 * POST /auth/logout — revokes the refresh token and clears the cookie server-side
 * (FR-BE-004). Best-effort: sign-out must never be blocked by a failing request.
 * `keepalive` lets it survive the navigation away.
 */
export async function logout(): Promise<void> {
  try {
    await rawFetch("/api/v1/auth/logout", buildHeaders(), {
      method: "POST",
      keepalive: true,
    });
  } catch {
    // Ignore: the local token is cleared regardless.
  }
}

/**
 * Authed transport: on a rejected access token, silently refresh once and replay
 * the request; log out with a message only if the refresh itself fails
 * (FR-AP-004).
 *
 * Replaying is safe because a 401 proves the handler never ran: every router
 * mounts `requireAuth` before its handlers, so the request died in middleware.
 * A replayed POST/PATCH therefore cannot double-execute.
 *
 * `init.body` is likewise replayable only because every caller passes a
 * JSON.stringify'd string — a stream body would already be consumed by attempt 1.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = buildHeaders(init);
  let { res, body } = await rawFetch(path, headers, init);
  if (res.ok) return body as T;

  let env = toEnvelope(body);
  // Only an access-token rejection is refreshable. Login's bad credentials come
  // back as INVALID_CREDENTIALS, and refresh's own NO_REFRESH/INVALID_REFRESH/
  // TOKEN_REUSE never reach here (those calls bypass request()).
  if (res.status !== 401 || env.code !== "UNAUTHORIZED") throw env;

  // Cheap recovery first: another tab may have rotated the token while this
  // request was in flight, in which case localStorage already holds a better one
  // and rotating again would be wasted. Purely an optimisation — if it doesn't
  // work we still fall through to a real refresh below, because that stored
  // token can be stale too (e.g. both expired while the laptop slept).
  const sent = bearerOf(headers);
  const stored = getToken();
  if (stored && sent && stored !== sent) {
    headers.set("Authorization", `Bearer ${stored}`);
    ({ res, body } = await rawFetch(path, headers, init));
    if (res.ok) return body as T;
    env = toEnvelope(body);
    if (res.status !== 401 || env.code !== "UNAUTHORIZED") throw env;
  }

  const r = await refreshAccessToken();
  if (!r.ok) {
    forceLogout(r.error.code === "TOKEN_REUSE" ? "reuse" : "expired");
    throw env; // the original 401, unchanged
  }

  // Re-stamp the fresh bearer. `set` (not `append`) or we'd send two headers;
  // this Headers instance is the same object rawFetch used, and it overrides
  // init.headers, so the stale token is structurally unreachable.
  headers.set("Authorization", `Bearer ${r.token}`);

  const retry = await rawFetch(path, headers, init);
  if (retry.res.ok) return retry.body as T;

  const retryEnv = toEnvelope(retry.body);
  // A freshly-refreshed token was still rejected — nothing left to try. Stop
  // here rather than looping.
  if (retry.res.status === 401 && retryEnv.code === "UNAUTHORIZED") forceLogout("expired");
  throw retryEnv;
}

export function me(token: string) {
  return request<{ user: User }>("/api/v1/auth/me", {
    headers: authHeader(token),
  });
}

export async function getDashboard(token: string): Promise<Dashboard> {
  const raw = await request<unknown>("/api/v1/dashboard", { headers: authHeader(token) });
  return dashboardSchema.parse(raw);
}

/* ── Projects (FR-AP-020/021/022 · FR-BE-020..023) ───────────────── */

export async function listProjects(
  token: string,
  opts?: { search?: string; cursor?: string },
): Promise<Page<Project>> {
  if (USE_FIXTURES) return fixtures.listProjects(opts);
  const qs = new URLSearchParams();
  if (opts?.search) qs.set("search", opts.search);
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const raw = await request<unknown>(`/api/v1/projects?${qs.toString()}`, {
    headers: authHeader(token),
  });
  return pageSchema(projectSchema).parse(raw);
}

export async function getProject(token: string, id: string): Promise<Project> {
  if (USE_FIXTURES) return fixtures.getProject(id);
  const raw = await request<unknown>(`/api/v1/projects/${id}`, {
    headers: authHeader(token),
  });
  return projectSchema.parse(raw);
}

export async function createProject(
  token: string,
  input: ProjectCreate,
): Promise<Project> {
  if (USE_FIXTURES) return fixtures.createProject(input);
  const raw = await request<unknown>(`/api/v1/projects`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify(input),
  });
  return projectSchema.parse(raw);
}

/**
 * Record the authorised-use attestation for a project (NFR-020 / C-07).
 *
 * The backend 403s `AUTHORISED_USE_REQUIRED` on POST /ext/sessions until this
 * has been done once per project, and writes the confirmation (user, project,
 * timestamp) to the audit log. Idempotent server-side: re-confirming returns the
 * original attestation rather than rewriting who attested first.
 *
 * `{ confirm: true }` is a literal in the shared schema, not a boolean — an empty
 * or malformed body must never be able to attest on someone's behalf.
 */
export async function authoriseProject(token: string, id: string): Promise<Project> {
  if (USE_FIXTURES) return fixtures.authoriseProject(id);
  const body: ProjectAuthorise = { confirm: true };
  const raw = await request<unknown>(`/api/v1/projects/${id}/authorise`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify(projectAuthoriseSchema.parse(body)),
  });
  return projectSchema.parse(raw);
}

export async function updateProject(
  token: string,
  id: string,
  input: ProjectUpdate,
): Promise<Project> {
  if (USE_FIXTURES) return fixtures.updateProject(id, input);
  const raw = await request<unknown>(`/api/v1/projects/${id}`, {
    method: "PATCH",
    headers: authHeader(token),
    body: JSON.stringify(input),
  });
  return projectSchema.parse(raw);
}

export async function archiveProject(token: string, id: string): Promise<void> {
  if (USE_FIXTURES) return fixtures.archiveProject(id);
  await request(`/api/v1/projects/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
}

/* ── Extension tokens (FR-AP-061 · FR-BE-060) ────────────────────── */

export async function listTokens(token: string): Promise<ApiToken[]> {
  if (USE_FIXTURES) return fixtures.listTokens();
  const raw = await request<unknown>(`/api/v1/tokens`, {
    headers: authHeader(token),
  });
  // The API returns the shared { items, nextCursor } list envelope (FR-BE-073),
  // not a bare array; the token page only needs the items.
  return pageSchema(apiTokenSchema).parse(raw).items;
}

export async function createToken(
  token: string,
  input: TokenCreate,
): Promise<TokenCreateResponse> {
  if (USE_FIXTURES) return fixtures.createToken(input);
  const raw = await request<unknown>(`/api/v1/tokens`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify(input),
  });
  return tokenCreateResponseSchema.parse(raw);
}

export async function revokeToken(token: string, id: string): Promise<void> {
  if (USE_FIXTURES) return fixtures.revokeToken(id);
  await request(`/api/v1/tokens/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
}

/* ── Users (FR-AP-060 · FR-BE-010) ───────────────────────────────── */

export async function listUsers(
  token: string,
  opts?: { search?: string; cursor?: string },
): Promise<Page<AdminUser>> {
  if (USE_FIXTURES) return fixtures.listUsers(opts);
  const qs = new URLSearchParams();
  if (opts?.search) qs.set("search", opts.search);
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const raw = await request<unknown>(`/api/v1/users?${qs.toString()}`, {
    headers: authHeader(token),
  });
  return pageSchema(adminUserSchema).parse(raw);
}

export async function createUser(
  token: string,
  input: UserCreate,
): Promise<AdminUser> {
  if (USE_FIXTURES) return fixtures.createUser(input);
  const raw = await request<unknown>(`/api/v1/users`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify(input),
  });
  return adminUserSchema.parse(raw);
}

export async function updateUser(
  token: string,
  id: string,
  input: UserUpdate,
): Promise<AdminUser> {
  if (USE_FIXTURES) return fixtures.updateUser(id, input);
  const raw = await request<unknown>(`/api/v1/users/${id}`, {
    method: "PATCH",
    headers: authHeader(token),
    body: JSON.stringify(input),
  });
  return adminUserSchema.parse(raw);
}

/* ── Sessions + screens (FR-AP-030/031/040/041) ──────────────────────
   Sessions + single screen use the shared `Session`/`Screen` (live). The
   gallery list + logs stay on fixtures (`GalleryScreen`/`SessionLog`) until the
   backend ships GET /sessions/:id/screens + /logs and thumbUrl/isDuplicate. */

export async function listSessions(
  token: string,
  projectId: string,
  // `status` is the shared union (the server 400s anything else); from/to are
  // inclusive "YYYY-MM-DD" calendar days on createdAt (FR-AP-030 / FR-BE-035).
  opts?: { status?: SessionStatus; from?: string; to?: string; cursor?: string },
): Promise<Page<Session>> {
  if (USE_FIXTURES) return fixtures.listSessions(projectId, opts);
  const qs = new URLSearchParams({ projectId });
  if (opts?.status) qs.set("status", opts.status);
  if (opts?.from) qs.set("from", opts.from);
  if (opts?.to) qs.set("to", opts.to);
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const raw = await request<unknown>(`/api/v1/sessions?${qs.toString()}`, {
    headers: authHeader(token),
  });
  return pageSchema(sessionSchema).parse(raw);
}

export async function getSession(token: string, id: string): Promise<Session> {
  if (USE_FIXTURES) return fixtures.getSession(id);
  const raw = await request<unknown>(`/api/v1/sessions/${id}`, {
    headers: authHeader(token),
  });
  return sessionSchema.parse(raw);
}

export async function listSessionLogs(
  token: string,
  sessionId: string,
  opts?: { cursor?: string },
): Promise<Page<SessionLogEntry>> {
  if (USE_FIXTURES) return fixtures.listSessionLogs(sessionId, opts);
  const qs = new URLSearchParams();
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const raw = await request<unknown>(`/api/v1/sessions/${sessionId}/logs?${qs.toString()}`, {
    headers: authHeader(token),
  });
  return pageSchema(sessionLogEntrySchema).parse(raw);
}

export async function listScreens(
  token: string,
  sessionId: string,
  opts?: {
    url?: string;
    depth?: number;
    duplicate?: boolean;
    cursor?: string;
    variant?: "desktop" | "mobile";
  },
): Promise<Page<Screen>> {
  if (USE_FIXTURES) return fixtures.listScreens(sessionId, opts);
  const qs = new URLSearchParams();
  if (opts?.url) qs.set("url", opts.url);
  if (opts?.depth !== undefined) qs.set("depth", String(opts.depth));
  if (opts?.duplicate !== undefined) qs.set("duplicate", String(opts.duplicate));
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  if (opts?.variant) qs.set("variant", opts.variant); // FR-EX-090
  const raw = await request<unknown>(`/api/v1/sessions/${sessionId}/screens?${qs.toString()}`, {
    headers: authHeader(token),
  });
  return pageSchema(screenSchema).parse(raw);
}

/** Single screen + signed image URL (GET /screens/:id, live). Returns the
 *  shared `Screen`. */
export async function getScreen(token: string, id: string): Promise<Screen> {
  if (USE_FIXTURES) return fixtures.getScreen(id);
  const raw = await request<unknown>(`/api/v1/screens/${id}`, {
    headers: authHeader(token),
  });
  return screenSchema.parse(raw);
}

/** Delete one screenshot — DB row + S3 objects (FR-AP-043 → FR-BE, DELETE
 *  /screens/:id). Owner/admin only server-side (403 FORBIDDEN otherwise); a
 *  storage failure comes back 502 STORAGE_ERROR and leaves the row intact. */
export async function deleteScreen(token: string, id: string): Promise<void> {
  if (USE_FIXTURES) return fixtures.deleteScreen(id);
  await request(`/api/v1/screens/${id}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
}

/** Cancel a running session (FR-AP-033 → FR-BE-034). Returns the updated
 *  shared `Session`. */
export async function cancelSession(token: string, id: string): Promise<Session> {
  if (USE_FIXTURES) return fixtures.cancelSession(id);
  const raw = await request<unknown>(`/api/v1/sessions/${id}/cancel`, {
    method: "POST",
    headers: authHeader(token),
  });
  return sessionSchema.parse(raw);
}

/** Sitemap graph for a session (FR-AP-050 → FR-BE-050). Uses the shared
 *  `sessionGraphSchema`. */
export async function getSessionGraph(token: string, id: string): Promise<SessionGraph> {
  if (USE_FIXTURES) return fixtures.getSessionGraph(id);
  const raw = await request<unknown>(`/api/v1/sessions/${id}/graph`, {
    headers: authHeader(token),
  });
  return sessionGraphSchema.parse(raw);
}

/** Coverage stats for a session (FR-AP-031 → FR-BE-051): unique URLs/states,
 *  states per depth, dead edges, duplicate rate. Computed on demand server-side,
 *  so it always matches the rows it summarises (a deleted screen lowers it). */
export async function getSessionCoverage(token: string, id: string): Promise<SessionCoverage> {
  if (USE_FIXTURES) return fixtures.getSessionCoverage(id);
  const raw = await request<unknown>(`/api/v1/sessions/${id}/coverage`, {
    headers: authHeader(token),
  });
  return sessionCoverageSchema.parse(raw);
}

/* ── Session ZIP export (FR-AP-042 → FR-BE) ──────────────────────────
   A server-generated async job. POST starts (or re-uses) a build and GET polls
   it until `status` flips to `ready` (with a signed `downloadUrl`) or `failed`. */

/** Start — or re-attach to — the ZIP build for a session. The backend returns an
 *  existing pending/ready job rather than spawning a duplicate, so calling this
 *  twice is safe. */
export async function createSessionExport(token: string, id: string): Promise<SessionExport> {
  if (USE_FIXTURES) return fixtures.createSessionExport(id);
  const raw = await request<unknown>(`/api/v1/sessions/${id}/export`, {
    method: "POST",
    headers: authHeader(token),
  });
  return sessionExportSchema.parse(raw);
}

/** Poll a running export. Flips to `ready` + `downloadUrl`, or `failed` + `error`. */
export async function getSessionExport(
  token: string,
  id: string,
  exportId: string,
): Promise<SessionExport> {
  if (USE_FIXTURES) return fixtures.getSessionExport(id, exportId);
  const raw = await request<unknown>(`/api/v1/sessions/${id}/exports/${exportId}`, {
    headers: authHeader(token),
  });
  return sessionExportSchema.parse(raw);
}

/* ── Project members (FR-AP-023 → FR-BE-024) ─────────────────────────
   The people list is resolved names (not raw ids). Add takes a userId — the
   panel resolves that from the user directory (admin-only GET /users), so the
   picker is only populated for admins; a non-admin owner is told as much. */

export async function listProjectMembers(token: string, projectId: string): Promise<ProjectMember[]> {
  if (USE_FIXTURES) return fixtures.listProjectMembers(projectId);
  const raw = await request<unknown>(`/api/v1/projects/${projectId}/members`, {
    headers: authHeader(token),
  });
  return projectMemberListSchema.parse(raw).items;
}

export async function addProjectMember(
  token: string,
  projectId: string,
  userId: string,
): Promise<ProjectMember[]> {
  if (USE_FIXTURES) return fixtures.addProjectMember(projectId, userId);
  const body = projectMemberAddSchema.parse({ userId });
  const raw = await request<unknown>(`/api/v1/projects/${projectId}/members`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify(body),
  });
  return projectMemberListSchema.parse(raw).items;
}

export async function removeProjectMember(
  token: string,
  projectId: string,
  userId: string,
): Promise<ProjectMember[]> {
  if (USE_FIXTURES) return fixtures.removeProjectMember(projectId, userId);
  const raw = await request<unknown>(`/api/v1/projects/${projectId}/members/${userId}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  return projectMemberListSchema.parse(raw).items;
}

/* ── Soft-deleted projects: trash + restore (FR-BE-025) ──────────────── */

/** Projects in the trash (soft-deleted, within the 7-day grace window). */
export async function listDeletedProjects(token: string): Promise<Project[]> {
  if (USE_FIXTURES) return fixtures.listDeletedProjects();
  const raw = await request<unknown>(`/api/v1/projects/trash`, {
    headers: authHeader(token),
  });
  return pageSchema(projectSchema).parse(raw).items;
}

/** Restore a soft-deleted project before its purge (FR-BE-025). */
export async function restoreProject(token: string, id: string): Promise<Project> {
  if (USE_FIXTURES) return fixtures.restoreProject(id);
  const raw = await request<unknown>(`/api/v1/projects/${id}/restore`, {
    method: "POST",
    headers: authHeader(token),
  });
  return projectSchema.parse(raw);
}

/** SSE endpoint URL for live session events (FR-AP-032). `EventSource` can't set
 *  headers, so the bearer token rides as `?token=` (the backend's SSE auth). */
export function sessionEventsUrl(id: string, token: string): string {
  return `${API_BASE}/api/v1/sessions/${id}/events?token=${encodeURIComponent(token)}`;
}
