// SnapCrawl browser smoke check — `npm run smoke:crawl`
//
// Drives a REAL crawl in a REAL Chrome against a local fixture and reports what
// the engine actually did. Like scripts/e2e-pipeline.mjs, this is NOT a test: it
// is the check you run when you touch the crawl engine, discovery, safe-click or
// the safety rules. CLAUDE.md: "read it twice and drive it in a browser — you are
// the only check left." This is the browser.
//
//   npm run smoke:crawl                 # fixture, headless, asserts the invariants
//   npm run smoke:crawl -- --headful    # watch it happen
//   npm run smoke:crawl -- --keep       # leave Chrome open at the end
//   npm run smoke:crawl -- --kill-sw-at 3   # kill the worker mid-run (FR-EX-080)
//   npm run smoke:crawl -- --target http://localhost:3000/ --domains localhost
//
// Zero dependencies: Node 24's global WebSocket + fetch speak CDP directly.
//
// Hard-won details, so nobody re-derives them:
//  • --load-extension is IGNORED by Chrome 137+. The replacement is the CDP
//    Extensions.loadUnpacked command, which needs --enable-unsafe-extension-debugging.
//  • This process must OWN Chrome. A backgrounded browser gets reaped with the
//    shell's process tree and the run dies half-way.
//  • Create the extension page target directly at its chrome-extension:// URL.
//    Navigating about:blank -> extension swaps renderer processes and kills the
//    attached CDP session mid-call.
//  • A service worker cannot sendMessage to itself, so the crawl is started from
//    an extension page (the options page), exactly as the popup does.
//  • Headless by default: a headful window launched from a script never takes
//    focus, and captureVisibleTab only sees the focused window's active tab (C-01).
//  • captureVisibleTab needs the literal <all_urls> permission (FR-EX-015). It is
//    OPTIONAL in the manifest and granted by a click the popup supplies and CDP
//    cannot, so this script grants it by patching the BUILT dist/manifest.json —
//    a gitignored artifact, restored on exit. The permission PROMPT is therefore
//    the one thing this check cannot cover.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXT_DIR = resolve(ROOT, "apps/extension/dist");
const PROFILE = resolve(ROOT, "node_modules/.cache/snapcrawl-smoke-profile");
const PORT = 8899;
const CDP_PORT = 9222;

const flag = (n) => process.argv.includes(n);
const num = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};
const str = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : d;
};

const TARGET = str("--target", `http://localhost:${PORT}/`);
const DOMAINS = str("--domains", "localhost").split(",");
const HEADLESS = !flag("--headful");
const KEEP = flag("--keep");
const KILL_AT = num("--kill-sw-at", 0);
// FR-EX-012 — send Stop after this many captures and time how long the crawl
// takes to actually halt. 0 (default) runs the normal coverage crawl instead;
// pass --stop-at 1 to run the stop-latency check. A high clickDelay makes the
// crawl sit in a long settle when Stop lands, so the measurement is meaningful.
const STOP_AT = num("--stop-at", 0);
// FR-EX-060 — crawl the out-of-band-nav fixture: a page that redirects itself
// off-scope with no click of ours. Separate mode so the coverage run stays put.
const OOB = flag("--oob");
// FR-EX-051 — crawl a tall fixture with fullPage on and verify the stitched shot
// is taller than one viewport. Separate mode so the coverage run stays put.
const FULLPAGE = flag("--fullpage");
// FR-EX-061 — the replay-divergence case: a table whose rows REORDER on every
// load (breaking position-based matching) while the state fingerprint stays put,
// so re-anchoring a recorded control needs its RECORD key, not its path.
const DIVERGENCE = flag("--divergence");
// FR-EX-076 — the crawl clicks a link to /login and must auto-pause (not keep
// crawling the auth wall) and log auth-paused.
const AUTH = flag("--auth");
// FR-EX-035 — with form-fill + submit enabled, the crawl fills a form's empty
// fields with dummy presets before submitting, so the submit handler sees them.
const FORMFILL = flag("--formfill");
// FR-EX-052 — pro (CDP) full-page capture on the tall fixture. --pro-mask forces
// the mask-guard fallback (masking can't be done below-fold in one CDP shot).
const PRO = flag("--pro");
const PRO_MASK = flag("--pro-mask");
// Each dedicated mode starts on its own fixture root.
const START_URL = OOB
  ? `http://localhost:${PORT}/oob-root`
  : FULLPAGE
    ? `http://localhost:${PORT}/tall`
    : DIVERGENCE
      ? `http://localhost:${PORT}/dlist`
      : AUTH
        ? `http://localhost:${PORT}/authroot`
        : FORMFILL
          ? `http://localhost:${PORT}/formroot`
          : PRO
            ? `http://localhost:${PORT}/tall`
            : TARGET;
