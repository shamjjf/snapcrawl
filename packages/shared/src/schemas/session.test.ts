import { describe, expect, it } from "vitest";
import { sessionLogBatchSchema, sessionLogInputSchema } from "./session.js";

describe("sessionLogInputSchema — extension error log line (FR-EX-082/084)", () => {
  it("defaults level to 'error' and requires a non-empty event", () => {
    const parsed = sessionLogInputSchema.parse({ event: "capture-failed" });
    expect(parsed.level).toBe("error");
    expect(() => sessionLogInputSchema.parse({ event: "" })).toThrow();
  });

  it("keeps arbitrary JSON context and coerces `at` to a Date", () => {
    const parsed = sessionLogInputSchema.parse({
      event: "click-failed",
      context: { url: "https://x.test/a", element: "Delete" },
      at: "2026-07-14T10:00:00.000Z",
    });
    expect(parsed.context).toEqual({ url: "https://x.test/a", element: "Delete" });
    expect(parsed.at).toBeInstanceOf(Date);
  });

  it("rejects an unknown level", () => {
    expect(() => sessionLogInputSchema.parse({ event: "x", level: "debug" })).toThrow();
  });
});

describe("sessionLogBatchSchema — batched upload body (FR-EX-084)", () => {
  const sessionId = "507f1f77bcf86cd799439011";

  it("accepts a session-scoped batch of 1..100 lines", () => {
    const ok = sessionLogBatchSchema.parse({
      sessionId,
      logs: [{ event: "a" }, { event: "b", level: "warn" }],
    });
    expect(ok.logs).toHaveLength(2);
  });

  it("rejects an empty batch and a batch over 100 lines", () => {
    expect(() => sessionLogBatchSchema.parse({ sessionId, logs: [] })).toThrow();
    const tooMany = Array.from({ length: 101 }, () => ({ event: "x" }));
    expect(() => sessionLogBatchSchema.parse({ sessionId, logs: tooMany })).toThrow();
  });

  it("rejects a non-ObjectId sessionId", () => {
    expect(() => sessionLogBatchSchema.parse({ sessionId: "nope", logs: [{ event: "x" }] })).toThrow();
  });
});
