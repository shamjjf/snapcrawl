"use client";

// Set a new password from an emailed link (FR-AP-003, implementing FR-BE-005).
//
// This is the page the reset email points at — apps/api/src/lib/mailer.ts builds
// `${WEB_ORIGIN}/reset-password?token=<raw>`, so the route and the query param
// name are a contract with the mailer, not a free choice.
//
// The token is single-use and expires in an hour. Unknown, already-used and
// expired all return the same 400 INVALID_RESET_TOKEN — the API deliberately
// doesn't distinguish them, so neither does this page.
//
// No auto-login: the API revokes every session on reset and returns 204, so we
// send the user to sign in. That proves the new password works and keeps the
// endpoint free of session state.

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { resetPasswordSchema } from "@snapcrawl/shared";
import { Alert, Button, EyeIcon, EyeOffIcon, Field, Input, Logo } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { resetPassword, toEnvelope } from "@/lib/api";

type Errors = { password?: string; confirm?: string; form?: string };

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Errors>({});

  // A link with no token can't do anything — say so rather than showing a form
  // that is guaranteed to fail on submit.
  if (!token) {
    return (
      <>
        <Alert tone="danger">
          This reset link is incomplete. Request a new one — links work once and expire after
          an hour.
        </Alert>
        <Link href="/forgot-password" style={{ fontSize: "var(--text-sm)", textAlign: "center" }}>
          Request a new link
        </Link>
      </>
    );
  }

  function validate(): Errors {
    const e: Errors = {};
    // The shared schema owns the rule (min 8), so the client and the API agree.
    const parsed = resetPasswordSchema.safeParse({ token, password });
    if (!parsed.success) {
      e.password =
        parsed.error.issues.find((i) => i.path[0] === "password")?.message ??
        "Choose a longer password.";
    }
    if (confirm !== password) e.confirm = "Passwords don't match.";
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return; // double-submit guard: the token is single-use
    const found = validate();
    setErrors(found);
    if (found.password || found.confirm) return;

    setSubmitting(true);
    try {
      await resetPassword(token, password);
      // Signed out everywhere by the reset; prove the new password at sign-in.
      router.replace("/login?reset=1");
    } catch (err) {
      const env = toEnvelope(err);
      setErrors({
        form:
          env.code === "INVALID_RESET_TOKEN"
            ? "This reset link is invalid, already used, or expired. Request a new one."
            : env.message,
      });
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
    >
      {errors.form ? (
        <Alert tone="danger">
          {errors.form}{" "}
          <Link href="/forgot-password" style={{ whiteSpace: "nowrap" }}>
            Request a new link
          </Link>
        </Alert>
      ) : null}

      <Field label="New password" htmlFor="password" error={errors.password}>
        <div className="input-wrap">
          <Input
            id="password"
            type={showPw ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            invalid={!!errors.password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={showPw ? "Hide password" : "Show password"}
            onClick={() => setShowPw((v) => !v)}
          >
            {showPw ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
          </button>
        </div>
      </Field>

      <Field label="Confirm new password" htmlFor="confirm" error={errors.confirm}>
        <Input
          id="confirm"
          type={showPw ? "text" : "password"}
          autoComplete="new-password"
          value={confirm}
          invalid={!!errors.confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>

      <Button type="submit" variant="primary" size="lg" block loading={submitting}>
        {submitting ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
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
              Set a new password
            </h1>
            <p className="muted" style={{ margin: "var(--space-1) 0 0", fontSize: "var(--text-sm)" }}>
              Setting a new password signs you out everywhere else.
            </p>
          </div>
        </header>

        {/* useSearchParams needs a Suspense boundary to prerender this route. */}
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>

        <Link href="/login" style={{ fontSize: "var(--text-sm)", textAlign: "center" }}>
          ← Back to sign in
        </Link>
      </div>
    </main>
  );
}
