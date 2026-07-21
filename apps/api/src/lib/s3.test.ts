import { describe, expect, it } from "vitest";
import { GET_TTL_SEC, PUT_TTL_SEC, missingS3Config, presignGet, presignPut } from "./s3";

// FR-BE-040 / C-05 — the AWS settings are environment-only: there is no
// placeholder credential, so a missing one must surface at boot.
describe("AWS S3 configuration (FR-BE-040)", () => {
  const full = {
    S3_REGION: "ap-south-1",
    S3_BUCKET: "snapcrawl-prod",
    S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
    S3_SECRET_ACCESS_KEY: "secret",
  };

  it("reports nothing missing when every required value is set", () => {
    expect(missingS3Config(full)).toEqual([]);
  });

  it("names each absent setting so the operator knows what to add", () => {
    const { S3_BUCKET: _b, S3_SECRET_ACCESS_KEY: _s, ...partial } = full;
    expect(missingS3Config(partial)).toEqual(["S3_BUCKET", "S3_SECRET_ACCESS_KEY"]);
  });

  it("treats a blank or whitespace value as missing, not as configured", () => {
    expect(missingS3Config({ ...full, S3_ACCESS_KEY_ID: "" })).toEqual(["S3_ACCESS_KEY_ID"]);
    expect(missingS3Config({ ...full, S3_ACCESS_KEY_ID: "   " })).toEqual(["S3_ACCESS_KEY_ID"]);
  });

  it("does not require S3_ENDPOINT — blank is what selects real AWS", () => {
    expect(missingS3Config(full)).not.toContain("S3_ENDPOINT");
  });
});

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
