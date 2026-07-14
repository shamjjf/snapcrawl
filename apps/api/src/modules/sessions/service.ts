import {
  crawlConfigSchema,
  sessionStatsSchema,
  type CrawlConfig,
  type EdgeKind,
  type Session,
  type SessionEndReason,
  type SessionGraph,
  type SessionLogEntry,
  type SessionLogInput,
  type SessionOverrides,
  type SessionStatus,
} from "@snapcrawl/shared";
import type { SessionDoc } from "../../models/session";
import type { SessionLogDoc } from "../../models/sessionLog";

// Session lifecycle logic (FR-BE-030/031). Pure helpers so the state machine and
// config snapshot are unit-testable without a DB.

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  pending: ["running", "failed", "cancelled"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["completed", "failed", "cancelled"];

/** Session state machine: is `from → to` a legal transition? (FR-BE-031) */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** A session may be cancelled only while it is still active (FR-BE-034). */
export function canCancel(status: SessionStatus): boolean {
  return !isTerminal(status);
}

/** No-heartbeat threshold before a running session is failed as stale (FR-BE-032). */
export const STALE_THRESHOLD_MS = 10 * 60 * 1000;

/** Is a running session stale (no heartbeat for > threshold)? Falls back to
 *  startedAt when it never heartbeated (FR-BE-032). */
export function isStale(
  s: { status: SessionStatus; lastHeartbeatAt?: Date | null; startedAt?: Date | null },
  now: Date,
  thresholdMs: number = STALE_THRESHOLD_MS,
): boolean {
  if (s.status !== "running") return false;
  const ref = s.lastHeartbeatAt ?? s.startedAt ?? null;
  if (!ref) return false;
  return now.getTime() - ref.getTime() > thresholdMs;
}

/** Mongo filter selecting running sessions that have gone stale (FR-BE-032). */
export function staleFilter(
  now: Date,
  thresholdMs: number = STALE_THRESHOLD_MS,
): Record<string, unknown> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  return {
    status: "running",
    $or: [
      { lastHeartbeatAt: { $lt: cutoff } },
      { lastHeartbeatAt: null, startedAt: { $lt: cutoff } },
    ],
  };
}

/** Immutable config snapshot at session start (FR-BE-030). Per-run overrides may
 *  only tighten maxDepth/maxScreens (never raise them) and may set fullPage
 *  (FR-EX-014). */
export function snapshotConfig(base: CrawlConfig, overrides?: SessionOverrides): CrawlConfig {
  const snap: CrawlConfig = { ...base };
  if (overrides?.maxDepth !== undefined) snap.maxDepth = Math.min(overrides.maxDepth, base.maxDepth);
  if (overrides?.maxScreens !== undefined) {
    snap.maxScreens = Math.min(overrides.maxScreens, base.maxScreens);
  }
  if (overrides?.fullPage !== undefined) snap.fullPage = overrides.fullPage;
  return snap;
}

/** Map a session document to the shared `Session` response shape (SRS §8.4). */
export function serializeSession(s: SessionDoc): Session {
  const o = s.toObject();
  return {
    id: String(s._id),
    projectId: String(s.projectId),
    userId: String(s.userId),
    tokenId: s.tokenId ? String(s.tokenId) : null,
    status: s.status as SessionStatus,
    // Default an empty/missing snapshot to config defaults rather than throwing.
    configSnapshot: crawlConfigSchema.parse(o.configSnapshot ?? {}),
    stats: sessionStatsSchema.parse(o.stats ?? {}),
    startedAt: s.startedAt ?? null,
    endedAt: s.endedAt ?? null,
    lastHeartbeatAt: s.lastHeartbeatAt ?? null,
    endReason: (s.endReason as SessionEndReason | undefined) ?? null,
    cancelRequested: s.cancelRequested ?? false,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** One persisted session-log line, ready for SessionLogModel.insertMany. */
export interface SessionLogDocInput {
  sessionId: unknown;
  seq: number;
  level: string;
  event: string;
  context: unknown;
  at: Date;
}

/**
 * Shape a batch of client log lines into ordered documents (FR-EX-082/084).
 * `seq` continues from the session's current line count so ordering stays stable
 * across batches and service-worker resumes; `at` falls back to `now`. Pure.
 */
export function buildSessionLogDocs(
  sessionId: unknown,
  base: number,
  logs: SessionLogInput[],
  now: Date,
): SessionLogDocInput[] {
  return logs.map((l, i) => ({
    sessionId,
    seq: base + i,
    level: l.level,
    event: l.event,
    context: l.context ?? undefined,
    at: l.at ?? now,
  }));
}

/** Map a session-log document to the shared `SessionLogEntry` shape (FR-AP-031). */
export function serializeSessionLog(l: SessionLogDoc): SessionLogEntry {
  return {
    id: String(l._id),
    sessionId: String(l.sessionId),
    seq: l.seq,
    level: l.level ?? "info",
    event: l.event,
    context: l.context ?? undefined,
    at: l.at ?? null,
    createdAt: l.createdAt,
  };
}

interface GraphScreenInput {
  _id: unknown;
  url: string;
  title?: string | null;
  depth?: number | null;
}
interface GraphEdgeInput {
  _id: unknown;
  fromScreenId?: unknown;
  toScreenId?: unknown;
  element?: { selector?: string | null; text?: string | null; tag?: string | null; role?: string | null } | null;
  kind?: string | null;
}

/** Assemble the render-ready sitemap graph from a session's screens (nodes) and
 *  edges (transitions). Thumbnails are pre-signed by the caller and passed in a
 *  map so this stays pure/testable (FR-BE-050). */
export function buildGraph(
  screens: GraphScreenInput[],
  edges: GraphEdgeInput[],
  thumbById: Map<string, string>,
): SessionGraph {
  return {
    nodes: screens.map((s) => ({
      id: String(s._id),
      url: s.url,
      title: s.title ?? "",
      depth: s.depth ?? 0,
      thumbUrl: thumbById.get(String(s._id)) ?? null,
    })),
    edges: edges.map((e) => ({
      id: String(e._id),
      from: e.fromScreenId != null ? String(e.fromScreenId) : null,
      to: e.toScreenId != null ? String(e.toScreenId) : null,
      element: e.element
        ? {
            selector: e.element.selector ?? "",
            text: e.element.text ?? "",
            tag: e.element.tag ?? "",
            role: e.element.role ?? null,
          }
        : null,
      kind: (e.kind as EdgeKind | null | undefined) ?? "navigation",
    })),
  };
}
