import type { NextFunction, Response } from "express";
import type { Role } from "@snapcrawl/shared";
import type { AuthedRequest } from "../auth";
import { ApiError } from "../http/envelope";

// Minimal role gate (deny-by-default). Ownership-based checks live in the
// domain services; this covers endpoints that are strictly role-scoped. Full
// FR-BE-006 hardening (per-route matrix) is a later slice.
export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new ApiError(401, "UNAUTHORIZED", "Authentication required."));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ApiError(403, "FORBIDDEN", "Insufficient permissions."));
      return;
    }
    next();
  };
}
