"use client";

// Confirmation dialog. When `requireText` is set, the confirm button stays
// disabled until the user types that exact string — used for destructive
// project actions where the project name must be typed (FR-AP-022).

import { useEffect, useState, type ReactNode } from "react";
import { Button, Input } from "@/components/ui";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  tone = "danger",
  requireText,
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
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");

  // Reset the typed value each time the dialog opens.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  if (!open) return null;

  const matches = !requireText || typed === requireText;

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
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
            disabled={!matches || busy}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
