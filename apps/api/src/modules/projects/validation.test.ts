import { describe, expect, it } from "vitest";
import { validateProjectConfig } from "./validation";

// FR-BE-023 — config validation on write → field-level errors.
describe("project config write validation (FR-BE-023)", () => {
  const base = "https://staging.acme.com/app";

  it("requires at least one allowed domain", () => {
    const details = validateProjectConfig(base, { allowedDomains: [] });
    expect(details.some((d) => d.path === "config.allowedDomains")).toBe(true);
  });

  it("requires the base URL host to be within allowedDomains (incl. subdomains)", () => {
    expect(validateProjectConfig(base, { allowedDomains: ["other.com"] }).length).toBeGreaterThan(0);
    expect(validateProjectConfig(base, { allowedDomains: ["acme.com"] })).toEqual([]);
    expect(validateProjectConfig(base, { allowedDomains: ["staging.acme.com"] })).toEqual([]);
  });

  it("rejects an invalid exclude-URL regex with a field path", () => {
    const details = validateProjectConfig(base, {
      allowedDomains: ["acme.com"],
      excludeUrlPatterns: ["(unclosed"],
    });
    expect(details.some((d) => d.path.startsWith("config.excludeUrlPatterns"))).toBe(true);
  });

  it("accepts a fully valid config", () => {
    expect(
      validateProjectConfig(base, {
        allowedDomains: ["acme.com"],
        excludeUrlPatterns: ["/logout", "^/admin"],
      }),
    ).toEqual([]);
  });
});
