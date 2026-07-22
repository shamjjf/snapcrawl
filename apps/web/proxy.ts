import { NextResponse, type NextRequest } from "next/server";

// Edge route protection (FR-AP-002): unauthenticated visitors are redirected to
// /login and returned to where they were headed once they sign in.
//
// This is Next 16's `proxy.ts` convention — the old `middleware.ts` filename
// still runs but warns "deprecated, please use proxy" on every build. Same edge
// runtime, same request/response API; only the file and export names changed.
//
// ── What this is, and what it deliberately is not ──────────────────────────
// This gates on `sc_session`, a non-secret marker the panel writes alongside the
// access token (lib/auth.ts). It is a NAVIGATION gate, not a security boundary,
// and it cannot be anything more:
//
//   * The real session cookie, `sc_refresh`, is scoped `Path=/api/v1/auth` and
//     lives on the API's origin — the browser never sends it to `/dashboard`, so
//     the edge genuinely cannot see it. (Verified: `GET /dashboard` carries no
//     Cookie header.)
//   * The access token lives in localStorage, which the edge cannot read either.
//
// So the edge can know "a session was established here" but never "this session
// is still valid". That is fine, because it isn't what protects the
// data: every page fetches with a bearer the API validates on each request
// (FR-AP-072), and a revoked session is caught by the transport's refresh →
// forceLogout path (FR-AP-004). This just spares an unauthenticated visitor the
// flash of an empty app shell before the client gate reaches the same verdict.
//
// A stale cookie (present, session actually revoked) is self-correcting: the
// page renders, its first API call 401s, and forceLogout clears both.

// The reset pages must stay public: someone who has forgotten their password is
// by definition signed out, and /reset-password is opened from an emailed link
// (FR-AP-003 / FR-BE-005). /register is public for the obvious reason — it is how
// an account comes to exist in the first place (FR-BE-001).
const PUBLIC_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"];

// …but "public" and "signed-out only" are not the same thing, and the difference
// matters here. These two are the ways IN, so a signed-in visitor is just lost and
// gets sent to the dashboard. The password pages deliberately stay reachable while
// signed in: a reset link is opened from an email, in whatever browser happens to
// have the session, and must work regardless of what cookie that browser holds.
const SIGNED_OUT_ONLY = ["/login", "/register"];

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const signedIn = req.cookies.get("sc_session")?.value === "1";
  if (PUBLIC_PATHS.includes(pathname)) {
    if (
      signedIn &&
      SIGNED_OUT_ONLY.includes(pathname) &&
      !req.nextUrl.searchParams.has("expired")
    ) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  if (signedIn) return NextResponse.next();

  // Preserve where they were headed, matching the client gate's contract so the
  // two produce identical URLs (SessionProvider + login's nextTarget()).
  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next internals, the favicon, and static assets. `/` is
  // excluded too: app/page.tsx already redirects it to /login, so gating it
  // would only add a hop. `api/` is excluded because in single-domain deploys
  // the next.config rewrites proxy /api/v1/* to the API on this same origin —
  // those are bearer-authenticated data requests the API itself guards
  // (FR-AP-072); redirecting them to /login turns a fetch into a 405.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$|$).*)"],
};
