import { recordAudit } from "../../lib/audit";
import { errorFields, log } from "../../lib/logger";
import { deleteObjects } from "../../lib/s3";
import { EdgeModel } from "../../models/edge";
import { ExportJobModel } from "../../models/exportJob";
import { ProjectModel } from "../../models/project";
import { ScreenModel } from "../../models/screen";
import { SessionModel } from "../../models/session";
import { SessionLogModel } from "../../models/sessionLog";
import { purgeFilter } from "./service";

// Cascade delete for soft-deleted projects (FR-BE-025). DELETE /projects/:id
// only stamps `deletedAt`; this is what eventually removes the sessions,
// screens, edges, logs and S3 objects, once the 7-day grace period has run out.
//
// In-process timer, single instance — the same caveat as the stale-session
// sweeper (NFR-004). Two instances racing here is harmless rather than
// dangerous: every step is idempotent, so the loser just deletes nothing.

/** Hourly. The deadline is measured in days, so a minute-resolution sweep would
 *  buy nothing and query for no reason 60× as often. */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export interface PurgeResult {
  screens: number;
  edges: number;
  logs: number;
  sessions: number;
  exports: number;
  /** False when S3 objects survived — the project is kept for the next sweep. */
  purged: boolean;
}

/**
 * Cascade-delete one project's data, then the project itself.
 *
 * ORDER IS LOAD-BEARING: S3 objects go first, and the DB rows are only removed
 * once storage has confirmed the bytes are gone. The screen rows are the sole
 * record of which objects belong to this project — drop them first and any
 * surviving object is orphaned forever, unreferenced and therefore un-retryable,
 * which is the one outcome a deletion feature must not produce.
 *
 * So a storage outage does not lose data or lie about it: the project keeps its
 * `deletedAt`, stays invisible to every read (`visibilityFilter`), and the next
 * sweep tries again. Fully idempotent — S3 treats deleting an absent key as
 * success, and every deleteMany re-runs harmlessly.
 */
export async function purgeProject(projectId: string): Promise<PurgeResult> {
  const empty = { screens: 0, edges: 0, logs: 0, sessions: 0, exports: 0 };

  const sessions = await SessionModel.find({ projectId }).select("_id").lean();
  const sessionIds = sessions.map((s) => s._id);

  // Screens are keyed by projectId directly, so this catches any whose session
  // row has already gone (a half-finished earlier sweep, say). Export ZIPs are
  // keyed by projectId too, and their objects go in the same batch.
  const screens = await ScreenModel.find({ projectId }).select("s3Key thumbKey").lean();
  const exports = await ExportJobModel.find({ projectId }).select("s3Key").lean();
  const keys = [
    ...screens.flatMap((s) => [s.s3Key, s.thumbKey]),
    ...exports.map((e) => e.s3Key),
  ].filter((k): k is string => Boolean(k));

  if (keys.length > 0) {
    const { failed } = await deleteObjects(keys);
    if (failed.length > 0) {
      log.warn("project purge deferred — storage objects survived", {
        projectId,
        failed: failed.length,
        of: keys.length,
      });
      return { ...empty, purged: false };
    }
  }

  const screensDeleted = await ScreenModel.deleteMany({ projectId });
  const edgesDeleted = await EdgeModel.deleteMany({ sessionId: { $in: sessionIds } });
  const logsDeleted = await SessionLogModel.deleteMany({ sessionId: { $in: sessionIds } });
  const exportsDeleted = await ExportJobModel.deleteMany({ projectId });
  const sessionsDeleted = await SessionModel.deleteMany({ projectId });
  await ProjectModel.deleteOne({ _id: projectId });

  // Null actor, deliberately: a timer did this, not a person. `project.delete`
  // already records who asked for it, seven days earlier.
  await recordAudit({
    action: "project.purge",
    userId: null,
    targetType: "project",
    targetId: projectId,
  });

  return {
    screens: screensDeleted.deletedCount,
    edges: edgesDeleted.deletedCount,
    logs: logsDeleted.deletedCount,
    sessions: sessionsDeleted.deletedCount,
    exports: exportsDeleted.deletedCount,
    purged: true,
  };
}

/** Purge every project past its grace period. Returns how many went. */
export async function purgeExpiredProjects(now: Date): Promise<number> {
  const due = await ProjectModel.find(purgeFilter(now)).select("_id").lean();
  let purged = 0;
  for (const { _id } of due) {
    const id = String(_id);
    try {
      const r = await purgeProject(id);
      if (!r.purged) continue;
      purged += 1;
      log.info("project purged after grace period", { projectId: id, ...r });
    } catch (err) {
      // One bad project must not stop the rest — it keeps its deletedAt and
      // comes back round on the next sweep.
      log.error("project purge failed", { projectId: id, ...errorFields(err) });
    }
  }
  return purged;
}

/** Start the periodic cascade; returns the timer so it can be cleared. */
export function startPurgeSweeper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void purgeExpiredProjects(new Date()).catch((err: unknown) => {
      log.warn("project purge sweep failed", errorFields(err));
    });
  }, PURGE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
