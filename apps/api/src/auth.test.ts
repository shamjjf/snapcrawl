import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { BCRYPT_COST, hashPassword, signAccessToken } from "./auth";

// FR-BE-001 / NFR-010 — passwords hashed with bcrypt cost ≥ 12.
describe("password hashing (FR-BE-001)", () => {
  it("uses a bcrypt work factor of at least 12", () => {
    expect(BCRYPT_COST).toBeGreaterThanOrEqual(12);
    // bcrypt encodes the cost in the hash prefix, e.g. $2b$12$...
    expect(hashPassword("hunter2")).toMatch(/^\$2[aby]\$1[2-9]\$/);
  });
});

// FR-BE-002 — access token is short-lived (≤ 15 min).
describe("access token TTL (FR-BE-002)", () => {
  it("expires within 15 minutes", () => {
    process.env.JWT_SECRET = "test-secret";
    const token = signAccessToken("507f1f77bcf86cd799439011", "member");
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(15 * 60);
  });
});
