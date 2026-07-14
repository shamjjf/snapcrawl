"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Alert, Button, Field, Input, Logo } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return;
    if (!email.trim() || !EMAIL_RE.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(undefined);
    setSubmitting(true);
    // Mock — no backend wired.
    window.setTimeout(() => {
      setSent(true);
      setSubmitting(false);
    }, 800);
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
              We&apos;ll email you a reset link.
            </p>
          </div>
        </header>

        {sent ? (
          <Alert tone="success">
            If an account exists for {email}, a reset link is on its way.
          </Alert>
        ) : (
          <form
            onSubmit={onSubmit}
            noValidate
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
          >
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
