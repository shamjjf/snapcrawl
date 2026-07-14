import { defineConfig } from "vitest/config";

// A DOM environment (happy-dom) so the crawl-engine content modules can be
// unit-tested without a real browser. Note: happy-dom has no layout engine, so
// getBoundingClientRect() returns zeros — layout-dependent checks are mocked in
// the tests and verified for real in the browser (the popup "Scan this page").
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
