import type { Response } from "express";
import bcrypt from "bcryptjs";
import {
  userCreateSchema,
  userListQuerySchema,
  userUpdateSchema,
} from "@snapcrawl/shared";
import type { AuthedRequest } from "../../auth";
import { ApiError } from "../../http/envelope";
import { buildPage } from "../../http/pagination";
import { asyncHandler, idParam, parseInput, requireUser } from "../../http/validate";
import { ApiTokenModel } from "../../models/apiToken";
import { UserModel } from "../../models/user";
import { serializeUser, userListFilter } from "./service";

// FR-BE-001: passwords hashed with bcrypt, cost ≥ 12.
const BCRYPT_COST = 12;

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
  if (body.role !== undefined) doc.role = body.role;
  if (body.status !== undefined) doc.status = body.status;
  await doc.save();

  // FR-BE-010: deactivated users' tokens are revoked immediately.
  if (body.status === "deactivated") {
    await ApiTokenModel.updateMany(
      { userId: doc._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }
  res.json(serializeUser(doc));
});
