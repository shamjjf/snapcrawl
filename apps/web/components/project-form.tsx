"use client";

// Project create/edit form (FR-AP-020). Covers EVERY field of the crawl config
// (FR-BE-021) with inline validation and safe defaults, and uses tag-style
// editors for the list fields (FR-AP-021). Validation runs against the shared
// Zod schemas — the same rules the backend enforces (incl. FR-BE-023's
// base-URL-in-allowedDomains check), so field errors match server behaviour.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  crawlConfigSchema,
  projectCreateSchema,
  type CrawlConfig,
  type Project,
  type ProjectCreate,
} from "@snapcrawl/shared";
import { Button, Checkbox, Field, Input, Textarea } from "@/components/ui";
import { TagInput } from "@/components/tag-input";

// Safe defaults straight from the shared schema (FR-BE-021 defaults, incl. the
// pre-populated destructive blocklist from the shared safety constants).
const DEFAULT_CONFIG: CrawlConfig = crawlConfigSchema.parse({});

/** Value to drop back to when "Unlimited" is unticked — the schema's own
 *  defaults are null now, so unticking needs a concrete finite starting point. */
const LIMIT_FALLBACK = { maxDepth: 5, maxScreens: 200, maxDurationMin: 30 } as const;

type Errors = Record<string, string>;

