"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getDashboard, type DashboardData } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { useSession } from "@/components/session-provider";
import { Alert, PageHeader, Spinner, StatTile, StatusChip } from "@/components/ui";

function fmtBytes(n: number): string {
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
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
  const [data, setData] = useState<DashboardData | null>(null);
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
