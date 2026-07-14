import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import type { User } from "@snapcrawl/shared";
import { toUser } from "../../auth";
import { ApiError } from "../../http/envelope";
import { hashToken } from "../../lib/tokens";
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
