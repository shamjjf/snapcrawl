import type { Response } from "express";
import { z } from "zod";
import {
  crawlConfigSchema,
  objectIdSchema,
  projectAuthoriseSchema,
  projectCreateSchema,
  projectListQuerySchema,
  projectMemberAddSchema,
  projectUpdateSchema,
} from "@snapcrawl/shared";
import type { AuthedRequest } from "../../auth";
import { ApiError } from "../../http/envelope";
import { buildPage } from "../../http/pagination";
import { asyncHandler, idParam, parseInput, requireUser } from "../../http/validate";
import { recordAudit } from "../../lib/audit";
import { ProjectModel, type ProjectDoc } from "../../models/project";
import { UserModel } from "../../models/user";
import {
  canManage,
  deletedVisibilityFilter,
  isAuthorisedForUse,
  memberAddProblem,
  mergeConfigPatch,
  projectListFilter,
  serializeMember,
  serializeProject,
  sortMembers,
  visibilityFilter,
} from "./service";
import { validateProjectConfig } from "./validation";

// GET /projects — visible projects, newest first, cursor-paginated, ?search=
// by name (FR-BE-020/073). Returns the shared { items, nextCursor } envelope.
export const listProjects = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { limit, cursor, search } = parseInput(projectListQuerySchema, req.query);
  const filter = projectListFilter(user, { search, cursor });
  const docs = await ProjectModel.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1);
  res.json(buildPage(docs, limit, serializeProject));
});

// POST /projects — creator becomes owner; config validated (FR-BE-020/021/023).
export const createProject = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const body = parseInput(projectCreateSchema, req.body);
  const config = crawlConfigSchema.parse(body.config ?? {});
  const details = validateProjectConfig(body.baseUrl, config);
  if (details.length > 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid project configuration.", details);
  }
  const doc = await ProjectModel.create({
    ownerId: user.id,
    name: body.name,
    description: body.description ?? "",
    baseUrl: body.baseUrl,
    config,
  });
  res.status(201).json(serializeProject(doc));
});

// GET /projects/:id — 404 (not 403) when out of scope, to avoid leaking existence.
export const getProject = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const doc = await ProjectModel.findOne({ _id: id, ...visibilityFilter(user) });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Project not found.");
  res.json(serializeProject(doc));
});

// PATCH /projects/:id — owner/admin only; re-validate the merged config (FR-BE-023).
export const updateProject = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const body = parseInput(projectUpdateSchema, req.body);
  const doc = await ProjectModel.findOne({ _id: id, ...visibilityFilter(user) });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Project not found.");
  if (!canManage(user, doc)) {
    throw new ApiError(403, "FORBIDDEN", "Only the owner or an admin can edit this project.");
  }

  const current = doc.toObject().config;
  const sentConfig = (req.body as { config?: Record<string, unknown> }).config ?? {};
  const effConfig =
    body.config !== undefined
      ? mergeConfigPatch(current, body.config as Record<string, unknown>, Object.keys(sentConfig))
      : current;
  const effBaseUrl = body.baseUrl ?? doc.baseUrl;
  const details = validateProjectConfig(effBaseUrl, effConfig);
  if (details.length > 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid project configuration.", details);
  }

  if (body.name !== undefined) doc.name = body.name;
  if (body.description !== undefined) doc.description = body.description;
  if (body.baseUrl !== undefined) doc.baseUrl = body.baseUrl;
  if (body.status !== undefined) doc.status = body.status;
  if (body.config !== undefined) doc.set("config", effConfig);
  await doc.save();
  res.json(serializeProject(doc));
});

/**
 * POST /projects/:id/authorise — the authorised-use gate (NFR-020, C-07).
 *
 * Before a project's first crawl, someone must confirm they own or are
 * authorised to test the target. This is the *only* thing standing between a
 * bearer token and pointing an automated clicker at a live third-party site, so
 * it is deliberately explicit: `{ confirm: true }` as a literal, never inferred
 * from an empty body or a side effect of another call.
 *
 * The confirmation is written to the audit log (what NFR-020 asks for) and
 * stamped on the project (what the gate reads, and what survives audit
 * retention). Once per project, per the SRS wording — the audit row records
 * which user attested.
 */
