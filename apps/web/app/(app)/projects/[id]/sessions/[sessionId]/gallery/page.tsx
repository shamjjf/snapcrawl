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
  Checkbox,
  Input,
  PageHeader,
  PagePlaceholder,
  Select,
  Spinner,
} from "@/components/ui";
import { ScreenViewer } from "@/components/screen-viewer";
import { useScreens } from "@/lib/queries";

export default function GalleryPage() {
  const params = useParams<{ id: string; sessionId: string }>();
  const projectId = params.id;
  const sessionId = params.sessionId;

  const [url, setUrl] = useState("");
  const [depth, setDepth] = useState("");
  const [dupOnly, setDupOnly] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const query = useScreens(sessionId, {
    url: url || undefined,
    depth: depth !== "" ? Number(depth) : undefined,
    duplicate: dupOnly ? true : undefined,
  });
  const screens = query.data?.pages.flatMap((p) => p.items) ?? [];

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

      <PageHeader title="Gallery" subtitle="Every unique state captured in this crawl." />

      <div className="filters">
        <Input
          type="search"
          placeholder="Filter by URL or title…"
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
        <Checkbox
          label="Duplicates only"
          checked={dupOnly}
          onChange={(e) => setDupOnly(e.target.checked)}
        />
      </div>

      {query.isLoading ? (
        <div className="loading-row">
          <Spinner /> Loading screenshots…
        </div>
      ) : query.isError ? (
        <Alert tone="danger">Couldn&apos;t load screenshots.</Alert>
      ) : screens.length === 0 ? (
        <PagePlaceholder title="No screenshots match">
          Adjust the filters, or run a crawl to capture states.
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
        />
      ) : null}
    </>
  );
}
