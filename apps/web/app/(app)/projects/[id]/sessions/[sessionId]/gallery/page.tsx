"use client";

// Screenshot gallery (FR-AP-040): responsive lazy-loaded thumbnail grid,
// filterable by URL substring / depth / duplicate flag, with the full-size
// viewer (FR-AP-041) opened on click.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  Input,
  PageHeader,
  PagePlaceholder,
  Select,
  Spinner,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";
import { ScreenViewer } from "@/components/screen-viewer";
import { useSession as useAuthSession } from "@/components/session-provider";
import { useProject, useScreens } from "@/lib/queries";

export default function GalleryPage() {
  const params = useParams<{ id: string; sessionId: string }>();
  const projectId = params.id;
  const sessionId = params.sessionId;

  const [url, setUrl] = useState("");
  const [depth, setDepth] = useState("");
  // "" = all, "true" = near-duplicates only, "false" = originals only. The API's
  // `duplicate` filter is tri-state now that pHash actually sets isDuplicate
  // (FR-BE-043), so the UI exposes all three rather than a two-state checkbox.
  const [dup, setDup] = useState<"" | "true" | "false">("");
  // FR-EX-090 — a run captures as ONE device, so a session holds one variant.
  // The tabs let you narrow explicitly; they are not the primary reading of the
  // data. Not defaulted blindly to desktop: a run is ONE device, so a mobile session's
  // desktop tab is empty and the placeholder would tell the user to enable a
  // setting they already used. `null` means "haven't chosen" — the unfiltered
  // first page decides which tab to open on.
  const [variant, setVariant] = useState<"desktop" | "mobile" | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const query = useScreens(sessionId, {
    url: url || undefined,
    depth: depth !== "" ? Number(depth) : undefined,
    duplicate: dup === "" ? undefined : dup === "true",
    variant: variant ?? undefined,
  });
  const screens = query.data?.pages.flatMap((p) => p.items) ?? [];
  // Open on whichever device this session actually captured.
  const activeTab: "desktop" | "mobile" =
    variant ?? (screens.length > 0 && screens[0].variant === "mobile" ? "mobile" : "desktop");

  // Delete is owner/admin only (mirrors the API's canManage; a viewer or a
  // non-owner member would get 403). Compute it here so the viewer shows the
  // button only when it will actually work, rather than showing-and-failing.
  const { user } = useAuthSession();
  const project = useProject(projectId);
  const canDelete =
    user.role === "admin" || (!!project.data && project.data.ownerId === user.id);

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span aria-hidden> / </span>
        <Link href={`/projects/${projectId}/sessions`}>Sessions</Link>
        <span aria-hidden> / </span>
        <Link href={`/projects/${projectId}/sessions/${sessionId}`} className="mono">
          {sessionId.slice(-8)}
        </Link>
        <span aria-hidden> / </span>
        <span>Gallery</span>
      </nav>

      <PageHeader
        title="Gallery"
        subtitle={
          activeTab === "mobile"
            ? "The emulated-phone capture of each state (FR-EX-090)."
            : "Every unique state captured in this crawl."
        }
        actions={<ExportButton sessionId={sessionId} />}
      />

      {/* FR-EX-090 — Desktop / Mobile tabs. */}
      <div
        role="tablist"
        aria-label="Capture variant"
        style={{
          display: "flex",
          gap: "var(--space-1)",
          borderBottom: "1px solid var(--color-border)",
          marginBottom: "var(--space-3)",
        }}
      >
        {(
          [
            { key: "desktop", label: "Desktop view" },
            { key: "mobile", label: "Mobile view" },
          ] as const
        ).map((t) => {
          const selected = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setVariant(t.key);
                setViewerIndex(null); // indices belong to the old list
              }}
              style={{
                appearance: "none",
                background: "none",
                border: "none",
                borderBottom: `2px solid ${selected ? "var(--color-accent)" : "transparent"}`,
                color: selected ? "var(--color-text)" : "var(--color-text-muted)",
                fontWeight: selected ? 600 : 400,
                fontSize: "var(--text-sm)",
                padding: "var(--space-2) var(--space-3)",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="filters">
        <Input
          type="search"
          // URL only: the server filter is a substring match on `url` and does
          // not look at `title` (GET /sessions/:id/screens ?url=).
          placeholder="Filter by URL…"
          aria-label="Filter by URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <Select
          aria-label="Filter by depth"
          value={depth}
          onChange={(e) => setDepth(e.target.value)}
          style={{ maxWidth: 140 }}
        >
          <option value="">Any depth</option>
          {[0, 1, 2, 3, 4, 5].map((d) => (
            <option key={d} value={d}>
              Depth {d}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by duplicate flag"
          value={dup}
          onChange={(e) => setDup(e.target.value as "" | "true" | "false")}
          style={{ maxWidth: 170 }}
        >
          <option value="">All states</option>
          <option value="false">Originals only</option>
          <option value="true">Duplicates only</option>
        </Select>
      </div>

      {query.isLoading ? (
        <div className="loading-row">
          <Spinner /> Loading screenshots…
        </div>
      ) : query.isError ? (
        <Alert tone="danger">Couldn&apos;t load screenshots.</Alert>
      ) : screens.length === 0 ? (
        <PagePlaceholder
          title={activeTab === "mobile" ? "No mobile captures" : "No screenshots match"}
        >
          {activeTab === "mobile" ? (
            <>
              This crawl ran in Desktop mode. To capture a phone view, pick{" "}
              <strong>Mobile</strong> under &ldquo;Capture as&rdquo; in the extension popup and run
              the crawl again — a run captures one device, so mobile is its own crawl.
            </>
          ) : (
            <>Adjust the filters, or run a crawl to capture states.</>
          )}
        </PagePlaceholder>
      ) : (
        <>
          <div className="gallery">
            {screens.map((screen, i) => (
              <button
                key={screen.id}
                type="button"
                className="thumb"
                onClick={() => setViewerIndex(i)}
                aria-label={`Open ${screen.title || screen.url}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="thumb__img"
                  src={screen.thumbUrl ?? screen.imageUrl ?? undefined}
                  alt={screen.title || screen.url}
                  loading="lazy"
                />
                <span className="thumb__meta">
                  <span className="thumb__title">{screen.title || screen.url}</span>
                  <span className="thumb__badges">
                    <span className="subtle">d{screen.depth}</span>
                    {screen.isDuplicate ? <Badge tone="neutral">dup</Badge> : null}
                    {/* FR-EX-090 — the page didn't actually re-render at phone
                        width, so this is a narrowed desktop layout. Say so on the
                        tile rather than passing it off as a real mobile render. */}
                    {screen.variant === "mobile" && screen.mobileReflowed === false ? (
                      <span title="The page did not re-render for mobile — this is a narrowed desktop layout">
                        <Badge tone="info">not responsive</Badge>
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            ))}
          </div>

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

      {viewerIndex !== null ? (
        <ScreenViewer
          screens={screens}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onNavigate={(next) => setViewerIndex(next)}
          sessionId={sessionId}
          canDelete={canDelete}
        />
      ) : null}
    </>
  );
}
