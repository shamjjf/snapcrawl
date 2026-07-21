import { defineConfig } from "vitest/config";

// Test-only S3 credentials. Presigning is pure local signing — getSignedUrl
// computes an HMAC and never contacts AWS — but the SDK still needs *a*
// credential to sign with, and there is deliberately no fallback in s3.ts any
// more (a placeholder there would hide a missing production variable). Supplying
// them here keeps that strictness in the app while the signing tests stay
// offline. These are not real keys and grant nothing.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: {
      S3_REGION: "us-east-1",
      S3_BUCKET: "snapcrawl-test",
      S3_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
      S3_SECRET_ACCESS_KEY: "test-secret-not-a-real-key",
    },
  },
});
