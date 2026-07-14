import { describe, expect, it } from "vitest";
import { effectiveAllowedDomains, hostOf, isInScope } from "./scope";

describe("hostOf (FR-EX-071)", () => {
  it("returns the lowercase hostname without the port", () => {
    expect(hostOf("http://localhost:4000/api")).toBe("localhost");
    expect(hostOf("https://APP.Example.com/x?y=1")).toBe("app.example.com");
  });
  it("returns null for a non-URL", () => {
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("isInScope (FR-EX-010 / FR-EX-071)", () => {
  const scope = ["example.com", "app.internal"];

  it("accepts an exact host match", () => {
    expect(isInScope("https://example.com/a", scope)).toBe(true);
  });
  it("accepts subdomains of an allowed domain", () => {
    expect(isInScope("https://staging.example.com/a", scope)).toBe(true);
    expect(isInScope("https://a.b.app.internal/x", scope)).toBe(true);
  });
  it("rejects an out-of-scope host (and a lookalike suffix)", () => {
    expect(isInScope("https://evil.com/a", scope)).toBe(false);
    expect(isInScope("https://notexample.com/a", scope)).toBe(false); // not a subdomain
  });
  it("ignores the port when matching", () => {
    expect(isInScope("http://example.com:8080/a", scope)).toBe(true);
  });
  it("treats a trailing-dot FQDN as the same host (not off-scope)", () => {
    expect(isInScope("https://example.com./a", scope)).toBe(true);
    expect(isInScope("https://staging.example.com./a", scope)).toBe(true);
  });
  it("treats an empty allow-list as unrestricted", () => {
    expect(isInScope("https://anywhere.test/x", [])).toBe(true);
  });
  it("rejects an unparseable URL", () => {
    expect(isInScope("javascript:void(0)", scope)).toBe(false);
  });
});

describe("effectiveAllowedDomains (FR-EX-071)", () => {
  it("uses the configured domains when present", () => {
    expect(effectiveAllowedDomains(["a.com", "b.com"], "https://a.com")).toEqual(["a.com", "b.com"]);
  });
  it("falls back to the base URL's host when the list is empty", () => {
    expect(effectiveAllowedDomains([], "https://shop.example.com/home")).toEqual([
      "shop.example.com",
    ]);
  });
  it("returns [] when there is nothing to fall back to", () => {
    expect(effectiveAllowedDomains(undefined, undefined)).toEqual([]);
  });
});
