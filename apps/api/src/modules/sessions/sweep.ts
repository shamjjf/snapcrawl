import { errorFields, log } from "../../lib/logger";
import { publishSessionEvent } from "../../lib/sessionEvents";
import { SessionModel } from "../../models/session";
import { serializeSession, staleFilter } from "./service";

// Stale-session sweep (FR-BE-032). A running session that hasn't heartbeated for
// > 10 min is finalised as failed(stale). In-process timer — single instance
// only; a multi-instance deployment needs a distributed scheduler (NFR-004).
export const SWEEP_INTERVAL_MS = 60 * 1000;

/** Mark all currently-stale running sessions as failed; returns how many. */
export async function markStaleSessions(now: Date): Promise<number> {
  const candidates = await SessionModel.find(staleFilter(now)).select("_id");
  let marked = 0;
  for (const { _id } of candidates) {
    // Atomic conditional update: only transition if it's STILL running, so we
    // never clobber a session the extension just completed/cancelled in a race.
    const updated = await SessionModel.findOneAndUpdate(
      { _id, status: "running" },
      { $set: { status: "failed", endReason: "stale", endedAt: now } },
      { new: true },
    );
    if (!updated) continue;
    marked += 1;
    // The DB update is what matters; the live event is best-effort.
    try {
      publishSessionEvent(String(updated._id), {
        type: "status",
        session: serializeSession(updated),
      });
    } catch (err) {
      log.warn("stale-session event emit failed", {
        sessionId: String(updated._id),
        ...errorFields(err),
      });
    }
  }
  return marked;
}

/** Start the periodic sweep; returns the timer so it can be cleared in tests. */
export function startStaleSweeper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void markStaleSessions(new Date()).catch((err: unknown) => {
      log.warn("stale-session sweep failed", errorFields(err));
    });
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive solely for the sweep.
  timer.unref?.();
  return timer;
}
