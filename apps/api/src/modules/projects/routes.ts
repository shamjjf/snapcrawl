import { Router } from "express";
import { requireAuth } from "../../auth";
import { requireRole } from "../../middleware/rbac";
import {
  addMember,
  authoriseProject,
  createProject,
  deleteProject,
  getProject,
  listDeletedProjects,
  listMembers,
  listProjects,
  removeMember,
  restoreProject,
  updateProject,
} from "./controller";

// /api/v1/projects — deny-by-default: every route needs auth; writes need a
// non-viewer role (FR-BE-006). Ownership is still enforced in the service.
const canWrite = requireRole("admin", "member");
const router = Router();
router.use(requireAuth);
router.get("/", listProjects);
router.post("/", canWrite, createProject);
// Before /:id — otherwise "trash" is parsed as a project id and 400s on the
// ObjectId check. Express matches in declaration order.
router.get("/trash", listDeletedProjects);
router.get("/:id", getProject);
router.patch("/:id", canWrite, updateProject);
router.delete("/:id", canWrite, deleteProject);
router.post("/:id/restore", canWrite, restoreProject);
// The authorised-use attestation (NFR-020). `canWrite` on purpose: a viewer
// cannot start a crawl, so a viewer must not be able to attest that one is
// permitted.
router.post("/:id/authorise", canWrite, authoriseProject);
// Membership (FR-BE-024). Reading the people list is open to anyone who can see
// the project; changing it is owner/admin, enforced in the controller.
router.get("/:id/members", listMembers);
router.post("/:id/members", canWrite, addMember);
router.delete("/:id/members/:userId", canWrite, removeMember);

export default router;
