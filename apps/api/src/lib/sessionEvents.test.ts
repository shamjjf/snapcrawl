import { describe, expect, it, vi } from "vitest";
import type { Session } from "@snapcrawl/shared";
import { publishSessionEvent, subscribeSessionEvents } from "./sessionEvents";

const fakeSession = { id: "s1", status: "running" } as unknown as Session;

// FR-BE-036 — in-process pub/sub backing the SSE stream.
describe("session event bus (FR-BE-036)", () => {
  it("delivers events to subscribers of that session only", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeSessionEvents("s1", a);
    subscribeSessionEvents("s2", b);

    publishSessionEvent("s1", { type: "stats", session: fakeSession });
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({ type: "stats", session: fakeSession });
    expect(b).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionEvents("s3", listener);
    publishSessionEvent("s3", { type: "status", session: fakeSession });
    unsubscribe();
    publishSessionEvent("s3", { type: "status", session: fakeSession });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fans out to multiple subscribers of the same session", () => {
    const one = vi.fn();
    const two = vi.fn();
    subscribeSessionEvents("s4", one);
    subscribeSessionEvents("s4", two);
    publishSessionEvent("s4", { type: "snapshot", session: fakeSession });
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });
});
