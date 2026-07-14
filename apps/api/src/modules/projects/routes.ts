import { Router } from "express";
import { requireAuth } from "../../auth";
import { requireRole } from "../../middleware/rbac";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "./controller";

// /api/v1/projects — deny-by-default: every route needs auth; writes need a
// non-viewer role (FR-BE-006). Ownership is still enforced in the service.
const canWrite = requireRole("admin", "member");
const router = Router();
router.use(requireAuth);
router.get("/", listProjects);
router.post("/", canWrite, createProject);
router.get("/:id", getProject);
router.patch("/:id", canWrite, updateProject);
router.delete("/:id", canWrite, deleteProject);

export default router;
