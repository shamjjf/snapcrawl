import { Router } from "express";
import { requireAuth } from "../../auth";
import { requireRole } from "../../middleware/rbac";
import { createToken, listTokens, revokeToken } from "./controller";

// /api/v1/tokens — authenticated user manages their own pairing tokens; minting
// and revoking need a non-viewer role (FR-BE-006).
const canWrite = requireRole("admin", "member");
const router = Router();
router.use(requireAuth);
router.get("/", listTokens);
router.post("/", canWrite, createToken);
router.delete("/:id", canWrite, revokeToken);

export default router;
