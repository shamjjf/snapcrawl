import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "../../lib/s3";
import { screenKey, screenListFilter, thumbKeyOf } from "./service";

// FR-BE-040/041 — server-generated object keys and the 15 MB cap.
describe("capture object keys (FR-BE-040)", () => {
  it("namespaces by session and picks the extension from content type", () => {
    expect(screenKey("sess1", "abcDEF123", "image/png")).toMatch(
      /^sessions\/sess1\/[0-9a-f]{32}\.png$/,
    );
    expect(screenKey("sess1", "abcDEF123", "image/webp")).toMatch(
      /^sessions\/sess1\/[0-9a-f]{32}\.webp$/,
    );
    // Content type selects only the extension — the same state digests alike.
    const png = screenKey("sess1", "abcDEF123", "image/png");
    const webp = screenKey("sess1", "abcDEF123", "image/webp");
    expect(png.replace(/\.png$/, "")).toBe(webp.replace(/\.webp$/, ""));
  });

  it("digests the fingerprint into a path-safe key segment", () => {
    // The segment is a hex digest, so no separator or dot-segment can survive
    // from the fingerprint no matter what the extension sends. Asserting the
    // shape rather than a literal digest keeps this honest if the hash changes.
    expect(screenKey("s", "../../etc/passwd", "image/png")).toMatch(
      /^sessions\/s\/[0-9a-f]{32}\.png$/,
    );
    expect(screenKey("s", "", "image/png")).toMatch(/^sessions\/s\/[0-9a-f]{32}\.png$/);
  });

  it("is deterministic per state and distinct across states", () => {
    expect(screenKey("s", "a", "image/png")).toBe(screenKey("s", "a", "image/png"));
    expect(screenKey("s", "a", "image/png")).not.toBe(screenKey("s", "b", "image/png"));
    // Session scoping is what stops one session naming another's object.
    expect(screenKey("s1", "a", "image/png")).not.toBe(screenKey("s2", "a", "image/png"));
  });

  it("caps uploads at 15 MB (NFR-013)", () => {
    expect(MAX_UPLOAD_BYTES).toBe(15 * 1024 * 1024);
  });
});

// FR-BE-041/FR-AP-040 — gallery list filter (session scope + url/depth/duplicate + cursor).
describe("gallery screen list filter (FR-AP-040)", () => {
  it("scopes to the session and applies gallery filters", () => {
    const f = screenListFilter("sess1", {
      url: "set.tin(gs",
      depth: 2,
      duplicate: true,
      cursor: "0123456789abcdef01234567",
    });
    expect(f.sessionId).toBe("sess1");
    expect(f.url).toEqual({ $regex: "set\\.tin\\(gs", $options: "i" });
    expect(f.depth).toBe(2);
    expect(f.isDuplicate).toBe(true);
    expect(f._id).toEqual({ $lt: "0123456789abcdef01234567" });
  });

  it("omits absent filters (bare session scope) and can filter non-duplicates", () => {
    expect(screenListFilter("s", {})).toEqual({ sessionId: "s" });
    expect(screenListFilter("s", { duplicate: false }).isDuplicate).toBe(false);
  });
});

// FR-BE-042 — thumbnail key falls back to the full image until real thumbs land.
describe("thumbnail key fallback (FR-BE-042)", () => {
  it("prefers thumbKey, falls back to s3Key", () => {
    expect(thumbKeyOf({ thumbKey: "t.webp", s3Key: "f.png" })).toBe("t.webp");
    expect(thumbKeyOf({ thumbKey: undefined, s3Key: "f.png" })).toBe("f.png");
  });
});
