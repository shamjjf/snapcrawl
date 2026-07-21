import { Router } from "express";
import { requireAuth, requireAuthSse } from "../../auth";
import { rateLimit, userKey } from "../../middleware/rateLimit";
import { listSessionScreens } from "../captures/controller";
import {
  cancelSession,
  createSessionExport,
  getSession,
  getSessionCoverage,
  getSessionExport,
  getSessionGraph,
  listSessionLogs,
  listSessions,
  sessionEvents,
} from "./controller";

// /api/v1/sessions — browser (panel) access, authenticated + visibility-scoped.
// Auth is per-route so the SSE stream can use the query-token variant.

/** Building a session ZIP streams every screenshot through the process and does
 *  a multipart S3 upload — the most expensive thing a panel user can trigger,
 *  and it's pollable, so cap how often ONE user can kick off a fresh build
 *  (FR-AP-042). 10/10 min per user is generous for real use: a finished job is
 *  reused rather than rebuilt, so normal polling never spends against this. The
 *  GET poll is left unlimited — it's a cheap read. Keyed per user, after
 *  requireAuth, so userKey always sees a resolved user. */
const exportLimit = rateLimit({
  limit: 10,
  windowMs: 10 * 60_000,
  key: userKey,
  message: "Too many export requests. Please wait a moment and try again.",
});

const router = Router();
router.get("/", requireAuth, listSessions);
router.get("/:id", requireAuth, getSession);
router.get("/:id/screens", requireAuth, listSessionScreens);
router.get("/:id/logs", requireAuth, listSessionLogs);
router.get("/:id/coverage", requireAuth, getSessionCoverage);
router.get("/:id/graph", requireAuth, getSessionGraph);
router.post("/:id/cancel", requireAuth, cancelSession);
// ZIP export (FR-AP-042): POST starts the async build (rate-limited — it's the
// most expensive user-triggered action), GET polls it (cheap, unlimited).
router.post("/:id/export", requireAuth, exportLimit, createSessionExport);
router.get("/:id/exports/:exportId", requireAuth, getSessionExport);
router.get("/:id/events", requireAuthSse, sessionEvents);

export default router;
