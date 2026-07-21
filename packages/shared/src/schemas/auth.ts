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

/** login/refresh response: the short-lived access token + user. The refresh
 *  token is delivered separately as an httpOnly cookie (FR-BE-002). Login MUST
 *  always carry a token — this stays required. */
export const authResponseSchema = z.object({
  user: authUserSchema,
  token: z.string(),
});

/**
 * register response (FR-BE-001/008). Normally identical to authResponseSchema —
 * a new account is signed in the instant it exists. But when a deployment
 * requires email verification (FR-BE-008), registration does NOT hand out a
 * session: `token` is absent and `verificationRequired` is true, and the panel
 * shows "check your inbox" instead of redirecting into an app the user cannot
 * yet use. `token` is therefore optional HERE and required on login — the two
 * endpoints have genuinely different guarantees.
 */
export const registerResponseSchema = z.object({
  user: authUserSchema,
  token: z.string().optional(),
  verificationRequired: z.boolean().default(false),
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

/** POST /auth/verify-email — consume the emailed token (FR-BE-008). */
export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

/** POST /auth/resend-verification — request a fresh link (FR-BE-008). Like
 *  forgot-password, keyed on an email and answered identically whether or not
 *  the address exists, so it cannot be used to enumerate accounts. */
export const resendVerificationSchema = z.object({
  email: z.email(),
});

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(120),
});

/** PATCH /users/me body — change your own name and/or password (FR-BE-011).
 *  Composed from updateProfileSchema + changePasswordSchema so the field rules
 *  stay defined in exactly one place. Both halves are optional, but a new
 *  password is only ever accepted alongside the matching current one. */
export const meUpdateSchema = updateProfileSchema
  .partial()
  .extend(changePasswordSchema.partial().shape)
  .refine((v) => v.name !== undefined || v.newPassword !== undefined, {
    message: "Provide a name and/or a new password to update.",
  })
  .refine((v) => v.newPassword === undefined || v.currentPassword !== undefined, {
    path: ["currentPassword"],
    message: "Your current password is required to set a new one.",
  });

export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type RegisterResponse = z.infer<typeof registerResponseSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type MeUpdate = z.infer<typeof meUpdateSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
