import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import type { User } from "@snapcrawl/shared";
import { UserModel, type UserDoc } from "./models/user";

// Short-lived access JWT (FR-BE-002); refresh rotation lives in modules/auth.
const ACCESS_TTL_SEC = 15 * 60; // ≤ 15 min
/** bcrypt work factor (FR-BE-001 / NFR-010). */
export const BCRYPT_COST = 12;

/** JWT signing secret — env-required, no hardcoded default (NFR-011). Read
 *  lazily so importing this module (e.g. in tests) never throws. */
function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required (no default).");
  return secret;
}

/** Hash a password with the mandated cost (FR-BE-001). */
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

/** Map a Mongoose user doc → the public User shape (drops passwordHash). */
export function toUser(u: UserDoc): User {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role as User["role"],
  };
}

export function signAccessToken(sub: string, role: string): string {
  return jwt.sign({ sub, role }, jwtSecret(), { expiresIn: ACCESS_TTL_SEC });
}

export function signToken(u: UserDoc): string {
  return signAccessToken(String(u._id), u.role);
}

export interface AuthedRequest extends Request {
  user?: User;
}

/** Verify a JWT and load the active user, or null. Shared by the header and
 *  query-token (SSE) middlewares. */
export async function userFromToken(token: string): Promise<User | null> {
  try {
    const payload = jwt.verify(token, jwtSecret()) as { sub: string };
    const user = await UserModel.findById(payload.sub);
    if (!user || user.status === "deactivated") return null;
    return toUser(user);
  } catch {
    return null;
  }
}

/** Bearer-token middleware. Loads the user from Mongo or 401s. */
export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ code: "UNAUTHORIZED", message: "Missing bearer token." });
    return;
  }
  const user = await userFromToken(token);
  if (!user) {
    res.status(401).json({ code: "UNAUTHORIZED", message: "Invalid or expired token." });
    return;
  }
  req.user = user;
  next();
}

/** SSE auth: EventSource can't set an Authorization header, so accept the token
 *  from `?token=` (falling back to the header). Used ONLY by the events stream.
 *  SECURITY TRADEOFF (accepted): this is the full-scope login JWT in a URL, so a
 *  leaked access log replays via the Authorization header on any route until the
 *  token expires (≤1h). Hardening = a short-TTL, SSE-scoped ticket token; deferred
 *  by product decision (kept simple, no auth-cookie refactor). Only mounted on
 *  GET /sessions/:id/events; every other route stays header-only via requireAuth. */
export async function requireAuthSse(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization ?? "";
  const headerToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";
  const token = headerToken || queryToken;
  if (!token) {
    res.status(401).json({ code: "UNAUTHORIZED", message: "Missing token." });
    return;
  }
  const user = await userFromToken(token);
  if (!user) {
    res.status(401).json({ code: "UNAUTHORIZED", message: "Invalid or expired token." });
    return;
  }
  req.user = user;
  next();
}