const MAX_DEPTH = num("--max-depth", 2);
const MAX_SCREENS = num("--max-screens", 12);
// Any URL on the fixture's origin — not just its root — means we host it.
const USING_FIXTURE = new URL(TARGET).origin === `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const list = async () => (await fetch(`${CDP}/json/list`)).json();

// ── the fixture: one page carrying one specimen per rule the engine must honour ──
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Home</title>
<style>.cover-wrap{position:relative;display:inline-block}.cover{position:absolute;inset:0;background:rgba(255,0,0,.2)}
@keyframes spin{to{transform:rotate(360deg)}}
/* FR-EX-033: a perpetual animation. If the freeze CSS lands, its computed
   animation-play-state reads "paused"; without it, "running". */
#spinner{width:20px;height:20px;background:#09c;animation:spin 1s linear infinite}</style>
</head><body>
<div id="spinner"></div>
<nav><a href="/">Home</a> <a href="/alpha">Alpha</a> <a href="/beta">Beta</a></nav>
<h1>Home</h1>
<form onsubmit="return false"><input name="q"><button id="search">Search</button>
  <button type="button" id="clear">Clear</button></form>
<!-- FR-EX-034: type="sumbit" is INVALID, so HTML resolves it to submit and the
     browser submits on click. A gate reading getAttribute("type") misses it. -->
<form onsubmit="document.title='TYPO FORM SUBMITTED';return false">
  <button type="sumbit" id="typo">Save typo</button></form>
<!-- FR-EX-070: must never be clicked. Wiping the body is how we detect it; the
     marker is set from a function so the word isn't sitting in body.innerHTML. -->
<button id="danger" onclick="wipe()">Delete account</button>
<!-- FR-EX-026: excluded by selector; the inner button must go too (closest). -->
<div id="chat-widget"><button id="chat">Open chat</button></div>
<!-- FR-EX-022: open shadow DOM. MUST be found and clicked. -->
<my-widget></my-widget>
<!-- FR-EX-021: covered by an overlay, so not hit-testable at its centre.
     MUST NOT be clicked — a user could not click it either. -->
<div class="cover-wrap"><button id="covered" onclick="mark('covered')">Covered button</button><div class="cover"></div></div>
<p><button id="reveal" onclick="document.getElementById('panel').hidden=false">Reveal panel</button></p>
<div id="panel" hidden><p>Revealed.</p></div>
<!-- FR-EX-074: clicking this starts a file download the engine must cancel. -->
<a href="/dl-file" download="report.bin">Download report</a>
<!-- FR-EX-075: a styled upload button — a cursor:pointer label bound to a file
     input. It IS discovered (cursor heuristic), and must be skipped, not clicked
     (a file picker would stall the crawl), and logged skipped-file. -->
<label id="uploadlbl" style="cursor:pointer">Upload file<input type="file" style="display:none"></label>
<!-- FR-EX-062: opening this modal is a state; the engine must capture it and then
     CLOSE it (Escape does nothing here, so the aria-label=Close × control does). -->
<button id="opendlg" onclick="document.getElementById('dlg').hidden=false">Open dialog</button>
<div id="dlg" role="dialog" hidden><h3>A dialog</h3><p>Modal body.</p>
  <button aria-label="Close" onclick="document.getElementById('dlg').hidden=true">×</button></div>
<!-- FR-EX-023: a SAME-origin iframe. Discovery must recurse into it and its
     button must be found and clicked. A CROSS-origin iframe (127.0.0.1 — same
     server, different host) must be skipped and recorded as unreachable (C-04). -->
<iframe src="/frame-inner" width="200" height="60" title="same-origin frame"></iframe>
<iframe src="http://127.0.0.1:${PORT}/frame-cross" width="200" height="60" title="cross-origin frame"></iframe>
<!-- FR-EX-025: five structurally identical rows. With siblingCollapseLimit=2 the
     crawler should click 2 "Open" buttons and record 3 skipped-similar. -->
<ul id="rows">
  <li><span>Row 1</span><button onclick="mark('row1')">Open</button></li>
  <li><span>Row 2</span><button onclick="mark('row2')">Open</button></li>
  <li><span>Row 3</span><button onclick="mark('row3')">Open</button></li>
  <li><span>Row 4</span><button onclick="mark('row4')">Open</button></li>
  <li><span>Row 5</span><button onclick="mark('row5')">Open</button></li>
</ul>
<script>
  // Markers go to localStorage, NOT the DOM: the crawl navigates away and back,
  // so a DOM marker is erased by the next page load and every "was it clicked?"
  // check silently reads false. localStorage is per-origin and survives.
  function mark(k){ try { localStorage.setItem('sc-'+k, '1'); } catch(e){} }
  // FR-EX-033 fixture instrumentation: the extension injects <style
  // id=sc-freeze-style> before it captures. Catch the moment it lands and record
  // the spinner's resulting play-state — persisted (same-origin localStorage) so
  // the assertion survives the crawl's navigations and the final page reload,
  // which the earlier end-of-run read could not.
  (function(){
    var seen = function(){
      if (!document.getElementById('sc-freeze-style')) return false;
      var sp = document.getElementById('spinner');
      try { localStorage.setItem('sc-freeze-effect', sp ? getComputedStyle(sp).animationPlayState : 'no-spinner'); } catch(e){}
      return true;
    };
    if (seen()) return;
    var obs = new MutationObserver(function(){ if (seen()) obs.disconnect(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  })();
  function wipe(){ mark('wiped'); document.body.innerHTML = '<h1>gone</h1>'; }
  class MyWidget extends HTMLElement {
    connectedCallback(){ const r=this.attachShadow({mode:"open"});
      r.innerHTML='<button id="shadow-btn">Shadow action</button>';
      r.getElementById('shadow-btn').addEventListener('click', () => mark('shadow')); }
  }
  customElements.define("my-widget", MyWidget);
</script></body></html>`;

