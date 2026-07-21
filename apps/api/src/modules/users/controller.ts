import type { Response } from "express";
import bcrypt from "bcryptjs";
import {
  meUpdateSchema,
  userCreateSchema,
  userListQuerySchema,
  userUpdateSchema,
} from "@snapcrawl/shared";
import { hashPassword, type AuthedRequest } from "../../auth";
import { ApiError } from "../../http/envelope";
import { buildPage } from "../../http/pagination";
import { asyncHandler, idParam, parseInput, requireUser } from "../../http/validate";
import { recordAudit } from "../../lib/audit";
import { ApiTokenModel } from "../../models/apiToken";
import { UserModel } from "../../models/user";
import { setRefreshCookie } from "../auth/cookies";
import { issueRefreshFamily, revokeUserRefreshTokens } from "../auth/service";
import { serializeUser, userListFilter } from "./service";

// FR-BE-001: passwords hashed with bcrypt, cost ≥ 12.
const BCRYPT_COST = 12;

// ── Self-service (FR-BE-011) — any signed-in user, no admin role ────────────

// GET /users/me — the caller's own profile.
export const getMe = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const actor = requireUser(req);
  const doc = await UserModel.findById(actor.id);
  if (!doc) throw new ApiError(404, "NOT_FOUND", "User not found.");
  res.json(serializeUser(doc));
});

// PATCH /users/me — change your own name and/or password (FR-BE-011). A new
// password requires the current one; role and status are deliberately NOT
// settable here (that is admin-only, FR-BE-010) — meUpdateSchema won't parse
// them, so privilege escalation isn't expressible.
export const updateMe = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const actor = requireUser(req);
  const body = parseInput(meUpdateSchema, req.body);

  const doc = await UserModel.findById(actor.id);
  if (!doc) throw new ApiError(404, "NOT_FOUND", "User not found.");

  if (body.name !== undefined) doc.name = body.name;

  if (body.newPassword !== undefined) {
    // Verify the CURRENT password before changing it, exactly as login does —
    // an access token alone must not be enough to seize an account.
    const ok = await bcrypt.compare(body.currentPassword!, doc.passwordHash);
    if (!ok) {
      throw new ApiError(400, "INVALID_PASSWORD", "Your current password is incorrect.", [
        { path: "currentPassword", message: "Incorrect password." },
      ]);
    }
    doc.passwordHash = hashPassword(body.newPassword);
  }

  await doc.save();

  if (body.newPassword !== undefined) {
    const now = new Date();
    // Kill every existing session: a password change is the standard response
    // to a suspected compromise, so a stolen refresh token must not survive it
    // by rotating forever (FR-BE-003).
    await revokeUserRefreshTokens(actor.id, now);
    // …then re-issue for THIS caller, so changing your password doesn't sign
    // you out of the tab you did it in.
    const { raw, expiresAt } = await issueRefreshFamily(actor.id, now);
    setRefreshCookie(res, raw, expiresAt);
    await recordAudit({
      action: "auth.password.change",
      userId: actor.id,
      targetType: "user",
      targetId: actor.id,
      req,
    });
  }

  res.json(serializeUser(doc));
});

// GET /users — admin-only, cursor-paginated, ?search= by name/email (FR-BE-010).
export const listUsers = asyncHandler(async (req: AuthedRequest, res: Response) => {
  requireUser(req);
  const { limit, cursor, search } = parseInput(userListQuerySchema, req.query);
  const docs = await UserModel.find(userListFilter({ search, cursor }))
    .sort({ _id: -1 })
    .limit(limit + 1);
  res.json(buildPage(docs, limit, serializeUser));
});

// POST /users — create a user with an initial role + password (FR-BE-010/001).
export const createUser = asyncHandler(async (req: AuthedRequest, res: Response) => {
  requireUser(req);
  const body = parseInput(userCreateSchema, req.body);
  const email = body.email.toLowerCase();
  if (await UserModel.findOne({ email })) {
    throw new ApiError(409, "EMAIL_TAKEN", "That email is already registered.");
  }
  const doc = await UserModel.create({
    name: body.name,
    email,
    passwordHash: bcrypt.hashSync(body.password, BCRYPT_COST),
    role: body.role,
    status: "active",
  });
  res.status(201).json(serializeUser(doc));
});

// PATCH /users/:id — change role and/or status (FR-BE-010). Deactivating a user
// immediately revokes their extension tokens.
export const updateUser = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const actor = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const body = parseInput(userUpdateSchema, req.body);

  // An admin must not be able to lock themselves out.
  if (id === actor.id) {
    if (body.status === "deactivated") {
      throw new ApiError(400, "SELF_UPDATE", "You can't deactivate your own account.");
    }
    if (body.role !== undefined && body.role !== "admin") {
      throw new ApiError(400, "SELF_UPDATE", "You can't change your own role.");
    }
  }

  const doc = await UserModel.findById(id);
  if (!doc) throw new ApiError(404, "NOT_FOUND", "User not found.");
  const prevRole = doc.role;
  if (body.role !== undefined) doc.role = body.role;
  if (body.status !== undefined) doc.status = body.status;
  await doc.save();

  // FR-BE-012 — only when the role actually moved; a no-op PATCH is not an event.
  if (body.role !== undefined && body.role !== prevRole) {
    await recordAudit({
      action: "user.role.change",
      userId: actor.id, // who did it…
      targetType: "user",
      targetId: id, // …and to whom. prevRole → body.role.
      req,
    });
  }

  // FR-BE-010: deactivated users' tokens are revoked immediately.
  if (body.status === "deactivated") {
    await ApiTokenModel.updateMany(
      { userId: doc._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }
  res.json(serializeUser(doc));
});
