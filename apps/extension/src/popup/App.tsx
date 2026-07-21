import { useEffect, useRef, useState } from "react";
import { interval } from "rxjs";
import type { SessionStatus } from "@snapcrawl/shared/design";
import {
  Button,
  Card,
  Field,
  GearIcon,
  IconButton,
  Input,
  Logo,
  MoonIcon,
  Pill,
  Select,
  StatTile,
  StatusChip,
  SunIcon,
  Toggle,
} from "../components/ui";
import { resolveTheme, setTheme } from "../lib/theme";
import { scanAndHighlight } from "../content/scan-inject";
import { DEFAULT_DESTRUCTIVE_BLOCKLIST } from "@snapcrawl/shared/constants";
import { getSafeMode, setSafeMode } from "../lib/settings";
import {
  captureAndStore,
  clearCaptures,
  downloadCapturesZip,
  downloadDataUrlsZip,
  getCaptures,
} from "../lib/capture";
import { configToRunOptions, type CrawlProgress, type CrawlReason } from "../lib/crawl";
import type { CrawlConfig, Project } from "@snapcrawl/shared";
import { getCachedProjects, getPairing, getSelectedProjectId, setSelectedProjectId } from "../lib/pairing";
import { getCrawlMobileShots, getCrawlShots } from "../lib/capture-sink";
import { getCrawlErrors, type CrawlErrorEntry } from "../lib/error-sink";
import { effectiveAllowedDomains, isInScope } from "../lib/scope";
import { requestCrawlAccess } from "../lib/host-access";
import {
  fetchProjectsViaWorker,
  swControlCrawl,
  swGetCrawlStatus,
  swStartCrawl,
} from "../lib/messaging";

type RunState = "idle" | SessionStatus;

const REASON_TEXT: Record<CrawlReason, string> = {
  completed: "crawl complete — explored every reachable state",
  // Reachable only on a project that still carries a finite limit; unlimited is
  // the default now, so this is the exception rather than the expected ending.
  "limit-reached": "stopped at a limit set on the project",
  cancelled: "stopped by you",
  "no-tab": "couldn't crawl this tab",
  error: "ended with an error",
};

const isTerminal = (s: RunState) =>
  s === "completed" || s === "failed" || s === "cancelled";

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Wall-clock time of a recorded error (epoch-ms) — HH:MM:SS, locale-independent. */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Render an error's `context` (a small object or string) as one concise line. */
function errContext(context: unknown): string {
  if (context == null) return "";
  if (typeof context === "string") return context;
  if (typeof context === "object") {
    const o = context as Record<string, unknown>;
    const msg = typeof o.message === "string" ? o.message : "";
    const url = typeof o.url === "string" ? o.url : "";
    if (msg || url) return [msg, url].filter(Boolean).join(" · ");
  }
  try {
    return JSON.stringify(context);
  } catch {
    return "";
  }
}

