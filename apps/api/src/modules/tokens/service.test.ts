import { describe, expect, it } from "vitest";
import { tokenUsable } from "./service";

// FR-BE-061 — /ext/* auth accepts only live, capture-scoped tokens.
describe("ext token usability & scope (FR-BE-061)", () => {
  const now = 10_000;

  it("accepts a live capture-scoped token", () => {
    expect(tokenUsable({ scopes: ["capture"] }, now).ok).toBe(true);
  });

  it("rejects revoked tokens", () => {
    expect(tokenUsable({ scopes: ["capture"], revokedAt: new Date(0) }, now)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("rejects expired tokens", () => {
    expect(tokenUsable({ scopes: ["capture"], expiresAt: new Date(5_000) }, now)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects tokens without capture scope", () => {
    expect(tokenUsable({ scopes: ["other"] }, now)).toEqual({ ok: false, reason: "scope" });
  });
});
