import {
  crawlConfigSchema,
  type Project,
  type ProjectMember,
  type ProjectStatus,
  type User,
} from "@snapcrawl/shared";
import type { ProjectDoc } from "../../models/project";
import type { UserDoc } from "../../models/user";

// Project access control + serialization (FR-BE-020). Members see projects they
// own or are assigned to; admins see all. Edit/delete is owner-or-admin.

/**
 * Mongo filter limiting a find() to the projects a user may see.
 *
 * Soft-deleted projects are excluded here rather than at each call site, and
 * that placement is the point (FR-BE-025). Every project-scoped read in the API
 * funnels through this one filter — sessions, screens, the dashboard, the
 * extension's project list — so a deleted project and everything hanging off it
 * vanish together, and a call site I forget still fails CLOSED.
 *
 * `deletedAt: null` matches documents where the field is null AND where it is
 * absent, so existing rows read as live with no backfill.
 */
export function visibilityFilter(user: User): Record<string, unknown> {
  const live = { deletedAt: null };
  if (user.role === "admin") return live;
  return { ...live, $or: [{ ownerId: user.id }, { memberIds: user.id }] };
}

/** The inverse: soft-deleted projects a user may see, for restore (FR-BE-025).
 *  Kept separate rather than a flag on `visibilityFilter`, so that reading a
 *  deleted project is always a deliberate act at the call site. */
export function deletedVisibilityFilter(user: User): Record<string, unknown> {
  const dead = { deletedAt: { $ne: null } };
  if (user.role === "admin") return dead;
  return { ...dead, $or: [{ ownerId: user.id }, { memberIds: user.id }] };
}

/** Escape a user string for safe use inside a Mongo $regex (NFR-010). */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the GET /projects Mongo filter: visibility + name search + cursor
 *  (FR-BE-020/073). Cursor pages by _id descending (newest first); the string
 *  cursor is cast to ObjectId by Mongoose at query time. */
export function projectListFilter(
  user: User,
  opts: { search?: string; cursor?: string },
): Record<string, unknown> {
  const filter: Record<string, unknown> = { ...visibilityFilter(user) };
  const search = opts.search?.trim();
  if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
  if (opts.cursor) filter._id = { $lt: opts.cursor };
  return filter;
}

/** Owner or admin may edit/delete a project. */
export function canManage(user: User, project: { ownerId: unknown }): boolean {
  return user.role === "admin" || String(project.ownerId) === user.id;
}

/** Merge only the config keys the client actually sent over the stored config.
 *  `crawlConfigSchema.partial()` re-injects every field's default, so a naive
 *  spread would reset untouched fields (e.g. wipe allowedDomains on a maxDepth
 *  edit). We overlay just `sentKeys` to keep a partial PATCH truly partial. */
export function mergeConfigPatch<T extends Record<string, unknown>>(
  current: T,
  parsed: Record<string, unknown>,
  sentKeys: string[],
): T {
  const patch: Record<string, unknown> = {};
  for (const key of sentKeys) patch[key] = parsed[key];
  return { ...current, ...patch };
}

/** Map a project document to the shared `Project` response shape (SRS §8.3). */
export function serializeProject(p: ProjectDoc): Project {
  return {
    id: String(p._id),
    ownerId: String(p.ownerId),
    memberIds: (p.memberIds ?? []).map((m) => String(m)),
    name: p.name,
    description: p.description,
    baseUrl: p.baseUrl,
    config: crawlConfigSchema.parse(p.toObject().config),
    status: p.status as ProjectStatus,
    // NFR-020: null until someone attests they may test this target.
    authorisedUse: p.authorisedUse
      ? { at: p.authorisedUse.at, by: String(p.authorisedUse.by) }
      : null,
    // FR-BE-025. Both null for a live project; `purgeDueAt` is derived here so
    // the panel never has to know the grace period to render "restorable until".
    deletedAt: p.deletedAt ?? null,
    purgeDueAt: p.deletedAt ? purgeDueAt(p.deletedAt) : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** May this project be crawled? (NFR-020, C-07.) The single predicate the gate
 *  and the panel's prompt both derive from. Pure. */
export function isAuthorisedForUse(p: { authorisedUse?: { at?: Date } | null }): boolean {
  return Boolean(p.authorisedUse?.at);
}

// ── Soft delete + cascade (FR-BE-025) ───────────────────────────────────────

/** How long a deleted project stays restorable before the cascade runs
 *  (FR-BE-025: "after a 7-day grace period"). */
export const DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** When the cascade becomes due for a project deleted at `deletedAt`. Pure. */
export function purgeDueAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + DELETE_GRACE_MS);
}

/** Projects whose grace period has elapsed — the purge sweep's only query.
 *  Pure; the caller owns the clock. `$ne: null` is load-bearing alongside
 *  `$lte`: without it a project that was never deleted (field absent) would
 *  compare as less than any date in Mongo's BSON type ordering and be purged. */
export function purgeFilter(now: Date): Record<string, unknown> {
  return {
    deletedAt: { $ne: null, $lte: new Date(now.getTime() - DELETE_GRACE_MS) },
  };
}

// ── Membership (FR-BE-024) ──────────────────────────────────────────────────

/** Map a user doc to a project people-list entry. Pure. */
export function serializeMember(u: UserDoc, ownerId: string): ProjectMember {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role as ProjectMember["role"],
    isOwner: String(u._id) === ownerId,
  };
}

/** Order the people list: owner first, then members by name. Pure — the sort
 *  lives here rather than in Mongo because `isOwner` is not a stored field. */
export function sortMembers(members: ProjectMember[]): ProjectMember[] {
  return [...members].sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export type MemberAddProblem = "owner" | "already" | null;

/**
 * Why (if at all) this user cannot be added to this project. Pure, so the rule
 * is stated once and readable without a DB.
 *
 * Both cases are "already has access", not real errors — the caller turns them
 * into a no-op returning the current list rather than a 4xx, so a panel that
 * double-submits does not have to distinguish failure from a race it already won.
 */
export function memberAddProblem(
  project: { ownerId: unknown; memberIds?: unknown[] },
  userId: string,
): MemberAddProblem {
  if (String(project.ownerId) === userId) return "owner";
  if ((project.memberIds ?? []).some((m) => String(m) === userId)) return "already";
  return null;
}