const sub = (t, extra) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body>
<nav><a href="/">Home</a> <a href="/alpha">Alpha</a> <a href="/beta">Beta</a></nav>
<h1>${t}</h1>${extra}</body></html>`;

// FR-EX-060 out-of-band nav mode (--oob): a minimal fixture whose only job is to
// bounce OFF-scope with no click of ours. localhost and 127.0.0.1 are the SAME
// server but DIFFERENT hosts, so with allowedDomains=["localhost"] a redirect to
// 127.0.0.1 leaves scope. The engine must catch the commit (FR-EX-071 "every
// navigation") and pull the tab back — no click, no window.open involved.
const OOB_ROOT = `<!doctype html><html><head><meta charset="utf-8"><title>OOB Home</title></head><body>
<nav><a href="/oob-bounce">Bounce</a> <a href="/oob-safe">Safe</a></nav>
<h1>OOB Home</h1></body></html>`;
const OOB_BOUNCE = `<!doctype html><html><head><meta charset="utf-8"><title>Bouncing</title>
<script>location.replace("http://127.0.0.1:${PORT}/oob-offscope")</script></head>
<body><h1>bouncing off-scope…</h1></body></html>`;

const ROUTES = {
  "/": FIXTURE,
  "/alpha": sub("Alpha", `<button onclick="document.getElementById('p').hidden=false">Toggle</button><div id="p" hidden>Alpha sub-state.</div>`),
  // A client-side route: pushState changes the URL but a fresh load of it does NOT
  // reproduce the state. This is the FR-EX-061 fallback's reason to exist.
  "/beta": sub("Beta", `<button onclick="history.pushState({},'','/beta?panel=1');document.getElementById('d').hidden=false">Open panel (pushState)</button><div id="d" hidden>Client-only state.</div>`),
  "/oob-root": OOB_ROOT,
  "/oob-bounce": OOB_BOUNCE,
  "/oob-safe": sub("OOB Safe", `<p>A normal in-scope page.</p>`),
  "/oob-offscope": sub("OFF SCOPE", `<p>The crawler must never end up here in-scope.</p>`),
  // FR-EX-076 — clicking "Sign in" lands the crawl on /login, which must auto-pause.
  "/authroot": sub("Auth Root", `<p>Home.</p><a href="/login">Sign in</a> <a href="/oob-safe">Other</a>`),
  "/login": sub("Login", `<h1>Sign in</h1><form onsubmit="return false"><input name="user"><button type="button">Go</button></form>`),
  // FR-EX-035 — a form whose submit handler records the field values it received,
  // so the harness can confirm the crawler filled them with the dummy presets
  // BEFORE submitting. The handler returns false (no navigation), and the values
  // persist in same-origin localStorage.
  "/formroot": `<!doctype html><html><head><meta charset="utf-8"><title>Form</title></head><body>
<h1>Contact</h1>
<form onsubmit="var g=function(id){return document.getElementById(id).value;};localStorage.setItem('sc-submit', JSON.stringify({email:g('f_em'),pass:g('f_pw'),name:g('f_nm'),tel:g('f_tel'),msg:g('f_msg')}));return false;">
  <input id="f_em" type="email" name="email" placeholder="Email">
  <input id="f_pw" type="password" name="password">
  <input id="f_nm" type="text" name="fullName" placeholder="Your name">
  <input id="f_tel" type="tel" name="phone">
  <textarea id="f_msg" name="message"></textarea>
  <button type="submit">Send</button>
</form></body></html>`,
  // FR-EX-023 — the same-origin frame's button marks localStorage (shared origin,
  // so the top page can read it back). The cross-origin frame is served the same
  // bytes but on 127.0.0.1, so the crawler can't see into it.
  "/frame-inner": `<!doctype html><meta charset="utf-8"><body><button id="framebtn" onclick="try{localStorage.setItem('sc-framebtn','1')}catch(e){}">Frame action</button></body>`,
  "/frame-cross": `<!doctype html><meta charset="utf-8"><body><button>Cross-origin button (invisible to the crawler)</button></body>`,
  // FR-EX-061 — /dlist is generated per request (see renderDlist in main) so the
  // row order is controlled server-side; it is not a static route.
  // FR-EX-051 — a page several viewports tall with a position:fixed header, so a
  // single viewport shot can't cover it and the sticky bar would repeat in every
  // slice if it weren't hidden on intermediate segments.
  "/tall": `<!doctype html><html><head><meta charset="utf-8"><title>Tall</title>
