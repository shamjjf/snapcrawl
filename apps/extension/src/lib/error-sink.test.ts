import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCrawlErrors,
  putCrawlError,
  resetCrawlErrors,
  type CrawlErrorEntry,
} from "./error-sink";

// Minimal in-memory chrome.storage.local stub (FR-EX-082 / C-03 persistence).
function stubChromeStorage() {
  let store: Record<string, unknown> = {};
  const local = {
    get: vi.fn(async (key: string) => ({ [key]: store[key] })),
    set: vi.fn(async (obj: Record<string, unknown>) => {
      store = { ...store, ...obj };
    }),
    remove: vi.fn(async () => {}),
  };
  vi.stubGlobal("chrome", { storage: { local } });
  return { reset: () => (store = {}) };
}

describe("error-sink — resilient crawl error log (FR-EX-082)", () => {
  beforeEach(() => stubChromeStorage());
  afterEach(() => vi.unstubAllGlobals());

  const mk = (event: string, at: number): CrawlErrorEntry => ({ level: "error", event, at });

  it("starts empty and appends errors in order", async () => {
    await resetCrawlErrors();
    expect(await getCrawlErrors()).toEqual([]);

    await putCrawlError(mk("capture-failed", 1));
    await putCrawlError(mk("click-failed", 2));
    const got = await getCrawlErrors();
    expect(got.map((e) => e.event)).toEqual(["capture-failed", "click-failed"]);
  });

  it("reset clears a previous run's errors", async () => {
    await putCrawlError(mk("old", 1));
    await resetCrawlErrors();
    expect(await getCrawlErrors()).toEqual([]);
  });

  it("caps the log so a misbehaving page can't grow storage unbounded", async () => {
    await resetCrawlErrors();
    for (let i = 0; i < 260; i++) await putCrawlError(mk(`e${i}`, i));
    const got = await getCrawlErrors();
    expect(got.length).toBe(200);
    // Keeps the most recent entries.
    expect(got.at(-1)?.event).toBe("e259");
    expect(got.at(0)?.event).toBe("e60");
  });
});
