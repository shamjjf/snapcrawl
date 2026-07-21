"use client";

// Sitemap graph page (FR-AP-050). The react-flow canvas is client-only
// (ssr: false) since it touches browser layout APIs.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Alert, PageHeader, PagePlaceholder, Spinner } from "@/components/ui";
import { CoverageSummary } from "@/components/coverage-panel";
import { useSessionGraph } from "@/lib/queries";

const SessionGraph = dynamic(
  () => import("@/components/session-graph").then((m) => m.SessionGraph),
  {
    ssr: false,
    loading: () => (
      <div className="loading-row">
        <Spinner /> Loading graph…
      </div>
    ),
  },
);

export default function GraphPage() {
  const params = useParams<{ id: string; sessionId: string }>();
  const projectId = params.id;
  const sessionId = params.sessionId;

  const q = useSessionGraph(sessionId);
  const graph = q.data;

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
        <span>Sitemap</span>
      </nav>

      <PageHeader
        title="Sitemap"
        subtitle="Every captured state and the clicks that reached it. Hover a node for its thumbnail; click to open it."
      />

      {/* Duplicate rate + dead-edge summary from the coverage endpoint (FR-BE-051):
          the numbers that explain the repeats and dead-end stubs in the graph. */}
      {graph && graph.nodes.length > 0 ? <CoverageSummary sessionId={sessionId} /> : null}

      {q.isLoading ? (
        <div className="loading-row">
          <Spinner /> Loading graph…
        </div>
      ) : q.isError ? (
        <Alert tone="danger">Couldn&apos;t load the sitemap graph.</Alert>
      ) : !graph || graph.nodes.length === 0 ? (
        <PagePlaceholder title="No graph yet">
          The sitemap appears once the crawl has captured states.
        </PagePlaceholder>
      ) : (
        <SessionGraph graph={graph} />
      )}
    </>
  );
}
