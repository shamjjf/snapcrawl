import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import type { User } from "@snapcrawl/shared";
import { hashPassword, toUser } from "../../auth";
import { envFlag } from "../../config/env";
import { ApiError } from "../../http/envelope";
import { hashToken } from "../../lib/tokens";
import { EmailVerificationModel } from "../../models/emailVerification";
import { PasswordResetModel } from "../../models/passwordReset";
import { RefreshTokenModel } from "../../models/refreshToken";
import { UserModel } from "../../models/user";

// Refresh-token rotation with reuse detection (FR-BE-002/003/004).
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type RefreshStatus = "not-found" | "revoked" | "reuse" | "expired" | "valid";

/** Classify a presented refresh token (pure, so the rotation logic is testable).
 *  Order matters: a revoked family wins over reuse; an already-used token is
 *  reuse (its successor is the only valid one). */
export function classifyRefreshToken(
  doc: { usedAt?: Date | null; revokedAt?: Date | null; expiresAt?: Date | null } | null,
  now: Date,
): RefreshStatus {
  if (!doc) return "not-found";
  if (doc.revokedAt) return "revoked";
  if (doc.usedAt) return "reuse";
  if (doc.expiresAt && doc.expiresAt.getTime() <= now.getTime()) return "expired";
  return "valid";
}

export function generateRefreshRaw(): string {
  return randomBytes(32).toString("base64url");
}

/** Mint a refresh token in a NEW family (login/register). */
export async function issueRefreshFamily(
  userId: string,
  now: Date,
): Promise<{ raw: string; expiresAt: Date }> {
  const raw = generateRefreshRaw();
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  await RefreshTokenModel.create({
    userId,
    familyId: new Types.ObjectId(),
    tokenHash: hashToken(raw),
    expiresAt,
  });
  return { raw, expiresAt };
}

/** Rotate a presented refresh token. Reuse of an already-rotated token revokes
 *  the whole family and 401s (FR-BE-003). The "claim" is a single atomic
 *  findOneAndUpdate so two concurrent uses of one token can't both win — exactly
 *  one rotates; the loser falls into the reuse path. (A benign simultaneous
 *  multi-tab refresh therefore fails closed: one tab wins, the other trips reuse
 *  and the family is revoked — secure, and rare for a well-behaved client.) */
export async function rotateRefreshToken(
  rawToken: string,
  now: Date,
): Promise<{ user: User; raw: string; expiresAt: Date }> {
  const tokenHash = hashToken(rawToken);

  // Atomically claim: only ONE request can flip usedAt from null.
  const claimed = await RefreshTokenModel.findOneAndUpdate(
    { tokenHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: false },
  );

  if (!claimed) {
    // We didn't win the claim — determine why (reuse ⇒ revoke the family).
    const existing = await RefreshTokenModel.findOne({ tokenHash });
    if (classifyRefreshToken(existing, now) === "reuse" && existing) {
      await RefreshTokenModel.updateMany(
        { familyId: existing.familyId },
        { $set: { revokedAt: now } },
      );
      throw new ApiError(401, "TOKEN_REUSE", "Refresh token reuse detected; session revoked.");
    }
    throw new ApiError(401, "INVALID_REFRESH", "Invalid or expired refresh token.");
  }

  const user = await UserModel.findById(claimed.userId);
  if (!user || user.status === "deactivated") {
    throw new ApiError(401, "INVALID_REFRESH", "Account unavailable.");
  }

  const raw = generateRefreshRaw();
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  await RefreshTokenModel.create({
    userId: claimed.userId,
    familyId: claimed.familyId,
    tokenHash: hashToken(raw),
    expiresAt,
  });
  return { user: toUser(user), raw, expiresAt };
}

/** Revoke the presented refresh token (logout, FR-BE-004). */
export async function revokeRefreshToken(rawToken: string, now: Date): Promise<void> {
  await RefreshTokenModel.updateOne(
    { tokenHash: hashToken(rawToken), revokedAt: null },
    { $set: { revokedAt: now } },
  );
}

// ── Login timing (FR-BE-007 / NFR-010) ──────────────────────────────────────

