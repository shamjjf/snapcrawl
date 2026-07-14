import type { NextFunction, Request, Response } from "express";
import { z, type ZodError, type ZodType } from "zod";
import { objectIdSchema, type ErrorDetail, type User } from "@snapcrawl/shared";
import type { AuthedRequest } from "../auth";
import { ApiError } from "./envelope";

/** Map a ZodError to the envelope's `details[]` (FR-BE-070). */
export function mapZodIssues(error: ZodError): ErrorDetail[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Validate `data` against a shared Zod schema or throw a 400 ApiError. */
export function parseInput<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid input.", mapZodIssues(parsed.error));
  }
  return parsed.data;
}

/** Wrap an async handler so rejected promises reach the central error handler. */
export function asyncHandler<R extends Request = Request>(
  fn: (req: R, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req as R, res, next).catch(next);
  };
}

/** Narrow an authenticated request to its user or throw 401 (deny-by-default). */
export function requireUser(req: AuthedRequest): User {
  if (!req.user) throw new ApiError(401, "UNAUTHORIZED", "Authentication required.");
  return req.user;
}

/** `:id` path-param schema — rejects malformed ObjectIds before they hit Mongo. */
export const idParam = z.object({ id: objectIdSchema });
