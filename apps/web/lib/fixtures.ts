// In-memory typed fixtures for the admin panel. Every fixture is parsed through
// the SAME @snapcrawl/shared schema the live endpoint will return, so the panel
// behaves identically now and after the backend ships. Mutations mutate this
// store so create/edit/archive/revoke feel real without a server.
//
// This file is only reached while lib/api.ts runs in fixture mode
// (NEXT_PUBLIC_USE_FIXTURES !== "false"). It is never imported by the live path.

import {
  adminUserSchema,
  apiTokenSchema,
  crawlConfigSchema,
  projectSchema,
  tokenCreateResponseSchema,
  type AdminUser,
  type ApiToken,
  type Page,
  type Project,
  type ProjectCreate,
  type ProjectUpdate,
  type Screen,
  type Session,
  type SessionEndReason,
  type SessionLogEntry,
  type SessionStatus,
  type TokenCreate,
  type TokenCreateResponse,
  type GraphEdge,
  type GraphNode,
  type SessionGraph,
  type UserCreate,
  type UserUpdate,
} from "@snapcrawl/shared";

const rawDefaultConfig = crawlConfigSchema.parse({});

/** 24-char hex ObjectId-like id (fixtures only). */
function hexId(n: number): string {
  return n.toString(16).padStart(24, "0");
}

let seq = 5000;
function nextSeq(): number {
  return (seq += 1);
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i += 1) arr[i] = (nextSeq() * 31 + i) & 255;
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function delay(ms = 220): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROJECT_NAMES = [
  "Acme Staging",
  "Dashboard QA",
  "Marketing Site",
  "Docs Portal",
  "Checkout Flow",
  "Admin Console",
  "Mobile Web",
  "Support Center",
  "Billing App",
  "Onboarding",
];

const LAST_RUN_STATUSES: SessionStatus[] = [
  "completed",
  "running",
  "failed",
  "cancelled",
];

const store = {
  projects: PROJECT_NAMES.map((name, i) => {
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const month = (i % 9) + 1;
    return projectSchema.parse({
      id: hexId(1000 + i),
      ownerId: hexId(1),
      memberIds: [],
      name,
      description: `Automated UI crawl of ${name}.`,
      baseUrl: `https://${slug}.example`,
      config: { ...rawDefaultConfig, allowedDomains: [`${slug}.example`] },
      status: i % 7 === 6 ? "archived" : "active",
      createdAt: `2026-0${month}-15T09:00:00Z`,
      updatedAt: `2026-07-0${month}T09:00:00Z`,
      lastRun:
        i % 3 === 0
          ? null
          : {
              sessionId: hexId(2000 + i),
              status: LAST_RUN_STATUSES[i % LAST_RUN_STATUSES.length],
              startedAt: `2026-07-0${month}T12:00:00Z`,
              screensCaptured: (i + 1) * 13,
            },
    });
  }) as Project[],

  tokens: [
    apiTokenSchema.parse({
      id: hexId(3001),
      name: "Work laptop",
      scopes: ["capture"],
      lastUsedAt: "2026-07-09T08:30:00Z",
      expiresAt: null,
      revokedAt: null,
      createdAt: "2026-06-01T10:00:00Z",
    }),
    apiTokenSchema.parse({
      id: hexId(3002),
      name: "Home desktop",
      scopes: ["capture"],
      lastUsedAt: null,
      expiresAt: "2026-12-31T00:00:00Z",
      revokedAt: null,
      createdAt: "2026-06-15T10:00:00Z",
    }),
    apiTokenSchema.parse({
      id: hexId(3003),
      name: "Old CI runner",
      scopes: ["capture"],
      lastUsedAt: "2026-05-01T10:00:00Z",
      expiresAt: null,
      revokedAt: "2026-06-20T10:00:00Z",
      createdAt: "2026-04-01T10:00:00Z",
    }),
  ] as ApiToken[],

  users: [
    adminUserSchema.parse({
      id: hexId(4001),
      name: "Admin",
      email: "admin@snapcrawl.dev",
      role: "admin",
      status: "active",
      lastLoginAt: "2026-07-10T09:00:00Z",
      createdAt: "2026-05-01T10:00:00Z",
    }),
    adminUserSchema.parse({
      id: hexId(4002),
      name: "Riya Member",
      email: "riya@snapcrawl.dev",
      role: "member",
      status: "active",
      lastLoginAt: "2026-07-09T14:30:00Z",
      createdAt: "2026-05-20T10:00:00Z",
    }),
    adminUserSchema.parse({
      id: hexId(4003),
      name: "Sam Viewer",
      email: "sam@snapcrawl.dev",
      role: "viewer",
      status: "active",
      lastLoginAt: null,
      createdAt: "2026-06-02T10:00:00Z",
    }),
    adminUserSchema.parse({
      id: hexId(4004),
      name: "Old Teammate",
      email: "old@snapcrawl.dev",
      role: "member",
      status: "deactivated",
      lastLoginAt: "2026-04-15T10:00:00Z",
      createdAt: "2026-03-01T10:00:00Z",
    }),
  ] as AdminUser[],
};

