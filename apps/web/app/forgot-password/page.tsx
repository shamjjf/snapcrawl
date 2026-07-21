"use client";

// Forgot password (FR-AP-003, implementing FR-BE-005).
//
// This page previously existed as a setTimeout that claimed "a reset link is on
// its way" with no backend behind it, and was deleted for lying. It is back
// because the endpoints now exist — POST /auth/forgot-password.
//
// The API answers 204 whether or not the address exists, so it cannot be used to
// enumerate accounts. That is a deliberate property and it constrains the copy:
// the success state must read identically for a real and an unknown address, and
// must not assert that an email was sent. "If an account exists … you'll get a
// link" is true in both cases; "We've sent you a link" would be a lie half the
// time and would leak the answer the 204 exists to hide.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { forgotPasswordSchema } from "@snapcrawl/shared";
import { Alert, Button, Field, Input, Logo } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { forgotPassword, toEnvelope } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return; // double-submit guard (FR-AP-001's rule, same shape)

    // Validate with the shared schema the API parses with, so the client and
    // server agree on what an address is.
    const parsed = forgotPasswordSchema.safeParse({ email: email.trim() });
    if (!parsed.success) {
      setError("Enter a valid email address.");
      return;
    }
    setError(undefined);
    setFormError(undefined);
    setSubmitting(true);
    try {
      await forgotPassword(parsed.data.email);
      setSent(true);
    } catch (err) {
      // A transport/server failure is NOT the no-enumeration 204 — it means we
      // genuinely don't know if anything happened, so don't claim success.
      setFormError(toEnvelope(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "var(--space-4)",
        position: "relative",
        background: "var(--color-bg)",
      }}
    >
      <div style={{ position: "absolute", top: "var(--space-4)", right: "var(--space-4)" }}>
        <ThemeToggle />
      </div>

      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 400,
          padding: "var(--space-8)",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <Logo size={28} />
            <strong style={{ fontSize: "var(--text-xl)", color: "var(--color-text)" }}>
              SnapCrawl
            </strong>
          </span>
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: "var(--text-xl)",
                fontWeight: "var(--weight-bold)",
                color: "var(--color-text)",
              }}
            >
              Reset password
            </h1>
            <p className="muted" style={{ margin: "var(--space-1) 0 0", fontSize: "var(--text-sm)" }}>
              We&apos;ll email you a link to set a new one.
            </p>
          </div>
        </header>

        {sent ? (
          <>
            <Alert tone="success">
              If an account exists for <strong>{email.trim()}</strong>, a reset link is on its
              way. It works once and expires in an hour.
            </Alert>
            <p className="subtle" style={{ fontSize: "var(--text-xs)", margin: 0 }}>
              Nothing arrived? Check spam, or try again — we don&apos;t confirm whether an
              address is registered.
            </p>
          </>
        ) : (
          <form
            onSubmit={onSubmit}
            noValidate
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
          >
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <Field label="Email" htmlFor="email" error={error}>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                invalid={!!error}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" block loading={submitting}>
              {submitting ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}

        <Link href="/login" style={{ fontSize: "var(--text-sm)", textAlign: "center" }}>
          ← Back to sign in
        </Link>
      </div>
    </main>
  );
}