export const authoriseProject = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  parseInput(projectAuthoriseSchema, req.body); // { confirm: true } or 400

  const doc = await ProjectModel.findOne({ _id: id, ...visibilityFilter(user) });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Project not found.");

  // Idempotent: re-confirming is a no-op that returns the original attestation,
  // rather than stacking audit rows or rewriting who attested first.
  if (isAuthorisedForUse(doc)) {
    res.json(serializeProject(doc));
    return;
  }

  const now = new Date();
  doc.set("authorisedUse", { at: now, by: user.id });
  await doc.save();
  await recordAudit({
    action: "project.authorised_use",
    userId: user.id,
    targetType: "project",
    targetId: id,
    req,
  });
  res.json(serializeProject(doc));
});

// ── Membership (FR-BE-024) ──────────────────────────────────────────────────

const memberParam = z.object({ id: objectIdSchema, userId: objectIdSchema });

/** Load a project the caller may SEE, or 404. */
async function visibleProject(req: AuthedRequest, id: string): Promise<ProjectDoc> {
  const user = requireUser(req);
  const doc = await ProjectModel.findOne({ _id: id, ...visibilityFilter(user) });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Project not found.");
  return doc;
}

/** Load a project the caller may MANAGE, or 404/403. Managing membership is
 *  owner-or-admin, exactly like editing: handing out access to a project is at
 *  least as consequential as changing its config. */
async function manageableProject(req: AuthedRequest, id: string): Promise<ProjectDoc> {
  const user = requireUser(req);
  const doc = await visibleProject(req, id);
  if (!canManage(user, doc)) {
    throw new ApiError(403, "FORBIDDEN", "Only the owner or an admin can manage members.");
  }
  return doc;
}

/** Resolve owner + memberIds to renderable people, owner first. */
async function memberList(doc: ProjectDoc): Promise<ReturnType<typeof sortMembers>> {
  const ids = [doc.ownerId, ...(doc.memberIds ?? [])];
  const users = await UserModel.find({ _id: { $in: ids } });
  const ownerId = String(doc.ownerId);
  return sortMembers(users.map((u) => serializeMember(u, ownerId)));
}

// GET /projects/:id/members — anyone who can see the project can see who else
// is on it. Deliberately not owner-only: a member who cannot tell who shares
// their project cannot reason about who sees their crawl data.
export const listMembers = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { id } = parseInput(idParam, req.params);
  const doc = await visibleProject(req, id);
  res.json({ items: await memberList(doc) });
});

/**
 * POST /projects/:id/members — grant a user access to this project (FR-BE-024).
 *
 * `$addToSet` rather than read-modify-write: two admins adding people at the
 * same moment must not clobber each other's addition, which a `doc.memberIds
 * .push()` + `save()` would do silently (last write wins, one grant vanishes).
 */
export const addMember = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const actor = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const { userId } = parseInput(projectMemberAddSchema, req.body);
  const doc = await manageableProject(req, id);

  // Already has access (owner, or already a member) ⇒ nothing to do. Idempotent
  // rather than a 409: the caller's intent is satisfied either way.
  if (memberAddProblem(doc, userId)) {
    res.json({ items: await memberList(doc) });
    return;
  }

  const invitee = await UserModel.findById(userId);
  // A deactivated account must not be granted access. FR-BE-010 deactivation is
  // meant to end someone's reach into the system; silently re-admitting them to
  // a project would make it a half-measure.
  if (!invitee || invitee.status === "deactivated") {
    throw new ApiError(400, "INVALID_USER", "That user does not exist or is deactivated.", [
      { path: "userId", message: "Unknown or deactivated user." },
    ]);
  }

  await ProjectModel.updateOne({ _id: doc._id }, { $addToSet: { memberIds: invitee._id } });
  await recordAudit({
    action: "project.member.add",
    userId: actor.id,
    targetType: "project",
    targetId: id,
    req,
  });
  const fresh = await visibleProject(req, id);
  res.status(201).json({ items: await memberList(fresh) });
});

