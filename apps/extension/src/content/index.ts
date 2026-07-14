// SnapCrawl content script — the in-page capture agent (scaffold stub).
//
// Injected per-project at runtime via chrome.scripting once the user grants the
// target domain's host permission (FR-EX-015). Element discovery, safe-click,
// UI-stability detection, and state fingerprinting land here during the
// Phase 0 crawl-engine spike. Safety controls (FR-EX-070…076) will live in a
// sibling `safety.ts` with a paired `safety.test.ts`.

export {};