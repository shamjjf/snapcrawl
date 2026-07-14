// SnapCrawl dialog guard (FR-EX-073 / EC-022).
//
// Registered dynamically at document_start in the MAIN world, scoped to the
// crawl's allowed domains, by lib/crawl.ts (chrome.scripting.registerContentScripts).
// Running BEFORE any page script is the only way to reliably stop a page from
// arming a `beforeunload` "Leave site?" prompt — such a prompt blocks the crawl's
// navigations, which otherwise jams the run after the first couple of captures.
// (For a `beforeunload` listener on `window`, listeners fire in REGISTRATION
// order, so a handler registered by the page before us can't be neutralised after
// the fact — we must prevent it from ever being registered.)
//
// This is a static asset (not bundled TS) because registerContentScripts takes a
// FILE, not a serialised function. It mirrors `neutralizeDialogsInPage` in
// src/content/crawl-inject.ts — keep the two in sync; that one is unit-tested
// (dialogs.test.ts) and also injected via executeScript as a belt-and-suspenders.
(function () {
  try {
    var w = window;
    if (w.__scDialogGuard) return;
    w.__scDialogGuard = true;

    // Native dialogs never block the crawl.
    w.alert = function () {};
    w.confirm = function () {
      return false;
    };
    w.prompt = function () {
      return null;
    };

    // Drop every beforeunload registration at the source, so the page can never
    // arm the prompt. Other event types pass straight through. We capture the
    // original first and use it for our own belt listener below.
    var origAdd = w.addEventListener.bind(w);
    w.addEventListener = function (type) {
      if (typeof type === "string" && type.toLowerCase() === "beforeunload") return undefined;
      return origAdd.apply(w, arguments);
    };

    // Lock window.onbeforeunload to null (the property-handler path).
    try {
      Object.defineProperty(w, "onbeforeunload", {
        configurable: true,
        get: function () {
          return null;
        },
        set: function () {},
      });
    } catch (e) {
      w.onbeforeunload = null;
    }

    // Belt: if anything still slips through, clear returnValue. It MUST be ""
    // (empty), never undefined — undefined coerces to the DOMString "undefined",
    // which is non-empty and itself arms the prompt.
    origAdd(
      "beforeunload",
      function (e) {
        if (e && typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        if (e) e.returnValue = "";
      },
      true,
    );
  } catch (e) {
    /* ignore */
  }
})();
