import {
  adminUserSchema,
  apiTokenSchema,
  errorEnvelopeSchema,
  pageSchema,
  projectSchema,
  screenSchema,
  sessionGraphSchema,
  sessionLogEntrySchema,
  sessionSchema,
  tokenCreateResponseSchema,
  type AdminUser,
  type ApiToken,
  type ErrorEnvelope,
  type Page,
  type Project,
  type ProjectCreate,
  type ProjectUpdate,
  type Screen,
  type Session,
  type SessionGraph,
  type SessionLogEntry,
  type TokenCreate,
  type TokenCreateResponse,
  type User,
  type UserCreate,
  type UserUpdate,
} from "@snapcrawl/shared";
import * as fixtures from "./fixtures";
import { onUnauthorized } from "./auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ── Fixture ⇄ live toggle ───────────────────────────────────────────────────
// The panel runs entirely on typed fixtures until each backend endpoint ships.
// Flip to live with NEXT_PUBLIC_USE_FIXTURES=false (env) — one change switches
// every endpoint below to its real request. Each fn keeps the live call inline
// so an individual endpoint can be moved over by deleting its fixture branch.
export const USE_FIXTURES =
  (process.env.NEXT_PUBLIC_USE_FIXTURES ?? "true") !== "false";

// Uniform error envelope, re-exported under the panel's historical name.
export type ApiError = ErrorEnvelope;

// `Page<T>` / `pageSchema` are the shared list envelope (FR-BE-073) — imported
// from @snapcrawl/shared, never redefined here.

export interface DashboardData {
  stats: {
    projects: number;
    sessionsLast30Days: number;
    screensCaptured: number;
    storageBytes: number;
  };
  recentSessions: {
    id: string;
    // Empty when the session's project was deleted; the row then isn't linkable.
    projectId: string;
    project: string;
    status: string;
    screens: number;
    startedAt: string;
  }[];
}

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw { code: "NETWORK", message: "Could not reach the API." } satisfies ErrorEnvelope;
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const env = toEnvelope(body);
    // An invalid/expired access token → auto-logout with a message (FR-AP-004).
    // Bad-credentials (login) come back as INVALID_CREDENTIALS, not UNAUTHORIZED.
    if (env.code === "UNAUTHORIZED") onUnauthorized();
    throw env;
  }
  return body as T;
}

/* ── Auth ────────────────────────────────────────────────────────── */

export function login(email: string, password: string) {
  return request<{ user: User; token: string }>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function me(token: string) {
  return request<{ user: User }>("/api/v1/auth/me", {
    headers: authHeader(token),
  });
}

export function getDashboard(token: string) {
  return request<DashboardData>("/api/v1/dashboard", {
    headers: authHeader(token),
  });
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
  opts?: { status?: string; from?: string; to?: string; cursor?: string },
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
  opts?: { url?: string; depth?: number; duplicate?: boolean; cursor?: string },
): Promise<Page<Screen>> {
  if (USE_FIXTURES) return fixtures.listScreens(sessionId, opts);
  const qs = new URLSearchParams();
  if (opts?.url) qs.set("url", opts.url);
  if (opts?.depth !== undefined) qs.set("depth", String(opts.depth));
  if (opts?.duplicate !== undefined) qs.set("duplicate", String(opts.duplicate));
  if (opts?.cursor) qs.set("cursor", opts.cursor);
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

/** SSE endpoint URL for live session events (FR-AP-032). `EventSource` can't set
 *  headers, so the bearer token rides as `?token=` (the backend's SSE auth). */
export function sessionEventsUrl(id: string, token: string): string {
  return `${API_BASE}/api/v1/sessions/${id}/events?token=${encodeURIComponent(token)}`;
}
