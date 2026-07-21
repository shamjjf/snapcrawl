import { describe, expect, it } from "vitest";
import type { User } from "@snapcrawl/shared";
import {
  canManage,
  escapeRegex,
  mergeConfigPatch,
  projectListFilter,
  visibilityFilter,
} from "./service";

const admin: User = { id: "a1", name: "Admin", email: "a@x.dev", role: "admin" };
const member: User = { id: "m1", name: "Mem", email: "m@x.dev", role: "member" };

// FR-BE-020 — member-scoped visibility; admins see all.
describe("project visibility & management (FR-BE-020)", () => {
  // Every filter carries `deletedAt: null` so soft-deleted projects stay hidden
  // from every project-scoped read (FR-BE-025) — an admin is unrestricted by
  // ownership, not by deletion.
  it("gives admins a filter unrestricted by ownership", () => {
    expect(visibilityFilter(admin)).toEqual({ deletedAt: null });
  });

  it("scopes members to owned or assigned projects", () => {
    expect(visibilityFilter(member)).toEqual({
      deletedAt: null,
      $or: [{ ownerId: "m1" }, { memberIds: "m1" }],
    });
  });

  it("lets only the owner or an admin manage a project", () => {
    expect(canManage(member, { ownerId: "m1" })).toBe(true);
    expect(canManage(member, { ownerId: "x9" })).toBe(false);
    expect(canManage(admin, { ownerId: "x9" })).toBe(true);
  });
});

// FR-BE-021/023 — a partial config PATCH must not reset untouched fields.
// (crawlConfigSchema.partial() re-injects defaults, so only sent keys may win.)
describe("partial config merge on update (FR-BE-021)", () => {
  it("overlays only the keys the client sent, keeping the rest", () => {
    const current = { allowedDomains: ["acme.com"], maxDepth: 5, fullPage: false };
    const parsedWithDefaults = { allowedDomains: [], maxDepth: 8, fullPage: false };
    const merged = mergeConfigPatch(current, parsedWithDefaults, ["maxDepth"]);
    expect(merged).toEqual({ allowedDomains: ["acme.com"], maxDepth: 8, fullPage: false });
  });
});

// FR-BE-020/073 — list filter: visibility + escaped name search + _id cursor.
describe("project list filter & search (FR-BE-020/073)", () => {
  it("adds a case-insensitive, regex-escaped name search", () => {
    const f = projectListFilter(member, { search: "a.c(me" });
    expect(f).toMatchObject({
      $or: [{ ownerId: "m1" }, { memberIds: "m1" }],
      name: { $regex: "a\\.c\\(me", $options: "i" },
    });
  });

  it("adds an _id cursor for the next page and trims blank search", () => {
    const f = projectListFilter(admin, { search: "   ", cursor: "0123456789abcdef01234567" });
    expect(f.name).toBeUndefined();
    expect(f._id).toEqual({ $lt: "0123456789abcdef01234567" });
  });

  it("escapes all regex metacharacters", () => {
    expect(escapeRegex("a+b*c?[d]")).toBe("a\\+b\\*c\\?\\[d\\]");
  });
});
