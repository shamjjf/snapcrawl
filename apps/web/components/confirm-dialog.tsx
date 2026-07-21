"use client";

// Confirmation dialog. When `requireText` is set, the confirm button stays
// disabled until the user types that exact string — used for destructive
// project actions where the project name must be typed (FR-AP-022).
//
// `canConfirm` is the same idea for a caller that gates on something other than
// typed text — the NFR-020 attestation gates on a checkbox. Kept as one dialog
// rather than a second implementation so the focus trap, Esc handling and modal
// semantics can't drift apart.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input } from "@/components/ui";
import { useFocusTrap } from "@/lib/use-focus-trap";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  tone = "danger",
  requireText,
  canConfirm = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  /** If set, the user must type this exact value to enable the confirm button. */
  requireText?: string;
  /** Caller-side gate on the confirm button, ANDed with `requireText`. */
  canConfirm?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset the typed value each time the dialog opens.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  // Focus in on open, trap Tab, Esc to cancel, focus back on close (FR-AP-073).
  useFocusTrap(dialogRef, onCancel, open);

  if (!open) return null;

  const matches = !requireText || typed === requireText;

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="dialog card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title">{title}</h2>
        <div className="dialog__body">
          {children}
          {requireText ? (
            <div className="field" style={{ marginTop: "var(--space-3)" }}>
              <label className="field__label" htmlFor="confirm-text">
                Type <strong>{requireText}</strong> to confirm
              </label>
              <Input
                id="confirm-text"
                value={typed}
                autoFocus
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          ) : null}
        </div>
        <div className="dialog__actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone}
            onClick={onConfirm}
            disabled={!matches || !canConfirm || busy}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
