import { randomBytes } from "node:crypto";
import type { AdminUser } from "@snapcrawl/shared";
import type { UserDoc } from "../../models/user";

// User administration helpers (FR-BE-010). Serialization never exposes the
// passwordHash (SRS §8.1).

/** Escape a user string for safe use inside a Mongo $regex (NFR-010). */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the GET /users Mongo filter: name/email search + _id cursor
 *  (FR-BE-010/073). Cursor pages by _id descending (newest first). */
export function userListFilter(opts: {
  search?: string;
  cursor?: string;
}): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const search = opts.search?.trim();
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [{ name: rx }, { email: rx }];
  }
  if (opts.cursor) filter._id = { $lt: opts.cursor };
  return filter;
}

// ── Admin bootstrap (FR-BE-001, NFR-011) ────────────────────────────────────
// Boot-time seeding is opt-in via SEED_ADMIN. The flag, not NODE_ENV, is what
// keeps a demo admin out of production: NODE_ENV is unset everywhere in this
// repo, so a `NODE_ENV !== "production"` guard would fail OPEN and still seed.
// An absent SEED_ADMIN fails CLOSED. NODE_ENV only tightens (never permits):
// in prod the credentials must be explicit, so no known password can be
// invented. The deliberate prod path is `npm run seed:admin`.

export type SeedDecision =
  | { action: "skip"; reason: string }
  | { action: "refuse"; reason: string }
  | { action: "seed"; email: string; password: string; generated: boolean };

export interface SeedEnv {
  seedAdmin: boolean;
  email?: string;
  password?: string;
  isProd: boolean;
}

export const DEFAULT_SEED_EMAIL = "admin@snapcrawl.dev";

/** A throwaway dev password — never a fixed literal, so a generated credential
 *  can't become a known one (the `admin/password` problem this replaces). */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Decide whether to seed an admin at boot. Pure: no DB, no bcrypt, no env
 *  reads — the caller supplies the environment (FR-BE-001, NFR-011). */
export function resolveAdminSeed(env: SeedEnv, password = generatePassword): SeedDecision {
  if (!env.seedAdmin) {
    return { action: "skip", reason: "SEED_ADMIN is not set to \"true\"" };
  }
  if (env.isProd && (!env.email || !env.password)) {
    return {
      action: "refuse",
      reason:
        "refusing to invent admin credentials in production — set SEED_ADMIN_EMAIL and " +
        "SEED_ADMIN_PASSWORD, or run `npm run seed:admin -w apps/api`",
    };
  }
  return {
    action: "seed",
    email: env.email ?? DEFAULT_SEED_EMAIL,
    password: env.password ?? password(),
    generated: !env.password,
  };
}

/** Map a user document to the admin-facing shape — never the passwordHash (§8.1). */
export function serializeUser(u: UserDoc): AdminUser {
  const doc = u as UserDoc & { createdAt: Date };
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role as AdminUser["role"],
    status: u.status as AdminUser["status"],
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: doc.createdAt,
  };
}