function openOptions() {
  try {
    chrome.runtime.openOptionsPage();
  } catch {
    /* not in an extension context (e.g. vite preview) */
  }
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [activeConfig, setActiveConfig] = useState<CrawlConfig | null>(null);
  const [paired, setPaired] = useState(false);
  const [activeTabUrl, setActiveTabUrl] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [prog, setProg] = useState<CrawlProgress>({
    screens: 0,
    states: 0,
    depth: 0,
    queue: 0,
    pages: 0,
    errors: 0,
    currentUrl: "",
    phase: "",
    unreachableRegions: 0,
  });
  const [reason, setReason] = useState<CrawlReason | null>(null);
  const [crawlErr, setCrawlErr] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [abandoned, setAbandoned] = useState(0); // FR-EX-084 — branches given up on
  const shotsRef = useRef<string[]>([]);
  const runStateRef = useRef<RunState>("idle");
  const [overrides, setOverrides] = useState({
    fullPage: false,
    proCaptureMode: false, // FR-EX-052
    captureMode: "desktop" as "desktop" | "mobile", // FR-EX-090
  });
  const [theme, setThemeState] = useState<"light" | "dark">("light");
  const [scan, setScan] = useState<{
    status: "idle" | "scanning" | "done" | "error";
    count?: number;
    blocked?: number;
  }>({ status: "idle" });
  const [safetyOn, setSafetyOn] = useState(true);
  const [captureCount, setCaptureCount] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [errorLog, setErrorLog] = useState<CrawlErrorEntry[]>([]);

  useEffect(() => {
    setThemeState(resolveTheme());
    void getSafeMode().then(setSafetyOn);
    void getCaptures().then((l) => setCaptureCount(l.length));
    // Active tab URL — for the allowedDomains Start-gate (FR-EX-010).
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => setActiveTabUrl(t?.url ?? ""))
      .catch(() => setActiveTabUrl(""));
    // Load paired projects (FR-EX-002); the selected project's config becomes the
    // run config. Falls back to local defaults when unpaired.
    // FR-EX-002 — the popup mounts on every icon click, so this runs each time
    // the extension is opened. Render the CACHED list first so the picker never
    // flashes empty, then refresh from the backend so projects created AFTER
    // pairing show up without the user having to re-pair. A failed refresh
    // (offline, backend down) deliberately keeps the cached list rather than
    // blanking the picker.
    let cancelled = false;
    const pickId = (list: Project[], preferred: string): string =>
      preferred && list.some((p) => p.id === preferred) ? preferred : (list[0]?.id ?? "");
    void (async () => {
      const [pairing, cached, storedId] = await Promise.all([
        getPairing(),
        getCachedProjects(),
        getSelectedProjectId(),
      ]);
      if (cancelled) return;
      setPaired(!!pairing);
      setProjects(cached);
      const cachedId = pickId(cached, storedId ?? "");
      setSelectedId(cachedId);
      applyProjectConfig(cached.find((p) => p.id === cachedId) ?? null);

      if (!pairing) return; // unpaired: nothing to refresh against
      const fresh = await fetchProjectsViaWorker().catch(() => null);
      if (cancelled || !fresh || !fresh.ok) return;
      setProjects(fresh.projects);
      // Keep the user's stored choice if it still exists; otherwise fall back to
      // the first project (e.g. the selected one was deleted in the panel).
      const freshId = pickId(fresh.projects, storedId ?? "");
      setSelectedId(freshId);
      applyProjectConfig(fresh.projects.find((p) => p.id === freshId) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the active-tab URL fresh so the Start-gate never goes stale if the tab
  // redirects out of scope while the popup is open (FR-EX-010).
  useEffect(() => {
    const requery = (): void => {
      void chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([t]) => setActiveTabUrl(t?.url ?? ""))
        .catch(() => {});
    };
    window.addEventListener("focus", requery);
    document.addEventListener("visibilitychange", requery);
    return () => {
      window.removeEventListener("focus", requery);
      document.removeEventListener("visibilitychange", requery);
    };
  }, []);

  // Seed the per-run overrides + active config from a project (FR-EX-002/014).
  function applyProjectConfig(proj: Project | null) {
    setActiveConfig(proj?.config ?? null);
    if (proj?.config) {
      setOverrides({
        // Seeded from the project now that scroll-and-stitch (FR-EX-051) and pro
        // capture (FR-EX-052) both exist — a project that turns either on defaults
        // the run toggle on, and the user can still flip it off for this run.
        // The three limits are NOT seeded here any more: a crawl runs until the
        // user stops it, and re-seeding a project's ceiling on every project
        // switch is what used to make an "unlimited" run stop at 200.
        fullPage: proj.config.fullPage,
        proCaptureMode: proj.config.proCaptureMode,
        // FR-EX-090 — a project that defaults to mobile starts the picker there;
        // the user can still switch this run.
        captureMode: proj.config.captureMobile ? ("mobile" as const) : ("desktop" as const),
      });
    }
  }

  function chooseProject(id: string) {
    setSelectedId(id);
    void setSelectedProjectId(id);
    applyProjectConfig(projects.find((p) => p.id === id) ?? null);
  }

  function changeSafeMode(value: boolean) {
    setSafetyOn(value);
    void setSafeMode(value);
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  // Phase-0 discovery demo: run the scanner on the active tab (activeTab grant).
  async function scanPage() {
    setScan({ status: "scanning" });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setScan({ status: "error" });
        return;
      }
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scanAndHighlight,
        args: [{ safety: safetyOn, blocklist: [...DEFAULT_DESTRUCTIVE_BLOCKLIST] }],
      });
      const r = res?.result as { clickable: number; blocked: number } | undefined;
      setScan({ status: "done", count: r?.clickable ?? 0, blocked: r?.blocked ?? 0 });
    } catch {
      setScan({ status: "error" });
    }
  }

  async function capturePage() {
    setCapturing(true);
    setCaptureMsg(null);
    try {
      setCaptureCount(await captureAndStore());
    } catch {
      setCaptureMsg("Can't capture this page (open a normal website).");
    } finally {
      setCapturing(false);
    }
  }

  async function downloadZip() {
    try {
      await downloadCapturesZip();
    } catch {
      setCaptureMsg("Download failed.");
    }
  }

  async function clearShots() {
    await clearCaptures();
    setCaptureCount(0);
    setCaptureMsg(null);
  }

  const activeProject = projects.find((p) => p.id === selectedId) ?? null;
  const projectBaseUrl = activeProject?.baseUrl ?? "current browser tab";
  // FR-EX-010/071 — the project's effective scope, and whether the active tab is in it.
  const projectDomains = activeProject
    ? effectiveAllowedDomains(activeProject.config.allowedDomains, activeProject.baseUrl)
    : [];
  const scopeEnforced = paired && !!activeProject && projectDomains.length > 0;
  const tabInScope = !scopeEnforced || isInScope(activeTabUrl, projectDomains);

  useEffect(() => {
    runStateRef.current = runState;
  }, [runState]);

  // Elapsed timer — ticks only while actively running (RxJS).
  useEffect(() => {
    if (runState !== "running") return;
    const sub = interval(1000).subscribe(() => setElapsed((e) => e + 1));
    return () => sub.unsubscribe();
  }, [runState]);

  // The crawl runs in the SERVICE WORKER against the user's current tab
  // (FR-EX-011); the popup polls its status (it may have been closed meanwhile).
  useEffect(() => {
    let alive = true;
    const applyStatus = (s: Awaited<ReturnType<typeof swGetCrawlStatus>>): void => {
      if (!alive || !s) return;
      const local = runStateRef.current;
      const next = s.runState as RunState;
      // Don't let polling undo a user action: after "New crawl" (local idle) keep
      // idle even if the SW still holds a terminal result; just after Start (local
      // running/paused) ignore a not-yet-updated SW "idle".
      const skip =
        (local === "idle" && next !== "running" && next !== "paused") ||
        ((local === "running" || local === "paused") && next === "idle");
      if (!skip) setRunState(next);
      if (s.progress) setProg(s.progress);
      if (s.result) {
        setReason(s.result.reason);
        setAbandoned(s.result.abandoned);
        if (s.result.error) setCrawlErr(s.result.error);
        if (s.result.sessionId && s.result.uploaded > 0) {
          setUploadNote(
            `Uploaded ${s.result.uploaded} of ${s.result.captures} screenshots to the backend.`,
          );
        }
      }
    };
    void swGetCrawlStatus().then(applyStatus).catch(() => {});
    const id = window.setInterval(() => {
      void swGetCrawlStatus().then(applyStatus).catch(() => {});
    }, 1200);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // "View errors" (FR-EX-082) — read the local error sink when the panel is open,
  // refreshing as the error count changes so it stays live during a run and after
  // Stop. The sink is chrome.storage, so it works even after the popup reopens.
  useEffect(() => {
    if (!showErrors) return;
    let alive = true;
    void getCrawlErrors().then((e) => {
      if (alive) setErrorLog(e);
    });
    return () => {
      alive = false;
    };
  }, [showErrors, prog.errors, runState]);

  const running = runState === "running";
  const paused = runState === "paused";
  const active = running || paused;
  const currentUrl = prog.currentUrl || projectBaseUrl;

  function start() {
    setElapsed(0);
    setProg({ screens: 0, states: 0, depth: 0, queue: 0, pages: 0, errors: 0, currentUrl: "", phase: "", unreachableRegions: 0 });
    setReason(null);
    setCrawlErr(null);
    setUploadNote(null);
    setAbandoned(0);
    shotsRef.current = [];
    setRunState("running");

    const runOptions = {
      ...configToRunOptions(activeConfig, overrides, safetyOn),
      // Paired ⇒ create a backend session and upload captures (FR-EX-011/081).
      projectId: paired && selectedId ? selectedId : undefined,
      // No limit overrides: the run is unbounded and the project config is the
      // only thing that can bound it. Sending a limit here would only ever
      // tighten the run back down.
      sessionOverrides: { fullPage: overrides.fullPage },
      allowedDomains: projectDomains, // FR-EX-010/071 scope
    };
    // Crawl the user's CURRENT tab in place — no separate window.
    const startUrl = activeTabUrl || activeProject?.baseUrl || "";

    // FR-EX-011/015 — acquire Chrome host access IN THIS USER GESTURE (the SW has
    // no gesture and can't prompt). request() only prompts if not already granted.
    // On deny: abort. swStartCrawl needs no gesture, so resolving the active tab
    // after the grant is fine.
    //
    // Chrome asks for all sites here, not just this one: captureVisibleTab accepts
    // only `<all_urls>` or `activeTab`, and a crawl can hold neither per-origin nor
    // activeTab across its own navigations. Without it the crawl runs and captures
    // nothing. The crawl itself still can't leave allowedDomains (FR-EX-010/071).
    void requestCrawlAccess(startUrl, projectDomains)
      .then(async (granted) => {
        if (!granted) {
          setRunState("failed");
          setCrawlErr(
            "SnapCrawl needs access to take screenshots — Chrome asks for all sites because its capture API accepts nothing narrower. The crawl still only visits this project's allowed domains.",
          );
          return;
        }
        // The SW drives THIS tab in place, so hand it the tab the user is on.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setRunState("failed");
          setCrawlErr("No active tab to crawl.");
          return;
        }
        const r = await swStartCrawl(startUrl, { tabId: tab.id, windowId: tab.windowId }, runOptions);
        if (!r.ok) {
          setRunState("failed");
          setCrawlErr(r.message ?? "Couldn't start the crawl.");
        }
      })
      .catch(() => {
        setRunState("failed");
        setCrawlErr("Couldn't request site access.");
      });
  }

  function pause() {
    setRunState("paused");
    void swControlCrawl("pause");
  }
  function resume() {
    setRunState("running");
    void swControlCrawl("resume");
  }
  function stop() {
    void swControlCrawl("stop");
  }

  async function downloadCrawlZip() {
    const shots = shotsRef.current.length ? shotsRef.current : await getCrawlShots();
    shotsRef.current = shots;
    if (shots.length === 0) return;
    try {
      // FR-EX-090 — mobile companions ride along, named after their desktop twin.
      const mobile = await getCrawlMobileShots();
      await downloadDataUrlsZip(shots, "snapcrawl-crawl.zip", true, mobile);
    } catch {
      setCrawlErr("ZIP download failed.");
    }
  }

  return (
    <main
      style={{
        width: 360,
        padding: "var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Logo size={22} />
        <strong style={{ fontSize: "var(--text-lg)", color: "var(--color-text)" }}>
          SnapCrawl
        </strong>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {runState === "idle" ? (
            <Pill tone="neutral">ready</Pill>
          ) : (
            <StatusChip status={runState} />
          )}
          <IconButton
            label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </IconButton>
          <IconButton label="Open settings" onClick={openOptions}>
            <GearIcon />
          </IconButton>
        </span>
      </header>

      {/* Project + config source */}
      <Field label="Project" htmlFor="project">
        <Select
          id="project"
          value={selectedId}
          disabled={active || projects.length === 0}
          onChange={(e) => chooseProject(e.target.value)}
        >
          {projects.length > 0 ? (
            projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))
          ) : (
            <option value="">Active tab (unpaired)</option>
          )}
        </Select>
      </Field>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontSize: "var(--text-xs)",
        }}
      >
        <span className="mono truncate subtle" style={{ flex: 1 }}>
          {projectBaseUrl}
        </span>
        {paired && activeConfig ? (
          <Pill tone="info">project config</Pill>
        ) : (
          <Pill tone="warning">not paired · defaults</Pill>
        )}
      </div>

      {/* Live progress (running / paused) */}
      {active && (
        <Card style={{ padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {/* The count is the headline — there is no ceiling to show it against.
              Elapsed rides in this row so the secondary grid below keeps an even
              number of tiles once Depth is gone. */}
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-2)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
              <span style={{ fontSize: "var(--text-2xl)", fontWeight: 600, lineHeight: 1 }}>
                {prog.screens}
              </span>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                screens captured
              </span>
            </div>
            <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
              {fmtElapsed(elapsed)}
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "var(--space-2)",
            }}
          >
            <StatTile label="States" value={prog.states} />
            <StatTile label="Queue" value={prog.queue} />
            <StatTile label="Errors" value={prog.errors} danger={prog.errors > 0} />
            {/* FR-EX-023 — cross-origin / too-deep iframe regions the crawl can't see into. */}
            <StatTile label="Skipped frames" value={prog.unreachableRegions} />
          </div>
          <Field label="Current screen">
            <span className="mono truncate" style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
              {currentUrl}
            </span>
          </Field>
          <Pill tone="warning">
            {paused
              ? "paused — resume to continue"
              : "crawling this tab — runs until you press Stop; don't switch tabs or type here"}
          </Pill>
        </Card>
      )}

      {/* Terminal summary */}
      {isTerminal(runState) && (
        <Card style={{ padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <StatusChip status={runState} />
            <span className="subtle" style={{ fontSize: "var(--text-xs)" }}>
              {/* "explored every reachable state" is only true if nothing was
                  abandoned. Saying it after giving up on branches reads as
                  "your site is 2 pages", which is how a broken crawl looked
                  like a finished one (FR-EX-084). */}
              {reason === "completed" && abandoned > 0
                ? `stopped — ${abandoned} branch${abandoned === 1 ? "" : "es"} could not be re-reached, so parts of the site were never explored`
                : reason
                  ? REASON_TEXT[reason]
                  : "run ended"}
            </span>
          </div>
          <div style={{ display: "flex", gap: "var(--space-4)", fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
            <span>
              <strong style={{ color: "var(--color-text)" }}>{prog.screens}</strong> screens
            </span>
            <span>
              <strong style={{ color: "var(--color-text)" }}>{prog.states}</strong> states
            </span>
            <span>
              <strong style={{ color: "var(--color-text)" }}>{fmtElapsed(elapsed)}</strong> elapsed
            </span>
          </div>
          {prog.screens > 0 ? (
            <Pill tone="success">
              Saved {prog.screens} screenshot{prog.screens === 1 ? "" : "s"} — ZIP downloaded.
            </Pill>
          ) : (
            <Pill tone="warning">No screenshots captured.</Pill>
          )}
          {/* FR-EX-084 — a run that gave up on branches still ends "completed",
              which reads as "that's the whole site". Say otherwise, in the one
              place the user actually looks. */}
          {abandoned > 0 ? (
            <Pill tone="warning">
              Gave up on {abandoned} branch{abandoned === 1 ? "" : "es"} — couldn&apos;t get back to
              {abandoned === 1 ? " it" : " them"}, so parts of the site went unexplored. See View
              errors.
            </Pill>
          ) : null}
          {uploadNote && <Pill tone="info">{uploadNote}</Pill>}
          {crawlErr && (
            <span className="subtle" style={{ fontSize: "var(--text-xs)", color: "var(--color-danger)" }}>
              {crawlErr}
            </span>
          )}
        </Card>
      )}

      {/* Errors (FR-EX-082) — live during a run and after Stop. Reads the local
          error sink, so it works even if the popup was closed and reopened. */}
      {prog.errors > 0 && (
        <Card style={{ padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span className="section-label" style={{ color: "var(--color-danger)" }}>
              Errors ({prog.errors})
            </span>
            <Button
              variant="ghost"
              size="sm"
              style={{ marginLeft: "auto" }}
              onClick={() => setShowErrors((v) => !v)}
            >
              {showErrors ? "Hide errors" : "View errors"}
            </Button>
          </div>
          {showErrors &&
            (errorLog.length === 0 ? (
              <p className="subtle" style={{ margin: 0, fontSize: "var(--text-xs)" }}>
                No error details recorded yet.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  maxHeight: 180,
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                }}
              >
                {errorLog
                  .slice()
                  .reverse()
                  .map((e, i) => (
                    <li
                      key={`${e.at}-${i}`}
                      style={{
                        borderLeft: "2px solid var(--color-danger)",
                        paddingLeft: "var(--space-2)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
                        <strong style={{ fontSize: "var(--text-xs)", color: "var(--color-text)" }}>
                          {e.event}
                        </strong>
                        <span className="subtle" style={{ fontSize: "var(--text-xs)", marginLeft: "auto" }}>
                          {fmtClock(e.at)}
                        </span>
                      </div>
                      {errContext(e.context) && (
                        <div
                          className="subtle mono"
                          style={{ fontSize: "var(--text-xs)", wordBreak: "break-word" }}
                        >
                          {errContext(e.context)}
                        </div>
                      )}
                    </li>
                  ))}
              </ul>
            ))}
        </Card>
      )}

      {/* Per-run overrides (editable only when idle) */}
      {runState === "idle" && (
        <Card style={{ padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div className="section-label">Capture options</div>
          {/* The Max depth / Max screens / Max minutes inputs are gone: a crawl
              runs until you press Stop. Depth is still tracked internally (capture
              metadata, the sitemap's parent/child edges, the panel) — it is just
              not something the extension asks you to set or shows you. */}
          {/* FR-EX-051 — full-page scroll-and-stitch now exists (the engine walks
              the page a viewport at a time, hides sticky chrome on intermediate
              segments, and stitches on an OffscreenCanvas), so the toggle is real
              again. Off by default: it is several captures per state and much
              slower, and viewport shots are the common case. */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginTop: "var(--space-3)",
              fontSize: "var(--text-sm)",
              color: "var(--color-text)",
            }}
          >
            <Toggle
              checked={overrides.fullPage}
              onChange={(v) => setOverrides((o) => ({ ...o, fullPage: v }))}
              aria-label="Full-page capture — scroll and stitch"
            />
            Full-page capture (scroll &amp; stitch, up to 10 segments)
          </label>
          {/* FR-EX-052 — pro (CDP) full-page capture. The debugger banner is
              disclosed below (C-02) — never hidden. */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginTop: "var(--space-2)",
              fontSize: "var(--text-sm)",
              color: "var(--color-text)",
            }}
          >
            <Toggle
              checked={overrides.proCaptureMode}
              onChange={(v) => setOverrides((o) => ({ ...o, proCaptureMode: v }))}
              aria-label="Pro capture — pixel-perfect full-page via the debugger"
            />
            Pro capture (pixel-perfect full-page, CDP)
          </label>
          {overrides.proCaptureMode && (
            <Pill tone="warning">
              Pro capture shows a Chrome “extension is debugging this browser”
              banner while each screenshot is taken. It falls back to
              scroll-and-stitch if the debugger can’t attach (e.g. DevTools is open).
            </Pill>
          )}
          {/* FR-EX-090 — ONE device per run. Crawling as a phone means the whole
              crawl is a phone: the mobile nav, the mobile-only flows, the mobile
              screenshots. Run it twice if you want both. */}
          <div style={{ marginTop: "var(--space-3)" }}>
            <div className="section-label" style={{ marginBottom: "var(--space-2)" }}>
              Capture as
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              {(
                [
                  { key: "desktop", label: "Desktop" },
                  {
                    key: "mobile",
                    label: `Mobile ${activeConfig?.mobileViewport.width ?? 430}×${activeConfig?.mobileViewport.height ?? 932}`,
                  },
                ] as const
              ).map((m) => {
                const on = overrides.captureMode === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setOverrides((o) => ({ ...o, captureMode: m.key }))}
                    aria-pressed={on}
                    style={{
                      flex: 1,
                      padding: "var(--space-2)",
                      fontSize: "var(--text-sm)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      border: `1px solid ${on ? "var(--color-accent)" : "var(--color-border)"}`,
                      background: on ? "var(--color-accent-soft)" : "transparent",
                      color: on ? "var(--color-text)" : "var(--color-text-muted)",
                      fontWeight: on ? 600 : 400,
                    }}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        {runState === "idle" && (
          <Button variant="primary" block onClick={start} disabled={scopeEnforced && !tabInScope}>
            Start crawl
          </Button>
        )}
        {running && (
          <>
            <Button variant="secondary" block onClick={pause}>
              Pause
            </Button>
            <Button variant="danger" block onClick={stop}>
              Stop
            </Button>
          </>
        )}
        {paused && (
          <>
            <Button variant="primary" block onClick={resume}>
              Resume
            </Button>
            <Button variant="danger" block onClick={stop}>
              Stop
            </Button>
          </>
        )}
        {isTerminal(runState) && (
          <>
            <Button variant="primary" block onClick={() => setRunState("idle")}>
              New crawl
            </Button>
            <Button variant="ghost" block disabled={prog.screens === 0} onClick={() => void downloadCrawlZip()}>
              Download ZIP
            </Button>
          </>
        )}
      </div>

      {runState === "idle" && scopeEnforced && !tabInScope && (
        <Pill tone="warning">
          Start is disabled — the active tab isn't in <strong>{activeProject?.name}</strong>'s
          allowed domains ({projectDomains.join(", ")}). Open an in-scope page (FR-EX-010).
        </Pill>
      )}
      {runState === "idle" && (
        <p className="subtle" style={{ margin: 0, fontSize: "var(--text-xs)" }}>
          BFS-crawls <strong>this tab in place</strong> — don't switch tabs or type here while it
          runs. <strong>Runs until you press Stop</strong> (FR-EX-011/030/050).
        </p>
      )}

      {/* Safety (FR-EX-070) + Discovery (dev) */}
      <div
        style={{
          borderTop: "1px solid var(--color-border)",
          paddingTop: "var(--space-3)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        <div className="section-label">Safe mode</div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            fontSize: "var(--text-sm)",
            color: "var(--color-text)",
          }}
        >
          <Toggle
            checked={safetyOn}
            onChange={changeSafeMode}
            aria-label="Safe mode — skip destructive actions"
          />
          Skip destructive actions (Delete, Log out, Pay…)
        </label>
        {safetyOn ? (
          <span className="subtle" style={{ fontSize: "var(--text-xs)" }}>
            Destructive actions are skipped and logged as blocked (FR-EX-070).
          </span>
        ) : (
          <Pill tone="info">
            Full test mode — destructive actions are clicked too, so you can
            capture what happens after them (staging/test apps).
          </Pill>
        )}

        <div className="section-label" style={{ marginTop: "var(--space-2)" }}>
          Discovery (dev)
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void scanPage()}
          disabled={scan.status === "scanning"}
        >
          {scan.status === "scanning" ? "Scanning…" : "Scan this page"}
        </Button>
        <p className="subtle" style={{ margin: 0, fontSize: "var(--text-xs)" }}>
          {scan.status === "idle" &&
            "Highlights clickable elements on the current tab (dangerous ones show red when safety is on)."}
          {scan.status === "scanning" && "Scanning the active tab…"}
          {scan.status === "done" &&
            (safetyOn
              ? `${scan.count} clickable · ${scan.blocked} blocked (dangerous, red). Outlined for 4s.`
              : `${scan.count} clickable incl. dangerous (safety off, all blue). Outlined for 4s.`)}
          {scan.status === "error" &&
            "Can't scan this page (open a normal website, not chrome:// or the Web Store)."}
        </p>
      </div>

      {/* Screenshots (dev) — FR-EX-050 */}
      <div
        style={{
          borderTop: "1px solid var(--color-border)",
          paddingTop: "var(--space-3)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        <div className="section-label">Screenshots (dev)</div>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void capturePage()}
            disabled={capturing}
          >
            {capturing ? "Capturing…" : "Capture page"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void downloadZip()}
            disabled={captureCount === 0}
          >
            Download ZIP ({captureCount})
          </Button>
          {captureCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => void clearShots()}>
              Clear
            </Button>
          )}
        </div>
        <p className="subtle" style={{ margin: 0, fontSize: "var(--text-xs)" }}>
          {captureMsg ??
            `${captureCount} screenshot${captureCount === 1 ? "" : "s"} saved. Capture the visible tab, then download them all as a ZIP.`}
        </p>
      </div>
    </main>
  );
}
