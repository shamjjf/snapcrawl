import { Router } from "express";
import { requireAuth } from "../../auth";
import { deleteScreen, getScreen } from "./controller";

// /api/v1/screens — browser (panel) read access to a single screen + signed URL.
const router = Router();
router.use(requireAuth);
router.get("/:id", getScreen);
// Delete a single screenshot: DB row + S3 objects (FR-AP-043). Owner/admin only,
// enforced in the controller against the screen's project.
router.delete("/:id", deleteScreen);

export default router;
