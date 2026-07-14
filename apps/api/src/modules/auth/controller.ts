import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { loginSchema, registerSchema } from "@snapcrawl/shared";
import {
  hashPassword,
  signAccessToken,
  signToken,
  toUser,
  type AuthedRequest,
} from "../../auth";
import { ApiError } from "../../http/envelope";
import { asyncHandler, parseInput, requireUser } from "../../http/validate";
import { UserModel } from "../../models/user";
import { issueRefreshFamily, revokeRefreshToken, rotateRefreshToken } from "./service";

// Refresh token is delivered as an httpOnly cookie scoped to the auth routes
// (FR-BE-002). Secure only in prod so it still flows over http://localhost.
const REFRESH_COOKIE = "sc_refresh";
const REFRESH_PATH = "/api/v1/auth";
const isProd = process.env.NODE_ENV === "production";

function setRefreshCookie(res: Response, raw: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: REFRESH_PATH,
    expires: expiresAt,
  });
}
function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: REFRESH_PATH,
  });
}
/** Read the refresh cookie without pulling in cookie-parser. */
function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === REFRESH_COOKIE) {
      // A malformed percent-encoding must behave like an absent cookie (→ 401),
      // not throw a URIError that surfaces as a 500.
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
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
  const { raw, expiresAt } = await issueRefreshFamily(String(user._id), new Date());
  setRefreshCookie(res, raw, expiresAt);
  res.status(201).json({ user: toUser(user), token: signToken(user) });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const body = parseInput(loginSchema, req.body);
  const user = await UserModel.findOne({ email: body.email.toLowerCase() });
  if (
    !user ||
    user.status === "deactivated" ||
    !(await bcrypt.compare(body.password, user.passwordHash))
  ) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }
  user.lastLoginAt = new Date();
  await user.save();
  const { raw, expiresAt } = await issueRefreshFamily(String(user._id), new Date());
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
