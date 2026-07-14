import { describe, expect, it } from "vitest";
import { checkWindow, type RateWindow } from "./rateLimit";

// FR-BE-062 — per-token rate limit → 429 + Retry-After after the cap.
describe("per-token rate limiting (FR-BE-062)", () => {
  it("allows up to the limit, then blocks with a positive retry-after", () => {
    const limit = 3;
    const windowMs = 60_000;
    const now = 1_000;
    let state: RateWindow | undefined;

    for (let i = 0; i < limit; i++) {
      const r = checkWindow(state, now, limit, windowMs);
      state = r.window;
      expect(r.allowed).toBe(true);
    }
    const over = checkWindow(state, now, limit, windowMs);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
    expect(over.remaining).toBe(0);
  });

  it("resets once the window elapses", () => {
    const limit = 2;
    const windowMs = 1_000;
    let state: RateWindow | undefined;

    checkWindow(state, 0, limit, windowMs).allowed; // 1
    state = checkWindow(state, 0, limit, windowMs).window; // count 1
    state = checkWindow(state, 0, limit, windowMs).window; // count 2
    const blocked = checkWindow(state, 0, limit, windowMs); // count 3 → blocked
    expect(blocked.allowed).toBe(false);

    const afterReset = checkWindow(blocked.window, 2_000, limit, windowMs);
    expect(afterReset.allowed).toBe(true);
  });
});