const PAGE_SIZE = 6;

/* ── Sessions / screens / logs (results UI fixtures) ─────────────────────────
   Built from the local view-schemas, which reuse shared primitives. Thumbnails
   are inline SVG data URIs so the gallery renders with no external assets. */

function svgThumb(seed: number, label: string, w = 400, h = 260): string {
  const hue = (seed * 47) % 360;
  const safe = label.replace(/[<>&]/g, "").slice(0, 26);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<rect width='100%' height='100%' fill='hsl(${hue} 55% 93%)'/>` +
    `<rect width='100%' height='${Math.round(h * 0.16)}' fill='hsl(${hue} 55% 55%)'/>` +
    `<rect x='${w * 0.06}' y='${h * 0.3}' width='${w * 0.5}' height='12' rx='6' fill='hsl(${hue} 35% 66%)'/>` +
    `<rect x='${w * 0.06}' y='${h * 0.46}' width='${w * 0.82}' height='8' rx='4' fill='hsl(${hue} 25% 80%)'/>` +
    `<rect x='${w * 0.06}' y='${h * 0.58}' width='${w * 0.7}' height='8' rx='4' fill='hsl(${hue} 25% 80%)'/>` +
    `<rect x='${w * 0.06}' y='${h * 0.7}' width='${w * 0.78}' height='8' rx='4' fill='hsl(${hue} 25% 80%)'/>` +
    `<text x='${w * 0.06}' y='${h * 0.135}' font-family='sans-serif' font-size='13' fill='white'>${safe}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const SESSION_PLAN: { status: SessionStatus; endReason: SessionEndReason | null }[] = [
  { status: "completed", endReason: "frontier-exhausted" },
  { status: "completed", endReason: "limit-reached" },
  { status: "running", endReason: null },
  { status: "failed", endReason: "error" },
  { status: "cancelled", endReason: "cancelled" },
];

const sessionStore: Session[] = [];
const screensBySession: Record<string, Screen[]> = {};
const logsBySession: Record<string, SessionLogEntry[]> = {};

store.projects.slice(0, 4).forEach((proj, pi) => {
  const sessionCount = 2 + (pi % 2); // 2 or 3 per project
  for (let si = 0; si < sessionCount; si += 1) {
    const plan = SESSION_PLAN[(pi + si) % SESSION_PLAN.length];
    const id = hexId(nextSeq());
    const day = ((pi + si) % 9) + 1;
    const createdAt = new Date(`2026-07-0${day}T10:00:00Z`);
    const running = plan.status === "running";
    const startedAt = new Date(createdAt.getTime() + 5000);
    const screenCount = running ? 4 + si * 2 : 8 + ((pi + si) * 3) % 12;
    const maxDepth = Math.min(proj.config.maxDepth, 1 + ((pi + si) % 4));
    const endedAt = running ? null : new Date(startedAt.getTime() + screenCount * 4000 + 60_000);

    const screens: Screen[] = [];
    for (let k = 0; k < screenCount; k += 1) {
      const path = k === 0 ? "" : `/page-${k}`;
      const label = k === 0 ? "Home" : `Page ${k}`;
      const capturedAt = new Date(startedAt.getTime() + k * 4000);
      screens.push({
        id: hexId(nextSeq()),
        sessionId: id,
        projectId: proj.id,
        fingerprint: hexId(nextSeq()),
        url: `${proj.baseUrl}${path}`,
        title: `${proj.name} — ${label}`,
        depth: Math.min(maxDepth, Math.floor(k / 3)),
        parentScreenId: k === 0 ? null : screens[k - 1].id,
        triggerElement:
          k === 0 ? null : { selector: `a.nav-${k}`, text: label, tag: "a", role: "link" },
        thumbUrl: svgThumb(pi * 10 + k, label),
        imageUrl: svgThumb(pi * 10 + k, label, 1000, 650),
        contentHash: hexId(nextSeq()),
        width: 1366,
        height: 900,
        fullPage: proj.config.fullPage,
        isDuplicate: k > 0 && k % 5 === 0,
        capturedAt,
        createdAt: capturedAt,
      });
    }
    screensBySession[id] = screens;

    sessionStore.push({
      id,
      projectId: proj.id,
      userId: hexId(1),
      tokenId: null,
      status: plan.status,
      endReason: plan.endReason,
      cancelRequested: false,
      startedAt,
      endedAt,
      lastHeartbeatAt: running ? new Date(startedAt.getTime() + 30_000) : endedAt,
      createdAt,
      updatedAt: endedAt ?? startedAt,
      configSnapshot: proj.config,
      stats: {
        screensCaptured: screens.length,
        edgesRecorded: screens.length + 3,
        duplicatesSkipped: screens.filter((s) => s.isDuplicate).length,
        errorsCount: plan.status === "failed" ? 2 : 0,
        maxDepthReached: maxDepth,
        currentUrl: running ? `${proj.baseUrl}/page-${screenCount}` : "",
      },
    });

    const mkLog = (seq: number, level: string, event: string, context: string, atMs: number): SessionLogEntry => {
      const at = new Date(startedAt.getTime() + atMs);
      return { id: hexId(nextSeq()), sessionId: id, seq, level, event, context, at, createdAt: at };
    };
    const logs: SessionLogEntry[] = [
      mkLog(1, "info", "session-started", proj.baseUrl, 0),
      mkLog(2, "info", "clicked", "a.nav-1 -> /page-1", 4000),
      mkLog(3, "warn", "skipped-blocked", "button 'Delete' (destructive blocklist)", 8000),
      mkLog(4, "warn", "dead-edge", "a.tab-2 produced no state change", 12000),
    ];
    if (plan.status === "failed") {
      logs.push(mkLog(5, "error", "capture-failed", "captureVisibleTab rate limit; requeued", 16000));
    }
    logsBySession[id] = logs;
  }
});

/* ── Projects ────────────────────────────────────────────────────── */

export async function listProjects(opts?: {
  search?: string;
  cursor?: string;
}): Promise<Page<Project>> {
  await delay();
  const q = (opts?.search ?? "").trim().toLowerCase();
  const all = store.projects.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.baseUrl.toLowerCase().includes(q),
  );
  const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
  const items = all.slice(start, start + PAGE_SIZE);
  const end = start + PAGE_SIZE;
  return { items, nextCursor: end < all.length ? String(end) : null };
}

