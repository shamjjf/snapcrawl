// Crawl session lifecycle DTOs (FR-BE-030..036). The extension creates a
// session, then streams status/stats/heartbeats to it.
import { z } from "zod";
import { cursorQuerySchema, objectIdSchema } from "./common.js";
import { crawlConfigSchema } from "./config.js";

export const sessionStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const sessionEndReasonSchema = z.enum([
  "limit-reached",
  "frontier-exhausted",
  "cancelled",
  "stale",
  "error",
  "auth",
]);

/** Live counters mirrored from the extension (FR-BE-033). */
export const sessionStatsSchema = z.object({
  screensCaptured: z.number().int().min(0).default(0),
  edgesRecorded: z.number().int().min(0).default(0),
  duplicatesSkipped: z.number().int().min(0).default(0),
  errorsCount: z.number().int().min(0).default(0),
  maxDepthReached: z.number().int().min(0).default(0),
  currentUrl: z.string().default(""),
});

/** Per-run overrides permitted by the popup within project limits (FR-EX-014). */
export const sessionOverridesSchema = z.object({
  /** null = unlimited for this run. Absent = "inherit the project config". The
   *  two are different: absent leaves the project's ceiling alone, null removes
   *  it for this run only. Still tighten-only — see tightenLimit. */
  maxDepth: z.number().int().min(1).max(20).nullable().optional(),
  maxScreens: z.number().int().min(1).max(5000).nullable().optional(),
  fullPage: z.boolean().optional(),
});

export const sessionCreateSchema = z.object({
  projectId: objectIdSchema,
  overrides: sessionOverridesSchema.optional(),
});

/** Status change / stats delta / heartbeat sent by the extension (FR-BE-032/033). */
export const sessionUpdateSchema = z.object({
  status: sessionStatusSchema.optional(),
  stats: sessionStatsSchema.partial().optional(),
  heartbeat: z.boolean().optional(),
  endReason: sessionEndReasonSchema.optional(),
});

// ── Response entities (what the API returns; SRS §8.4) ──────────────────────

/** GET /sessions query: cursor pagination scoped to a project, plus the panel's
 *  status + calendar-date filters (FR-BE-035, FR-AP-030). */
