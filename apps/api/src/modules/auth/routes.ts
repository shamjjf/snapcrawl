import { Router } from "express";
import { requireAuth } from "../../auth";
import { identityKey, ipEmailKey, rateLimit, sourceKey } from "../../middleware/rateLimit";
import {
  forgotPassword,
  login,
  logout,
  me,
  refresh,
  register,
  resendVerification,
  resetPassword,
  verifyEmail,
} from "./controller";

// /api/v1/auth — register/login issue an access token + set the refresh cookie;
// refresh rotates it; logout revokes it (FR-BE-001..004). The reset pair is
// public by necessity: someone who cannot log in cannot authenticate (FR-BE-005).

// ── Rate limits (FR-BE-007) ─────────────────────────────────────────────────
// These routes are unauthenticated, so limits key off the request itself. One
// key never covers a whole threat, so the risky routes get two: a per-target
// limit and a per-source limit answer different attacks, and an attacker has to
// beat both.
const MIN = 60_000;

/** Password guessing from one place at one account. The per-account lockout
 *  (5 strikes → 15 min) is what stops a DISTRIBUTED guess; this stops a fast
 *  local one before the lockout even has to fire. */
const loginPerIpEmail = rateLimit({
  limit: 10,
  windowMs: 15 * MIN,
  key: ipEmailKey,
  message: "Too many sign-in attempts. Please wait and try again.",
});

/** …and a cap per source, because the pair key alone has a hole: rotating the
 *  email gives a fresh bucket every request, so one host could spray logins
 *  across endless addresses unchecked — which is how you enumerate accounts and
 *  how you'd amplify any per-request work the handler does. Generous enough that
 *  a shared office NAT never notices. */
const loginPerIp = rateLimit({
  limit: 30,
  windowMs: 15 * MIN,
  key: sourceKey,
  message: "Too many sign-in attempts from this location. Please wait and try again.",
});

/**
 * forgot-password is the sharp one: public, unauthenticated, and it SENDS MAIL.
 * Unlimited, it is an amplifier — anyone can point it at any address and flood
 * that person's inbox, using our domain and reputation to do it.
 *
 * Two limits, because they close different holes:
 *  - identityKey caps how much mail ONE address can be sent from ANY source, so
 *    a botnet cannot flood a victim by spreading the requests across IPs. This
 *    is the one that actually protects the inbox.
 *  - sourceKey caps how many DIFFERENT addresses one source can hit, so a single
 *    host cannot spray a thousand victims with one message each — which the
 *    per-address cap alone would happily allow.
 */
const forgotPerEmail = rateLimit({
  limit: 3,
  windowMs: 15 * MIN,
  key: identityKey,
  message: "A reset link was already sent. Check your inbox, or try again shortly.",
});
const forgotPerIp = rateLimit({
  limit: 10,
  windowMs: 15 * MIN,
  key: sourceKey,
  message: "Too many reset requests. Please wait and try again.",
});

/** Reset tokens are 256-bit, so guessing is hopeless — but an unbounded public
 *  endpoint that does a DB lookup per call is still worth capping. */
const resetLimit = rateLimit({ limit: 10, windowMs: 15 * MIN, key: sourceKey });

/** Verify-email consumes a 256-bit token; same reasoning as resetLimit. */
const verifyLimit = rateLimit({ limit: 10, windowMs: 15 * MIN, key: sourceKey });

/** Resend-verification SENDS MAIL, so it is the same amplifier shape as
 *  forgot-password and gets the same paired defence: a per-address cap (protect
 *  the inbox across any source) and a per-source cap (stop one host spraying
 *  many addresses). See the forgot-password block for the full reasoning. */
const resendPerEmail = rateLimit({
  limit: 3,
  windowMs: 15 * MIN,
  key: identityKey,
  message: "A verification link was already sent. Check your inbox, or try again shortly.",
});
const resendPerIp = rateLimit({
  limit: 10,
  windowMs: 15 * MIN,
  key: sourceKey,
  message: "Too many verification requests. Please wait and try again.",
});

/** Stops one host mass-creating accounts. */
const registerLimit = rateLimit({ limit: 5, windowMs: 60 * MIN, key: sourceKey });

const router = Router();
router.post("/register", registerLimit, register);
router.post("/login", loginPerIp, loginPerIpEmail, login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.post("/forgot-password", forgotPerIp, forgotPerEmail, forgotPassword);
router.post("/reset-password", resetLimit, resetPassword);
// Email verification (FR-BE-008). Both public — an unverified user cannot
// authenticate, so these must be reachable without a session.
router.post("/verify-email", verifyLimit, verifyEmail);
router.post("/resend-verification", resendPerIp, resendPerEmail, resendVerification);
router.get("/me", requireAuth, me);

export default router;
