// Crawl limits (FR-EX-014 / FR-EX-030). `null` means unlimited: a crawl runs
// until the user stops it. One implementation, shared by the extension engine,
// the API's per-run clamp and the panel's fixtures — three copies of this lattice
// is how they drift apart.

/** A crawl budget. `null` is unlimited — the top of the lattice, not a missing value. */
export type Limit = number | null;

/** Finite defaults for reading BACK a historical session's config snapshot.
 *  A completed run must keep describing what it was actually permitted to do,
 *  so a snapshot with a missing field resolves conservatively-finite rather than
 *  inheriting today's unlimited default. */
export const LEGACY_LIMITS = {
  maxDepth: 5,
  maxScreens: 200,
  maxDurationMin: 30,
} as const;

/** Resolve to a number the engine can compare against. Call this ONLY on locals
 *  inside the run loop — Infinity must never cross a process boundary, because
 *  JSON.stringify(Infinity) is "null" and that round-trip is luck, not design.
 *
 *  Treats undefined and any non-finite value as UNLIMITED, not just null. This
 *  is not defensive padding — getting it wrong is silent and severe. A missing
 *  field (a config cached by an older build, a hand-edited Mongo doc, a partial
 *  API response) used to pass straight through, and `parentDepth < undefined` is
 *  false, so canDescend refused to enqueue ANY child: the crawl captured the
 *  seed, expanded it, drained the queue and reported "completed" after one or
 *  two screens with no error anywhere. Unlimited is the safe direction — the
 *  user asked for unbounded runs, so a limit we cannot read means "no limit". */
export function resolveLimit(v: Limit | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
}

/** FR-EX-014 — a per-run override may only make a run SMALLER than the project
 *  allows, never larger. `null` is the top of the lattice:
 *    - override null (unlimited) => take the base; unlimited can never RAISE a ceiling.
 *    - base null (unlimited)     => take the override; a finite override always tightens.
 *    - both finite               => the smaller.
 *  Replaces Math.min, which produced 0 the moment either side was null. */
export function tightenLimit(override: Limit, base: Limit): Limit {
  if (override === null) return base;
  if (base === null) return override;
  return Math.min(override, base);
}
