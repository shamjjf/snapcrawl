import { useEffect, useState } from "react";
import type { Project } from "@snapcrawl/shared";
import {
  Button,
  Card,
  Field,
  Input,
  Logo,
  Pill,
  SectionLabel,
} from "../components/ui";
import { getTheme, setTheme, type ThemeMode } from "../lib/theme";
import { pairExtension } from "../lib/messaging";
import {
  getCachedProjects,
  getPairing,
  getSelectedProjectId,
  setSelectedProjectId,
} from "../lib/pairing";

type ConnState = "idle" | "testing" | "connected" | "failed";

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const cardStyle = {
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column" as const,
  gap: "var(--space-4)",
};

export function App() {
  const [backendUrl, setBackendUrl] = useState("");
  const [pairingToken, setPairingToken] = useState("");
  const [conn, setConn] = useState<ConnState>("idle");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemeMode>("system");

  useEffect(() => {
    setThemeState(getTheme());
    // Restore an existing pairing (FR-EX-001) — backend URL + cached projects.
    // The token is a secret and is never surfaced back into the field (C-05).
    void (async () => {
      const pairing = await getPairing();
      if (!pairing) return;
      setBackendUrl(pairing.backendUrl);
      setConn("connected");
      const [cached, storedId] = await Promise.all([getCachedProjects(), getSelectedProjectId()]);
      setProjects(cached);
      setProjectId(storedId && cached.some((p) => p.id === storedId) ? storedId : cached[0]?.id ?? "");
    })();
  }, []);

  function chooseTheme(mode: ThemeMode) {
    setThemeState(mode);
    setTheme(mode);
  }

  function chooseProject(id: string) {
    setProjectId(id);
    void setSelectedProjectId(id);
  }

  // Real pairing (FR-EX-001): the SW calls GET /ext/projects with the bearer
  // token; 200 ⇒ connected + projects, 401/403 ⇒ the envelope's re-pair message.
  async function testConnection() {
    if (!backendUrl.trim() || !pairingToken.trim()) {
      setConn("failed");
      setErrMsg("Enter both a backend URL and a pairing token.");
      return;
    }
    setConn("testing");
    setErrMsg(null);
    const result = await pairExtension(backendUrl, pairingToken);
    if (result.ok) {
      setConn("connected");
      setProjects(result.projects);
      setPairingToken(""); // don't keep the secret in component state
      const id =
        projectId && result.projects.some((p) => p.id === projectId)
          ? projectId
          : result.projects[0]?.id ?? "";
      setProjectId(id);
      if (id) void setSelectedProjectId(id);
      setErrMsg(
        result.projects.length === 0
          ? "Paired, but you have no projects yet — create one in the admin panel."
          : null,
      );
    } else {
      setConn("failed");
      setErrMsg(result.message);
    }
  }

  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "var(--space-8) var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-5)",
      }}
    >
      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <Logo size={28} />
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: "var(--weight-bold)", color: "var(--color-text)" }}>
            SnapCrawl — Settings
          </h1>
          <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
            Pair this extension with your backend and pick a project.
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={theme === t.value}
              onClick={() => chooseTheme(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* Pairing (FR-EX-001) */}
      <Card style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <SectionLabel>Pairing</SectionLabel>
          <span style={{ marginLeft: "auto" }}>
            {conn === "connected" && <Pill tone="success">connected</Pill>}
            {conn === "testing" && <Pill tone="info">testing…</Pill>}
            {conn === "failed" && <Pill tone="warning">not connected</Pill>}
            {conn === "idle" && <Pill tone="neutral">not paired</Pill>}
          </span>
        </div>

        <Field
          label="Backend URL"
          htmlFor="backendUrl"
          hint="The SnapCrawl API base, e.g. http://localhost:4000"
        >
          <Input
            id="backendUrl"
            type="url"
            placeholder="http://localhost:4000"
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
          />
        </Field>

        <Field
          label="Pairing token"
          htmlFor="pairingToken"
          hint="Generated once in the admin panel; stored locally, never logged (C-05)."
        >
          <Input
            id="pairingToken"
            mono
            type="password"
            placeholder={conn === "connected" ? "•••••••• (paired — re-enter to re-pair)" : "sc_live_••••••••••••"}
            value={pairingToken}
            onChange={(e) => setPairingToken(e.target.value)}
          />
        </Field>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <Button variant="primary" onClick={testConnection} disabled={conn === "testing"}>
            {conn === "testing" ? "Testing…" : "Test connection"}
          </Button>
          {errMsg && (
            <span
              className="subtle"
              style={{
                fontSize: "var(--text-sm)",
                color: conn === "failed" ? "var(--color-danger)" : "var(--color-text-muted)",
              }}
            >
              {errMsg}
            </span>
          )}
        </div>
      </Card>

      {/* Project selection (FR-EX-002) — real projects once paired */}
      {conn === "connected" && projects.length > 0 && (
        <Card style={cardStyle}>
          <SectionLabel>Active project</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {projects.map((p) => {
              const selected = p.id === projectId;
              return (
                <label
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-3)",
                    padding: "var(--space-3)",
                    borderRadius: "var(--radius-md)",
                    border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                    background: selected ? "var(--color-primary-subtle-bg)" : "var(--color-surface)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="project"
                    value={p.id}
                    checked={selected}
                    onChange={() => chooseProject(p.id)}
                  />
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)", color: "var(--color-text)" }}>
                      {p.name}
                    </span>
                    <span className="mono subtle truncate" style={{ fontSize: "var(--text-xs)" }}>
                      {p.baseUrl}
                    </span>
                  </span>
                  <span style={{ marginLeft: "auto" }}>
                    <Pill tone="neutral">depth {p.config.maxDepth} · {p.config.maxScreens} shots</Pill>
                  </span>
                </label>
              );
            })}
          </div>
        </Card>
      )}

      {/* Help */}
      <Card style={cardStyle}>
        <SectionLabel>How pairing works</SectionLabel>
        <ol style={{ margin: 0, paddingLeft: "var(--space-5)", fontSize: "var(--text-sm)", color: "var(--color-text-muted)", lineHeight: "var(--leading-normal)", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <li>In the admin panel, generate a personal pairing token.</li>
          <li>Paste the backend URL and token above, then Test connection.</li>
          <li>Pick your active project — the popup uses its crawl config.</li>
        </ol>
      </Card>
    </main>
  );
}
