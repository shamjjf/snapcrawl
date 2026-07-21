"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  EyeIcon,
  EyeOffIcon,
  Field,
  Input,
  Logo,
} from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { login, type ApiError } from "@/lib/api";
import { clearToken, getToken, setToken } from "@/lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Errors = { email?: string; password?: string; form?: string };

/** Why we're showing the sign-in form with something to say.
 *  "expired" is a routine timeout; "reuse" means the backend revoked the whole
 *  token family, so every other tab and device was signed out at the same moment
 *  — worth saying plainly rather than passing off as an ordinary timeout.
 *  "reset" is the happy path back from /reset-password (FR-AP-003). */
type Notice = "expired" | "reuse" | "reset" | null;

/** Where to send the user after login: an internal `?next=` path or the
 *  dashboard. Rejects external/protocol-relative URLs (open-redirect guard). */
function nextTarget(): string {
  if (typeof window === "undefined") return "/dashboard";
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/dashboard";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<Notice>(null);

  // Already signed in? Skip the form. Also surface why the session ended
  // (FR-AP-004, ?expired=1) or that a reset just succeeded (FR-AP-003, ?reset=1).
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    // A completed reset revokes every session, so a stale token here is dead —
    // clear it rather than bouncing them to a dashboard that will 401.
    if (qs.get("reset") === "1") {
      clearToken();
      setNotice("reset");
      return;
    }
    if (getToken()) {
      router.replace(nextTarget());
      return;
    }
    if (qs.get("expired") !== "1") return;
    setNotice(qs.get("reason") === "reuse" ? "reuse" : "expired");
  }, [router]);

  function validate(): Errors {
    const e: Errors = {};
    if (!email.trim()) e.email = "Email is required.";
    else if (!EMAIL_RE.test(email)) e.email = "Enter a valid email address.";
    if (!password) e.password = "Password is required.";
    else if (password.length < 6)
      e.password = "Password must be at least 6 characters.";
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return; // double-submit guard (FR-AP-001)
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    setSubmitting(true);
    try {
      const { token } = await login(email.trim(), password);
      setToken(token);
      router.replace(nextTarget());
    } catch (err) {
      const message = (err as ApiError)?.message ?? "Something went wrong.";
      setErrors({ form: message });
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
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(70% 55% at 50% -5%, var(--color-primary-subtle-bg), transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "absolute", top: "var(--space-4)", right: "var(--space-4)" }}>
        <ThemeToggle />
      </div>

      <div
        className="card"
        style={{
          position: "relative",
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
              Sign in
            </h1>
            <p className="muted" style={{ margin: "var(--space-1) 0 0", fontSize: "var(--text-sm)" }}>
              Access your crawl workspace.
            </p>
          </div>
        </header>

        <form
          onSubmit={onSubmit}
          noValidate
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
        >
          {notice === "reset" ? (
            <Alert tone="success">
              Password updated. Sign in with your new password.
            </Alert>
          ) : null}
          {notice === "expired" ? (
            <Alert tone="info">Your session expired. Please sign in again.</Alert>
          ) : null}
          {notice === "reuse" ? (
            <Alert tone="danger">
              We ended your session for security, because your sign-in token was
              used more than once. Any other tabs or devices were signed out too.
              Please sign in again.
            </Alert>
          ) : null}
          {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}

          <Field label="Email" htmlFor="email" error={errors.email}>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              invalid={!!errors.email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="Password" htmlFor="password" error={errors.password}>
            <div className="input-wrap">
              <Input
                id="password"
                type={showPw ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                invalid={!!errors.password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ paddingRight: 40 }}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={showPw ? "Hide password" : "Show password"}
                onClick={() => setShowPw((s) => !s)}
              >
                {showPw ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
              </button>
            </div>
          </Field>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Link href="/forgot-password" style={{ fontSize: "var(--text-sm)" }}>
              Forgot password?
            </Link>
          </div>

          <Button type="submit" variant="primary" size="lg" block loading={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="subtle" style={{ margin: 0, fontSize: "var(--text-sm)", textAlign: "center" }}>
          New to SnapCrawl? <Link href="/register">Create an account</Link>
        </p>

        <p
          className="subtle"
          style={{ margin: 0, fontSize: "var(--text-xs)", textAlign: "center" }}
        >
          Demo:{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>admin@snapcrawl.dev</code>{" "}
          / <code style={{ fontFamily: "var(--font-mono)" }}>password</code>
        </p>
      </div>
    </main>
  );
}
