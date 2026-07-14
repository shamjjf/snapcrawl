import type { Response } from "express";
import {
  crawlConfigSchema,
  projectCreateSchema,
  projectListQuerySchema,
  projectUpdateSchema,
} from "@snapcrawl/shared";
import type { AuthedRequest } from "../../auth";
import { ApiError } from "../../http/envelope";
import { buildPage } from "../../http/pagination";
import { asyncHandler, idParam, parseInput, requireUser } from "../../http/validate";
import { ProjectModel } from "../../models/project";
import {
  canManage,
  mergeConfigPatch,
  projectListFilter,
  serializeProject,
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

// DELETE /projects/:id — owner/admin only. Hard delete this slice; FR-BE-025
// soft-delete + cascade is deferred (no sessions/screens exist yet).
export const deleteProject = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const doc = await ProjectModel.findOne({ _id: id, ...visibilityFilter(user) });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Project not found.");
  if (!canManage(user, doc)) {
    throw new ApiError(403, "FORBIDDEN", "Only the owner or an admin can delete this project.");
  }
  await doc.deleteOne();
  res.status(204).end();
});
