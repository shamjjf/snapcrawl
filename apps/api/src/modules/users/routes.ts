import { Router } from "express";
import { requireAuth } from "../../auth";
import { requireRole } from "../../middleware/rbac";
import { createUser, listUsers, updateUser } from "./controller";

// /api/v1/users — admin-only user administration (FR-BE-010, deny-by-default).
const router = Router();
router.use(requireAuth, requireRole("admin"));
router.get("/", listUsers);
router.post("/", createUser);
router.patch("/:id", updateUser);

export default router;