const DOMAIN_RE = /^(localhost|(\*\.)?([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?$/i;

export function ProjectForm({
  mode,
  initial,
  submitting,
  onSubmit,
}: {
  mode: "create" | "edit";
  initial?: Project;
  submitting: boolean;
  onSubmit: (payload: ProjectCreate) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [config, setConfig] = useState<CrawlConfig>(initial?.config ?? DEFAULT_CONFIG);
  const [errors, setErrors] = useState<Errors>({});

  function setCfg<K extends keyof CrawlConfig>(key: K, value: CrawlConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
  }
  function setNum<K extends keyof CrawlConfig>(key: K, raw: string) {
    const n = Number.parseInt(raw, 10);
    setCfg(key, (Number.isNaN(n) ? 0 : n) as CrawlConfig[K]);
  }
  /** Limit fields are `number | null` where null = unlimited. Toggling the
   *  checkbox is the ONLY way to produce null — deliberately, because this form
   *  is noValidate and an emptied number input parses to 0, so any numeric
   *  sentinel would let a stray keystroke silently unbound a crawl. */
  function setLimit(key: "maxDepth" | "maxScreens" | "maxDurationMin", unlimited: boolean) {
    setCfg(key, unlimited ? null : LIMIT_FALLBACK[key]);
  }

  function validate(): ProjectCreate | null {
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      baseUrl: baseUrl.trim(),
      config,
    };
    const parsed = projectCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const map: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (!map[key]) map[key] = issue.message;
      }
      setErrors(map);
      return null;
    }
    setErrors({});
    return parsed.data;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const payload = validate();
    if (payload) onSubmit(payload);
  }

  const err = (path: string) => errors[path];

  return (
    <form onSubmit={submit} noValidate className="project-form">
      {/* ── Basics ─────────────────────────────────────────────── */}
      <section className="card form-section">
        <h2 className="form-section__title">Basics</h2>
        <Field label="Name" htmlFor="p-name" error={err("name")}>
          <Input
            id="p-name"
            value={name}
            invalid={!!err("name")}
            placeholder="Acme Staging"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="p-desc"
          error={err("description")}
          hint="Optional. What this crawl target is."
        >
          <Textarea
            id="p-desc"
            value={description}
            invalid={!!err("description")}
            placeholder="QA crawl of the staging SPA."
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label="Base URL"
          htmlFor="p-url"
          error={err("baseUrl")}
          hint="The crawl start URL. Must sit within the allowed domains below."
        >
          <Input
            id="p-url"
            type="url"
            value={baseUrl}
            invalid={!!err("baseUrl")}
            placeholder="https://staging.acme.example"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
      </section>

      {/* ── Scope & safety ─────────────────────────────────────── */}
      <section className="card form-section">
        <h2 className="form-section__title">Scope &amp; safety</h2>

        <Field
          label="Allowed domains"
          htmlFor="p-domains"
          error={err("config.allowedDomains")}
          hint="Navigations outside these are blocked. Include the base URL's domain."
        >
          <TagInput
            id="p-domains"
            ariaLabel="Allowed domains"
            values={config.allowedDomains}
            onChange={(v) => setCfg("allowedDomains", v)}
            placeholder="staging.acme.example"
            validate={(v) =>
              DOMAIN_RE.test(v) ? null : "Enter a valid domain (e.g. app.example.com)."
            }
          />
        </Field>

        <Field
          label="Destructive text blocklist"
          htmlFor="p-blocklist"
          error={err("config.destructiveTextBlocklist")}
          hint="Elements whose text matches these are never clicked (FR-EX-070). Pre-filled with safe defaults."
        >
          <TagInput
            id="p-blocklist"
            ariaLabel="Destructive text blocklist"
            values={config.destructiveTextBlocklist}
            onChange={(v) => setCfg("destructiveTextBlocklist", v)}
            placeholder="delete"
          />
        </Field>

        <Field
          label="Mask selectors"
          htmlFor="p-mask"
          error={err("config.maskSelectors")}
          hint="CSS selectors covered by an opaque overlay before capture so PII never reaches storage."
        >
          <TagInput
            id="p-mask"
            ariaLabel="Mask selectors"
            values={config.maskSelectors}
            onChange={(v) => setCfg("maskSelectors", v)}
            placeholder=".user-avatar"
          />
        </Field>

        <Field
          label="Exclude selectors"
          htmlFor="p-exclude-sel"
          error={err("config.excludeSelectors")}
          hint="CSS selectors that are never clicked."
        >
          <TagInput
            id="p-exclude-sel"
            ariaLabel="Exclude selectors"
            values={config.excludeSelectors}
            onChange={(v) => setCfg("excludeSelectors", v)}
            placeholder="#chat-widget"
          />
        </Field>

        <Field
          label="Exclude URL patterns"
          htmlFor="p-exclude-url"
          error={err("config.excludeUrlPatterns")}
          hint="Links matching these globs/regexes are never followed."
        >
          <TagInput
            id="p-exclude-url"
            ariaLabel="Exclude URL patterns"
            values={config.excludeUrlPatterns}
            onChange={(v) => setCfg("excludeUrlPatterns", v)}
            placeholder="/admin/*"
          />
        </Field>
      </section>

      {/* ── Limits & capture ───────────────────────────────────── */}
      <section className="card form-section">
        <h2 className="form-section__title">Limits &amp; capture</h2>
        <div className="form-grid">
          {(
            [
              { key: "maxDepth", label: "Max depth", id: "p-maxdepth", min: 1, max: 20 },
              { key: "maxScreens", label: "Max screens", id: "p-maxscreens", min: 1, max: 5000 },
              { key: "maxDurationMin", label: "Max duration (min)", id: "p-maxdur", min: 1, max: 240 },
            ] as const
          ).map((f) => {
            const unlimited = config[f.key] === null;
            return (
              <Field key={f.key} label={f.label} htmlFor={f.id} error={err(`config.${f.key}`)}>
                <Input
                  id={f.id}
                  type="number"
                  min={f.min}
                  max={f.max}
                  disabled={unlimited}
                  value={unlimited ? "" : (config[f.key] as number)}
                  placeholder={unlimited ? "Unlimited" : undefined}
                  onChange={(e) => setNum(f.key, e.target.value)}
                />
                <label className="subtle" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={unlimited}
                    onChange={(e) => setLimit(f.key, e.target.checked)}
                  />
                  Unlimited
                </label>
              </Field>
            );
          })}
          {/* FR-EX-033 — the shutter delay. Sites with entrance animations or
              content that streams in after first paint need a real pause; the
              stability check only watches the DOM and the network. */}
          <Field
            label="Wait before screenshot (ms)"
            htmlFor="p-settle"
            error={err("config.captureSettleMs")}
            hint="Extra pause after images and fonts finish, before each shot. Raise to 10000–20000 for sites that animate in."
          >
            <Input
              id="p-settle"
              type="number"
              min={0}
              max={60000}
              step={500}
              value={config.captureSettleMs}
              onChange={(e) => setNum("captureSettleMs", e.target.value)}
            />
          </Field>
          <Field label="Click delay (ms)" htmlFor="p-clickdelay" error={err("config.clickDelayMs")}>
            <Input
              id="p-clickdelay"
              type="number"
              min={0}
              max={10000}
              step={100}
              value={config.clickDelayMs}
              onChange={(e) => setNum("clickDelayMs", e.target.value)}
            />
          </Field>
          <Field
            label="Stability timeout (ms)"
            htmlFor="p-stability"
            error={err("config.stabilityTimeoutMs")}
          >
            <Input
              id="p-stability"
              type="number"
              min={500}
              max={60000}
              step={100}
              value={config.stabilityTimeoutMs}
              onChange={(e) => setNum("stabilityTimeoutMs", e.target.value)}
            />
          </Field>
          <Field
            label="Sibling collapse limit"
            htmlFor="p-sibling"
            error={err("config.siblingCollapseLimit")}
          >
            <Input
              id="p-sibling"
              type="number"
              min={0}
              max={50}
              value={config.siblingCollapseLimit}
              onChange={(e) => setNum("siblingCollapseLimit", e.target.value)}
            />
          </Field>
          <Field
            label="Viewport width"
            htmlFor="p-vw"
            error={err("config.viewport.width")}
          >
            <Input
              id="p-vw"
              type="number"
              min={320}
              max={3840}
              value={config.viewport.width}
              onChange={(e) =>
                setCfg("viewport", {
                  ...config.viewport,
                  width: Number.parseInt(e.target.value, 10) || 0,
                })
              }
            />
          </Field>
          <Field
            label="Viewport height"
            htmlFor="p-vh"
            error={err("config.viewport.height")}
          >
            <Input
              id="p-vh"
              type="number"
              min={320}
              max={2160}
              value={config.viewport.height}
              onChange={(e) =>
                setCfg("viewport", {
                  ...config.viewport,
                  height: Number.parseInt(e.target.value, 10) || 0,
                })
              }
            />
          </Field>
        </div>
        <div style={{ marginTop: "var(--space-4)" }}>
          <Checkbox
            label="Capture full page (scroll & stitch)"
            checked={config.fullPage}
            onChange={(e) => setCfg("fullPage", e.target.checked)}
          />
        </div>
        {/* FR-EX-090 */}
        <div style={{ marginTop: "var(--space-4)" }}>
          <Checkbox
            label="Crawl as mobile by default"
            checked={config.captureMobile}
            onChange={(e) => setCfg("captureMobile", e.target.checked)}
          />
          <p className="subtle" style={{ fontSize: "var(--text-xs)", margin: "var(--space-1) 0 0" }}>
            Sets the default device for this project&apos;s crawls. A run captures{" "}
            <strong>one</strong> device, not both: in mobile mode the whole crawl runs at{" "}
            {config.mobileViewport.width}×{config.mobileViewport.height} with a phone user-agent, so
            you get the real mobile site — hamburger nav and all — rather than a narrowed desktop
            one. Chrome shows a &ldquo;being debugged&rdquo; banner for the duration. Run the crawl
            twice if you want both devices.
          </p>
        </div>
        <div style={{ marginTop: "var(--space-4)" }}>
          <Checkbox
            label="Click submit buttons in forms"
            checked={config.clickSubmitEmptyForms}
            onChange={(e) => setCfg("clickSubmitEmptyForms", e.target.checked)}
          />
          <p className="subtle" style={{ fontSize: "var(--text-xs)", margin: "var(--space-1) 0 0" }}>
            Off by default. The crawler never fills fields, so clicking a submit sends the form
            as-is. Turn this on to raise coverage on apps whose buttons sit inside forms — buttons
            matching the destructive blocklist are never clicked either way.
          </p>
        </div>
      </section>

      <div className="form-actions">
        <Link href="/projects" className="btn btn--secondary btn--md">
          Cancel
        </Link>
        <Button type="submit" variant="primary" loading={submitting}>
          {mode === "create" ? "Create project" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
