import { describe, expect, it } from "vitest";
import { GET_TTL_SEC, PUT_TTL_SEC, presignGet, presignPut } from "./s3";

// FR-BE-040/044 — presigned URLs are signed locally (no network): a PUT for
// upload and a short-lived GET for reads, each bound to the object key.
describe("S3 presigned URLs (FR-BE-040/044)", () => {
  it("signs a time-limited PUT URL for a specific key", async () => {
    const url = await presignPut("sessions/abc/deadbeef.png", "image/png");
    expect(url).toContain("sessions/abc/deadbeef.png");
    expect(url).toMatch(/X-Amz-Signature=/);
    expect(url).toContain(`X-Amz-Expires=${PUT_TTL_SEC}`);
  });

  it("caps the PUT TTL at 10 min and GET TTL at 1 h (NFR-013/FR-BE-044)", () => {
    expect(PUT_TTL_SEC).toBeLessThanOrEqual(600);
    expect(GET_TTL_SEC).toBeLessThanOrEqual(3600);
  });

  it("signs a short-lived GET URL for reads", async () => {
    const url = await presignGet("sessions/abc/deadbeef.png");
    expect(url).toMatch(/X-Amz-Signature=/);
    expect(url).toContain(`X-Amz-Expires=${GET_TTL_SEC}`);
  });
});
