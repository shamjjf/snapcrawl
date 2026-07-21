import type { Request, Response } from "express";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@snapcrawl/shared";
import {
  hashPassword,
  signAccessToken,
  signToken,
  toUser,
  type AuthedRequest,
} from "../../auth";
import { ApiError } from "../../http/envelope";
import { asyncHandler, parseInput, requireUser } from "../../http/validate";
import { recordAudit } from "../../lib/audit";
import { errorFields, log } from "../../lib/logger";
import {
  accountLockedMail,
  passwordResetMail,
  sendMail,
  verifyEmailMail,
} from "../../lib/mailer";
import { UserModel, type UserDoc } from "../../models/user";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "./cookies";
import {
  LOCK_DURATION_MIN,
  RESET_TTL_MIN,
  VERIFY_TTL_MIN,
  consumeResetToken,
  consumeVerificationToken,
  emailVerificationRequired,
  grandfatherBefore,
  isLockedOut,
  issueRefreshFamily,
  issueResetToken,
  issueVerificationToken,
  mayLogIn,
  onFailedLogin,
  revokeRefreshToken,
  revokeUserRefreshTokens,
  rotateRefreshToken,
  verifyPassword,
} from "./service";

/** Issue a verification token and email the link (FR-BE-008). Best-effort mail:
 *  in dev with no SMTP it logs; in prod `sendMail` throws, which the caller
 *  either surfaces (register) or swallows off-response (resend). */
