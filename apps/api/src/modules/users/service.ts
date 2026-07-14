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
