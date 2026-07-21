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
import { recordAudit } from "../../lib/audit";
import { inc } from "../../lib/metrics";
import {
  MAX_UPLOAD_BYTES,
  PUT_TTL_SEC,
  deleteObject,
  deleteObjects,
  headObject,
  isAllowedUploadContentType,
  presignGet,
  presignPut,
} from "../../lib/s3";
import { queueThumbnail } from "../../lib/thumbnails";
import type { ExtRequest } from "../../middleware/extAuth";
import { EdgeModel } from "../../models/edge";
import { ProjectModel } from "../../models/project";
import { ScreenModel } from "../../models/screen";
import { SessionModel } from "../../models/session";
import { canManage, visibilityFilter } from "../projects/service";
import {
  isServerIssuedKey,
  screenKey,
  screenListFilter,
  serializeScreen,
  thumbKeyOf,
} from "./service";

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

  // The client hands back the key it was given — so re-derive what we would
  // have given it and require a match (FR-BE-040/044). Without this the caller
  // chooses the key, and "server-generated" is a comment rather than a
  // property: any object in the bucket could be attached to a screen row and
  // read back through this session's signed GET. Checked BEFORE HeadObject, so
  // a foreign key is refused without even confirming whether it exists.
  if (!isServerIssuedKey(body.key, String(session._id), body.stateFingerprint)) {
    throw new ApiError(400, "INVALID_KEY", "Upload key does not match this capture.");
  }

  const head = await headObject(body.key);
  if (!head) {
    inc("captures_failed_total");
    throw new ApiError(400, "UPLOAD_NOT_FOUND", "Uploaded object not found in storage.");
  }
  // NFR-013 — re-check the STORED object against both hard limits, not just its
  // size. The presign restricts the PUT, but this verifies what actually landed:
  // a client that presigned for image/png then uploaded something else is caught
  // here, server-side, and the offending object is dropped rather than persisted
  // and later served back under a signed GET. Both violations delete the object
  // (it must never linger unreferenced) and count as an upload failure (NFR-022).
  if (head.size > MAX_UPLOAD_BYTES) {
    await deleteObject(body.key);
    inc("captures_failed_total");
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Screenshot exceeds the 15 MB limit.");
  }
  if (!isAllowedUploadContentType(head.contentType)) {
    await deleteObject(body.key);
    inc("captures_failed_total");
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Screenshot must be image/png or image/webp.",
    );
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
      // HeadObject already told us the size — the server is the authority here,
      // and the extension must never supply it (C-05: its code is public).
      bytes: head.size,
      fullPage: meta.fullPage,
      // FR-EX-090 — which device the RUN captured as. A run is one device, so
      // every screen in a session shares this value and each one is a distinct
      // state: nothing here may be excluded from state counts, the sitemap or
      // coverage. (It used to mean "phone companion of a desktop twin"; that
      // design is gone, and so are the filters that assumed it.)
      variant: meta.variant,
      mobileReflowed: meta.mobileReflowed,
      capturedAt: meta.clientTimestamp ?? new Date(),
    });
    res.status(201).json(serializeScreen(doc));
    inc("captures_completed_total");
    // Render the thumbnail AFTER responding (FR-BE-042: "asynchronously"), so
    // the capture cadence (C-01, ~2/sec) never waits on an S3 round trip plus
    // an encode. If it fails or is dropped, the screen keeps thumbKey:null and
    // the backfill reconciles it.
    queueThumbnail(String(doc._id));
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

/**
 * DELETE /screens/:id — remove one screenshot: its DB row AND its S3 objects
 * (FR-AP-043).
 *
 * S3 first, then the row — the same ordering the project cascade uses and for
 * the same reason: the row is the only thing that names the objects, so if the
 * row went first a failed object delete would orphan the bytes with nothing left
 * to reference or retry them. If storage fails, the row stays and the caller
 * gets a 502, so a retry finds the screen still there and tries again.
 *
 * Owner-or-admin only. A viewer can see a project's screenshots but must not be
 * able to destroy them — deletion is a management action (canManage), the same
 * bar as editing or deleting the project itself.
 */
export const deleteScreen = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = requireUser(req);
  const { id } = parseInput(idParam, req.params);
  const doc = await ScreenModel.findById(id);
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Screen not found.");

  const project = await ProjectModel.findOne({ _id: doc.projectId, ...visibilityFilter(user) });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Screen not found.");
  if (!canManage(user, project)) {
    throw new ApiError(403, "FORBIDDEN", "Only the owner or an admin can delete screenshots.");
  }

  // Both binaries: the full image and, if rendered, its thumbnail (FR-BE-042).
  const keys = [doc.s3Key, doc.thumbKey].filter((k): k is string => Boolean(k));
  const { failed } = await deleteObjects(keys);
  if (failed.length > 0) {
    throw new ApiError(502, "STORAGE_ERROR", "Could not delete the image from storage. Try again.");
  }

  await doc.deleteOne();
  // Edges referencing this screen are deliberately left: `buildGraph` already
  // tolerates a dangling from/to id (a click whose target was removed), and
  // rewriting the graph on a single-screen delete is out of scope for FR-AP-043.
  await recordAudit({
    action: "screen.delete",
    userId: user.id,
    targetType: "screen",
    targetId: id,
    req,
  });
  res.status(204).end();
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
