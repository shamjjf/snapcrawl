import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "../../lib/s3";
import { screenKey, screenListFilter, thumbKeyOf } from "./service";

// FR-BE-040/041 — server-generated object keys and the 15 MB cap.
describe("capture object keys (FR-BE-040)", () => {
  it("namespaces by session and picks the extension from content type", () => {
    expect(screenKey("sess1", "abcDEF123", "image/png")).toBe("sessions/sess1/abcDEF123.png");
    expect(screenKey("sess1", "abcDEF123", "image/webp")).toBe("sessions/sess1/abcDEF123.webp");
  });

  it("sanitizes the fingerprint into a safe key segment", () => {
    expect(screenKey("s", "../../etc/passwd", "image/png")).toBe("sessions/s/etcpasswd.png");
    expect(screenKey("s", "", "image/png")).toBe("sessions/s/state.png");
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