async function sendVerificationEmail(user: UserDoc, req: Request): Promise<void> {
  const { raw } = await issueVerificationToken(String(user._id), new Date());
  await sendMail(verifyEmailMail(user.email, raw, VERIFY_TTL_MIN));
  await recordAudit({
    action: "auth.email.verification.request",
    userId: String(user._id),
    targetType: "user",
    targetId: String(user._id),
    req,
  });
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const body = parseInput(registerSchema, req.body);
  const exists = await UserModel.findOne({ email: body.email.toLowerCase() });
  if (exists) throw new ApiError(409, "EMAIL_TAKEN", "That email is already registered.");

  const user = await UserModel.create({
    name: body.name,
    email: body.email,
    passwordHash: hashPassword(body.password),
    role: "member",
    status: "active",
  });

  // When verification is required, registration must NOT sign the user in
  // (FR-BE-008): no access token, no refresh cookie. It sends the link and tells
  // the panel to show "check your inbox". Otherwise the account is signed in the
  // instant it exists, exactly as before — the default path is unchanged.
  if (emailVerificationRequired()) {
    await sendVerificationEmail(user, req);
    res.status(201).json({ user: toUser(user), verificationRequired: true });
    return;
  }

  const { raw, expiresAt } = await issueRefreshFamily(String(user._id), new Date());
  setRefreshCookie(res, raw, expiresAt);
  res.status(201).json({ user: toUser(user), token: signToken(user), verificationRequired: false });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const body = parseInput(loginSchema, req.body);
  const email = body.email.toLowerCase();
  const now = new Date();
  const user = await UserModel.findOne({ email });

  /** Every rejection gives ONE indistinguishable answer. Unknown email, wrong
   *  password, deactivated, locked — all 401 INVALID_CREDENTIALS. Anything more
   *  specific is an oracle: it would confirm which addresses have accounts, and
   *  a distinct "locked" reply would tell an attacker their guessing is working.
   *  The locked-out user learns by email (FR-BE-007) — a channel only the real
   *  owner of the account can read. */
  const auditFailure = async (): Promise<void> => {
    await recordAudit({
      action: "auth.login.failure",
      userId: user ? String(user._id) : null,
      targetType: "user",
      targetId: email,
      req,
    });
  };
  const invalid = (): ApiError =>
    new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");

  /**
   * ONE bcrypt compare, on every path, before any branch reads its result
   * (NFR-010). Unknown address, deactivated, locked, wrong password — all pay
   * the same ~600 ms, so the response time stops being an oracle for which
   * addresses have accounts.
   *
   * `verifyPassword` burns a compare against a dummy hash when there is no real
   * one, which is why this can be hoisted above the `!user` check at all.
   */
  const passwordOk = await verifyPassword(body.password, user?.passwordHash);

  if (!user || user.status === "deactivated") {
    await auditFailure();
    throw invalid();
  }

  // Refuse a locked account BEFORE the password is allowed to matter
  // (FR-BE-007). The order is load-bearing: reporting the lock only after a
  // *successful* verify would tell an attacker the exact moment they guessed
  // right — the one thing the lockout exists to deny them. The compare above
  // has already run; its result is discarded here, deliberately.
  if (isLockedOut(user.lockedUntil, now)) {
    await auditFailure();
    throw invalid();
  }

  if (!passwordOk) {
    // Atomic $inc — two simultaneous wrong guesses must both count, which a
    // read-modify-write through the hydrated doc would not guarantee.
    const failed = await UserModel.findOneAndUpdate(
      { _id: user._id },
      { $inc: { failedLoginAttempts: 1 } },
      { new: true, projection: { failedLoginAttempts: 1, email: 1 } },
    );
    const outcome = onFailedLogin(failed?.failedLoginAttempts ?? 1, now);
    if (outcome.justLocked && outcome.lockedUntil) {
      await UserModel.updateOne({ _id: user._id }, { $set: { lockedUntil: outcome.lockedUntil } });
      await recordAudit({
        action: "auth.account.locked",
        userId: String(user._id),
        targetType: "user",
        targetId: String(user._id),
        req,
      });
      // Off the response path entirely, not merely wrapped in try/catch. An
      // awaited send would restore the oracle we just closed one line up: only
      // a REAL account can reach this branch, so an SMTP round trip here would
      // make the 5th attempt on a real address visibly slower than the 5th on a
      // fictional one. The lock is already durable; the notice is best-effort.
      // (`void p.catch(...)` is the house fire-and-forget idiom — see
      // lib/thumbnails.ts. Not a floating promise: the rejection is handled.)
      void sendMail(accountLockedMail(user.email, LOCK_DURATION_MIN, req.ip ?? null)).catch(
        (err: unknown) => {
          log.warn("account-locked notice failed to send", {
            userId: String(user._id),
            ...errorFields(err),
          });
        },
      );
    }
    await auditFailure();
    throw invalid();
  }

  // Email-verification gate (FR-BE-008), checked ONLY after the password is
  // confirmed. The order matters as much as the lockout's did: a "verify your
  // email" answer reveals the account exists, so it must be unreachable without
  // the correct password — a stranger guessing still gets the generic 401 from
  // the block above, and only the real owner ever sees this. The streak is NOT
  // cleared here: the credentials were right, but this is not a completed login.
  if (!mayLogIn(user, { required: emailVerificationRequired(), grandfatherBefore: grandfatherBefore() })) {
    await recordAudit({
      action: "auth.login.failure",
      userId: String(user._id),
      targetType: "user",
      targetId: String(user._id),
      req,
    });
    throw new ApiError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Verify your email address before signing in — check your inbox for the confirmation link.",
    );
  }

  // Success clears the streak — the threshold counts CONSECUTIVE failures, so a
  // user who mistypes a few times over months is never locked out.
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { lastLoginAt: now, failedLoginAttempts: 0 }, $unset: { lockedUntil: 1 } },
  );
  await recordAudit({
    action: "auth.login.success",
    userId: String(user._id),
    targetType: "user",
    targetId: String(user._id),
    req,
  });
  const { raw, expiresAt } = await issueRefreshFamily(String(user._id), now);
  setRefreshCookie(res, raw, expiresAt);
  res.json({ user: toUser(user), token: signToken(user) });
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const raw = readRefreshCookie(req);
  if (!raw) throw new ApiError(401, "NO_REFRESH", "No refresh token.");
  try {
    const { user, raw: nextRaw, expiresAt } = await rotateRefreshToken(raw, new Date());
    setRefreshCookie(res, nextRaw, expiresAt);
    res.json({ user, token: signAccessToken(user.id, user.role) });
  } catch (err) {
    // On any refresh failure the cookie is useless — clear it.
    clearRefreshCookie(res);
    throw err;
  }
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const raw = readRefreshCookie(req);
  if (raw) await revokeRefreshToken(raw, new Date());
  clearRefreshCookie(res);
  res.status(204).end();
});

export const me = (req: AuthedRequest, res: Response): void => {
  res.json({ user: requireUser(req) });
};

/**
 * Do the actual reset work for one address. Runs AFTER the response, so nothing
 * it does — a DB write, a slow SMTP handshake, an outright mail failure — can be
 * timed from outside. See `forgotPassword`.
 */
async function deliverPasswordReset(email: string, req: Request): Promise<void> {
  const user = await UserModel.findOne({ email });

  // Deactivated accounts get no reset link — resetting a password must not be a
  // way to walk an account back to usable (that is an admin action, FR-BE-010).
  if (user && user.status !== "deactivated") {
    const { raw } = await issueResetToken(String(user._id), new Date());
    await sendMail(passwordResetMail(user.email, raw, RESET_TTL_MIN));
    await recordAudit({
      action: "auth.password.reset.request",
      userId: String(user._id),
      targetType: "user",
      targetId: String(user._id),
      req,
    });
  } else {
    // Still record the attempt: repeated resets aimed at addresses that do not
    // exist is exactly the pattern an audit trail should surface (FR-BE-012).
    await recordAudit({
      action: "auth.password.reset.request",
      userId: null,
      targetType: "user",
      targetId: email,
      req,
    });
  }
}