export async function getProject(id: string): Promise<Project> {
  await delay();
  const found = store.projects.find((p) => p.id === id);
  if (!found) throw { code: "NOT_FOUND", message: "Project not found." };
  return found;
}

export async function createProject(input: ProjectCreate): Promise<Project> {
  await delay();
  const config = crawlConfigSchema.parse(input.config ?? {});
  const now = new Date();
  const project: Project = {
    id: hexId(nextSeq()),
    ownerId: hexId(1),
    memberIds: [],
    name: input.name,
    description: input.description,
    baseUrl: input.baseUrl,
    config,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastRun: null,
  };
  store.projects = [project, ...store.projects];
  return project;
}

export async function updateProject(
  id: string,
  input: ProjectUpdate,
): Promise<Project> {
  await delay();
  let updated: Project | undefined;
  store.projects = store.projects.map((p) => {
    if (p.id !== id) return p;
    updated = {
      ...p,
      name: input.name ?? p.name,
      description: input.description ?? p.description,
      baseUrl: input.baseUrl ?? p.baseUrl,
      config: input.config
        ? crawlConfigSchema.parse({ ...p.config, ...input.config })
        : p.config,
      status: input.status ?? p.status,
      updatedAt: new Date(),
    };
    return updated;
  });
  if (!updated) throw { code: "NOT_FOUND", message: "Project not found." };
  return updated;
}

