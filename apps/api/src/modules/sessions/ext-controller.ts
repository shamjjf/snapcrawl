import type { Response } from "express";
import {
  crawlConfigSchema,
  sessionCreateSchema,
  sessionLogBatchSchema,
  sessionUpdateSchema,
  type SessionStatus,
} from "@snapcrawl/shared";
import { ApiError } from "../../http/envelope";
import { asyncHandler, idParam, parseInput, requireUser } from "../../http/validate";
import { publishSessionEvent } from "../../lib/sessionEvents";
import type { ExtRequest } from "../../middleware/extAuth";
import { ProjectModel } from "../../models/project";
import { SessionModel } from "../../models/session";
import { SessionLogModel } from "../../models/sessionLog";
import { visibilityFilter } from "../projects/service";
import { buildSessionLogDocs, canTransition, isTerminal, serializeSession, snapshotConfig } from "./service";

// POST /ext/sessions — create with an immutable config snapshot (FR-BE-030).
export const createSession = asyncHandler(async (req: ExtRequest, res: Response) => {
  const user = requireUser(req);
  const body = parseInput(sessionCreateSchema, req.body);
  const project = await ProjectModel.findOne({ _id: body.projectId, ...visibilityFilter(user) });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");

  const base = crawlConfigSchema.parse(project.toObject().config);
  const doc = await SessionModel.create({
    projectId: project._id,
    userId: user.id,
    tokenId: req.extTokenId,
    status: "pending",
    configSnapshot: snapshotConfig(base, body.overrides),
    stats: {},
  });
  res.status(201).json(serializeSession(doc));
});

// PATCH /ext/sessions/:id — status transitions, stats deltas, heartbeat
// (FR-BE-031/033). Invalid transitions are rejected with 409.
export const updateSession = asyncHandler(async (req: ExtRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const body = parseInput(sessionUpdateSchema, req.body);

  const doc = await SessionModel.findOne({ _id: id, userId: user.id });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Session not found.");

  const prevStatus = doc.status as SessionStatus;

  if (body.heartbeat) doc.lastHeartbeatAt = new Date();

  if (body.status && body.status !== doc.status) {
    if (!canTransition(prevStatus, body.status)) {
      throw new ApiError(
        409,
        "INVALID_TRANSITION",
        `Cannot transition from ${prevStatus} to ${body.status}.`,
      );
    }
    doc.status = body.status;
    if (body.status === "running" && !doc.startedAt) doc.startedAt = new Date();
    if (isTerminal(body.status)) doc.endedAt = new Date();
  }

  if (body.stats) {
    doc.set("stats", { ...doc.toObject().stats, ...body.stats });
  }
  if (body.endReason) doc.endReason = body.endReason;

  await doc.save();
  const session = serializeSession(doc);
  // Push a live event: status change vs. a stats/heartbeat delta (FR-BE-036).
  publishSessionEvent(id, {
    type: session.status !== prevStatus ? "status" : "stats",
    session,
  });
  res.json(session);
});

// POST /ext/logs — batched session-log ingest (FR-EX-082/084). The extension
// uploads error (and, later, decision) lines for the panel's session log
// (FR-AP-031). `seq` is assigned server-side, continuing from the session's
// current line count so ordering is stable across batches and SW resumes.
export const uploadLogs = asyncHandler(async (req: ExtRequest, res: Response) => {
  const user = requireUser(req);
  const body = parseInput(sessionLogBatchSchema, req.body);

  const session = await SessionModel.findOne({ _id: body.sessionId, userId: user.id });
  if (!session) throw new ApiError(404, "NOT_FOUND", "Session not found.");

  const base = await SessionLogModel.countDocuments({ sessionId: session._id });
  const docs = buildSessionLogDocs(session._id, base, body.logs, new Date());

  const inserted = await SessionLogModel.insertMany(docs, { ordered: false });
  res.status(201).json({ recorded: inserted.length });
});