/**
 * DELETE /projects/:id/members/:userId — revoke a user's access (FR-BE-024).
 *
 * The owner cannot be removed: `visibilityFilter` matches on ownerId OR
 * memberIds, so removing the owner from memberIds would be a no-op that LOOKS
 * like a revocation. Refusing is honest; pretending is not.
 */
export const removeMember = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const actor = requireUser(req);
  const { id, userId } = parseInput(memberParam, req.params);
  const doc = await manageableProject(req, id);

  if (String(doc.ownerId) === userId) {
    throw new ApiError(400, "OWNER_IMMUTABLE", "The project owner cannot be removed.");
  }

  const r = await ProjectModel.updateOne({ _id: doc._id }, { $pull: { memberIds: userId } });
  // Removing someone who is not a member is a no-op, not an error — but only
  // audit when something actually changed, so the trail records revocations
  // rather than clicks.
  if (r.modifiedCount > 0) {
    await recordAudit({
      action: "project.member.remove",
      userId: actor.id,
      targetType: "project",
      targetId: id,
      req,
    });
  }
  const fresh = await visibleProject(req, id);
  res.json({ items: await memberList(fresh) });
});

// ── Delete / restore (FR-BE-025) ────────────────────────────────────────────

/**
 * DELETE /projects/:id — soft-delete; owner/admin only (FR-BE-025).
 *
 * The project vanishes immediately from every read (`visibilityFilter` excludes
 * `deletedAt`), and its sessions, screens, edges, logs and S3 objects go for
 * real once the 7-day grace period expires — see ./purge.ts.
 *
 * This used to be `doc.deleteOne()`, which removed the project row and ORPHANED
 * everything hanging off it: sessions, screens, edges and logs all key on
 * projectId/sessionId, so they survived unreachable, and their S3 objects were
 * billed forever with nothing left to name them. The soft delete is what makes
 * the cascade possible at all — you cannot cascade from a row you already threw
 * away.
 *
 * Returns 200 with the project rather than 204, so the panel can show what it
 * needs for an undo affordance (`purgeDueAt`) without a follow-up read that
 * would now 404.
 */
export const deleteProject = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const doc = await manageableProject(req, id);

  doc.set("deletedAt", new Date());
  // FR-BE-021's status enum already had "pending-delete" and nothing ever set
  // it. `deletedAt` is what the filters read — status is for humans reading the
  // trash list, and the two are written together so they cannot disagree.
  doc.set("status", "pending-delete");
  await doc.save();

  await recordAudit({
    action: "project.delete",
    userId: user.id,
    targetType: "project",
    targetId: id,
    req,
  });
  res.json(serializeProject(doc));
});

/**
 * GET /projects/trash — soft-deleted projects still inside their grace period
 * (FR-BE-025). Separate from GET /projects on purpose: a deleted project must
 * never surface in a normal listing, and an `?includeDeleted` flag on the main
 * endpoint is exactly the kind of thing a caller forgets and a filter silently
 * honours.
 */
export const listDeletedProjects = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const docs = await ProjectModel.find(deletedVisibilityFilter(user)).sort({ deletedAt: -1 });
  res.json({ items: docs.map(serializeProject) });
});

/**
 * POST /projects/:id/restore — undo a soft delete (FR-BE-025).
 *
 * Only works while the data is still there: once the cascade has run, the
 * project row is gone and this 404s, which is the honest answer. Restoring to
 * "active" is deliberate even if the project was archived before deletion —
 * guessing at a prior status would be worse than a visible, correctable state.
 */
export const restoreProject = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const doc = await ProjectModel.findOne({ _id: id, ...deletedVisibilityFilter(user) });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Project not found.");
  if (!canManage(user, doc)) {
    throw new ApiError(403, "FORBIDDEN", "Only the owner or an admin can restore this project.");
  }

  doc.set("deletedAt", undefined);
  doc.set("status", "active");
  await doc.save();

  await recordAudit({
    action: "project.restore",
    userId: user.id,
    targetType: "project",
    targetId: id,
    req,
  });
  res.json(serializeProject(doc));
});
