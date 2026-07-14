import type { NextFunction, Response } from "express";
import { toUser, type AuthedRequest } from "../auth";
import { ApiError } from "../http/envelope";
import { hashToken } from "../lib/tokens";
import { ApiTokenModel } from "../models/apiToken";
import { UserModel } from "../models/user";
import { tokenUsable } from "../modules/tokens/service";

export interface ExtRequest extends AuthedRequest {
  extTokenId?: string;
  extScopes?: string[];
}

// Bearer extension-token auth for /ext/*, capture scope only (FR-BE-061/063).
export async function requireExtToken(
  req: ExtRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!raw) throw new ApiError(401, "UNAUTHORIZED", "Missing bearer token.");

    const token = await ApiTokenModel.findOne({ tokenHash: hashToken(raw) });
    if (!token) throw new ApiError(401, "UNAUTHORIZED", "Invalid token.");

    const usable = tokenUsable(token, Date.now());
    if (!usable.ok) {
      if (usable.reason === "scope") {
        throw new ApiError(403, "FORBIDDEN", "Token lacks capture scope.");
      }
      throw new ApiError(401, "UNAUTHORIZED", `Token ${usable.reason}.`);
    }

    const user = await UserModel.findById(token.userId);
    if (!user || user.status === "deactivated") {
      throw new ApiError(401, "UNAUTHORIZED", "Account unavailable.");
    }

    req.user = toUser(user);
    req.extTokenId = String(token._id);
    req.extScopes = token.scopes ?? ["capture"];

    // FR-BE-063 — surface usage in the panel's token list.
    token.lastUsedAt = new Date();
    await token.save();
    next();
  } catch (err) {
    next(err);
  }
}
