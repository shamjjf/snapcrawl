"use client";

// Trash — soft-deleted projects within their 7-day grace window (FR-BE-025).
// Deleting a project (DELETE /projects/:id) sets deletedAt rather than removing
// it; it stays restorable here until the background purge runs. Restoring clears
// deletedAt and puts it back in the active list.

import Link from "next/link";
import type { Project } from "@snapcrawl/shared";
import { Alert, Badge, Button, PageHeader, PagePlaceholder, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { useDeletedProjects, useRestoreProject } from "@/lib/queries";
import { fmtDate } from "@/lib/format";

/** Whole days from now until the purge, floored at 0 ("today"). */
function daysUntil(purgeDueAt: Date | null | undefined): number | null {
  if (!purgeDueAt) return null;
  const ms = new Date(purgeDueAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default function TrashPage() {
  const toast = useToast();
  const query = useDeletedProjects();
  const restore = useRestoreProject();
  const projects = query.data ?? [];

  function doRestore(p: Project) {
    restore.mutate(p.id, {
      onSuccess: () => toast.success(`Restored "${p.name}".`),
      onError: (e) => toast.error(e as never),
    });
  }

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span aria-hidden> / </span>
        <span>Trash</span>
      </nav>

      <PageHeader
        title="Trash"
        subtitle="Deleted projects are kept for 7 days, then permanently removed. Restore one to bring it back."
      />

      {query.isLoading ? (
        <div className="loading-row">
          <Spinner /> Loading trash…
        </div>
      ) : query.isError ? (
        <Alert tone="danger">Couldn&apos;t load the trash.</Alert>
      ) : projects.length === 0 ? (
        <PagePlaceholder title="Trash is empty">
          Deleted projects show up here for 7 days before they&apos;re gone for good.
        </PagePlaceholder>
      ) : (
        <section className="card" style={{ padding: "var(--space-2)" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Deleted</th>
                  <th>Purges</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const days = daysUntil(p.purgeDueAt);
                  return (
                    <tr key={p.id}>
                      <td>
                        <span style={{ fontWeight: "var(--weight-medium)" }}>{p.name}</span>
                        <div className="subtle mono" style={{ fontSize: "var(--text-xs)" }}>
                          {p.baseUrl}
                        </div>
                      </td>
                      <td>{fmtDate(p.deletedAt)}</td>
                      <td>
                        {days === null ? (
                          <span className="subtle">—</span>
                        ) : (
                          <Badge tone={days <= 1 ? "danger" : "neutral"}>
                            {days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}
                          </Badge>
                        )}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => doRestore(p)}
                          disabled={restore.isPending}
                        >
                          Restore
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
