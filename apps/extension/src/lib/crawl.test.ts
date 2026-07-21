import { describe, expect, it } from "vitest";
import {
  canDescend,
  configToRunOptions,
  isDeadTabError,
  limitReason,
  matchCandidate,
  pairKey,
  pickNextForState,
  shouldNavigateInPlace,
  stabilitySettled,
  type ClickStep,
  type RunOverrides,
} from "./crawl";
import type { InjectedCandidate } from "../content/crawl-inject";
import type { CrawlConfig } from "@snapcrawl/shared";

function cand(partial: Partial<InjectedCandidate> & { key: string }): InjectedCandidate {
  return {
    idx: 0,
    tag: "button",
    role: null,
    text: "",
    href: null,
    destructive: false,
    excluded: false,
    submit: false,
    nativeDialog: false,
    similar: false,
    selector: "",
    anchor: null,
    containerKey: null,
    ...partial,
  };
}

describe("pickNextForState — (state, element) selection (FR-EX-030 / FR-EX-041)", () => {
  const list = [cand({ key: "a", idx: 0 }), cand({ key: "b", idx: 1 })];

  it("returns the first untried candidate for the state", () => {
    expect(pickNextForState(list, new Set(), "S1", true)?.key).toBe("a");
  });

  it("skips (state, element) pairs already tried — never re-clicked (EC-016)", () => {
    const tried = new Set([pairKey("S1", "a")]);
    expect(pickNextForState(list, tried, "S1", true)?.key).toBe("b");
  });

  it("keys tried-pairs by state, so the same element is fresh in another state", () => {
    const tried = new Set([pairKey("S1", "a")]);
    expect(pickNextForState(list, tried, "S2", true)?.key).toBe("a");
  });

  it("returns null once every element of the state is tried", () => {
    const tried = new Set([pairKey("S1", "a"), pairKey("S1", "b")]);
    expect(pickNextForState(list, tried, "S1", true)).toBeNull();
  });
});

describe("pickNextForState — safety gating (FR-EX-070)", () => {
  const list = [
    cand({ key: "del", text: "Delete", destructive: true, idx: 0 }),
    cand({ key: "ok", text: "Next", destructive: false, idx: 1 }),
  ];

  it("skips destructive elements when safe mode is ON", () => {
    expect(pickNextForState(list, new Set(), "S", true)?.key).toBe("ok");
  });

  it("allows destructive elements when safe mode is OFF (tester full-test mode)", () => {
    expect(pickNextForState(list, new Set(), "S", false)?.key).toBe("del");
  });
});

describe("matchCandidate — replay re-find (FR-EX-061)", () => {
  const step: ClickStep = { key: "button||Save|", tag: "button", role: null, text: "Save", href: null };

  it("matches by exact key first", () => {
    const list = [cand({ key: "x" }), cand({ key: "button||Save|", idx: 3 })];
    expect(matchCandidate(list, step)?.idx).toBe(3);
  });

  it("falls back to tag/role/text when the key drifted", () => {
    const list = [cand({ key: "changed-key", tag: "button", role: null, text: "Save", idx: 5 })];
    expect(matchCandidate(list, step)?.idx).toBe(5);
  });

  it("returns null when nothing matches ⇒ branch abandoned", () => {
    expect(matchCandidate([cand({ key: "nope", text: "Other" })], step)).toBeNull();
  });

  it("fallback distinguishes same-text links by href (no wrong-item re-find)", () => {
    const viewStep: ClickStep = {
      key: "a||View|https://x.test/item/2",
      tag: "a",
      role: null,
      text: "View",
      href: "https://x.test/item/2",
    };
    const list = [
      cand({ key: "drifted-1", tag: "a", text: "View", href: "https://x.test/item/1", idx: 1 }),
      cand({ key: "drifted-2", tag: "a", text: "View", href: "https://x.test/item/2", idx: 2 }),
    ];
    expect(matchCandidate(list, viewStep)?.idx).toBe(2);
  });
});

describe("limitReason — BFS budgets (FR-EX-030)", () => {
  const base = { shots: 0, maxScreens: 40, elapsedMs: 0, maxDurationMs: 600_000 };

  it("is null while under both budgets", () => {
    expect(limitReason(base)).toBeNull();
  });

  it("hits limit-reached at the screen budget", () => {
    expect(limitReason({ ...base, shots: 40 })).toBe("limit-reached");
  });

  it("hits limit-reached at the time budget", () => {
    expect(limitReason({ ...base, elapsedMs: 600_000 })).toBe("limit-reached");
  });

  it("treats an Infinity duration as no time limit", () => {
    expect(limitReason({ ...base, elapsedMs: 9_999_999, maxDurationMs: Infinity })).toBeNull();
  });
});

