"use client";

// Create an account (FR-BE-001). The backend has had POST /auth/register since
// db3e675 with no page in front of it — the panel could only ever be entered by
// an account someone seeded or an admin created by hand (FR-BE-010).
//
// Registration signs you straight in: the API returns 201 { user, token } and
// sets the sc_refresh cookie in the same response, so there is no "now go and
// sign in" step to stage. Treat the 201 as a login — same setToken + replace as
// the login page, which is also what makes the sc_session cookie appear so the
// edge gate (proxy.ts) lets /dashboard through on the very first navigation.
//
// A note on enumeration, because it reads as inconsistent with its neighbour and
// isn't an oversight: /auth/forgot-password answers 204 for every address so it
// can't be used to discover who has an account, while this endpoint answers 409
// EMAIL_TAKEN and therefore does exactly that. That is inherent to registration
// rather than a bug — a signup form cannot both refuse duplicates and hide
// whether an address is a duplicate. Flagged to the backend lane as a judgement
// call to make deliberately, not one to fix here by inventing a vaguer error the
// panel would then have to lie about.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { registerSchema } from "@snapcrawl/shared";
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
import { register, toEnvelope } from "@/lib/api";
import { setToken } from "@/lib/auth";

type Errors = { name?: string; email?: string; password?: string; form?: string };

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  // Set when the deployment requires email verification (FR-BE-008): registration
  // succeeds but returns no session, so we show "check your inbox" rather than
  // redirect into an app the new account cannot use until it confirms.
  const [verifyNotice, setVerifyNotice] = useState(false);

  /** Validate with the same schema the API parses, so the two agree on what a
   *  name/address/password is and the client can't pass something the server
   *  will only reject after a round trip. */
  function validate(): Errors {
    const parsed = registerSchema.safeParse({
      name: name.trim(),
      email: email.trim(),
      password,
    });
    if (parsed.success) return {};
    const e: Errors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "name") e.name ??= "Enter your name.";
      else if (field === "email") e.email ??= "Enter a valid email address.";
      else if (field === "password") e.password ??= "Use at least 8 characters.";
    }
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return; // double-submit guard — a second POST would 409 itself
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    setSubmitting(true);
    try {
      const result = await register({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      // No token ⇒ verification is required (FR-BE-008). Stay on the page and
      // tell them to confirm their email before signing in.
      if (result.verificationRequired || !result.token) {
        setVerifyNotice(true);
        setSubmitting(false);
        return;
      }
      setToken(result.token);
      router.replace("/dashboard");
    } catch (err) {
      const env = toEnvelope(err);
      // A taken address is about one field, so it belongs on that field rather
      // than in a form-wide banner the user has to map back to an input.
      if (env.code === "EMAIL_TAKEN") setErrors({ email: "That email is already registered." });
      else setErrors({ form: env.message });
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
              Create your account
            </h1>
            <p className="muted" style={{ margin: "var(--space-1) 0 0", fontSize: "var(--text-sm)" }}>
              Set up a crawl workspace in a minute.
            </p>
          </div>
        </header>

        <form
          onSubmit={onSubmit}
          noValidate
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
        >
          {verifyNotice ? (
            <Alert tone="info">
              Almost there — we&apos;ve emailed a confirmation link to {email.trim()}. Verify your
              address, then sign in.
            </Alert>
          ) : null}
          {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}

          <Field label="Name" htmlFor="name" error={errors.name}>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              placeholder="Ada Lovelace"
              value={name}
              invalid={!!errors.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

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
                // `new-password`, not `current-password`: it tells a password
                // manager to offer to generate and store one rather than trying
                // to autofill an existing credential into a signup form.
                autoComplete="new-password"
                placeholder="At least 8 characters"
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

          <Button type="submit" variant="primary" size="lg" block loading={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </Button>
        </form>

        <p className="subtle" style={{ margin: 0, fontSize: "var(--text-sm)", textAlign: "center" }}>
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
