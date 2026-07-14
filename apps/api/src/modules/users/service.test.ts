import { describe, expect, it } from "vitest";
import { escapeRegex, userListFilter } from "./service";

// FR-BE-010/073 — user list filter: name/email search + _id cursor.
describe("user list filter & search (FR-BE-010/073)", () => {
  it("searches name and email case-insensitively, regex-escaped", () => {
    const f = userListFilter({ search: "a.b+c" });
    expect(f.$or).toEqual([
      { name: { $regex: "a\\.b\\+c", $options: "i" } },
      { email: { $regex: "a\\.b\\+c", $options: "i" } },
    ]);
  });

  it("adds an _id cursor for the next page and ignores blank search", () => {
    const f = userListFilter({ search: "   ", cursor: "0123456789abcdef01234567" });
    expect(f.$or).toBeUndefined();
    expect(f._id).toEqual({ $lt: "0123456789abcdef01234567" });
  });

  it("escapes all regex metacharacters (NFR-010)", () => {
    expect(escapeRegex("x*(y)?[z]")).toBe("x\\*\\(y\\)\\?\\[z\\]");
  });
});
