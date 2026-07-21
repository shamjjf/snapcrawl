// Structured observability counters (NFR-022 groundwork). In-process, monotonic
// counters for the events an operator watches to know the crawler is healthy:
// how many sessions started, how many finished each way, and how often an upload
// failed. Deliberately minimal — this is the seam a real metrics backend
// (Prometheus, OTel) plugs into later, not that backend itself.
//
// Process-local, like every other counter in this app (the rate-limit buckets,
// the thumbnail semaphore). A horizontally-scaled deployment reads each
// instance's /metrics and sums them (NFR-004); nothing here pretends to be a
// cluster-wide total.

/** The counters we track. A closed set, so /metrics has a stable shape and a
 *  typo in an increment call is a compile error rather than a phantom metric. */
export type Counter =
  | "sessions_started_total"
  | "sessions_completed_total"
  | "sessions_failed_total"
  | "sessions_cancelled_total"
  | "captures_completed_total"
  | "captures_failed_total";

const counters: Record<Counter, number> = {
  sessions_started_total: 0,
  sessions_completed_total: 0,
  sessions_failed_total: 0,
  sessions_cancelled_total: 0,
  captures_completed_total: 0,
  captures_failed_total: 0,
};

/** Record one occurrence of `name`. Never throws — a metrics write must not be
 *  able to fail the request it is observing. */
export function inc(name: Counter, by = 1): void {
  counters[name] += by;
}

/** Map a terminal session status to its counter, or null for a non-terminal
 *  transition. Pure — the state→metric mapping lives in one place. */
export function terminalCounter(status: string): Counter | null {
  switch (status) {
    case "completed":
      return "sessions_completed_total";
    case "failed":
      return "sessions_failed_total";
    case "cancelled":
      return "sessions_cancelled_total";
    default:
      return null;
  }
}

export interface MetricsSnapshot {
  counters: Record<Counter, number>;
  /** Fraction of capture attempts that failed, in [0,1] (NFR-022). Derived so a
   *  scraper does not have to know which two counters to divide — and guarded so
   *  "no captures yet" reads as 0, not NaN. */
  uploadFailureRate: number;
  /** Seconds this process has been up — context for reading the totals. */
  uptimeSec: number;
}

/** A point-in-time read of every counter plus the derived rates. */
export function snapshot(uptimeSec: number): MetricsSnapshot {
  const attempts = counters.captures_completed_total + counters.captures_failed_total;
  return {
    counters: { ...counters },
    uploadFailureRate: attempts === 0 ? 0 : counters.captures_failed_total / attempts,
    uptimeSec,
  };
}

/** Reset every counter to zero. Test-only — production counters are monotonic
 *  for the life of the process. */
export function resetMetrics(): void {
  for (const k of Object.keys(counters) as Counter[]) counters[k] = 0;
}