<style>#bar{position:fixed;top:0;left:0;right:0;height:40px;background:#0b6bcb;color:#fff}
.block{height:800px}#b1{background:#eef}#b2{background:#efe}#b3{background:#fee}#b4{background:#ffe}</style>
</head><body>
<div id="bar">FIXED HEADER</div>
<div class="block" id="b1"><h1>Top</h1></div>
<div class="block" id="b2"><h1>Second</h1></div>
<div class="block" id="b3"><h1>Third</h1></div>
<div class="block" id="b4"><h1>Fourth</h1><a href="/oob-safe">A link</a></div>
</body></html>`,
};

// ── tiny CDP client ──
class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    return new Session(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

// ── manifest patch (build artifact only; restored on exit) ──
const MANIFEST = resolve(EXT_DIR, "manifest.json");
let manifestBackup = null;
function grantCapturePermission() {
  manifestBackup = readFileSync(MANIFEST, "utf8");
  const m = JSON.parse(manifestBackup);
  m.host_permissions = [...new Set([...(m.host_permissions ?? []), "<all_urls>"])];
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}
function restoreManifest() {
  if (manifestBackup !== null) { writeFileSync(MANIFEST, manifestBackup); manifestBackup = null; }
}

let chrome = null;
let server = null;
const cleanup = () => {
  restoreManifest();
  if (!KEEP) { try { chrome?.kill(); } catch { /* already dead */ } }
  try { server?.close(); } catch { /* not started */ }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  if (!existsSync(MANIFEST)) {
    console.error("No build found. Run `npm run build -w apps/extension` first.");
    process.exit(2);
  }

  if (USING_FIXTURE) {
    // FR-EX-061 — /dlist is generated PER REQUEST so the row order is controlled
    // server-side (localStorage doesn't reliably survive the crawl's reloads).
    // The FIRST serve is [Alice,Bob,Carol]; every later serve is reversed. So a
    // control recorded on the first load is always replayed against a different
    // order — deterministic divergence — while later loads are mutually stable.
    let dlistServes = 0;
    const renderDlist = () => {
      const rows = [["a", "Alice"], ["b", "Bob"], ["c", "Carol"], ["d", "Dave"], ["e", "Eve"]];
      // Rotate by a step coprime to the row count on EVERY serve, so consecutive
      // loads never share an order and the crawl's active exploration (well past
      // the seed reload) records and replays against different positions. 5 rows,
      // step 2 → period 5; a recorded control is at a fresh position on replay.
      const k = (dlistServes++ * 2) % rows.length;
      const order = rows.slice(k).concat(rows.slice(0, k));
      // No id/data-testid on the row ON PURPOSE: the button's robust path is then
      // positional (it breaks on reorder), so re-anchoring depends entirely on the
      // record key derived from the row's text — exactly the FR-EX-061 tier.
      const trs = order
        .map(
          ([, name]) =>
            `<tr><td>${name}</td><td><button class="open" data-name="${name}">Open</button></td></tr>`,
        )
        .join("");
      return `<!doctype html><html><head><meta charset="utf-8"><title>DList</title>
<style>#modal{position:fixed;top:30%;left:25%;width:50%;background:#fff;border:2px solid #333;padding:16px}</style>
</head><body>
<h1>Records</h1>
<table><tbody id="tb">${trs}</tbody></table>
<div id="modal" role="dialog" hidden><h3 id="mtitle"></h3><button id="mclose">Close</button></div>
<script>
  document.querySelectorAll('button.open').forEach(function(b){
    b.addEventListener('click', function(){
      document.getElementById('mtitle').textContent = 'Detail ' + b.getAttribute('data-name');
      document.getElementById('modal').hidden = false;
    });
  });
  document.getElementById('mclose').addEventListener('click', function(){ document.getElementById('modal').hidden = true; });
