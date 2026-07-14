import { defineManifest } from "@crxjs/vite-plugin";

// MV3 manifest for the SnapCrawl capture agent.
// Permissions are the minimum the crawl engine needs (FR-EX-015); host access
// is granted per-project at runtime, never at install (FR-EX-015, C-07).
export default defineManifest({
  manifest_version: 3,
  name: "SnapCrawl",
  version: "0.0.0",
  description: "SnapCrawl — automated UI crawler & screenshot capture agent.",
  action: {
    default_popup: "src/popup/index.html",
    default_title: "SnapCrawl",
    default_icon: {
      16: "assets/icon-16.png",
      32: "assets/icon-32.png",
    },
  },
  icons: {
    16: "assets/icon-16.png",
    32: "assets/icon-32.png",
    48: "assets/icon-48.png",
    128: "assets/icon-128.png",
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  permissions: [
    "activeTab",
    "storage",
    "tabs",
    "scripting",
    "webNavigation",
    "downloads",
    "alarms",
    "unlimitedStorage",
  ],
  // Backend origin for pairing (FR-EX-001) + the S3/MinIO origin for presigned
  // PUT uploads (FR-EX-081) — the SW hits these CORS-free. Dev defaults; add your
  // deployed API + bucket origins when hosted.
  host_permissions: ["http://localhost:4000/*", "http://localhost:9000/*"],
  // Target app domains are granted per-project at runtime, never at install.
  optional_host_permissions: ["*://*/*"],
});
