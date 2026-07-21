"use client";

// Auth gate + current-user context for every authenticated (app) route.
// Centralises what each page used to do inline: read the bearer token, load
// /me once, redirect unauthenticated visitors to login (preserving where they
// were headed), and expose { user, logout } to the shell and pages.
//
// Silent access-token refresh (FR-AP-004) lives in lib/api.ts, at the transport
// layer, so it covers every call rather than just this one — an expired token
// here is refreshed and retried before it ever surfaces as an error.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { User } from "@snapcrawl/shared";
import { logout as apiLogout, me } from "@/lib/api";
import { clearToken, forceLogout, getToken, syncSessionCookie } from "@/lib/auth";
import { Alert, Button, Logo, Spinner } from "@/components/ui";

interface SessionValue {
  user: User;
  logout: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>.");
  return ctx;
}

type State = "loading" | "ready" | "error";

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // Capture the entry path for the login return-to without re-running the
  // /me load on every navigation.
  const entryPath = useRef(pathname);
  entryPath.current = pathname;

  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    const token = getToken();
    // The presence cookie is session-scoped, so reopening the browser drops it
    // while the token survives. Re-sync before anything else, or middleware
    // would bounce a perfectly valid session to login (FR-AP-002).
    syncSessionCookie();
    if (!token) {
      router.replace(`/login?next=${encodeURIComponent(entryPath.current)}`);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await me(token);
        if (!alive) return;
        setUser(res.user);
        setState("ready");
      } catch (err) {
        if (!alive) return;
        // A surfaced UNAUTHORIZED means the silent refresh already failed inside
        // request() — the token is unrecoverable. forceLogout is loop-guarded, so
        // this duplicate call is a no-op after the transport's own (FR-AP-004).
        if ((err as { code?: string })?.code === "UNAUTHORIZED") {
          forceLogout();
          return;
        }
        setState("error");
      }
    })();
    return () => {
      alive = false;
    };
    // Run once on entry to the authenticated area.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function logout() {
    // Revoke the refresh token server-side (FR-BE-004) — fire-and-forget, since
    // the cookie is what authenticates it, so clearing the local token first is
    // safe, and sign-out should never hang on a slow API.
    void apiLogout();
    clearToken();
    router.replace("/login");
  }

  if (state === "error") {
    return (
      <CenteredCard>
        <Alert tone="danger">
          Couldn&apos;t reach the API on :4000. Is it running?&nbsp;
          <code style={{ fontFamily: "var(--font-mono)" }}>npm run dev:api</code>
        </Alert>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </CenteredCard>
    );
  }

  if (state !== "ready" || !user) {
    return (
      <CenteredCard>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--color-text-muted)" }}>
          <Spinner /> Loading…
        </span>
      </CenteredCard>
    );
  }

  return (
    <SessionContext.Provider value={{ user, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

/** Full-viewport centered container for the pre-app loading / error states. */
function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "var(--space-4)",
        background: "var(--color-bg)",
      }}
    >
      <div
        className="card"
        style={{
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--space-4)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Logo size={24} />
          <strong style={{ fontSize: "var(--text-lg)", color: "var(--color-text)" }}>SnapCrawl</strong>
        </span>
        {children}
      </div>
    </main>
  );
}
