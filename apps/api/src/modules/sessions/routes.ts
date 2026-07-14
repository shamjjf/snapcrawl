import { Router } from "express";
import { requireAuth, requireAuthSse } from "../../auth";
import { listSessionScreens } from "../captures/controller";
import {
  cancelSession,
  getSession,
  getSessionGraph,
  listSessionLogs,
  listSessions,
  sessionEvents,
} from "./controller";

// /api/v1/sessions — browser (panel) access, authenticated + visibility-scoped.
// Auth is per-route so the SSE stream can use the query-token variant.
const router = Router();
router.get("/", requireAuth, listSessions);
router.get("/:id", requireAuth, getSession);
router.get("/:id/screens", requireAuth, listSessionScreens);
router.get("/:id/logs", requireAuth, listSessionLogs);
router.get("/:id/graph", requireAuth, getSessionGraph);
router.post("/:id/cancel", requireAuth, cancelSession);
router.get("/:id/events", requireAuthSse, sessionEvents);

export default router;
