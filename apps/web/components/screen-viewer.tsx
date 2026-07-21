"use client";

// Full-size screenshot viewer overlay (FR-AP-041): image + metadata, with
// previous/next navigation (buttons and ←/→ keys) and Esc to close.

import { useEffect, useRef, useState } from "react";
import type { Screen } from "@snapcrawl/shared";
import { Badge, Button, DownloadIcon } from "@/components/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast";
import { fmtDateTime } from "@/lib/format";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useDeleteScreen, useScreen } from "@/lib/queries";

/** Map the image's real MIME to a file extension, so a WebP capture doesn't get
 *  saved as `.png`. Falls back to the extension in the URL path, then `png`. */
function extensionFor(mime: string | undefined, url: string): string {
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  const fromPath = url.split("?")[0]?.match(/\.(png|webp|jpe?g)$/i)?.[1];
  return fromPath ? fromPath.toLowerCase().replace("jpeg", "jpg") : "png";
}

/** A filename a human can find again: the page host + a short id, ASCII-safe. */
function downloadName(screen: Screen, ext: string): string {
  let host = "";
  try {
    host = new URL(screen.url).host;
  } catch {
    /* url may be a non-absolute state label; just omit the host */
  }
  const slug = `${host}-${screen.id.slice(-6)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `snapcrawl-${slug || screen.id}.${ext}`;
}

export function ScreenViewer({
  screens,
  index,
  onClose,
  onNavigate,
  // Deletion (FR-AP-043) is opt-in: the gallery passes the session id and whether
  // the current user may delete (owner/admin). The graph's single-screen viewer
  // passes neither, so no delete button appears there.
  sessionId,
  canDelete = false,
}: {
  screens: Screen[];
  index: number;
  onClose: () => void;
  onNavigate: (nextIndex: number) => void;
  sessionId?: string;
  canDelete?: boolean;
}) {
  const screen = screens[index];
  const hasPrev = index > 0;
  const hasNext = index < screens.length - 1;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useDeleteScreen(sessionId ?? "");
  const showDelete = Boolean(sessionId) && canDelete;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus into the viewer on open, trap Tab, Esc to close, restore focus on close
  // (FR-AP-073). Suspended while the delete-confirm is open so that nested dialog
  // owns the keyboard; otherwise both would fight over focus and Esc.
  useFocusTrap(dialogRef, onClose, !confirmDelete);

  // `GET /sessions/:id/screens` (the gallery's list) returns `thumbUrl` but NO
  // `imageUrl` — only `GET /screens/:id` carries the full-size signed URL. So
  // the viewer fetches it itself rather than trusting the caller to have done
  // it; otherwise the gallery would show a thumbnail blown up to full size.
  // Today `thumbUrl` happens to BE the full image, which is exactly why this
  // would have failed silently the moment real thumbnails land (FR-BE-042).
  const full = useScreen(screen?.id ?? "");
  // Prefer the full-size URL; fall back to the list's thumb so the image is
  // visible instantly instead of blank while the fetch is in flight (FR-AP-041).
  const src = full.data?.imageUrl ?? screen?.imageUrl ?? screen?.thumbUrl ?? undefined;

  const toast = useToast();
  const [downloading, setDownloading] = useState(false);

  /**
   * Download the full-size image (FR-AP-042, the per-image half; the session ZIP
   * export is a separate server-generated job, not built yet).
   *
   * This deliberately fetches the bytes into a Blob rather than the far simpler
   * `<a href={url} download>`. The `download` attribute is IGNORED for a
   * cross-origin URL — and the image lives on the S3 bucket origin, not the API —
   * so the anchor would just open the picture inline and the "download" would
   * silently not happen. Blob + object URL is the only client-side way to force a
   * save across origins. The presigned URL carries its own auth in the query
   * string, so this default-credentials fetch sends no cookies, which is correct.
   *
   * Prod note: this needs the image bucket to allow cross-origin GET from the
   * panel — set a CORS rule on the bucket allowing GET from it. If that rule
   * is stricter, the fetch throws and the user gets the toast below rather than a
   * silent no-op — and the robust fix then is a backend presign with
   * `response-content-disposition: attachment`, flagged to that lane.
   */
  async function download() {
    if (!screen) return;
    const url = full.data?.imageUrl ?? screen.imageUrl;
    if (!url) {
      // useScreen is still resolving the signed URL (or it failed). Don't fake a
      // download; say why nothing happened.
      toast.error("The full-size image isn't ready yet — try again in a moment.");
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Image server returned ${res.status}.`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = downloadName(screen, extensionFor(blob.type, url));
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      toast.error("Couldn't download the image. Check your connection and try again.");
    } finally {
      setDownloading(false);
    }
  }

  function doDelete() {
    if (!screen) return;
    del.mutate(screen.id, {
      onSuccess: () => {
        toast.success("Screenshot deleted.");
        setConfirmDelete(false);
        // The current screen is gone; close rather than leave the viewer on a
        // now-stale index. The gallery's invalidation refreshes the grid.
        onClose();
      },
      // A 403 (not owner/admin) or 502 (storage) surfaces via the global error
      // toast; keep the dialog open so it can be retried or cancelled.
    });
  }

  // Arrow-key navigation between screenshots. Esc-to-close and focus trapping are
  // handled by useFocusTrap (which scopes Esc to the focused dialog, so it closes
  // a nested delete-confirm rather than the whole viewer).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft" && hasPrev) onNavigate(index - 1);
      else if (e.key === "ArrowRight" && hasNext) onNavigate(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, hasPrev, hasNext, onNavigate]);

  if (!screen) return null;
  const trigger = screen.triggerElement;

  return (
    <>
      <div className="viewer-backdrop" onClick={onClose}>
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="viewer card"
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot viewer"
          onClick={(e) => e.stopPropagation()}
        >
        <div className="viewer__stage">
          <button
            type="button"
            className="viewer__nav"
            aria-label="Previous screenshot"
            disabled={!hasPrev}
            onClick={() => onNavigate(index - 1)}
          >
            ‹
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="viewer__img" src={src} alt={screen.title || screen.url} />
          <button
            type="button"
            className="viewer__nav"
            aria-label="Next screenshot"
            disabled={!hasNext}
            onClick={() => onNavigate(index + 1)}
          >
            ›
          </button>
        </div>

        <aside className="viewer__meta">
          <div className="viewer__meta-head">
            <strong>{screen.title || "Untitled state"}</strong>
            <button type="button" className="icon-btn" aria-label="Close viewer" onClick={onClose}>
              ×
            </button>
          </div>

          <div className="viewer__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={download}
              loading={downloading}
              disabled={downloading}
            >
              <DownloadIcon size={16} />
              {downloading ? "Downloading…" : "Download image"}
            </Button>
            {showDelete ? (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                disabled={del.isPending}
              >
                Delete
              </Button>
            ) : null}
          </div>
          <dl className="meta-list">
            <div>
              <dt>Page URL</dt>
              <dd className="mono">{screen.url}</dd>
            </div>
            <div>
              <dt>Captured</dt>
              <dd>{fmtDateTime(screen.capturedAt)}</dd>
            </div>
            <div>
              <dt>Depth</dt>
              <dd>{screen.depth}</dd>
            </div>
            <div>
              <dt>Fingerprint</dt>
              <dd className="mono">{screen.fingerprint.slice(0, 16)}…</dd>
            </div>
            <div>
              <dt>Trigger</dt>
              <dd className="mono">
                {trigger
                  ? `${trigger.selector}${trigger.text ? ` — "${trigger.text}"` : ""}`
                  : "root (entry point)"}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>
                {screen.width && screen.height ? `${screen.width}×${screen.height}` : "—"}
                {screen.fullPage ? " · full page" : ""}
              </dd>
            </div>
          </dl>
          {screen.isDuplicate ? <Badge tone="neutral">Duplicate state</Badge> : null}
          <div className="viewer__count">
            {index + 1} of {screens.length}
          </div>
        </aside>
        </div>
      </div>

      {/* Rendered as a sibling of the viewer, not a child: its own backdrop
          doesn't stop propagation, so nesting it would bubble a dialog click up
          to the viewer's onClose. Equal z-index + later in the DOM keeps it on
          top of the viewer. */}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete screenshot"
        confirmLabel="Delete"
        tone="danger"
        busy={del.isPending}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      >
        <p style={{ margin: 0 }}>
          Permanently delete this screenshot? The image and its thumbnail are removed
          from storage. This can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
