// Per-user workspace KPIs for the dashboard (FR-AP-010). Scoped to what the
// caller may see: admins see everything; members see only projects they own or
// are assigned to (consistent with FR-BE-020), and their sessions/screens.
import type { Dashboard, User } from "@snapcrawl/shared";
import { ProjectModel, ScreenModel, SessionModel } from "./models";
import { visibilityFilter } from "./modules/projects/service";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function getDashboard(user: User, now: Date = new Date()): Promise<Dashboard> {
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);

  // Projects the caller can see, then scope sessions/screens to those projects.
  const projectDocs = await ProjectModel.find(visibilityFilter(user)).select("_id");
  const projectIds = projectDocs.map((p) => p._id);
  const scope =
    user.role === "admin" ? {} : { projectId: { $in: projectIds } };

  const [sessionsLast30Days, screenTotals, recent] = await Promise.all([
    SessionModel.countDocuments({ ...scope, createdAt: { $gte: since } }),
    // Count + storage in ONE pass over the same scope.
    //
    // Two traps here. (1) $match MUST reuse `scope`, not a re-derived
    // {projectId: {$in: …}}: for admins `scope` is {} and matches screens whose
    // project was deleted, so re-deriving would make storage exclude orphans
    // while the count includes them — two tiles on one card disagreeing.
    // (2) Separate $sum accumulators, NOT $sum:{$add:["$bytes","$thumbBytes"]}
    // — $add returns null if ANY operand is missing, so every row without a
    // thumbnail would contribute null and discard its original bytes too.
    ScreenModel.aggregate<{ count: number; bytes: number; thumbBytes: number }>([
      { $match: scope },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          bytes: { $sum: "$bytes" },
          thumbBytes: { $sum: "$thumbBytes" },
        },
      },
    ]),
    SessionModel.find(scope).sort({ createdAt: -1 }).limit(5).populate("projectId", "name"),
  ]);

  // An aggregate over zero matched docs returns [], not [{bytes:0}] — so a
  // fresh workspace (or a member with no projects) would throw on rows[0].bytes.
  const totals = screenTotals[0];
  const screensCaptured = totals?.count ?? 0;
  // Storage used = originals + thumbnails; both occupy the bucket.
  const storageBytes = (totals?.bytes ?? 0) + (totals?.thumbBytes ?? 0);

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
      storageBytes,
    },
    recentSessions,
  };
}
