import { describe, expect, it } from "vitest";
import { computeFingerprint, normalizeUrl, sha256Hex } from "./fingerprint";

describe("normalizeUrl (FR-EX-040)", () => {
  it("sorts query params so order doesn't change the fingerprint", () => {
    expect(normalizeUrl("https://x.test/a?b=2&a=1")).toBe("https://x.test/a?a=1&b=2");
    expect(normalizeUrl("https://x.test/a?a=1&b=2")).toBe("https://x.test/a?a=1&b=2");
  });

  it("drops volatile params (utm_*, click ids, cache-busters)", () => {
    expect(normalizeUrl("https://x.test/p?utm_source=g&id=7&_=99")).toBe("https://x.test/p?id=7");
    expect(normalizeUrl("https://x.test/p?gclid=abc&fbclid=def")).toBe("https://x.test/p");
  });

  it("strips a trailing slash except at root", () => {
    expect(normalizeUrl("https://x.test/a/")).toBe("https://x.test/a");
    expect(normalizeUrl("https://x.test/")).toBe("https://x.test/");
  });

  it("drops a scroll-anchor hash but keeps a hash-route", () => {
    expect(normalizeUrl("https://x.test/page#section")).toBe("https://x.test/page");
    expect(normalizeUrl("https://x.test/#/dashboard")).toBe("https://x.test/#/dashboard");
    expect(normalizeUrl("https://x.test/#!/inbox")).toBe("https://x.test/#!/inbox");
  });

  it("keeps any hash when hashRouted is forced", () => {
    expect(normalizeUrl("https://x.test/p#tab2", { hashRouted: true })).toBe(
      "https://x.test/p#tab2",
    );
  });

  it("returns the trimmed input when it isn't a URL", () => {
    expect(normalizeUrl("  not a url  ")).toBe("not a url");
  });
});

describe("sha256Hex (FR-EX-040)", () => {
  it("is deterministic and 64 hex chars", async () => {
    const a = await sha256Hex("hello");
    const b = await sha256Hex("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different input", async () => {
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });
});

describe("computeFingerprint (FR-EX-040 / FR-EX-043)", () => {
  it("is stable for the same URL + DOM signature", async () => {
    const a = await computeFingerprint("https://x.test/p", "body>main>h1");
    const b = await computeFingerprint("https://x.test/p", "body>main>h1");
    expect(a).toBe(b);
  });

  it("ignores volatile URL differences (same state ⇒ same fingerprint)", async () => {
    const a = await computeFingerprint("https://x.test/p?utm_source=g&id=1", "sig");
    const b = await computeFingerprint("https://x.test/p?id=1&utm_source=email", "sig");
    expect(a).toBe(b);
  });

  it("changes when a sub-state opens (modal ⇒ different signature)", async () => {
    const closed = await computeFingerprint("https://x.test/p", "d0|n10|body>main");
    const open = await computeFingerprint("https://x.test/p", "d1|n12|body>main>div:dialog");
    expect(open).not.toBe(closed);
  });

  it("distinguishes different hash-routes on the same path", async () => {
    const a = await computeFingerprint("https://x.test/#/inbox", "sig");
    const b = await computeFingerprint("https://x.test/#/sent", "sig");
    expect(a).not.toBe(b);
  });
});
