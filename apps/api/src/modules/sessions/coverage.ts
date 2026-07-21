import { Types } from "mongoose";
import type { DepthCoverage, SessionCoverage } from "@snapcrawl/shared";
import { EdgeModel } from "../../models/edge";
import { ScreenModel } from "../../models/screen";
import type { SessionDoc } from "../../models/session";

// Coverage statistics per session (FR-BE-051): unique URLs, unique states,
// states per depth, dead edges, duplicate rate.
//
// Computed on read, from the rows themselves. `session.stats` cannot answer
// this: it is a running total the EXTENSION reports (FR-BE-033), so it counts
// what the crawler believed it did, not what was actually persisted — and a lost
// batch, a rejected capture or a screenshot deleted later (FR-AP-043) all make
// it wrong with nothing to reconcile against. The aggregations below are cheap
// (a session is capped at maxScreens, default 200) and always agree with the
// gallery, because they are derived from the same rows the gallery renders.

export interface DuplicateInputs {
  /** Distinct states that were stored (one screenshot each). */
  uniqueStates: number;
  /** Captures the API refused at presign — the exact bytes already existed. */
  duplicatesSkipped: number;
  /** Stored states flagged as near-duplicates of another (FR-BE-043). */
  nearDuplicates: number;
}

/**
 * The fraction of capture attempts that turned out to be redundant. Pure.
 *
 * Denominator = every capture the crawler ATTEMPTED = the states it stored plus
 * the ones presign turned away. Numerator = the attempts that added nothing =
 * those same skipped exact duplicates, plus stored states that a perceptual hash
 * later judged to be a near-copy of one already held.
 *
 * Near-duplicates sit in both terms on purpose: they were stored, so they are
 * part of the denominator, and they were redundant, so they count in the
 * numerator. That keeps the ratio inside 0..1 by construction rather than by a
 * clamp — the numerator's terms are each a subset of the denominator's.
 *
 * A crawl that captured nothing has no rate to report; 0 is the honest answer.
 */
export function computeDuplicateRate(i: DuplicateInputs): number {
  const attempts = i.uniqueStates + i.duplicatesSkipped;
  if (attempts === 0) return 0;
  return (i.duplicatesSkipped + i.nearDuplicates) / attempts;
}

/** Fill depth gaps so the panel can plot a continuous axis. Pure.
 *
 *  A crawl reaching depths 0, 1 and 3 but not 2 is a real and interesting
 *  shape — every depth-2 click was blocked or dead — and a bar chart that just
 *  omits the bar draws it as though depth 3 followed depth 1. */
export function fillDepthGaps(rows: DepthCoverage[]): DepthCoverage[] {
  if (rows.length === 0) return [];
  const byDepth = new Map(rows.map((r) => [r.depth, r.states]));
  const max = Math.max(...rows.map((r) => r.depth));
  const out: DepthCoverage[] = [];
  for (let depth = 0; depth <= max; depth++) {
    out.push({ depth, states: byDepth.get(depth) ?? 0 });
  }
  return out;
}

interface ScreenAgg {
  uniqueUrls: number;
  uniqueStates: number;
  nearDuplicates: number;
}

/** One pass over the session's screens: distinct URLs, count, near-dupe count.
 *  `$addToSet` then `$size` rather than a separate distinct() — the set is
 *  bounded by maxScreens, and one round trip beats two. */
async function aggregateScreens(sessionId: Types.ObjectId): Promise<ScreenAgg> {
  const [row] = await ScreenModel.aggregate<{
    urls: number;
    states: number;
    near: number;
  }>([
    { $match: { sessionId } },
    {
      $group: {
        _id: null,
        urls: { $addToSet: "$url" },
        states: { $sum: 1 },
        near: { $sum: { $cond: [{ $eq: ["$isDuplicate", true] }, 1, 0] } },
      },
    },
    { $project: { urls: { $size: "$urls" }, states: 1, near: 1 } },
  ]);
  return {
    uniqueUrls: row?.urls ?? 0,
    uniqueStates: row?.states ?? 0,
    nearDuplicates: row?.near ?? 0,
  };
}

async function aggregateDepths(sessionId: Types.ObjectId): Promise<DepthCoverage[]> {
  const rows = await ScreenModel.aggregate<{ _id: number | null; states: number }>([
    { $match: { sessionId } },
    { $group: { _id: "$depth", states: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return fillDepthGaps(
    // A legacy screen with no depth groups under null; treat it as depth 0
    // rather than dropping it — the count must still add up to uniqueStates.
    rows.map((r) => ({ depth: r._id ?? 0, states: r.states })),
  );
}

async function aggregateEdges(
  sessionId: Types.ObjectId,
): Promise<{ deadEdges: number; totalEdges: number }> {
  const rows = await EdgeModel.aggregate<{ _id: string | null; n: number }>([
    { $match: { sessionId } },
    { $group: { _id: "$kind", n: { $sum: 1 } } },
  ]);
  let deadEdges = 0;
  let totalEdges = 0;
  for (const r of rows) {
    totalEdges += r.n;
    if (r._id === "dead") deadEdges += r.n;
  }
  return { deadEdges, totalEdges };
}

/** Compute the full coverage report for one session (FR-BE-051). */
export async function computeCoverage(session: SessionDoc): Promise<SessionCoverage> {
  // Aggregation pipelines do NOT autocast strings to ObjectId the way find()
  // does — a string here silently matches nothing and every number comes back 0.
  const sessionId = new Types.ObjectId(String(session._id));

  const [screens, statesPerDepth, edges] = await Promise.all([
    aggregateScreens(sessionId),
    aggregateDepths(sessionId),
    aggregateEdges(sessionId),
  ]);

  const duplicatesSkipped = session.stats?.duplicatesSkipped ?? 0;
  return {
    sessionId: String(session._id),
    uniqueUrls: screens.uniqueUrls,
    uniqueStates: screens.uniqueStates,
    statesPerDepth,
    deadEdges: edges.deadEdges,
    totalEdges: edges.totalEdges,
    duplicatesSkipped,
    nearDuplicates: screens.nearDuplicates,
    duplicateRate: computeDuplicateRate({
      uniqueStates: screens.uniqueStates,
      duplicatesSkipped,
      nearDuplicates: screens.nearDuplicates,
    }),
  };
}