export async function archiveProject(id: string): Promise<void> {
  await delay();
  store.projects = store.projects.map((p) =>
    p.id === id ? { ...p, status: "archived", updatedAt: new Date() } : p,
  );
}

/* ── Tokens ──────────────────────────────────────────────────────── */

export async function listTokens(): Promise<ApiToken[]> {
  await delay();
  return store.tokens;
}

export async function createToken(
  input: TokenCreate,
): Promise<TokenCreateResponse> {
  await delay();
  const record = apiTokenSchema.parse({
    id: hexId(nextSeq()),
    name: input.name,
    scopes: ["capture"],
    lastUsedAt: null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
  store.tokens = [record, ...store.tokens];
  return tokenCreateResponseSchema.parse({
    token: record,
    rawToken: `sc_${randomHex(24)}`,
  });
}

export async function revokeToken(id: string): Promise<void> {
  await delay();
  store.tokens = store.tokens.map((t) =>
    t.id === id ? { ...t, revokedAt: new Date() } : t,
  );
}

/* ── Users ───────────────────────────────────────────────────────── */

export async function listUsers(opts?: {
  search?: string;
  cursor?: string;
}): Promise<Page<AdminUser>> {
  await delay();
  const q = (opts?.search ?? "").trim().toLowerCase();
  const all = store.users.filter(
    (u) =>
      !q ||
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q),
  );
  const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
  const items = all.slice(start, start + PAGE_SIZE);
  const end = start + PAGE_SIZE;
  return { items, nextCursor: end < all.length ? String(end) : null };
}

export async function createUser(input: UserCreate): Promise<AdminUser> {
  await delay();
  const user: AdminUser = {
    id: hexId(nextSeq()),
    name: input.name,
    email: input.email.toLowerCase(),
    role: input.role,
    status: "active",
    lastLoginAt: null,
    createdAt: new Date(),
  };
  store.users = [user, ...store.users];
  return user;
}

export async function updateUser(
  id: string,
  input: UserUpdate,
): Promise<AdminUser> {
  await delay();
  let updated: AdminUser | undefined;
  store.users = store.users.map((u) => {
    if (u.id !== id) return u;
    updated = {
      ...u,
      role: input.role ?? u.role,
      status: input.status ?? u.status,
    };
    return updated;
  });
  if (!updated) throw { code: "NOT_FOUND", message: "User not found." };
  return updated;
}

/* ── Sessions / screens / logs ───────────────────────────────────── */

export async function listSessions(
  projectId: string,
  opts?: { status?: string; from?: string; to?: string; cursor?: string },
): Promise<Page<Session>> {
  await delay();
  let all = sessionStore.filter((s) => s.projectId === projectId);
  if (opts?.status) all = all.filter((s) => s.status === opts.status);
  if (opts?.from) {
    const f = new Date(opts.from).getTime();
    if (!Number.isNaN(f)) all = all.filter((s) => s.createdAt.getTime() >= f);
  }
  if (opts?.to) {
    const t = new Date(opts.to).getTime() + 86_400_000; // inclusive end-of-day
    if (!Number.isNaN(t)) all = all.filter((s) => s.createdAt.getTime() <= t);
  }
  all = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
  const items = all.slice(start, start + PAGE_SIZE);
  return { items, nextCursor: start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null };
}

// Sessions with a pending cancel; getSession winds them down after a beat so the
// "cancelling…" state is visible before the crawl goes terminal.
const cancelCountdown = new Map<string, number>();

function isActiveStatus(status: Session["status"]): boolean {
  return status === "running" || status === "paused" || status === "pending";
}

export async function getSession(id: string): Promise<Session> {
  await delay();
  const found = sessionStore.find((s) => s.id === id);
  if (!found) throw { code: "NOT_FOUND", message: "Session not found." };

  // A cancellation was requested — stop the crawl on a later read (mirrors the
  // extension observing the flag on its next heartbeat, FR-BE-034).
  if (isActiveStatus(found.status) && found.cancelRequested) {
    const left = cancelCountdown.get(id) ?? 0;
    if (left <= 1) {
      cancelCountdown.delete(id);
      found.status = "cancelled";
      found.endReason = "cancelled";
      found.endedAt = new Date();
      found.updatedAt = new Date();
    } else {
      cancelCountdown.set(id, left - 1);
    }
    return found;
  }

  // Otherwise simulate a live crawl: nudge a running session's stats on each read
  // so the detail page's polling/SSE refresh shows movement (FR-AP-032 demo).
  if (found.status === "running") {
    const ceiling = Math.min(found.configSnapshot.maxScreens, 40);
    if (found.stats.screensCaptured < ceiling) {
      found.stats.screensCaptured += 1;
      found.stats.edgesRecorded += 1;
      if (found.stats.screensCaptured % 4 === 0) {
        found.stats.maxDepthReached = Math.min(
          found.configSnapshot.maxDepth,
          found.stats.maxDepthReached + 1,
        );
      }
      found.stats.currentUrl = found.stats.currentUrl.replace(
        /\d+$/,
        String(found.stats.screensCaptured),
      );
      found.lastHeartbeatAt = new Date();
    }
  }
  return found;
}

export async function cancelSession(id: string): Promise<Session> {
  await delay();
  const found = sessionStore.find((s) => s.id === id);
  if (!found) throw { code: "NOT_FOUND", message: "Session not found." };
  // Match the backend (POST /sessions/:id/cancel): flag the request and keep the
  // status active — the crawl stops on a later read (getSession). Idempotent.
  if (isActiveStatus(found.status) && !found.cancelRequested) {
    found.cancelRequested = true;
    found.updatedAt = new Date();
    cancelCountdown.set(id, 2);
  }
  return found;
}

export async function getSessionGraph(id: string): Promise<SessionGraph> {
  await delay();
  const screens = screensBySession[id] ?? [];
  // Nodes are the compact shared GraphNode shape (id/url/title/depth/thumbUrl).
  const nodes: GraphNode[] = screens.map((s) => ({
    id: s.id,
    url: s.url,
    title: s.title,
    depth: s.depth,
    thumbUrl: s.thumbUrl,
  }));
  const edges: GraphEdge[] = [];
  for (const screen of screens) {
    if (screen.parentScreenId) {
      edges.push({
        id: hexId(nextSeq()),
        from: screen.parentScreenId,
        to: screen.id,
        element: screen.triggerElement ?? null,
        kind: "navigation",
      });
    }
  }
  // A couple of non-tree edges for variety: a sub-state re-entry and a dead edge.
  if (screens.length > 3) {
    edges.push({
      id: hexId(nextSeq()),
      from: screens[1].id,
      to: screens[3].id,
      element: { selector: "button.tab-2", text: "Details", tag: "button", role: "tab" },
      kind: "substate",
    });
    edges.push({
      id: hexId(nextSeq()),
      from: screens[2].id,
      to: null,
      element: { selector: "a.noop", text: "Refresh", tag: "a", role: "link" },
      kind: "dead",
    });
  }
  return { nodes, edges };
}

export async function listSessionLogs(
  sessionId: string,
  opts?: { cursor?: string },
): Promise<Page<SessionLogEntry>> {
  await delay();
  const all = logsBySession[sessionId] ?? [];
  const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
  const items = all.slice(start, start + 20);
  return { items, nextCursor: start + 20 < all.length ? String(start + 20) : null };
}

export async function listScreens(
  sessionId: string,
  opts?: { url?: string; depth?: number; duplicate?: boolean; cursor?: string },
): Promise<Page<Screen>> {
  await delay();
  let all = screensBySession[sessionId] ?? [];
  if (opts?.url) {
    const q = opts.url.toLowerCase();
    all = all.filter(
      (s) => s.url.toLowerCase().includes(q) || s.title.toLowerCase().includes(q),
    );
  }
  if (opts?.depth !== undefined) all = all.filter((s) => s.depth === opts.depth);
  if (opts?.duplicate !== undefined) all = all.filter((s) => s.isDuplicate === opts.duplicate);
  const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
  const PAGE = 12;
  const items = all.slice(start, start + PAGE);
  return { items, nextCursor: start + PAGE < all.length ? String(start + PAGE) : null };
}

export async function getScreen(id: string): Promise<Screen> {
  await delay();
  for (const list of Object.values(screensBySession)) {
    const found = list.find((s) => s.id === id);
    if (found) return found;
  }
  throw { code: "NOT_FOUND", message: "Screen not found." };
}
