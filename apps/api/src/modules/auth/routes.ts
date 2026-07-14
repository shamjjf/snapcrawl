import { Router } from "express";
import { requireAuth } from "../../auth";
import { login, logout, me, refresh, register } from "./controller";

// /api/v1/auth — register/login issue an access token + set the refresh cookie;
// refresh rotates it; logout revokes it (FR-BE-001..004).
const router = Router();
router.post("/register", register);
router.post("/login", login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/me", requireAuth, me);

export default router;
