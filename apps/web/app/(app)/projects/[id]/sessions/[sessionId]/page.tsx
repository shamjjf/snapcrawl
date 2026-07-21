"use client";

// Session detail (FR-AP-031): config snapshot, live stats, current URL, depth
// reached, error log, and final outcome.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  PageHeader,
  Spinner,
  StatTile,
  StatusChip,
} from "@/components/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CoveragePanel } from "@/components/coverage-panel";
import { useToast } from "@/components/toast";
import {
  useCancelSession,
  useSession,
  useSessionEvents,
  useSessionLogs,
} from "@/lib/queries";
import { fmtDateTime, fmtDuration } from "@/lib/format";

function LogLevel({ level }: { level: string }) {
  const tone = level === "error" ? "danger" : level === "warn" ? "info" : "neutral";
  return <Badge tone={tone}>{level}</Badge>;
}

/** Session-log `context` is `unknown` (string or JSON blob) — render it safely. */
function logContext(context: unknown): string {
  if (context == null) return "";
  return typeof context === "string" ? context : JSON.stringify(context);
}

export default function SessionDetailPage() {
  const params = useParams<{ id: string; sessionId: string }>();
  const projectId = params.id;
  const sessionId = params.sessionId;

  const q = useSession(sessionId);
  const logsQ = useSessionLogs(sessionId);
  const cancel = useCancelSession();
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const status = q.data?.status;
  const isActive = status === "pending" || status === "running" || status === "paused";
  // Live updates (FR-AP-032): SSE + 5 s polling (the polling lives in useSession).
  useSessionEvents(sessionId, isActive);

  const logs = logsQ.data?.pages.flatMap((p) => p.items) ?? [];

  if (q.isLoading) {
    return (
      <>
        <PageHeader title="Session" />
        <div className="loading-row">
          <Spinner /> Loading…
        </div>
      </>
    );
  }
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title="Session" />
        <Alert tone="danger">Couldn&apos;t load this session.</Alert>
      </>
    );
  }

  const s = q.data;
  const cfg = s.configSnapshot;
  const running = s.status === "running";
  const cancelPending = s.cancelRequested && isActive;
  const cancellable = isActive && !s.cancelRequested;

  function doCancel() {
    cancel.mutate(s.id, {
      onSuccess: () => {
        toast.success("Cancellation requested — the crawl will stop shortly.");
        setConfirmCancel(false);
      },
    });
  }

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span aria-hidden> / </span>
        <Link href={`/projects/${projectId}/sessions`}>Sessions</Link>
        <span aria-hidden> / </span>
        <span className="mono">{s.id.slice(-8)}</span>
      </nav>

      <PageHeader
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-3)" }}>
            <span className="mono">{s.id.slice(-8)}</span>
            <StatusChip status={s.status} />
            {cancelPending ? <Badge tone="danger">cancelling…</Badge> : null}
            {isActive && q.isFetching ? (
              <span className="subtle" style={{ fontSize: "var(--text-xs)" }}>
                updating…
              </span>
            ) : null}
          </span>
        }
        subtitle={
          s.endReason
            ? `Ended: ${s.endReason.replace(/-/g, " ")}`
            : running
              ? "Live crawl in progress — updates automatically."
              : undefined
        }
        actions={
          <>
            {cancellable ? (
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                Cancel session
              </Button>
            ) : null}
            <Link
              href={`/projects/${projectId}/sessions/${s.id}/graph`}
              className="btn btn--secondary btn--md"
            >
              Sitemap
            </Link>
            <Link
              href={`/projects/${projectId}/sessions/${s.id}/gallery`}
              className="btn btn--primary btn--md"
            >
              View gallery ({s.stats.screensCaptured})
            </Link>
          </>
        }
      />

      {/* Live stats (FR-AP-031). */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "var(--space-4)",
        }}
      >
        <StatTile label="Screens" value={s.stats.screensCaptured} />
        <StatTile label="Edges" value={s.stats.edgesRecorded} />
        <StatTile label="Duplicates" value={s.stats.duplicatesSkipped} />
        <StatTile label="Errors" value={s.stats.errorsCount} />
        <StatTile label="Max depth" value={s.stats.maxDepthReached} />
        <StatTile
          label="Duration"
          value={running ? "running…" : fmtDuration(s.startedAt, s.endedAt)}
        />
      </div>

      {/* Current position + timing. */}
      <section className="card" style={{ padding: "var(--space-5)" }}>
        <dl className="meta-list meta-list--wide">
          <div>
            <dt>Current URL</dt>
            <dd className="mono">{s.stats.currentUrl || "—"}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{fmtDateTime(s.startedAt)}</dd>
          </div>
          <div>
            <dt>Ended</dt>
            <dd>{fmtDateTime(s.endedAt)}</dd>
          </div>
        </dl>
      </section>

      {/* Config snapshot (FR-AP-031 / FR-BE-030). */}
      <section className="card" style={{ padding: "var(--space-5)" }}>
        <h2 className="form-section__title" style={{ marginBottom: "var(--space-3)" }}>
          Config snapshot
        </h2>
        <dl className="meta-list meta-list--grid">
          <div>
            <dt>Allowed domains</dt>
            <dd className="mono">{cfg.allowedDomains.join(", ") || "—"}</dd>
          </div>
          <div>
            <dt>Max depth</dt>
            <dd>{cfg.maxDepth ?? "Unlimited"}</dd>
          </div>
          <div>
            <dt>Max screens</dt>
            <dd>{cfg.maxScreens ?? "Unlimited"}</dd>
          </div>
          <div>
            <dt>Max duration</dt>
            <dd>{cfg.maxDurationMin === null ? "Unlimited" : `${cfg.maxDurationMin} min`}</dd>
          </div>
          <div>
            <dt>Viewport</dt>
            <dd>
              {cfg.viewport.width}×{cfg.viewport.height}
            </dd>
          </div>
          <div>
            <dt>Full page</dt>
            <dd>{cfg.fullPage ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt>Click delay</dt>
            <dd>{cfg.clickDelayMs} ms</dd>
          </div>
          <div>
            <dt>Blocklist</dt>
            <dd>{cfg.destructiveTextBlocklist.length} terms</dd>
          </div>
        </dl>
      </section>

      {/* Coverage (FR-AP-031 / FR-BE-051): unique URLs/states, states per depth,
          dead clicks, duplicate rate — computed from the captured rows. */}
      <CoveragePanel sessionId={s.id} />

      {/* Error / event log (FR-AP-031 / FR-EX-082/084). The extension streams the
          crawl's swallowed failures here, so the log doubles as the error list. */}
      <section className="card" style={{ padding: "var(--space-5)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            marginBottom: "var(--space-3)",
          }}
        >
          <h2 className="form-section__title" style={{ margin: 0 }}>
            Session log
          </h2>
          {s.stats.errorsCount > 0 ? (
            <Badge tone="danger">
              {s.stats.errorsCount} error{s.stats.errorsCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        {logsQ.isLoading ? (
          <div className="loading-row">
            <Spinner /> Loading log…
          </div>
        ) : logs.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {s.stats.errorsCount > 0
              ? "This run reported errors — details are still syncing from the extension."
              : "No errors or log entries for this run."}
          </p>
        ) : (
          <>
            <ul className="log-list">
              {logs.map((l) => (
                <li key={l.id} className="log-list__item">
                  <LogLevel level={l.level} />
                  <span className="log-list__event">{l.event}</span>
                  <span className="log-list__ctx muted mono">{logContext(l.context)}</span>
                  <span className="log-list__at subtle">{fmtDateTime(l.at)}</span>
                </li>
              ))}
            </ul>
            {logsQ.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void logsQ.fetchNextPage()}
                disabled={logsQ.isFetchingNextPage}
                style={{ marginTop: "var(--space-3)" }}
              >
                {logsQ.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : null}
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel session"
        confirmLabel="Cancel session"
        tone="danger"
        busy={cancel.isPending}
        onConfirm={doCancel}
        onCancel={() => setConfirmCancel(false)}
      >
        <p style={{ margin: 0 }}>
          Stop this crawl now? Any states captured so far are kept. This can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
