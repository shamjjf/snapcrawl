"use client";

// Authorised-use gate (NFR-020 / C-07): before a project's first crawl, someone
// must confirm they own or are authorised to test the target. The backend 403s
// AUTHORISED_USE_REQUIRED on POST /ext/sessions until this is recorded, and
// writes the confirmation (user, project, timestamp) to the audit log.
//
// Tone is set by docs/DESIGN.md §6.2: plain, first-person, serious without
// theatrics. It records accountability, so it must read as a deliberate
// attestation, not a dismissable nag — hence neutral surface styling rather than
// the danger palette, an unchecked box, and a confirm button that stays disabled
// until it is ticked. It must never imply SnapCrawl bypasses protections: it
// explicitly does not (no CAPTCHA or bot-detection circumvention).

import { useState } from "react";
import type { Project } from "@snapcrawl/shared";
import { Alert, Button, Checkbox } from "@/components/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useAuthoriseProject } from "@/lib/queries";
import { fmtDateTime } from "@/lib/format";

/** The host the crawler would actually visit. */
function targetDomain(p: Project): string {
  try {
    return new URL(p.baseUrl).host;
  } catch {
    return p.baseUrl;
  }
}

/**
 * Renders the attestation prompt when a project has not been confirmed, and a
 * quiet record of who confirmed it once it has. `canWrite` mirrors the API:
 * viewers get 403 on the write, so they are told rather than shown a dead button.
 */
export function AuthoriseGate({ project, canWrite }: { project: Project; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const authorise = useAuthoriseProject(project.id);

  if (project.authorisedUse) {
    return (
      <p className="subtle" style={{ fontSize: "var(--text-xs)", margin: 0 }}>
        Authorised use confirmed {fmtDateTime(project.authorisedUse.at)}.
      </p>
    );
  }

  function close() {
    setOpen(false);
    setChecked(false);
  }

  return (
    <section className="card authorise-gate">
      <h2 className="authorise-gate__title">Confirm authorization</h2>
      <p className="authorise-gate__body">
        No crawl has been authorised for this project yet. SnapCrawl will click and
        screenshot <strong>{targetDomain(project)}</strong> on your behalf, so someone has to
        confirm they are allowed to test it first. Crawls are blocked until then.
      </p>
      {canWrite ? (
        <Button variant="primary" onClick={() => setOpen(true)}>
          Confirm authorization
        </Button>
      ) : (
        <Alert tone="info">
          Ask an admin or a project member to confirm authorization — viewers cannot.
        </Alert>
      )}

      <ConfirmDialog
        open={open}
        title="Confirm authorization"
        confirmLabel="Confirm authorization"
        tone="primary"
        canConfirm={checked}
        busy={authorise.isPending}
        onCancel={close}
        onConfirm={() =>
          authorise.mutate(undefined, {
            onSuccess: close,
            // Failures surface through the global error toast (FR-AP-070); keep
            // the dialog open so the user can retry without re-ticking.
          })
        }
      >
        <p style={{ margin: 0 }}>
          I own or am authorized to test <strong>{targetDomain(project)}</strong>. SnapCrawl
          will click and screenshot this app on my behalf.
        </p>
        <p className="subtle" style={{ fontSize: "var(--text-xs)", margin: "var(--space-2) 0 0" }}>
          This confirmation is recorded against your account. SnapCrawl does not bypass
          CAPTCHAs or bot detection.
        </p>
        <div style={{ marginTop: "var(--space-3)" }}>
          <Checkbox
            label="I confirm I have permission to crawl this target."
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
        </div>
      </ConfirmDialog>
    </section>
  );
}
