"use client";

// Extension token management (FR-AP-061). Generate a pairing token (shown
// exactly once, with copy + setup instructions), list existing tokens with
// last-used time, and revoke them.

import { useState, type FormEvent } from "react";
import type { ApiToken, TokenCreateResponse } from "@snapcrawl/shared";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  Spinner,
} from "@/components/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast";
import { useCreateToken, useRevokeToken, useTokens } from "@/lib/queries";
import { fmtDate, fmtDateTime } from "@/lib/format";

type TokenState = { label: string; tone: "success" | "neutral" | "danger" };

function tokenState(t: ApiToken): TokenState {
  if (t.revokedAt) return { label: "Revoked", tone: "neutral" };
  if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now())
    return { label: "Expired", tone: "danger" };
  return { label: "Active", tone: "success" };
}

export default function TokensPage() {
  const toast = useToast();
  const list = useTokens();
  const create = useCreateToken();
  const revoke = useRevokeToken();

  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  const [created, setCreated] = useState<TokenCreateResponse | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiToken | null>(null);

  function onGenerate(e: FormEvent) {
    e.preventDefault();
    if (create.isPending) return;
    if (!name.trim()) {
      setNameError("Give the token a name so you can recognise it later.");
      return;
    }
    setNameError(undefined);
    create.mutate(
      { name: name.trim(), expiresAt: expiresAt ? new Date(expiresAt) : undefined },
      {
        onSuccess: (res) => {
          setCreated(res);
          setName("");
          setExpiresAt("");
          toast.success(`Token "${res.token.name}" created.`);
        },
      },
    );
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.rawToken);
      toast.success("Token copied to clipboard.");
    } catch {
      toast.error("Couldn't copy — select the token and copy it manually.");
    }
  }

  function confirmRevoke() {
    if (!toRevoke) return;
    const label = toRevoke.name;
    revoke.mutate(toRevoke.id, {
      onSuccess: () => {
        toast.success(`Revoked "${label}".`);
        setToRevoke(null);
      },
    });
  }

  const tokens = list.data ?? [];

  return (
    <>
      <PageHeader
        title="Extension tokens"
        subtitle="Pair the Chrome extension with a personal token."
      />

      {/* One-time reveal after creation (FR-AP-061). */}
      {created ? (
        <section className="card reveal">
          <div className="reveal__head">
            <strong>Copy your token now — you won&apos;t see it again.</strong>
            <button
              type="button"
              className="icon-btn"
              aria-label="Dismiss"
              onClick={() => setCreated(null)}
            >
              ×
            </button>
          </div>
          <div className="copy-field">
            <code className="copy-field__value mono">{created.rawToken}</code>
            <Button variant="primary" size="sm" onClick={() => void copyToken()}>
              Copy
            </Button>
          </div>
          <ol className="reveal__steps">
            <li>Open the SnapCrawl extension → <strong>Options</strong>.</li>
            <li>Set the backend URL to your API base (e.g. <code className="mono">http://localhost:4000</code>).</li>
            <li>Paste this token and save — the extension validates it and lists your projects.</li>
          </ol>
        </section>
      ) : null}

      {/* Generate form. */}
      <section className="card form-section">
        <h2 className="form-section__title">Generate a token</h2>
        <form onSubmit={onGenerate} noValidate>
          <div className="form-grid">
            <Field label="Name" htmlFor="t-name" error={nameError}>
              <Input
                id="t-name"
                value={name}
                invalid={!!nameError}
                placeholder="Work laptop"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label="Expires (optional)"
              htmlFor="t-expires"
              hint="Leave blank for a non-expiring token."
            >
              <Input
                id="t-expires"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </Field>
          </div>
          <div className="form-actions" style={{ marginTop: "var(--space-4)" }}>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Generate token
            </Button>
          </div>
        </form>
      </section>

      {/* Existing tokens. */}
      <section className="card" style={{ padding: "var(--space-2)" }}>
        {list.isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-4)",
              color: "var(--color-text-muted)",
            }}
          >
            <Spinner /> Loading tokens…
          </div>
        ) : list.isError ? (
          <div style={{ padding: "var(--space-3)" }}>
            <Alert tone="danger">Couldn&apos;t load tokens.</Alert>
          </div>
        ) : tokens.length === 0 ? (
          <p className="muted" style={{ padding: "var(--space-4)", margin: 0 }}>
            No tokens yet. Generate one above to pair the extension.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th>Created</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => {
                  const state = tokenState(t);
                  const revocable = !t.revokedAt;
                  return (
                    <tr key={t.id}>
                      <td style={{ fontWeight: "var(--weight-medium)" }}>{t.name}</td>
                      <td>
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </td>
                      <td className="muted">{fmtDateTime(t.lastUsedAt)}</td>
                      <td className="muted">{fmtDate(t.expiresAt)}</td>
                      <td className="muted">{fmtDate(t.createdAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        {revocable ? (
                          <Button variant="ghost" size="sm" onClick={() => setToRevoke(t)}>
                            Revoke
                          </Button>
                        ) : (
                          <span className="subtle">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={!!toRevoke}
        title="Revoke token"
        confirmLabel="Revoke token"
        busy={revoke.isPending}
        onConfirm={confirmRevoke}
        onCancel={() => setToRevoke(null)}
      >
        <p style={{ margin: 0 }}>
          Revoking <strong>{toRevoke?.name}</strong> immediately stops any extension using it.
          This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
