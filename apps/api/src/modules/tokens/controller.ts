import type { Response } from "express";
import { tokenCreateSchema } from "@snapcrawl/shared";
import type { AuthedRequest } from "../../auth";
import { ApiError } from "../../http/envelope";
import { asyncHandler, idParam, parseInput, requireUser } from "../../http/validate";
import { generateRawToken, hashToken } from "../../lib/tokens";
import { ApiTokenModel } from "../../models/apiToken";
import { serializeToken } from "./service";

// POST /tokens — the raw token is returned exactly once, here (FR-BE-060).
export const createToken = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const body = parseInput(tokenCreateSchema, req.body);
  const rawToken = generateRawToken();
  const doc = await ApiTokenModel.create({
    userId: user.id,
    name: body.name,
    tokenHash: hashToken(rawToken),
    scopes: ["capture"],
    expiresAt: body.expiresAt,
  });
  res.status(201).json({ token: serializeToken(doc), rawToken });
});

// GET /tokens — the caller's own tokens, newest first (metadata only), in the
// shared list envelope. Bounded per FR-BE-073; a user's token count is small,
// so we return them all in one page (nextCursor always null).
export const listTokens = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const docs = await ApiTokenModel.find({ userId: user.id }).sort({ createdAt: -1 }).limit(100);
  res.json({ items: docs.map((d) => serializeToken(d)), nextCursor: null });
});

// DELETE /tokens/:id — revoke (soft); tokens are never hard-deleted (FR-BE-060).
export const revokeToken = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const doc = await ApiTokenModel.findOne({ _id: id, userId: user.id });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Token not found.");
  if (!doc.revokedAt) {
    doc.revokedAt = new Date();
    await doc.save();
  }
  res.status(204).end();
});
