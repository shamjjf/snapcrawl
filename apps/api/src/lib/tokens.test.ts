import { describe, expect, it } from "vitest";
import { generateRawToken, hashToken } from "./tokens";

// FR-BE-060 — raw token shown once; only its SHA-256 hash is stored.
describe("extension token secrets (FR-BE-060)", () => {
  it("generates unique, prefixed, high-entropy raw tokens", () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a.startsWith("sc_")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(24);
  });

  it("hashes deterministically to 64-hex; the hash does not reveal the raw token", () => {
    const raw = generateRawToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
    expect(hashToken(raw)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(raw)).not.toContain(raw.slice(3));
  });

  it("maps different raw tokens to different hashes", () => {
    expect(hashToken("alpha")).not.toBe(hashToken("beta"));
  });
});