describe("canDescend — depth cap (FR-EX-030)", () => {
  it("allows children while parent depth < maxDepth", () => {
    expect(canDescend(0, 3)).toBe(true);
    expect(canDescend(2, 3)).toBe(true);
  });
  it("stops enqueueing at maxDepth", () => {
    expect(canDescend(3, 3)).toBe(false);
    expect(canDescend(4, 3)).toBe(false);
  });
});

describe("configToRunOptions — project config becomes run config (FR-EX-002)", () => {
  // The popup holds no limit state: a run goes until stopped, so the limits come
  // from the project config alone and overrides carry only per-run toggles.
  const overrides: RunOverrides = {
    fullPage: true,
    proCaptureMode: false,
    captureMode: "desktop",
  };

  it("takes blocklist + clickDelay + maskSelectors from the project config and maps overrides", () => {
    const config = {
      maxScreens: 40,
      maxDepth: 4,
      maxDurationMin: 10,
      destructiveTextBlocklist: ["Nuke", "Wipe"],
      clickDelayMs: 800,
      maskSelectors: [".card-number", "[data-pii]"],
    } as unknown as CrawlConfig;
    const opts = configToRunOptions(config, overrides, true);
    expect(opts).toMatchObject({
      maxScreens: 40,
      maxDepth: 4,
      maxDurationMin: 10,
      fullPage: true,
      safeMode: true,
      clickDelayMs: 800,
      blocklist: ["Nuke", "Wipe"],
      maskSelectors: [".card-number", "[data-pii]"],
      proCaptureMode: false,
      captureMode: "desktop",
    });
  });

  it("falls back to the default blocklist when unpaired (config null)", () => {
    const opts = configToRunOptions(null, overrides, false);
    expect(opts.blocklist.length).toBeGreaterThan(0);
    expect(opts.clickDelayMs).toBeUndefined();
    expect(opts.safeMode).toBe(false);
  });

  it("leaves an unpaired run unlimited (null = no ceiling)", () => {
    const opts = configToRunOptions(null, overrides, false);
    expect(opts.maxScreens).toBeNull();
    expect(opts.maxDepth).toBeNull();
    expect(opts.maxDurationMin).toBeNull();
  });
});

describe("shouldNavigateInPlace — same-window crawl (FR-EX-011)", () => {
  it("does not navigate when the tab is already on the start URL (usual case)", () => {
    expect(shouldNavigateInPlace("https://x.test/app", "https://x.test/app")).toBe(false);
  });

  it("navigates in place when the tab is on a different URL", () => {
    expect(shouldNavigateInPlace("https://x.test/other", "https://x.test/app")).toBe(true);
  });

  it("does not navigate when no start URL is given (crawl wherever the tab is)", () => {
    expect(shouldNavigateInPlace("https://x.test/app", "")).toBe(false);
  });
});

describe("isDeadTabError — crashed/closed tab classification (FR-EX-083 / EC-019)", () => {
  it("flags Chrome's raw crashed-renderer string ('Frame with ID 0 was removed.')", () => {
    expect(isDeadTabError("Frame with ID 0 was removed.")).toBe(true);
  });

  it("flags closed / detached / discarded tab errors", () => {
    expect(isDeadTabError("No tab with id: 42.")).toBe(true);
    expect(isDeadTabError("The tab was closed.")).toBe(true);
    expect(isDeadTabError("No frame with id 0 in tab 7")).toBe(true);
    expect(isDeadTabError("The frame was removed.")).toBe(true);
    expect(isDeadTabError("The tab was discarded")).toBe(true);
  });

  it("is case-insensitive and null/empty-safe", () => {
    expect(isDeadTabError("FRAME WITH ID 0 WAS REMOVED")).toBe(true);
    expect(isDeadTabError("")).toBe(false);
    expect(isDeadTabError(undefined as unknown as string)).toBe(false);
  });

  it("does NOT flag ordinary/transient errors (kept as-is for the user)", () => {
    expect(isDeadTabError("Cannot access a chrome:// URL")).toBe(false);
    expect(isDeadTabError("Timed out")).toBe(false);
    expect(isDeadTabError("Network request failed")).toBe(false);
  });
});

describe("stabilitySettled — DOM-quiet AND network-idle (FR-EX-032)", () => {
  it("settles only when quiet long enough AND nothing is in flight", () => {
    expect(stabilitySettled({ inflight: 0, quietElapsedMs: 500, quietThresholdMs: 500 })).toBe(true);
  });
  it("stays unsettled while a request is in flight, even if DOM is quiet", () => {
    expect(stabilitySettled({ inflight: 1, quietElapsedMs: 800, quietThresholdMs: 500 })).toBe(
      false,
    );
  });
  it("stays unsettled until the quiet window elapses", () => {
    expect(stabilitySettled({ inflight: 0, quietElapsedMs: 200, quietThresholdMs: 500 })).toBe(
      false,
    );
  });
});
