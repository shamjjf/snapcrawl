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
  maxDepth: z.number().int().min(1).max(20).optional(),
  maxScreens: z.number().int().min(1).max(5000).optional(),
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

/** GET /sessions query: cursor pagination scoped to a project (FR-BE-035). */
export const sessionListQuerySchema = cursorQuerySchema.extend({
  projectId: objectIdSchema,
  cursor: objectIdSchema.optional(),
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
