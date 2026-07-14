import type { Response } from "express";
import {
  captureCompleteSchema,
  edgeBatchSchema,
  presignRequestSchema,
  screenListQuerySchema,
} from "@snapcrawl/shared";
import type { AuthedRequest } from "../../auth";
import { ApiError } from "../../http/envelope";
import { asyncHandler, idParam, parseInput, requireUser } from "../../http/validate";
import {
  MAX_UPLOAD_BYTES,
  PUT_TTL_SEC,
  deleteObject,
  headObject,
  presignGet,
  presignPut,
} from "../../lib/s3";
import type { ExtRequest } from "../../middleware/extAuth";
import { EdgeModel } from "../../models/edge";
import { ProjectModel } from "../../models/project";
import { ScreenModel } from "../../models/screen";
import { SessionModel } from "../../models/session";
import { visibilityFilter } from "../projects/service";
import { screenKey, screenListFilter, serializeScreen, thumbKeyOf } from "./service";

/** Load a session owned by the extension token's user, or 404. */
async function ownedSession(req: ExtRequest, sessionId: string) {
  const user = requireUser(req);
  const session = await SessionModel.findOne({ _id: sessionId, userId: user.id });
  if (!session) throw new ApiError(404, "NOT_FOUND", "Session not found.");
  return session;
}

// POST /ext/captures/presign — dedupe by contentHash, else a presigned PUT
// (server key, png/webp, TTL ≤ 10 min) (FR-BE-040).
export const presignCapture = asyncHandler(async (req: ExtRequest, res: Response) => {
  const body = parseInput(presignRequestSchema, req.body);
  const session = await ownedSession(req, body.sessionId);

  const dup = await ScreenModel.findOne({
    sessionId: session._id,
    contentHash: body.contentHash,
  });
  if (dup) {
    res.json({ duplicate: true });
    return;
  }

  const key = screenKey(String(session._id), body.stateFingerprint, body.contentType);
  const uploadUrl = await presignPut(key, body.contentType);
  res.json({ duplicate: false, uploadUrl, key, expiresInSec: PUT_TTL_SEC });
});

// POST /ext/captures/complete — verify the object exists (and size ≤ 15 MB),
// then persist the screen, unique per (sessionId, fingerprint) (FR-BE-041).
export const completeCapture = asyncHandler(async (req: ExtRequest, res: Response) => {
  const body = parseInput(captureCompleteSchema, req.body);
  const session = await ownedSession(req, body.sessionId);

  const head = await headObject(body.key);
  if (!head) throw new ApiError(400, "UPLOAD_NOT_FOUND", "Uploaded object not found in storage.");
  if (head.size > MAX_UPLOAD_BYTES) {
    await deleteObject(body.key);
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Screenshot exceeds the 15 MB limit.");
  }

  // Idempotent: return the existing screen if this state was already captured.
  const existing = await ScreenModel.findOne({
    sessionId: session._id,
    fingerprint: body.stateFingerprint,
  });
  if (existing) {
    res.status(200).json(serializeScreen(existing));
    return;
  }

  const meta = body.meta;
  const parent = meta.parentFingerprint
    ? await ScreenModel.findOne({ sessionId: session._id, fingerprint: meta.parentFingerprint })
    : null;

  try {
    const doc = await ScreenModel.create({
      sessionId: session._id,
      projectId: session.projectId,
      fingerprint: body.stateFingerprint,
      url: meta.url,
      title: meta.title,
      depth: meta.depth,
      parentScreenId: parent?._id,
      triggerElement: meta.triggerElement ?? undefined,
      s3Key: body.key,
      contentHash: body.contentHash,
      width: body.width,
      height: body.height,
      fullPage: meta.fullPage,
      capturedAt: meta.clientTimestamp ?? new Date(),
    });
    res.status(201).json(serializeScreen(doc));
  } catch (err) {
    // Lost a race on the unique (sessionId, fingerprint) index — return the winner.
    if ((err as { code?: number }).code === 11000) {
      const winner = await ScreenModel.findOne({
        sessionId: session._id,
        fingerprint: body.stateFingerprint,
      });
      if (winner) {
        res.status(200).json(serializeScreen(winner));
        return;
      }
    }
    throw err;
  }
});

// POST /ext/edges — batched, idempotent edge upload (≤ 100) (FR-BE-045).
export const uploadEdges = asyncHandler(async (req: ExtRequest, res: Response) => {
  const body = parseInput(edgeBatchSchema, req.body);
  const session = await ownedSession(req, body.sessionId);

  // Resolve fingerprints → screen ids in one query.
  const fps = new Set<string>();
  for (const e of body.edges) {
    fps.add(e.fromFingerprint);
    if (e.toFingerprint) fps.add(e.toFingerprint);
  }
  const screens = await ScreenModel.find({
    sessionId: session._id,
    fingerprint: { $in: [...fps] },
  });
  const byFp = new Map(screens.map((s) => [s.fingerprint, s._id]));

  let recorded = 0;
  for (const e of body.edges) {
    try {
      await EdgeModel.create({
        sessionId: session._id,
        fromScreenId: byFp.get(e.fromFingerprint) ?? null,
        toScreenId: e.toFingerprint ? (byFp.get(e.toFingerprint) ?? null) : null,
        element: e.element,
        kind: e.kind,
      });
      recorded += 1;
    } catch (err) {
      // Duplicate edge (idempotent) — skip; anything else is a real failure.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  res.json({ recorded });
});

// GET /screens/:id — screen detail + a short-lived signed image URL (FR-BE-044).
export const getScreen = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const doc = await ScreenModel.findById(id);
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Screen not found.");

  const project = await ProjectModel.findOne({ _id: doc.projectId, ...visibilityFilter(user) });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Screen not found.");

  const [imageUrl, thumbUrl] = await Promise.all([
    presignGet(doc.s3Key),
    presignGet(thumbKeyOf(doc)),
  ]);
  res.json(serializeScreen(doc, { imageUrl, thumbUrl }));
});

// GET /sessions/:id/screens — cursor-paginated gallery list, visibility-scoped,
// with url/depth/duplicate filters; each item carries a signed thumbUrl
// (FR-BE-041/FR-AP-040).
export const listSessionScreens = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const q = parseInput(screenListQuerySchema, req.query);

  const session = await SessionModel.findById(id);
  if (!session) throw new ApiError(404, "NOT_FOUND", "Session not found.");
  const project = await ProjectModel.findOne({ _id: session.projectId, ...visibilityFilter(user) });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Session not found.");

  const filter = screenListFilter(String(session._id), q);
  const docs = await ScreenModel.find(filter)
    .sort({ _id: -1 })
    .limit(q.limit + 1);
  const hasMore = docs.length > q.limit;
  const kept = hasMore ? docs.slice(0, q.limit) : docs;
  const items = await Promise.all(
    kept.map(async (s) => serializeScreen(s, { thumbUrl: await presignGet(thumbKeyOf(s)) })),
  );
  const nextCursor = hasMore ? String(kept[kept.length - 1]._id) : null;
  res.json({ items, nextCursor });
});
