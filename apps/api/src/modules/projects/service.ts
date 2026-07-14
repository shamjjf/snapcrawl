import { crawlConfigSchema, type Project, type ProjectStatus, type User } from "@snapcrawl/shared";
import type { ProjectDoc } from "../../models/project";

// Project access control + serialization (FR-BE-020). Members see projects they
// own or are assigned to; admins see all. Edit/delete is owner-or-admin.

/** Mongo filter limiting a find() to the projects a user may see. */
export function visibilityFilter(user: User): Record<string, unknown> {
  if (user.role === "admin") return {};
  return { $or: [{ ownerId: user.id }, { memberIds: user.id }] };
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
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
