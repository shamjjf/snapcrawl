import { describe, expect, it } from "vitest";
import { crawlOrigins, injectionErrorMessage } from "./host-access";

describe("crawlOrigins (FR-EX-011/015)", () => {
  it("covers the start URL's host and its subdomains", () => {
    expect(crawlOrigins("https://lifesaverarmy.com/", [])).toEqual([
      "*://lifesaverarmy.com/*",
      "*://*.lifesaverarmy.com/*",
    ]);
  });

  it("adds every scope domain (host + subdomains), de-duplicated", () => {
    const o = crawlOrigins("https://app.example.com/x", ["example.com"]);
    expect(o).toContain("*://app.example.com/*");
    expect(o).toContain("*://*.app.example.com/*");
    expect(o).toContain("*://example.com/*");
    expect(o).toContain("*://*.example.com/*");
    // No duplicates.
    expect(new Set(o).size).toBe(o.length);
  });

  it("normalises leading/trailing dots in scope domains", () => {
    expect(crawlOrigins("https://x.test/", [".example.com."])).toContain("*://example.com/*");
  });

  it("falls back to scope domains when the start URL isn't parseable", () => {
    expect(crawlOrigins("not-a-url", ["example.com"])).toEqual([
      "*://example.com/*",
      "*://*.example.com/*",
    ]);
  });
});

describe("injectionErrorMessage (FR-EX-011)", () => {
  it("names the site for a normal http(s) page that couldn't be accessed", () => {
    expect(injectionErrorMessage("https://lifesaverarmy.com/")).toMatch(
      /couldn't access lifesaverarmy\.com/i,
    );
    expect(injectionErrorMessage("https://lifesaverarmy.com/")).not.toMatch(/chrome:\/\//);
  });

  it("keeps the restricted-page message for genuinely restricted schemes", () => {
    for (const url of [
      "chrome://extensions",
      "chrome-extension://abc/page.html",
      "about:blank",
      "edge://settings",
      "view-source:https://x.test",
    ]) {
      expect(injectionErrorMessage(url)).toMatch(/restricted page/i);
    }
  });

  it("treats the Chrome Web Store as restricted", () => {
    expect(injectionErrorMessage("https://chromewebstore.google.com/detail/x")).toMatch(
      /restricted page/i,
    );
    expect(injectionErrorMessage("https://chrome.google.com/webstore/detail/x")).toMatch(
      /restricted page/i,
    );
  });

  it("gives a generic message when the URL is unknown", () => {
    expect(injectionErrorMessage("")).toMatch(/couldn't access this page/i);
  });
});
