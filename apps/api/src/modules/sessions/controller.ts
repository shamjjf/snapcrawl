import type { Response } from "express";
import { sessionListQuerySchema, sessionLogQuerySchema, type SessionStatus } from "@snapcrawl/shared";
import type { AuthedRequest } from "../../auth";
import { ApiError } from "../../http/envelope";
import { buildPage } from "../../http/pagination";
import { asyncHandler, idParam, parseInput, requireUser } from "../../http/validate";
import { presignGet } from "../../lib/s3";
import { publishSessionEvent, subscribeSessionEvents } from "../../lib/sessionEvents";
import { EdgeModel } from "../../models/edge";
import { ProjectModel } from "../../models/project";
import { ScreenModel } from "../../models/screen";
import { SessionModel } from "../../models/session";
import { SessionLogModel } from "../../models/sessionLog";
import { thumbKeyOf } from "../captures/service";
import { visibilityFilter } from "../projects/service";
import { buildGraph, canCancel, serializeSession, serializeSessionLog } from "./service";

// GET /sessions?projectId= — cursor-paginated, newest first, project-scoped and
// visibility-checked (FR-BE-035).
export const listSessions = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { projectId, limit, cursor } = parseInput(sessionListQuerySchema, req.query);

  // Confirm the caller can see the project (else 404 — no existence leak).
  const project = await ProjectModel.findOne({ _id: projectId, ...visibilityFilter(user) });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");

  const filter: Record<string, unknown> = { projectId };
  if (cursor) filter._id = { $lt: cursor };
  const docs = await SessionModel.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1);
  res.json(buildPage(docs, limit, serializeSession));
});

// GET /sessions/:id — full detail incl. config snapshot (FR-BE-035).
export const getSession = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const doc = await SessionModel.findById(id);
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Session not found.");

  const project = await ProjectModel.findOne({ _id: doc.projectId, ...visibilityFilter(user) });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Session not found.");
  res.json(serializeSession(doc));
});

// GET /sessions/:id/logs — cursor-paginated session log (the detail view's error
// log), newest first, optional ?level= filter (FR-AP-031).
export const listSessionLogs = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const q = parseInput(sessionLogQuerySchema, req.query);

  const session = await SessionModel.findById(id);
  if (!session) throw new ApiError(404, "NOT_FOUND", "Session not found.");
  const project = await ProjectModel.findOne({ _id: session.projectId, ...visibilityFilter(user) });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Session not found.");

  const filter: Record<string, unknown> = { sessionId: session._id };
  if (q.level) filter.level = q.level;
  if (q.cursor) filter._id = { $lt: q.cursor };
  const docs = await SessionLogModel.find(filter)
    .sort({ _id: -1 })
    .limit(q.limit + 1);
  res.json(buildPage(docs, q.limit, serializeSessionLog));
});

/** Load a session the caller may see, or throw 404 (no existence leak). */
async function visibleSession(req: AuthedRequest, id: string) {
  const user = requireUser(req);
  const session = await SessionModel.findById(id);
  if (!session) throw new ApiError(404, "NOT_FOUND", "Session not found.");
  const project = await ProjectModel.findOne({ _id: session.projectId, ...visibilityFilter(user) });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Session not found.");
  return session;
}

// POST /sessions/:id/cancel — request cancellation; the extension reads the flag
// on its next PATCH and stops (FR-BE-034).
export const cancelSession = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { id } = parseInput(idParam, req.params);
  const session = await visibleSession(req, id);
  if (!canCancel(session.status as SessionStatus)) {
    throw new ApiError(409, "ALREADY_FINISHED", "Session has already finished.");
  }
  if (!session.cancelRequested) {
    session.cancelRequested = true;
    await session.save();
    publishSessionEvent(id, { type: "status", session: serializeSession(session) });
  }
  res.json(serializeSession(session));
});

// GET /sessions/:id/graph — render-ready nodes (screens + signed thumbs) and
// edges (transitions) (FR-BE-050).
export const getSessionGraph = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { id } = parseInput(idParam, req.params);
  const session = await visibleSession(req, id);
  const [screens, edges] = await Promise.all([
    ScreenModel.find({ sessionId: session._id }),
    EdgeModel.find({ sessionId: session._id }),
  ]);
  const thumbById = new Map<string, string>();
  await Promise.all(
    screens.map(async (s) => {
      thumbById.set(String(s._id), await presignGet(thumbKeyOf(s)));
    }),
  );
  res.json(buildGraph(screens, edges, thumbById));
});

// GET /sessions/:id/events — SSE stream of stats/status changes (FR-BE-036).
// Auth is via ?token= (see requireAuthSse) since EventSource can't set headers.
export const sessionEvents = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { id } = parseInput(idParam, req.params);

  // Teardown is registered BEFORE the awaited DB lookup: Node emits 'close'
  // exactly once, so if the client disconnects during the lookup the handler
  // must already be attached or the bus subscription + ping timer would leak.
  let closed = false;
  let ping: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  const cleanup = (): void => {
    if (ping) {
      clearInterval(ping);
      ping = undefined;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
    if (!res.writableEnded) res.end();
  };
  req.on("close", () => {
    closed = true;
    cleanup();
  });
  res.on("error", cleanup);

  const session = await visibleSession(req, id);
  if (closed) {
    cleanup();
    return; // client already gone during the lookup — nothing to stream
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (type: string, data: unknown): void => {
    if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("snapshot", serializeSession(session));
  unsubscribe = subscribeSessionEvents(id, (e) => send(e.type, e.session));
  ping = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 25_000);
  ping.unref?.();
});