/**
 * A real bcrypt hash, at the real cost, of a password nobody knows.
 *
 * Login used to answer in 17 ms for an address with no account and 604 ms for a
 * real one — a 35× gap, because only the real path ran bcrypt. The bodies were
 * identical and the statuses were identical, but the clock told you which
 * addresses were registered, which is exactly the question forgot-password's
 * always-204 design refuses to answer. An attacker just asked login instead.
 *
 * Comparing against this burns the same ~600 ms on the paths that have no hash
 * to check. Derived from `hashPassword`, not a pasted constant, so it can never
 * drift out of step with BCRYPT_COST — a stale cost here would silently re-open
 * the gap. Generated per process: an attacker who somehow learned this string
 * still cannot use it (`verifyPassword` returns false whenever `hash` is absent,
 * regardless of what the compare says).
 *
 * Costs ~600 ms once at import. That is a boot cost, not a request cost.
 */
const DUMMY_HASH = hashPassword(randomBytes(32).toString("base64url"));

/**
 * Check a password against a hash that may not exist, in the same time either
 * way. `null` hash ⇒ still one full bcrypt compare, then an unconditional false.
 *
 * The `Boolean(hash) &&` is not defensive noise: without it, a caller passing
 * null would be one improbable collision away from authenticating as nobody.
 * The compare's result on the dummy path must never be able to matter.
 */
export async function verifyPassword(
  plain: string,
  hash: string | null | undefined,
): Promise<boolean> {
  const match = await bcrypt.compare(plain, hash || DUMMY_HASH);
  return Boolean(hash) && match;
}

// ── Brute-force lockout (FR-BE-007) ─────────────────────────────────────────

/** Lock an account after this many CONSECUTIVE failed logins. */
export const MAX_FAILED_LOGINS = 5;
/** How long the lock holds (FR-BE-007: 15 minutes). */
export const LOCK_DURATION_MS = 15 * 60 * 1000;
export const LOCK_DURATION_MIN = LOCK_DURATION_MS / 60_000;

/** Is this account currently locked out? Pure. Takes the field rather than the
 *  document so it stays free of Mongoose types. */
export function isLockedOut(lockedUntil: Date | null | undefined, now: Date): boolean {
  return Boolean(lockedUntil && lockedUntil.getTime() > now.getTime());
}

export interface FailedLoginOutcome {
  /** Set when this failure crossed the threshold — the caller emails the user. */
  lockedUntil: Date | null;
  justLocked: boolean;
}

/**
 * Decide what a failed login does, given the attempt count AFTER incrementing.
 * Pure — the caller owns the atomic $inc and the clock.
 *
 * `>=` not `===`: an account already at the threshold that somehow takes another
 * failure must re-lock rather than sail through on an off-by-one.
 */
export function onFailedLogin(attemptsAfterInc: number, now: Date): FailedLoginOutcome {
  if (attemptsAfterInc >= MAX_FAILED_LOGINS) {
    return { lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS), justLocked: true };
  }
  return { lockedUntil: null, justLocked: false };
}

// ── Password reset (FR-BE-005) ──────────────────────────────────────────────

/** Single-use, time-limited reset window (FR-BE-005: 60 min). */
export const RESET_TTL_MS = 60 * 60 * 1000;
export const RESET_TTL_MIN = RESET_TTL_MS / 60_000;

export type ResetStatus = "not-found" | "used" | "expired" | "valid";

/** Classify a presented reset token. Pure, so the rules are readable in one
 *  place: an already-used token is dead, and so is an expired one. */
export function classifyResetToken(
  doc: { usedAt?: Date | null; expiresAt?: Date | null } | null,
  now: Date,
): ResetStatus {
  if (!doc) return "not-found";
  if (doc.usedAt) return "used";
  if (doc.expiresAt && doc.expiresAt.getTime() <= now.getTime()) return "expired";
  return "valid";
}

/** Mint a reset token for a user. Returns the RAW token — the only time it
 *  exists un-hashed — for the email. Only its hash is stored. */
export async function issueResetToken(
  userId: string,
  now: Date,
): Promise<{ raw: string; expiresAt: Date }> {
  const raw = generateRefreshRaw();
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
  await PasswordResetModel.create({ userId, tokenHash: hashToken(raw), expiresAt });
  return { raw, expiresAt };
}

/**
 * Consume a reset token and return whose account it unlocks.
 *
 * The claim is a single atomic findOneAndUpdate, exactly like refresh rotation:
 * two clicks on the same emailed link race, and only one may win. A
 * read-then-write would let both through, and "single-use" would be a comment
 * rather than a property.
 */
