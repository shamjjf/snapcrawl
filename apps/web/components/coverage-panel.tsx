"use client";

// Coverage statistics (FR-AP-031 → FR-BE-051): how much of the app a run reached
// and how much of the effort was wasted. Computed on demand by the backend from
// the screens and edges, so it always agrees with what the gallery shows — a
// deleted screenshot (FR-AP-043) lowers it rather than leaving a stale count.

import { Alert, Spinner, StatTile } from "@/components/ui";
import { useSessionCoverage } from "@/lib/queries";
import type { SessionCoverage } from "@snapcrawl/shared";

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Horizontal bars of states-per-depth. Widths are relative to the busiest
 *  depth, so the shape of the crawl (where the states cluster) reads at a glance. */
function DepthBars({ coverage }: { coverage: SessionCoverage }) {
  const max = coverage.statesPerDepth.reduce((m, d) => Math.max(m, d.states), 0);
  if (coverage.statesPerDepth.length === 0) return null;
  return (
    <div className="coverage-depths">
      {coverage.statesPerDepth.map((d) => (
        <div key={d.depth} className="coverage-depth">
          <span className="coverage-depth__label mono">d{d.depth}</span>
          <span className="coverage-depth__track" aria-hidden="true">
            <span
              className="coverage-depth__bar"
              style={{ width: max > 0 ? `${Math.max(2, (d.states / max) * 100)}%` : "0%" }}
            />
          </span>
          <span className="coverage-depth__count">{d.states}</span>
        </div>
      ))}
    </div>
  );
}

export function CoveragePanel({ sessionId }: { sessionId: string }) {
  const q = useSessionCoverage(sessionId);

  return (
    <section className="card" style={{ padding: "var(--space-5)" }}>
      <h2 className="form-section__title" style={{ marginBottom: "var(--space-3)" }}>
        Coverage
      </h2>

      {q.isLoading ? (
        <div className="loading-row">
          <Spinner /> Loading coverage…
        </div>
      ) : q.isError || !q.data ? (
        <Alert tone="danger">Couldn&apos;t load coverage for this session.</Alert>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            <StatTile label="Unique URLs" value={q.data.uniqueUrls} />
            <StatTile label="Unique states" value={q.data.uniqueStates} />
            <StatTile
              label="Dead clicks"
              value={q.data.deadEdges}
              hint={`of ${q.data.totalEdges} edges`}
            />
            <StatTile
              label="Duplicate rate"
              value={pct(q.data.duplicateRate)}
              hint={`${q.data.nearDuplicates} near-dup · ${q.data.duplicatesSkipped} skipped`}
            />
          </div>

          <div style={{ marginTop: "var(--space-4)" }}>
            <h3
              className="subtle"
              style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)" }}
            >
              States by depth
            </h3>
            <DepthBars coverage={q.data} />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Compact coverage summary for the graph page (FR-AP-051 neighbour): duplicate
 * rate + dead edges only, the two numbers that explain "why does the sitemap
 * have repeats and stubs?" without repeating the whole panel.
 */
export function CoverageSummary({ sessionId }: { sessionId: string }) {
  const q = useSessionCoverage(sessionId);
  if (!q.data) return null;
  return (
    <div className="coverage-summary" role="status">
      <span>
        <strong>{pct(q.data.duplicateRate)}</strong> duplicate rate
      </span>
      <span aria-hidden>·</span>
      <span>
        <strong>{q.data.deadEdges}</strong> dead click{q.data.deadEdges === 1 ? "" : "s"} of{" "}
        {q.data.totalEdges}
      </span>
      <span aria-hidden>·</span>
      <span>
        <strong>{q.data.uniqueStates}</strong> states across <strong>{q.data.uniqueUrls}</strong> URLs
      </span>
    </div>
  );
}
