import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../auth";
import { ApiError } from "../http/envelope";
import { requireRole } from "./rbac";

function runGate(role: string | undefined): unknown {
  const req = {
    user: role ? { id: "u1", name: "U", email: "u@x.dev", role } : undefined,
  } as unknown as AuthedRequest;
  const next = vi.fn();
  requireRole("admin", "member")(req, {} as Response, next);
  return next.mock.calls[0]?.[0];
}

// FR-BE-006 — RBAC deny-by-default; viewers are read-only on write routes.
describe("requireRole (FR-BE-006)", () => {
  it("lets members and admins through", () => {
    expect(runGate("member")).toBeUndefined();
    expect(runGate("admin")).toBeUndefined();
  });

  it("blocks viewers with 403", () => {
    const err = runGate("viewer");
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it("blocks the unauthenticated with 401", () => {
    expect((runGate(undefined) as ApiError).status).toBe(401);
  });
});
