import { Router } from "express";
import { requireAuth } from "../../auth";
import { getScreen } from "./controller";

// /api/v1/screens — browser (panel) read access to a single screen + signed URL.
const router = Router();
router.use(requireAuth);
router.get("/:id", getScreen);

export default router;
