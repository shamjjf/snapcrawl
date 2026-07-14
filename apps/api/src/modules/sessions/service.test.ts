import { describe, expect, it } from "vitest";
import type { CrawlConfig, SessionLogInput } from "@snapcrawl/shared";
import {
  buildGraph,
  buildSessionLogDocs,
  canCancel,
  canTransition,
  isStale,
  isTerminal,
  snapshotConfig,
  staleFilter,
} from "./service";

// FR-BE-031 — session state machine pending→running→(paused⇄running)→terminal.
describe("session state machine (FR-BE-031)", () => {
  it("allows the documented transitions", () => {
    expect(canTransition("pending", "running")).toBe(true);
    expect(canTransition("running", "paused")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("paused", "cancelled")).toBe(true);
  });

  it("rejects illegal and terminal transitions", () => {
    expect(canTransition("pending", "paused")).toBe(false);
    expect(canTransition("pending", "completed")).toBe(false);
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(false);
  });

  it("identifies terminal states", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});

// FR-BE-030 — immutable snapshot; overrides may only tighten limits.
describe("session config snapshot (FR-BE-030)", () => {
  const base = { maxDepth: 5, maxScreens: 200, fullPage: false } as unknown as CrawlConfig;

  it("clamps overrides to the project limits and never raises them", () => {
    expect(snapshotConfig(base, { maxDepth: 3 }).maxDepth).toBe(3);
    expect(snapshotConfig(base, { maxDepth: 99 }).maxDepth).toBe(5);
    expect(snapshotConfig(base, { maxScreens: 500 }).maxScreens).toBe(200);
    expect(snapshotConfig(base, { fullPage: true }).fullPage).toBe(true);
  });

  it("returns the base unchanged when no overrides are given", () => {
    expect(snapshotConfig(base)).toEqual(base);
  });
});

// FR-BE-032 — stale detection for the heartbeat sweep.
describe("stale session detection (FR-BE-032)", () => {
  const now = new Date("2026-07-10T12:00:00Z");
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it("flags a running session with no heartbeat for > 10 min", () => {
    expect(isStale({ status: "running", lastHeartbeatAt: minsAgo(11) }, now)).toBe(true);
    expect(isStale({ status: "running", lastHeartbeatAt: minsAgo(5) }, now)).toBe(false);
  });

  it("falls back to startedAt when it never heartbeated", () => {
    expect(isStale({ status: "running", startedAt: minsAgo(20) }, now)).toBe(true);
    expect(isStale({ status: "running", startedAt: minsAgo(1) }, now)).toBe(false);
  });

  it("never flags non-running sessions", () => {
    expect(isStale({ status: "paused", lastHeartbeatAt: minsAgo(60) }, now)).toBe(false);
    expect(isStale({ status: "completed", lastHeartbeatAt: minsAgo(60) }, now)).toBe(false);
  });

  it("builds a filter for running + stale sessions", () => {
    const f = staleFilter(now);
    expect(f.status).toBe("running");
    expect(Array.isArray(f.$or)).toBe(true);
  });
});

// FR-BE-034 — cancellation is only allowed on active sessions.
describe("cancellation guard (FR-BE-034)", () => {
  it("allows cancel while active, rejects once terminal", () => {
    expect(canCancel("running")).toBe(true);
    expect(canCancel("paused")).toBe(true);
    expect(canCancel("pending")).toBe(true);
    expect(canCancel("completed")).toBe(false);
    expect(canCancel("cancelled")).toBe(false);
    expect(canCancel("failed")).toBe(false);
  });
});

// FR-EX-082/084 — batched session-log ingest ordering.
describe("session-log doc assembly (FR-EX-082/084)", () => {
  const now = new Date("2026-07-14T10:00:00Z");
  const logs: SessionLogInput[] = [
    { level: "error", event: "capture-failed", context: { url: "/a" } },
    { level: "error", event: "click-failed", at: new Date("2026-07-14T09:59:00Z") },
  ];

  it("assigns monotonic seq continuing from the session's current line count", () => {
    const docs = buildSessionLogDocs("sess1", 5, logs, now);
    expect(docs.map((d) => d.seq)).toEqual([5, 6]);
    expect(docs[0].sessionId).toBe("sess1");
  });

  it("keeps context and prefers the client `at`, falling back to now", () => {
    const docs = buildSessionLogDocs("sess1", 0, logs, now);
    expect(docs[0].context).toEqual({ url: "/a" });
    expect(docs[0].at).toBe(now); // no client `at` → server clock
    expect(docs[1].at).toEqual(new Date("2026-07-14T09:59:00Z")); // client `at` kept
  });

  it("maps an empty batch to an empty doc list", () => {
    expect(buildSessionLogDocs("s", 3, [], now)).toEqual([]);
  });
});

// FR-BE-050 — render-ready graph assembly.
describe("sitemap graph assembly (FR-BE-050)", () => {
  it("maps screens to nodes (with thumbs) and edges to transitions", () => {
    const screens = [
      { _id: "n1", url: "/home", title: "Home", depth: 0 },
      { _id: "n2", url: "/settings", title: "Settings", depth: 1 },
    ];
    const edges = [
      { _id: "e1", fromScreenId: "n1", toScreenId: "n2", element: { selector: "#s", tag: "a" }, kind: "navigation" },
      { _id: "e2", fromScreenId: "n1", toScreenId: null, element: null, kind: "dead" },
    ];
    const thumbs = new Map([["n1", "https://cdn/n1.png"]]);
    const g = buildGraph(screens, edges, thumbs);

    expect(g.nodes).toEqual([
      { id: "n1", url: "/home", title: "Home", depth: 0, thumbUrl: "https://cdn/n1.png" },
      { id: "n2", url: "/settings", title: "Settings", depth: 1, thumbUrl: null },
    ]);
    expect(g.edges[0]).toMatchObject({ id: "e1", from: "n1", to: "n2", kind: "navigation" });
    expect(g.edges[0].element).toEqual({ selector: "#s", text: "", tag: "a", role: null });
    expect(g.edges[1]).toMatchObject({ id: "e2", from: "n1", to: null, element: null, kind: "dead" });
  });
});