export const sessionListQuerySchema = cursorQuerySchema.extend({
  projectId: objectIdSchema,
  cursor: objectIdSchema.optional(),
  /** Single status — the panel's filter is a single-choice <Select>. */
  status: sessionStatusSchema.optional(),
  /** Inclusive calendar-day bounds on createdAt, "YYYY-MM-DD" as produced by
   *  the panel's <input type="date">. Deliberately kept as strings rather than
   *  coerced dates: z.coerce.date() would collapse "2026-07-15" to the single
   *  instant T00:00:00Z and lose the fact that the client meant a whole DAY,
   *  which is exactly what the `to` bound has to expand to. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

/** Full session record returned by the API (SRS §8.4). `configSnapshot` is the
 *  immutable copy of the project config taken at creation (FR-BE-030). */
export const sessionSchema = z.object({
  id: objectIdSchema,
  projectId: objectIdSchema,
  userId: objectIdSchema,
  tokenId: objectIdSchema.nullable().optional(),
  status: sessionStatusSchema,
  configSnapshot: crawlConfigSchema,
  stats: sessionStatsSchema,
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  lastHeartbeatAt: z.coerce.date().nullable(),
  endReason: sessionEndReasonSchema.nullable().optional(),
  /** Set by POST /sessions/:id/cancel; the extension reads it on its next PATCH
   *  response and stops (FR-BE-034). */
  cancelRequested: z.boolean().default(false),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** A single live-monitoring event pushed over the SSE stream (FR-BE-036). */
export const sessionEventTypeSchema = z.enum(["snapshot", "stats", "status"]);
export const sessionEventSchema = z.object({
  type: sessionEventTypeSchema,
  session: sessionSchema,
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionEndReason = z.infer<typeof sessionEndReasonSchema>;
export type SessionStats = z.infer<typeof sessionStatsSchema>;
export type SessionOverrides = z.infer<typeof sessionOverridesSchema>;
export type SessionCreate = z.infer<typeof sessionCreateSchema>;
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;
/** A single session-log line for the detail view's error log (FR-AP-031,
 *  SRS §8.4 sessionLogs; populated by the batched FR-EX-084 upload). */
export const sessionLogEntrySchema = z.object({
  id: objectIdSchema,
  sessionId: objectIdSchema,
  seq: z.number().int(),
  level: z.string(),
  event: z.string(),
  context: z.unknown().optional(),
  at: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
});

/** GET /sessions/:id/logs query: cursor + optional level filter (FR-AP-031). */
export const sessionLogQuerySchema = cursorQuerySchema.extend({
  cursor: objectIdSchema.optional(),
  level: z.string().max(20).optional(),
});

/** One log line the extension emits for batched upload (FR-EX-082/084). `seq`
 *  is assigned server-side; the client supplies level/event/context/at. */
export const sessionLogLevelSchema = z.enum(["error", "warn", "info"]);
export const sessionLogInputSchema = z.object({
  level: sessionLogLevelSchema.default("error"),
  event: z.string().min(1).max(120),
  /** Free-form JSON context (url, phase, element, message…) — kept small. */
  context: z.unknown().optional(),
  /** Client capture time; the server also stamps its own createdAt. */
  at: z.coerce.date().optional(),
});

/** POST /ext/logs body: a session-scoped batch of log lines (≤ 100) (FR-EX-084). */
export const sessionLogBatchSchema = z.object({
  sessionId: objectIdSchema,
  logs: z.array(sessionLogInputSchema).min(1).max(100),
});

/** Response to a batch log upload: how many lines were persisted (FR-EX-084). */
export const sessionLogBatchResponseSchema = z.object({
  recorded: z.number().int().min(0),
});

// ── Coverage statistics (FR-BE-051) ─────────────────────────────────────────

/** How many distinct states were captured at one crawl depth. */
export const depthCoverageSchema = z.object({
  depth: z.number().int().min(0),
  states: z.number().int().min(0),
});

/**
 * GET /sessions/:id/coverage — "how much of the app did this run actually
 * reach, and how much of the effort was wasted?" (FR-BE-051).
 *
 * Computed from the screens and edges on demand rather than counted into
 * `session.stats` as the crawl runs. Two reasons: `stats` is reported BY the
 * extension (FR-BE-033), so it is a claim rather than an observation, and it
 * cannot be recomputed if a batch is lost; and coverage is derived, so storing
 * it would let it drift out of step with the rows it summarises — a screenshot
 * deleted under FR-AP-043 silently makes a stored count wrong.
 */
export const sessionCoverageSchema = z.object({
  sessionId: objectIdSchema,
  /** Distinct page URLs reached. Lower than `uniqueStates` whenever one page
   *  has several UI states (a modal open, a tab switched). */
  uniqueUrls: z.number().int().min(0),
  /** Distinct UI states captured — one screenshot each (FR-BE-041). */
  uniqueStates: z.number().int().min(0),
  /** States per depth, ascending, no gaps for depths that were never reached. */
  statesPerDepth: z.array(depthCoverageSchema),
  /** Clicks that changed nothing (edge kind "dead") — the crawler's wasted
   *  effort, and the best single hint at what to add to excludeSelectors. */
  deadEdges: z.number().int().min(0),
  totalEdges: z.number().int().min(0),
  /** Captures skipped at presign because the exact bytes were already stored
   *  (FR-BE-040 contentHash dedupe). Reported by the extension via stats. */
  duplicatesSkipped: z.number().int().min(0),
  /** Stored screens flagged as near-duplicates of another state (FR-BE-043). */
  nearDuplicates: z.number().int().min(0),
  /** 0..1: of everything this crawl decided to capture, the fraction that
   *  turned out to be a repeat. See `computeDuplicateRate` for the arithmetic —
   *  a rate is meaningless without its denominator written down. */
  duplicateRate: z.number().min(0).max(1),
});

export type DepthCoverage = z.infer<typeof depthCoverageSchema>;
export type SessionCoverage = z.infer<typeof sessionCoverageSchema>;

// ── Session ZIP export (FR-AP-042) ──────────────────────────────────────────

export const exportStatusSchema = z.enum(["pending", "ready", "failed"]);

/**
 * A server-generated session export (FR-AP-042: "server-generated, asynchronous
 * with notification when ready").
 *
 * The build happens off the request, so this record is the notification channel:
 * POST returns one as `pending`, and the panel polls GET until it flips to
 * `ready` and `downloadUrl` (a short-lived signed GET) appears — or `failed`
 * with a reason. No websocket, no push; a poll is a perfectly good "tell me when
 * it's done" for a job measured in seconds.
 */
export const sessionExportSchema = z.object({
  id: objectIdSchema,
  sessionId: objectIdSchema,
  status: exportStatusSchema,
  /** Screens written into the ZIP — set once the build starts producing. */
  screenCount: z.number().int().min(0).nullable().default(null),
  /** Final ZIP size in bytes; null until `ready`. */
  bytes: z.number().int().min(0).nullable().default(null),
  /** Present only when `ready`: a signed URL to download the ZIP (≤ 1 h). */
  downloadUrl: z.string().nullable().default(null),
  /** Present only when `failed`: a human-readable reason. */
  error: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type ExportStatus = z.infer<typeof exportStatusSchema>;
export type SessionExport = z.infer<typeof sessionExportSchema>;

export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionEventType = z.infer<typeof sessionEventTypeSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionLogEntry = z.infer<typeof sessionLogEntrySchema>;
export type SessionLogQuery = z.infer<typeof sessionLogQuerySchema>;
export type SessionLogLevel = z.infer<typeof sessionLogLevelSchema>;
export type SessionLogInput = z.infer<typeof sessionLogInputSchema>;
export type SessionLogBatch = z.infer<typeof sessionLogBatchSchema>;
export type SessionLogBatchResponse = z.infer<typeof sessionLogBatchResponseSchema>;
