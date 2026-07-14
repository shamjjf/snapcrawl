// Auth + account DTOs (FR-BE-001..005, 010, 011). These become the single
// source of truth once the API routes are migrated off their local schemas.
import { z } from "zod";
import { objectIdSchema } from "./common.js";

export const roleSchema = z.enum(["admin", "member", "viewer"]);

/** The public user shape returned by auth endpoints (never the passwordHash). */
export const authUserSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  email: z.string(),
  role: roleSchema,
});

/** login/register/refresh response: the short-lived access token + user. The
 *  refresh token is delivered separately as an httpOnly cookie (FR-BE-002). */
export const authResponseSchema = z.object({
  user: authUserSchema,
  token: z.string(),
});

export const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.email(),
  password: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(120),
});

export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