/**
 * POST /auth/forgot-password — email a single-use, 60-minute reset link
 * (FR-BE-005).
 *
 * ALWAYS 204, whether or not the address exists. The response must not reveal
 * which emails have accounts: this endpoint is public and unauthenticated, so a
 * distinguishable answer turns it into a free user-enumeration oracle.
 *
 * "Indistinguishable" has to include the clock, which is why the work happens
 * after the response rather than before it. A real address costs a token insert
 * plus an SMTP round trip; a fictional one costs neither. Awaiting that would
 * have made this endpoint answer 204-fast for strangers and 204-slow for
 * customers, which is the same oracle written in latency instead of in JSON.
 *
 * The trade: a caller cannot distinguish "queued" from "the mailer is down".
 * That is correct here — this endpoint is REQUIRED to be uninformative, and
 * failures are logged for the operator, who is the one who can act on them.
 */
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const body = parseInput(forgotPasswordSchema, req.body);
  const email = body.email.toLowerCase();

  res.status(204).end();

  void deliverPasswordReset(email, req).catch((err: unknown) => {
    log.error("password reset delivery failed", { ...errorFields(err) });
  });
});

/**
 * POST /auth/reset-password — consume the token and set a new password
 * (FR-BE-005).
 */
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const body = parseInput(resetPasswordSchema, req.body);
  const now = new Date();
  // Atomic single-use claim; throws 400 for unknown/used/expired alike.
  const userId = await consumeResetToken(body.token, now);

  const user = await UserModel.findById(userId);
  if (!user || user.status === "deactivated") {
    throw new ApiError(400, "INVALID_RESET_TOKEN", "This reset link is invalid or has expired.");
  }
  user.passwordHash = hashPassword(body.password);
  await user.save();
  // Clear any brute-force lockout: the account-locked email points the user
  // here, so a reset must actually restore access rather than leave them shut
  // out for the rest of the window (FR-BE-007). Proving control of the mailbox
  // is strictly stronger evidence than waiting 15 minutes.
  await UserModel.updateOne(
    { _id: userId },
    { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: 1 } },
  );

  // Whoever held the old password loses every session — the whole point of a
  // reset is that the previous holder is locked out (FR-BE-003).
  await revokeUserRefreshTokens(userId, now);
  await recordAudit({
    action: "auth.password.reset.complete",
    userId,
    targetType: "user",
    targetId: userId,
    req,
  });
  // No auto-login: the panel sends them to the sign-in page (FR-AP-003), which
  // proves the new password works and keeps this endpoint free of session state.
  res.status(204).end();
});

/**
 * POST /auth/verify-email — consume the emailed token and mark the address
 * confirmed (FR-BE-008).
 *
 * Idempotent: a second click on the link (or a user who was already verified
 * before this token) still succeeds with 204 rather than erroring — the goal is
 * "this address is confirmed", and it is.
 */
export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const body = parseInput(verifyEmailSchema, req.body);
  const userId = await consumeVerificationToken(body.token, new Date());

  const user = await UserModel.findById(userId);
  if (!user || user.status === "deactivated") {
    throw new ApiError(400, "INVALID_VERIFICATION_TOKEN", "This link is invalid or has expired.");
  }
  if (!user.emailVerifiedAt) {
    await UserModel.updateOne({ _id: userId }, { $set: { emailVerifiedAt: new Date() } });
    await recordAudit({
      action: "auth.email.verified",
      userId,
      targetType: "user",
      targetId: userId,
      req,
    });
  }
  res.status(204).end();
});

/** The work behind resend-verification, run AFTER the response for the same
 *  timing reason as forgot-password: a real, unverified account costs a token
 *  insert plus an SMTP round trip, and awaiting that would make the 204 slower
 *  for real addresses than fictional ones — an enumeration oracle in latency. */
async function deliverVerification(email: string, req: Request): Promise<void> {
  const user = await UserModel.findOne({ email });
  // Nothing to do for unknown, deactivated, or already-verified accounts — and
  // crucially the response never distinguished them anyway.
  if (user && user.status !== "deactivated" && !user.emailVerifiedAt) {
    await sendVerificationEmail(user, req);
  }
}

/**
 * POST /auth/resend-verification — re-send the confirmation link (FR-BE-008).
 *
 * ALWAYS 204, whether or not the address exists or is already verified — the
 * same anti-enumeration contract as forgot-password, and the same after-response
 * delivery so the clock cannot be read as an oracle either.
 */
export const resendVerification = asyncHandler(async (req: Request, res: Response) => {
  const body = parseInput(resendVerificationSchema, req.body);
  const email = body.email.toLowerCase();

  res.status(204).end();

  void deliverVerification(email, req).catch((err: unknown) => {
    log.error("verification resend failed", { ...errorFields(err) });
  });
});
