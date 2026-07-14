"use client";

// Sessions list per project (FR-AP-030): status chips, duration, screens count,
// status + date filters.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { SessionStatus } from "@snapcrawl/shared";
import {
  Alert,
  Button,
  Field,
  Input,
  PageHeader,
  PagePlaceholder,
  Select,
  Spinner,
  StatusChip,
} from "@/components/ui";
import { useProject, useSessions } from "@/lib/queries";
import { fmtDateTime, fmtDuration } from "@/lib/format";

const STATUSES: SessionStatus[] = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

export default function SessionsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const project = useProject(projectId);

  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const query = useSessions(projectId, {
    status: status || undefined,
    from: from || undefined,
    to: to || undefined,
  });
  const sessions = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span aria-hidden> / </span>
        <span>{project.data?.name ?? "…"}</span>
      </nav>

      <PageHeader title="Sessions" subtitle="Crawl runs for this project." />

      <div className="filters">
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ maxWidth: 180 }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Field label="From" htmlFor="from">
          <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="to">
          <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>

      {query.isLoading ? (
        <div className="loading-row">
          <Spinner /> Loading sessions…
        </div>
      ) : query.isError ? (
        <Alert tone="danger">Couldn&apos;t load sessions.</Alert>
      ) : sessions.length === 0 ? (
        <PagePlaceholder title="No sessions match">
          Sessions appear here once the extension runs a crawl for this project.
        </PagePlaceholder>
      ) : (
        <>
          <section className="card" style={{ padding: "var(--space-2)" }}>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th style={{ textAlign: "right" }}>Screens</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link
                          href={`/projects/${projectId}/sessions/${s.id}`}
                          className="mono"
                          style={{ fontWeight: "var(--weight-medium)" }}
                        >
                          {s.id.slice(-8)}
                        </Link>
                      </td>
                      <td>
                        <StatusChip status={s.status} />
                      </td>
                      <td className="muted">{fmtDateTime(s.startedAt)}</td>
                      <td className="muted">
                        {s.status === "running" ? "running…" : fmtDuration(s.startedAt, s.endedAt)}
                      </td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {s.stats.screensCaptured}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {query.hasNextPage ? (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Button
                variant="secondary"
                onClick={() => void query.fetchNextPage()}
                loading={query.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
