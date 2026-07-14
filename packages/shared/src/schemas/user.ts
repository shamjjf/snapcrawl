// Admin user-management DTOs + response entity (FR-BE-010, SRS §8.1). The panel
// lists/creates/updates users; passwordHash is NEVER part of any response.
import { z } from "zod";
import { roleSchema } from "./auth.js";
import { cursorQuerySchema, objectIdSchema } from "./common.js";

export const userStatusSchema = z.enum(["active", "deactivated"]);

/** GET /users query: cursor pagination + case-insensitive name/email search. */
export const userListQuerySchema = cursorQuerySchema.extend({
  cursor: objectIdSchema.optional(),
  search: z.string().trim().max(200).optional(),
});

/** Admin-facing user record (SRS §8.1). Never includes the passwordHash. */
export const adminUserSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  lastLoginAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
});

/** Admin creates a user with an initial role + password (FR-BE-010 / FR-BE-001). */
export const userCreateSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.email(),
  password: z.string().min(8).max(200),
  role: roleSchema.default("member"),
});

/** Admin changes a user's role and/or activation status (FR-BE-010). */
export const userUpdateSchema = z
  .object({
    role: roleSchema.optional(),
    status: userStatusSchema.optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: "Provide a role and/or status to update.",
  });

export type UserStatus = z.infer<typeof userStatusSchema>;
export type UserListQuery = z.infer<typeof userListQuerySchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type UserCreate = z.infer<typeof userCreateSchema>;
export type UserUpdate = z.infer<typeof userUpdateSchema>;