export async function consumeResetToken(rawToken: string, now: Date): Promise<string> {
  const tokenHash = hashToken(rawToken);
  const claimed = await PasswordResetModel.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: false },
  );
  if (!claimed) {
    // Deliberately one error for every failure mode (unknown / used / expired):
    // distinguishing them would tell an attacker which guesses are real tokens.
    throw new ApiError(400, "INVALID_RESET_TOKEN", "This reset link is invalid or has expired.");
  }
  return String(claimed.userId);
}

/** Revoke every live refresh token for a user — every session, everywhere.
 *  Used on password change (FR-BE-011): changing a password is the standard
 *  response to a suspected compromise, so a stolen refresh token must not
 *  survive it by rotating indefinitely. */
export async function revokeUserRefreshTokens(userId: string, now: Date): Promise<number> {
  const r = await RefreshTokenModel.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  return r.modifiedCount;
}

// ── Email verification (FR-BE-008) ──────────────────────────────────────────

/** How long a verification link stays valid (24 h — longer than a reset, since
 *  a new user may not act immediately, and the stakes are lower). */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const VERIFY_TTL_MIN = VERIFY_TTL_MS / 60_000;

/**
 * Is email verification REQUIRED to log in on this deployment? (FR-BE-008 —
 * "may require".) Off unless REQUIRE_EMAIL_VERIFICATION=true, and deliberately
 * so: a Could-priority gate that defaulted on would lock every existing user out
 * the moment it shipped, and break the demo seed. Read at call time.
 */
export function emailVerificationRequired(): boolean {
  return envFlag("REQUIRE_EMAIL_VERIFICATION");
}

/**
 * Accounts created before this instant are grandfathered past the verification
 * gate — the feature did not exist then, so they never had a link to click and
 * blocking them would be punishing users for the feature's own absence.
 *
 * Defaults to this feature's ship date; an operator who wants to force EVERY
 * account (even old ones) to verify can move it earlier via
 * EMAIL_VERIFICATION_GRANDFATHER_BEFORE, or disable grandfathering with a very
 * old date. Invalid/absent ⇒ the ship-date default.
 */
export const EMAIL_VERIFICATION_SHIP_DATE = new Date("2026-07-16T00:00:00.000Z");

export function grandfatherBefore(): Date {
  const raw = process.env.EMAIL_VERIFICATION_GRANDFATHER_BEFORE;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return EMAIL_VERIFICATION_SHIP_DATE;
}

/**
 * May this user sign in, given the verification policy? Pure.
 *
 * Grandfathering is the subtle part. When the gate is on, an account with no
 * `emailVerifiedAt` is blocked — EXCEPT one created before the feature existed,
 * which never had a chance to verify and whose absent field means "unknown", not
 * "refused". `createdBefore` (the feature's rollout instant) draws that line:
 * newer accounts must verify, older ones are trusted as they were before.
 */
export function mayLogIn(
  user: { emailVerifiedAt?: Date | null; createdAt?: Date },
  opts: { required: boolean; grandfatherBefore?: Date },
): boolean {
  if (!opts.required) return true;
  if (user.emailVerifiedAt) return true;
  if (opts.grandfatherBefore && user.createdAt && user.createdAt < opts.grandfatherBefore) {
    return true;
  }
  return false;
}

/** Mint a verification token for a user. Returns the RAW token for the email;
 *  only its hash is stored. Mirrors issueResetToken exactly. */
export async function issueVerificationToken(
  userId: string,
  now: Date,
): Promise<{ raw: string; expiresAt: Date }> {
  const raw = generateRefreshRaw();
  const expiresAt = new Date(now.getTime() + VERIFY_TTL_MS);
  await EmailVerificationModel.create({ userId, tokenHash: hashToken(raw), expiresAt });
  return { raw, expiresAt };
}

/**
 * Consume a verification token and return whose email it confirms. Atomic
 * single-use claim, identical to consumeResetToken: two clicks on the link race
 * and only one wins, and unknown/used/expired are one indistinguishable error.
 */
export async function consumeVerificationToken(rawToken: string, now: Date): Promise<string> {
  const tokenHash = hashToken(rawToken);
  const claimed = await EmailVerificationModel.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: false },
  );
  if (!claimed) {
    throw new ApiError(400, "INVALID_VERIFICATION_TOKEN", "This link is invalid or has expired.");
  }
  return String(claimed.userId);
}
