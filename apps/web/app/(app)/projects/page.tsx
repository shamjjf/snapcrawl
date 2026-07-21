"use client";

// Projects list (FR-AP-020): search, cursor pagination ("Load more"), and
// last-run info. Row actions: edit, and archive behind a typed-name
// confirmation (FR-AP-022).

import { useState } from "react";
import Link from "next/link";
import type { Project } from "@snapcrawl/shared";
import {
  Alert,
  Badge,
  Button,
  Input,
  PageHeader,
  PagePlaceholder,
  Spinner,
  StatusChip,
} from "@/components/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast";
import { useArchiveProject, useProjects } from "@/lib/queries";
import { fmtDate } from "@/lib/format";

function statusTone(status: Project["status"]): "success" | "neutral" | "danger" {
  if (status === "active") return "success";
  if (status === "pending-delete") return "danger";
  return "neutral";
}

export default function ProjectsPage() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<Project | null>(null);

  const query = useProjects(search);
  const archive = useArchiveProject();

  const projects = query.data?.pages.flatMap((p) => p.items) ?? [];

  function confirmDelete() {
    if (!toDelete) return;
    const name = toDelete.name;
    archive.mutate(toDelete.id, {
      onSuccess: () => {
        toast.success(`Moved "${name}" to the trash.`);
        setToDelete(null);
      },
    });
  }

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Define and configure crawl targets."
        actions={
          <span style={{ display: "inline-flex", gap: "var(--space-2)" }}>
            <Link href="/projects/trash" className="btn btn--secondary btn--md">
              Trash
            </Link>
            <Link href="/projects/new" className="btn btn--primary btn--md">
              New project
            </Link>
          </span>
        }
      />

      <div style={{ maxWidth: 420 }}>
        <Input
          type="search"
          placeholder="Search by name or URL…"
          aria-label="Search projects"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {query.isLoading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--color-text-muted)",
          }}
        >
          <Spinner /> Loading projects…
        </div>
      ) : query.isError ? (
        <Alert tone="danger">Couldn&apos;t load projects. Please try again.</Alert>
      ) : projects.length === 0 ? (
        <PagePlaceholder title={search ? "No projects match your search" : "No projects yet"}>
          {search ? "Try a different term." : "Create your first crawl target to get started."}
        </PagePlaceholder>
      ) : (
        <>
          <section className="card" style={{ padding: "var(--space-2)" }}>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Status</th>
                    <th>Last run</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/projects/${p.id}/sessions`} style={{ fontWeight: "var(--weight-medium)" }}>
                          {p.name}
                        </Link>
                        <div className="subtle mono" style={{ fontSize: "var(--text-xs)" }}>
                          {p.baseUrl}
                        </div>
                      </td>
                      <td>
                        <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                      </td>
                      <td>
                        {p.lastRun ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
                            <StatusChip status={p.lastRun.status} />
                            <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                              {fmtDate(p.lastRun.startedAt)} · {p.lastRun.screensCaptured} screens
                            </span>
                          </span>
                        ) : (
                          <span className="subtle">Never run</span>
                        )}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <Link href={`/projects/${p.id}/edit`} className="btn btn--ghost btn--sm">
                          Edit
                        </Link>
                        <Button variant="ghost" size="sm" onClick={() => setToDelete(p)}>
                          Delete
                        </Button>
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

      <ConfirmDialog
        open={!!toDelete}
        title="Delete project"
        confirmLabel="Delete project"
        requireText={toDelete?.name}
        busy={archive.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      >
        <p style={{ margin: 0 }}>
          Move <strong>{toDelete?.name}</strong> to the trash. Its sessions and screenshots are
          kept, and you can restore it for 7 days before it&apos;s permanently deleted.
        </p>
      </ConfirmDialog>
    </>
  );
}
