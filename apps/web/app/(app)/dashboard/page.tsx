"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Dashboard } from "@snapcrawl/shared";
import { getDashboard } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { useSession } from "@/components/session-provider";
import { Alert, PageHeader, Spinner, StatTile, StatusChip } from "@/components/ui";

/** Format a byte count. Needs the small units: a workspace with a few hundred
 *  KB of screenshots is the common case, and rounding those to "0 MB" reads as
 *  a broken tile rather than a small one. */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log10(n) / 3), units.length - 1);
  const v = n / 1000 ** i;
  // One decimal below GB reads as noise; above it, it's the difference that matters.
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 1 : 0)} ${units[i]}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DashboardPage() {
  const { user } = useSession();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) return; // SessionProvider handles the redirect.
    let alive = true;
    void (async () => {
      try {
        const dash = await getDashboard(token);
        if (alive) setData(dash);
      } catch {
        if (alive)
          setError("Couldn't load the dashboard. Is the API running?  (npm run dev:api)");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <PageHeader title={`Welcome back, ${user.name}`} subtitle="Workspace overview." />

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--color-text-muted)",
          }}
        >
          <Spinner /> Loading…
        </div>
      ) : error ? (
        <Alert tone="danger">{error}</Alert>
      ) : data ? (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            <StatTile label="Projects" value={data.stats.projects} />
            <StatTile label="Sessions (30d)" value={data.stats.sessionsLast30Days} />
            <StatTile
              label="Screens captured"
              value={data.stats.screensCaptured.toLocaleString()}
            />
            <StatTile label="Storage used" value={fmtBytes(data.stats.storageBytes)} />
          </div>

          <section className="card" style={{ padding: "var(--space-5)" }}>
            <h2
              style={{
                margin: "0 0 var(--space-4)",
                fontSize: "var(--text-lg)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--color-text)",
              }}
            >
              Recent sessions
            </h2>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Project</th>
                    <th>Status</th>
                    <th style={{ textAlign: "right" }}>Screens</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentSessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.projectId ? (
                          <Link
                            href={`/projects/${s.projectId}/sessions/${s.id}`}
                            className="mono"
                            style={{ fontWeight: "var(--weight-medium)" }}
                          >
                            {s.id}
                          </Link>
                        ) : (
                          <span className="mono">{s.id}</span>
                        )}
                      </td>
                      <td>{s.project}</td>
                      <td>
                        <StatusChip status={s.status} />
                      </td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {s.screens}
                      </td>
                      <td className="muted">{fmtDate(s.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
