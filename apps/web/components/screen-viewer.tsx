"use client";

// Full-size screenshot viewer overlay (FR-AP-041): image + metadata, with
// previous/next navigation (buttons and ←/→ keys) and Esc to close.

import { useEffect } from "react";
import type { Screen } from "@snapcrawl/shared";
import { Badge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export function ScreenViewer({
  screens,
  index,
  onClose,
  onNavigate,
}: {
  screens: Screen[];
  index: number;
  onClose: () => void;
  onNavigate: (nextIndex: number) => void;
}) {
  const screen = screens[index];
  const hasPrev = index > 0;
  const hasNext = index < screens.length - 1;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev) onNavigate(index - 1);
      else if (e.key === "ArrowRight" && hasNext) onNavigate(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, hasPrev, hasNext, onClose, onNavigate]);

  if (!screen) return null;
  const trigger = screen.triggerElement;

  return (
    <div className="viewer-backdrop" onClick={onClose}>
      <div
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
          <img
            className="viewer__img"
            src={screen.imageUrl ?? screen.thumbUrl ?? undefined}
            alt={screen.title || screen.url}
          />
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
  );
}
