import { describe, expect, it } from "vitest";
import { extProjectsUrl, normalizeBackendUrl, parseProjectsResponse } from "./pairing";

describe("backend URL handling (FR-EX-001)", () => {
  it("trims whitespace and drops trailing slashes", () => {
    expect(normalizeBackendUrl("  http://localhost:4000/  ")).toBe("http://localhost:4000");
    expect(normalizeBackendUrl("http://localhost:4000///")).toBe("http://localhost:4000");
  });

  it("builds the /api/v1/ext/projects endpoint", () => {
    expect(extProjectsUrl("http://localhost:4000/")).toBe(
      "http://localhost:4000/api/v1/ext/projects",
    );
    expect(extProjectsUrl("https://api.snapcrawl.dev")).toBe(
      "https://api.snapcrawl.dev/api/v1/ext/projects",
    );
  });
});

describe("parseProjectsResponse (FR-EX-001 / FR-EX-002)", () => {
  it("200 returns the items array as projects (FR-EX-002)", () => {
    const r = parseProjectsResponse(200, { items: [{ id: "1" }, { id: "2" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.projects).toHaveLength(2);
  });

  it("200 without items yields an empty project list", () => {
    expect(parseProjectsResponse(200, {})).toEqual({ ok: true, projects: [] });
  });

  it("401 surfaces the envelope message for re-pairing (FR-EX-001)", () => {
    const r = parseProjectsResponse(401, { code: "UNAUTHORIZED", message: "Invalid token." });
    expect(r).toMatchObject({
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid token.",
    });
  });

  it("403 (missing capture scope) is a clear failure (FR-EX-001)", () => {
    const r = parseProjectsResponse(403, { code: "FORBIDDEN", message: "Token lacks capture scope." });
    expect(r).toMatchObject({ ok: false, status: 403, message: "Token lacks capture scope." });
  });

  it("401 with no envelope falls back to a re-pair message", () => {
    const r = parseProjectsResponse(401, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/re-pair/i);
  });

  it("other non-2xx is a generic backend error", () => {
    expect(parseProjectsResponse(500, {})).toMatchObject({ ok: false, status: 500 });
  });
});
