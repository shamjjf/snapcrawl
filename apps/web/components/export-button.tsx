"use client";

// Session ZIP export (FR-AP-042: "server-generated, asynchronous with
// notification when ready"). The build runs off the request, so this is a small
// state machine over the job record: POST starts (or re-attaches to) a build,
// then we poll GET until it flips to `ready` with a signed download URL, or
// `failed` with a reason. No websocket — a 1.5 s poll is a fine "tell me when
// it's done" for a job measured in seconds (the poll lives in the query hook).

import { useState } from "react";
import { Alert, Button, DownloadIcon } from "@/components/ui";
import { useToast } from "@/components/toast";
import { useSessionExportJob, useStartSessionExport } from "@/lib/queries";

function fmtBytes(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExportButton({ sessionId }: { sessionId: string }) {
  const [exportId, setExportId] = useState<string | null>(null);
  const start = useStartSessionExport(sessionId);
  const jobQ = useSessionExportJob(sessionId, exportId);
  const toast = useToast();

  // The POST response seeds the initial job; the poll then keeps it fresh.
  const job = jobQ.data ?? start.data ?? null;

  function begin() {
    start.mutate(undefined, {
      onSuccess: (j) => setExportId(j.id),
      onError: (e) => toast.error(e as never),
    });
  }

  // Preparing: a job exists and hasn't finished, or the POST is still in flight.
  const preparing = start.isPending || job?.status === "pending";

  if (job?.status === "ready" && job.downloadUrl) {
    const meta = [
      job.screenCount != null ? `${job.screenCount} screens` : null,
      fmtBytes(job.bytes) || null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
        {/* A ZIP can't render in the browser, so a plain signed-URL link
            downloads it — no cross-origin Blob dance needed (unlike an image). */}
        <a
          className="btn btn--primary btn--md"
          href={job.downloadUrl}
          download
          rel="noopener"
        >
          <DownloadIcon size={16} />
          Download ZIP
        </a>
        {meta ? (
          <span className="subtle" style={{ fontSize: "var(--text-xs)" }}>
            {meta}
          </span>
        ) : null}
      </span>
    );
  }

  if (job?.status === "failed") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Alert tone="danger">{job.error || "The export failed."}</Alert>
        <Button
          variant="secondary"
          size="md"
          onClick={() => {
            setExportId(null); // a failed job is not reused; start a fresh one
            begin();
          }}
        >
          Retry
        </Button>
      </span>
    );
  }

  return (
    <Button variant="secondary" size="md" onClick={begin} disabled={preparing} loading={preparing}>
      {preparing ? (
        "Preparing ZIP…"
      ) : (
        <>
          <DownloadIcon size={16} /> Export ZIP
        </>
      )}
    </Button>
  );
}
