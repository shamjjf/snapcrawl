// Per-user workspace KPIs for the dashboard (FR-AP-010). Scoped to what the
// caller may see: admins see everything; members see only projects they own or
// are assigned to (consistent with FR-BE-020), and their sessions/screens.
import type { User } from "@snapcrawl/shared";
import { ProjectModel, ScreenModel, SessionModel } from "./models";
import { visibilityFilter } from "./modules/projects/service";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function getDashboard(user: User, now: Date = new Date()) {
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);

  // Projects the caller can see, then scope sessions/screens to those projects.
  const projectDocs = await ProjectModel.find(visibilityFilter(user)).select("_id");
  const projectIds = projectDocs.map((p) => p._id);
  const scope =
    user.role === "admin" ? {} : { projectId: { $in: projectIds } };

  const [sessionsLast30Days, screensCaptured, recent] = await Promise.all([
    SessionModel.countDocuments({ ...scope, createdAt: { $gte: since } }),
    ScreenModel.countDocuments(scope),
    SessionModel.find(scope).sort({ createdAt: -1 }).limit(5).populate("projectId", "name"),
  ]);

  const recentSessions = recent.map((s) => {
    const project = s.projectId as unknown as { _id?: unknown; name?: string } | null;
    const started = s.startedAt ?? (s as unknown as { createdAt: Date }).createdAt;
    return {
      id: String(s._id),
      // projectId lets the panel deep-link each row to the session detail page
      // (FR-AP-031). Empty when the project was deleted (populate → null).
      projectId: project?._id ? String(project._id) : "",
      project: project?.name ?? "—",
      status: String(s.status),
      screens: s.stats?.screensCaptured ?? 0,
      startedAt: started.toISOString(),
    };
  });

  return {
    stats: {
      projects: projectDocs.length,
      sessionsLast30Days,
      screensCaptured,
      // Screens store dimensions, not byte size, so storage isn't tracked yet.
      storageBytes: 0,
    },
    recentSessions,
  };
}