</script></body></html>`;
    };
    server = createServer((req, res) => {
      const path = new URL(req.url, TARGET).pathname;
      // FR-EX-074 — a real attachment: forces a download the engine must cancel.
      if (path === "/dl-file") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="report.bin"',
        });
        res.end(Buffer.from("SNAPCRAWL-REPORT-BYTES"));
        return;
      }
      const body = path === "/dlist" ? renderDlist() : ROUTES[path];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body ?? sub("Not found", "<p>404</p>"));
    });
    await new Promise((r) => server.listen(PORT, r));
    console.log(`fixture on ${TARGET}`);
  }

  grantCapturePermission();
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* first run */ }

  const chromePath =
    process.env.CHROME_PATH ??
    [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "/usr/bin/google-chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].find((p) => existsSync(p));
  if (!chromePath) {
    console.error("Chrome not found. Set CHROME_PATH.");
    process.exit(2);
  }

  chrome = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    ...(HEADLESS ? ["--headless=new"] : []),
    "--window-size=1280,900",
    START_URL,
  ], { stdio: "ignore" });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    try { await fetch(`${CDP}/json/version`); up = true; } catch { /* not yet */ }
  }
  if (!up) throw new Error("Chrome DevTools never came up");
  const ver = await (await fetch(`${CDP}/json/version`)).json();
  console.log(`${ver.Browser} (${HEADLESS ? "headless" : "headful"})`);

  const browser = await Session.open(ver.webSocketDebuggerUrl);
  const { id: extId } = await browser.send("Extensions.loadUnpacked", { path: EXT_DIR });
  console.log(`extension ${extId}`);
  // FR-EX-074 — allow downloads so onCreated fires (headless denies by default);
  // the engine then cancels them. Path is a throwaway; nothing should land there.
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: resolve(ROOT, "node_modules/.cache/snapcrawl-smoke-dl"),
  }).catch(() => {});
  await sleep(2000);

  // An extension page to drive from — the worker can't message itself.
  let ext = null;
  for (let i = 0; i < 8 && !ext; i++) {
    const { targetId } = await browser.send("Target.createTarget", {
      url: `chrome-extension://${extId}/src/options/index.html`,
    });
    await sleep(1500);
    const t = (await list()).find((x) => x.id === targetId);
    if (!t) continue;
    const s = await Session.open(t.webSocketDebuggerUrl);
    await s.send("Runtime.enable");
    if ((await s.evaluate(`typeof chrome?.tabs`).catch(() => "undefined")) === "object") { ext = s; break; }
    s.close();
    await browser.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  if (!ext) throw new Error("could not open a working extension page");

  const tab = await ext.evaluate(`
    (async () => {
      const [t] = await chrome.tabs.query({ url: ${JSON.stringify(new URL(TARGET).origin + "/*")} });
      return t ? { tabId: t.id, windowId: t.windowId } : null;
    })()`);
  if (!tab) throw new Error("extension cannot see the target tab");

  const runOptions = {
    maxScreens: MAX_SCREENS, maxDepth: MAX_DEPTH, maxDurationMin: 3,
    // FR-EX-012 — a long click delay parks the crawl in a settle wait, so a Stop
    // has a real in-flight wait to interrupt (otherwise it would halt between
    // ops regardless and prove nothing about interrupting a wait).
    clickDelayMs: STOP_AT ? 8000 : 150,
    safeMode: true,
    blocklist: ["delete", "remove", "logout", "sign out", "pay", "buy", "checkout"],
    fullPage: FULLPAGE, // FR-EX-051
    proCaptureMode: PRO, // FR-EX-052

    allowedDomains: DOMAINS,
    // FR-EX-052 — masks force the pro-mode fallback (can't mask below-fold in one
    // CDP shot); --pro-mask exercises that path.
    maskSelectors: PRO && PRO_MASK ? ["h1"] : [],
    excludeSelectors: ["#chat-widget"],
    excludeUrlPatterns: ["/beta$"],
    // FR-EX-035 needs submits to actually fire; every other mode keeps them gated.
    clickSubmitEmptyForms: FORMFILL,
    formFillDummyData: FORMFILL, // FR-EX-035
    // FR-EX-061 mode explores every identical row (FR-EX-025 collapse would
    // otherwise keep only 2 and mask the re-anchor case); coverage mode keeps 2.
    siblingCollapseLimit: DIVERGENCE ? 50 : undefined,
    loginUrlPatterns: ["/login", "/signin", "/logout"], // FR-EX-076 (spec defaults)
  };
  console.log(`\ncrawling ${START_URL} (maxDepth=${MAX_DEPTH}, maxScreens=${MAX_SCREENS})`);
  await ext.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({
    type: "EXT_CRAWL_START", startUrl: START_URL, tab, runOptions,
  })})`);

  let terminal = null, killed = false, last = "", stopLatencyMs = null, authPaused = false;
  for (let i = 0; i < 200; i++) {
    await sleep(1000);
    let st;
    try { st = await ext.evaluate(`chrome.runtime.sendMessage({type:"EXT_CRAWL_STATUS"})`); } catch { continue; }
    const p = st?.progress;
    const line = `${st?.runState} screens=${p?.screens ?? "-"} states=${p?.states ?? "-"} queue=${p?.queue ?? "-"} d=${p?.depth ?? "-"} ${p?.phase ?? ""}`;
    if (line !== last) { console.log(`  [${String(i).padStart(3)}s] ${line}`); last = line; }

    // FR-EX-076 — a paused crawl never reaches a terminal state on its own. When
    // the auth landing pauses it, record that, then Stop so the harness finalises.
    if (AUTH && st?.runState === "paused" && !authPaused) {
      authPaused = true;
      console.log(`  *** auto-paused on auth landing (phase=${p?.phase}) — stopping ***`);
      await ext.evaluate(`chrome.runtime.sendMessage({type:"EXT_CRAWL_CONTROL",action:"stop"})`).catch(() => {});
    }

    if (KILL_AT && !killed && (p?.screens ?? 0) >= KILL_AT) {
      killed = true;
      const swT = (await list()).find((t) => t.type === "service_worker" && t.url.includes(extId));
      if (swT) {
        console.log(`  *** killing the service worker after ${p.screens} captures (FR-EX-080) ***`);
        await browser.send("Target.closeTarget", { targetId: swT.id });
      }
    }

    // FR-EX-012 — send Stop, then tight-poll (100ms) for the terminal state and
    // measure the wall-clock latency. The crawl is parked in an 8s settle wait,
    // so anything under 2s proves the wait was actually interrupted.
    if (STOP_AT && stopLatencyMs === null && (p?.screens ?? 0) >= STOP_AT) {
      console.log(`  *** sending Stop after ${p.screens} captures (FR-EX-012) ***`);
      const t0 = Date.now();
      await ext.evaluate(`chrome.runtime.sendMessage({type:"EXT_CRAWL_CONTROL",action:"stop"})`).catch(() => {});
      for (let j = 0; j < 60; j++) { // up to 6s of tight polling
        let s2;
        try { s2 = await ext.evaluate(`chrome.runtime.sendMessage({type:"EXT_CRAWL_STATUS"})`); } catch {}
        if (s2?.runState && !["running", "paused", "idle"].includes(s2.runState)) { terminal = s2; break; }
        await sleep(100);
      }
      stopLatencyMs = Date.now() - t0;
      console.log(`  *** halted in ${stopLatencyMs}ms ***`);
      if (terminal) break;
    }
    if (st?.runState && !["running", "paused", "idle"].includes(st.runState)) { terminal = st; break; }
  }
  if (!terminal) throw new Error("crawl never reached a terminal state");

  const r = terminal.result ?? {};
  console.log("\nresult:", JSON.stringify(r));

  await ext.evaluate(`chrome.runtime.sendMessage({type:"PING"})`).catch(() => {});
  await sleep(400);
  let log = [], shot0 = null;
  const swT = (await list()).find((t) => t.type === "service_worker" && t.url.includes(extId));
  if (swT) {
    const sw = await Session.open(swT.webSocketDebuggerUrl);
    await sw.send("Runtime.enable");
    log = await sw.evaluate(`
      chrome.storage.local.get("sc-crawl-errors").then(x =>
        (x["sc-crawl-errors"]||[]).map(e => e.level+"|"+e.event+"|"+JSON.stringify(e.context||{})))`);
    // FR-EX-051 — pull the first stored shot so we can measure its dimensions.
    shot0 = await sw.evaluate(`chrome.storage.local.get("sc-crawl-shot-0").then(x => x["sc-crawl-shot-0"] || null)`).catch(() => null);
    sw.close();
  }
  // Decode a PNG data URL's dimensions from the IHDR (no canvas needed): width at
  // byte 16, height at byte 20, big-endian, after the 8-byte signature.
  const pngSize = (dataUrl) => {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) return null;
    const buf = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
    if (buf.length < 24) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };
  if (log.length) {
    console.log("\nengine decisions (FR-EX-084):");
    for (const l of log) console.log("  " + l.slice(0, 150));
  }

  console.log("\nchecks:");
  check("crawl reached a terminal state", !!terminal.runState, terminal.runState);
  check("captured at least one screenshot (FR-EX-050)", (r.captures ?? 0) > 0, `captures=${r.captures}`);
  check("no engine errors", (terminal.progress?.errors ?? 0) === 0, `errors=${terminal.progress?.errors}`);

  if (FORMFILL) {
    // FR-EX-035 — the crawl filled the contact form's empty fields with dummy
    // presets and then submitted it; the handler stashed what it received. Read
    // it back and confirm the presets (email/name/tel/text) actually landed, and
    // that a form-filled decision was logged.
    let submitted = null;
    const pageT = (await list()).find((t) => t.type === "page" && t.url.startsWith(`http://localhost:${PORT}`));
    if (pageT) {
      const pg = await Session.open(pageT.webSocketDebuggerUrl);
      await pg.send("Runtime.enable");
      submitted = await pg.evaluate(`localStorage.getItem('sc-submit')`).catch(() => null);
      pg.close();
    }
    const v = submitted ? JSON.parse(submitted) : {};
    check("FR-EX-035 form submitted with dummy data (not empty)", !!submitted, `sc-submit=${submitted}`);
    check("FR-EX-035 email preset filled", v.email === "test@example.com", `email=${v.email}`);
    check("FR-EX-035 name preset filled", v.name === "Test User", `name=${v.name}`);
    check("FR-EX-035 tel + text presets filled", v.tel === "5551234567" && v.msg === "test", `tel=${v.tel} msg=${v.msg}`);
    check("FR-EX-035 password is a dummy, never empty and obviously fake", v.pass === "Test1234!", `pass=${v.pass}`);
    check("FR-EX-035 form-filled decision logged", log.some((l) => l.includes("form-filled")), "form-filled logged");
  }

  if (AUTH) {
    // FR-EX-076 — the crawl clicked "Sign in", landed on /login, and must have
    // auto-paused (not kept crawling the auth wall) with an auth-paused decision
    // in the session log naming the matched pattern.
    check("FR-EX-076 auto-paused on the login landing", authPaused === true, `authPaused=${authPaused}`);
    check("FR-EX-076 auth-paused logged with the matched pattern",
      log.some((l) => l.includes("auth-paused") && l.includes("/login")), "auth-paused /login logged");
  }

  if (DIVERGENCE) {
    // FR-EX-061 — the three modal sub-states (Alice/Bob/Carol) are each reached
    // by replaying a click on an "Open" button whose row has moved since it was
    // recorded. Re-anchoring by the row's data-testid must find the right row, so
    // every branch restores and NOTHING is abandoned. Without the record-key
    // tier, the reordered path resolves to the wrong row, the modal shows the
    // wrong name, the fingerprint check fails, and the branch is abandoned.
    check("FR-EX-061 replay survives row reorder (nothing abandoned)",
      (r.abandoned ?? -1) === 0, `abandoned=${r.abandoned}`);
    check("FR-EX-061 all record sub-states captured", (r.captures ?? 0) >= 6, `captures=${r.captures} (base + 5 modals)`);
  }

  if (FULLPAGE) {
    // FR-EX-051 — the /tall page is ~3200px over a ~900px window, so a stitched
    // full-page shot must be far taller than one viewport. A viewport-only shot
    // would be ≤ the window height; anything past ~1500px proves multi-segment
    // stitching happened.
    const sz = pngSize(shot0);
    check("FR-EX-051 full-page shot stitched taller than one viewport",
      !!sz && sz.h > 1500 && sz.h > sz.w,
      `shot0 = ${sz ? sz.w + "x" + sz.h : "none"}`);
  }

  if (PRO) {
    // FR-EX-052 — pro mode captures the tall page full-page (via CDP, or the
    // scroll-and-stitch fallback), so the shot must be far taller than a viewport.
    const sz = pngSize(shot0);
    const method = (log.find((l) => l.includes("pro-capture")) || "").match(/"method":"(\w+)"/)?.[1] ?? "none";
    console.log(`  pro-capture method: ${method}`);
    check("FR-EX-052 pro-mode produced a full-page image", !!sz && sz.h > 1500, `shot0 = ${sz ? sz.w + "x" + sz.h : "none"}`);
    check("FR-EX-052 pro-capture decision logged", method !== "none", `method=${method}`);
    if (PRO_MASK) {
      // Masking can't be done below-fold in one CDP shot, so pro mode falls back
      // to per-segment scroll-and-stitch — the pro failure never aborts the
      // capture. (Same `?? fullPageShot()` path the attach-fail catch feeds.)
      check("FR-EX-052 graceful fallback to scroll-and-stitch", method === "fallback", `method=${method}`);
    } else {
      // No masks ⇒ the pixel-perfect CDP path runs (and Chrome shows its
      // debugging banner automatically, C-02).
      check("FR-EX-052 CDP path used (debugger banner shown)", method === "cdp", `method=${method}`);
    }
  }

  if (STOP_AT) {
    // FR-EX-012 — Stop is a hard kill: halt within 2s, finalise as cancelled,
    // keep partial results. The crawl was parked in an 8s settle when Stop landed.
    check("FR-EX-012 Stop halts within 2s", stopLatencyMs !== null && stopLatencyMs < 2000, `latency=${stopLatencyMs}ms`);
    check("FR-EX-012 finalised as cancelled", (r.reason ?? terminal.runState) === "cancelled", `reason=${r.reason ?? terminal.runState}`);
    check("FR-EX-012 partial results kept", (r.captures ?? 0) >= STOP_AT, `captures=${r.captures}`);
  }

  if (OOB) {
    // FR-EX-060 / FR-EX-071 — the page bounced itself to 127.0.0.1 (off-scope)
    // with no click of ours. The engine must have caught the commit, logged it,
    // and pulled the tab back — and must NOT have come to rest off-scope.
    const endT = (await list()).find((t) => t.type === "page" && (t.url.includes("localhost") || t.url.includes("127.0.0.1")));
    const endedOffScope = !!endT && endT.url.includes("127.0.0.1");
    check("FR-EX-060 out-of-band off-scope nav caught + logged",
      log.some((l) => l.includes("out-of-scope-nav") && l.includes("127.0.0.1")),
      "out-of-scope-nav logged");
    check("FR-EX-060 crawl pulled back in-scope (not resting off-scope)", !endedOffScope, `ended at ${endT?.url}`);
    check("FR-EX-060 crawl continued after the bounce (kept capturing)", (r.captures ?? 0) >= 1, `captures=${r.captures}`);
  }

  if (USING_FIXTURE && !STOP_AT && !OOB && !FULLPAGE && !DIVERGENCE && !AUTH && !FORMFILL && !PRO) {
    const pageT = (await list()).find((t) => t.type === "page" && t.url.startsWith(`http://localhost:${PORT}`));
    let wiped = null, title = null, marks = {}, routeSignals = null;
    if (pageT) {
      const pg = await Session.open(pageT.webSocketDebuggerUrl);
      await pg.send("Runtime.enable");
      // NOT innerHTML.includes(...) — the marker must not be a string that exists
      // in the page whether or not the button was clicked.
      wiped = await pg.evaluate(`document.querySelector("nav") === null`).catch(() => null);
      title = await pg.evaluate(`document.title`).catch(() => null);
      marks = await pg.evaluate(
        `({ wiped: !!localStorage.getItem('sc-wiped'), shadow: !!localStorage.getItem('sc-shadow'), covered: !!localStorage.getItem('sc-covered'), freezeEffect: localStorage.getItem('sc-freeze-effect'), framebtn: !!localStorage.getItem('sc-framebtn') })`
      ).catch(() => ({}));
      // FR-EX-042 — installNetworkCounter (MAIN world, re-installed on every
      // commit) wraps history.pushState/replaceState and listens to
      // popstate/hashchange, firing __scOnNetChange so a client-side route change
      // re-arms the stability wait. Drive each directly and count the signals: if
      // the wrap is in place, all three fire it.
      routeSignals = await pg.evaluate(`
        (function(){
          var n = 0;
          window.__scOnNetChange = function(){ n++; };
          try { history.pushState({}, '', location.pathname + '?sc-spa=1'); } catch(e){}
          try { history.replaceState({}, '', location.pathname); } catch(e){}
          try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch(e){}
          window.__scOnNetChange = undefined;
          return n;
        })()
      `).catch(() => null);
      pg.close();
    }
    check("FR-EX-070 destructive element never clicked", wiped === false && marks.wiped === false, `body wiped=${wiped} mark=${marks.wiped}`);
    check("FR-EX-022 shadow-DOM button was found and clicked", marks.shadow === true, `shadow mark=${marks.shadow}`);
    check("FR-EX-021 covered button never clicked", marks.covered === false, `covered mark=${marks.covered}`);
    check("FR-EX-033 animations frozen before capture", marks.freezeEffect === "paused", `spinner play-state at freeze=${marks.freezeEffect}`);
    check("FR-EX-034 typo'd submit never submitted the form", title !== "TYPO FORM SUBMITTED", `title=${JSON.stringify(title)}`);
    check("FR-EX-034 submit gated", log.some((l) => l.includes("skipped-submit")), "skipped-submit logged");
    check("FR-EX-034 gate catches type=\"sumbit\"", log.some((l) => l.includes("skipped-submit") && l.includes("Save typo")));
    check("FR-EX-026 exclude rules enforced", log.some((l) => l.includes("skipped-excluded")), "skipped-excluded logged");
    // FR-EX-025 — 5 identical "Open" rows, limit 2: rows 3/4/5 are skipped-similar
    // (rows 1/2 kept). Count DISTINCT selectors, not log lines: "Reveal panel"
    // opens a second same-URL state whose own copy of the rows collapses too, so
    // the same three selectors are legitimately recorded once per state.
    const openSel = new Set(
      log.filter((l) => l.includes("skipped-similar") && l.includes('"Open"'))
        .map((l) => (l.match(/"selector":"([^"]+)"/) || [])[1]),
    );
    check("FR-EX-025 repeated siblings collapsed to the limit",
      openSel.size === 3 && [...openSel].every((s) => /li:[345]>button/.test(s)),
      `distinct skipped "Open" selectors=${[...openSel].join(", ")}`);
    // FR-EX-023 — same-origin frame recursed into and clicked; cross-origin logged.
    check("FR-EX-023 same-origin iframe button found and clicked", marks.framebtn === true, `framebtn mark=${marks.framebtn}`);
    check("FR-EX-023 cross-origin iframe recorded unreachable (C-04)", log.some((l) => l.includes("unreachable-region")), "unreachable-region logged");
    // FR-EX-023 — the cross-origin frame is counted in the surfaced progress total.
    check("FR-EX-023 unreachable regions surfaced in the result", (r.unreachableRegions ?? 0) >= 1, `unreachableRegions=${r.unreachableRegions}`);
    // FR-EX-062 — the modal was captured then dismissed (Escape didn't close it, so
    // the aria-label=Close control did).
    check("FR-EX-062 modal captured then closed", log.some((l) => l.includes("dialog-dismissed") && l.includes('"closed":true')), "dialog-dismissed closed:true logged");
    // FR-EX-074 — clicking the download link started a download that was cancelled.
    check("FR-EX-074 click-triggered download cancelled", log.some((l) => l.includes("download-cancelled")), "download-cancelled logged");
    // FR-EX-084 — the full decision log: clicks and the safety (blocked) skip must
    // both be present, alongside the excluded/submit/similar/dialog/download lines
    // already asserted above. (All go through the same batched /ext/logs upload.)
    check("FR-EX-084 clicks recorded in the decision log", log.some((l) => l.startsWith("info|clicked")), "clicked logged");
    check("FR-EX-084 destructive skip logged as skipped-blocked", log.some((l) => l.includes("skipped-blocked")), "skipped-blocked logged");
    // FR-EX-075 — the styled upload button (label bound to a file input) was
    // skipped, never clicked, and recorded as skipped-file.
    check("FR-EX-075 native file-picker trigger skipped + logged", log.some((l) => l.includes("skipped-file")), "skipped-file logged");
    // FR-EX-042 — the route hooks fire the settle re-arm on pushState/replaceState/hashchange.
    check("FR-EX-042 SPA route changes re-arm the stability wait", (routeSignals ?? 0) >= 3, `route signals fired=${routeSignals}`);
  }
  if (KILL_AT) {
    check("FR-EX-080 survived a worker kill", (r.reason ?? "") !== "error", `reason=${r.reason}`);
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (KEEP) { console.log("--keep: Chrome left running; ^C to quit."); await new Promise(() => {}); }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("\nSMOKE FAILED:", e.message); cleanup(); process.exit(1); });
