// Dashboard KPI response (FR-AP-010). Typed here so the panel and the API
// share one definition rather than each declaring their own.
import { z } from "zod";

export const dashboardStatsSchema = z.object({
  projects: z.number().int().min(0),
  sessionsLast30Days: z.number().int().min(0),
  screensCaptured: z.number().int().min(0),
  /** Bytes stored in the object store: originals + thumbnails (FR-BE-042). */
  storageBytes: z.number().int().min(0),
});

/** Compact recent-session row for the dashboard list (FR-AP-010/031). */
export const dashboardRecentSessionSchema = z.object({
  id: z.string(),
  /** Empty when the session's project was deleted — the row isn't linkable then. */
  projectId: z.string(),
  project: z.string(),
  status: z.string(),
  screens: z.number().int().min(0),
  startedAt: z.string(),
});

export const dashboardSchema = z.object({
  stats: dashboardStatsSchema,
  recentSessions: z.array(dashboardRecentSessionSchema),
});

export type DashboardStats = z.infer<typeof dashboardStatsSchema>;
export type DashboardRecentSession = z.infer<typeof dashboardRecentSessionSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
