import { describe, expect, it } from "vitest";
import { classifyRefreshToken } from "./service";

// FR-BE-003 — refresh rotation with reuse detection: a rotated (used) token must
// be classified as reuse; a revoked family wins; expiry is honoured.
describe("refresh token classification (FR-BE-003)", () => {
  const now = new Date("2026-07-10T12:00:00Z");
  const future = new Date(now.getTime() + 60_000);
  const past = new Date(now.getTime() - 60_000);

  it("valid when unused, unrevoked, and unexpired", () => {
    expect(classifyRefreshToken({ expiresAt: future }, now)).toBe("valid");
  });

  it("not-found when the token is missing", () => {
    expect(classifyRefreshToken(null, now)).toBe("not-found");
  });

  it("reuse when the token was already used (rotated)", () => {
    expect(classifyRefreshToken({ usedAt: past, expiresAt: future }, now)).toBe("reuse");
  });

  it("revoked wins over reuse", () => {
    expect(
      classifyRefreshToken({ usedAt: past, revokedAt: past, expiresAt: future }, now),
    ).toBe("revoked");
  });

  it("expired when past its expiry", () => {
    expect(classifyRefreshToken({ expiresAt: past }, now)).toBe("expired");
  });
});
