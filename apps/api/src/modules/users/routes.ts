import { Router } from "express";
import { requireAuth } from "../../auth";
import { requireRole } from "../../middleware/rbac";
import { createUser, getMe, listUsers, updateMe, updateUser } from "./controller";

// /api/v1/users — every route needs auth; user ADMINISTRATION additionally
// needs the admin role (FR-BE-010, deny-by-default). Self-service /me is any
// signed-in user, including a viewer (FR-BE-011).
const adminOnly = requireRole("admin");
const router = Router();
router.use(requireAuth);

// `/me` MUST be declared before `/:id`: ":id" happily matches the literal
// string "me", so the order is what keeps PATCH /users/me out of updateUser
// (and out of the admin guard).
router.get("/me", getMe);
router.patch("/me", updateMe);

router.get("/", adminOnly, listUsers);
router.post("/", adminOnly, createUser);
router.patch("/:id", adminOnly, updateUser);

export default router;
