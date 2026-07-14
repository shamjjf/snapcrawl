import { Router } from "express";
import { requireExtToken } from "../../middleware/extAuth";
import { perTokenRateLimit } from "../../middleware/rateLimit";
import { completeCapture, presignCapture, uploadEdges } from "../captures/controller";
import { createSession, updateSession, uploadLogs } from "../sessions/ext-controller";
import { extProjects } from "./controller";

// /api/v1/ext/* — extension-token auth + per-token rate limit (FR-BE-061/062).
// Capture-scope surface only: no user/project administration is mounted here.
const router = Router();
router.use(requireExtToken, perTokenRateLimit(300));
router.get("/projects", extProjects);
router.post("/sessions", createSession);
router.patch("/sessions/:id", updateSession);
// Presign is capped tighter than the general limit (FR-BE-062).
router.post("/captures/presign", perTokenRateLimit(120), presignCapture);
router.post("/captures/complete", completeCapture);
router.post("/edges", uploadEdges);
router.post("/logs", uploadLogs);

export default router;
