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
    "notifications",
    "debugger",
    "unlimitedStorage",
  ],
  // Backend origin for pairing (FR-EX-001) + the S3/MinIO origin for presigned
  // PUT uploads (FR-EX-081) — the SW hits these CORS-free. Dev defaults; add your
  // deployed API + bucket origins when hosted.
  host_permissions: ["http://localhost:4000/*", "http://localhost:9000/*"],
  // Target app access is granted at runtime, never at install (C-07).
  //
  // `<all_urls>` and not `*://*/*`, which is what this used to be: verified in
  // Chrome 150, chrome.tabs.captureVisibleTab accepts ONLY the literal
  // `<all_urls>` permission or `activeTab`. A per-origin grant — even one the
  // extension definitely holds (permissions.contains() === true) — and even
  // `*://*/*` itself both fail with "Either the '<all_urls>' or 'activeTab'
  // permission is required." Since the crawl navigates constantly and activeTab
  // dies on navigation, `<all_urls>` is the only grant that lets a crawl actually
  // screenshot anything. See requestCrawlAccess.
  //
  // The crawl's SCOPE is still the project's allowedDomains, which gates every
  // navigation (FR-EX-010/071) — the permission is broad, the crawl is not.
  optional_host_permissions: ["<all_urls>"],
});
