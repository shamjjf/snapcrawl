import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { statusTokens, type SessionStatus } from "@snapcrawl/shared/design";

/** SnapCrawl brand mark: a capture frame + a small crawl-path node graph.
 *  Inline SVG (theme-aware via tokens) — distinct from the toolbar PNG icon. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      role="img"
    >
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="5"
        stroke="var(--color-primary-text)"
        strokeWidth="2"
      />
      <path
        d="M7 15 L12 9 L17 14"
        stroke="var(--color-primary-text)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="15" r="1.9" fill="var(--color-primary-text)" />
      <circle cx="12" cy="9" r="1.9" fill="var(--color-primary-text)" />
      <circle cx="17" cy="14" r="1.9" fill="var(--color-primary-text)" />
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  block?: boolean;
};

export function Button({
  variant = "secondary",
  size = "md",
  block = false,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = [
    "btn",
    `btn--${variant}`,
    `btn--${size}`,
    block ? "btn--block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  // eslint-disable-next-line react/button-has-type
  return <button type={type} className={cls} {...rest} />;
}

export function IconButton({
  label,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="card" style={style}>
      {children}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? (
        <span className="subtle" style={{ fontSize: "var(--text-xs)" }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Input({
  mono = false,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      className={["input", mono ? "input--mono" : "", className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function Select({
  children,
  className = "",
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={["select", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  id,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  "aria-label"?: string;
}) {
  return (
    <span className="toggle">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle__track" />
      <span className="toggle__thumb" />
    </span>
  );
}

export function StatTile({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div
        className="stat__value"
        style={danger ? { color: "var(--color-danger)" } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

/** Session-status pill — dot + text label (text is required, never color alone). */
export function StatusChip({ status }: { status: SessionStatus }) {
  const t = statusTokens(status);
  const live = status === "running" || status === "paused";
  return (
    <span className="chip" style={{ background: t.bg, color: t.text }}>
      <span
        className={`chip__dot${live ? " chip__dot--live" : ""}`}
        style={{ background: t.dot }}
      />
      {status}
    </span>
  );
}

/** Neutral pill for non-session states (e.g. "ready", "in scope"). */
export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "info";
}) {
  const map: Record<string, { bg: string; text: string; dot: string }> = {
    neutral: {
      bg: "var(--status-pending-bg)",
      text: "var(--status-pending-text)",
      dot: "var(--status-pending-dot)",
    },
    success: {
      bg: "var(--color-success-subtle-bg)",
      text: "var(--color-success-subtle-text)",
      dot: "var(--color-success)",
    },
    warning: {
      bg: "var(--color-warning-subtle-bg)",
      text: "var(--color-warning-subtle-text)",
      dot: "var(--color-warning)",
    },
    info: {
      bg: "var(--color-info-subtle-bg)",
      text: "var(--color-info-subtle-text)",
      dot: "var(--color-info)",
    },
  };
  const t = map[tone] ?? map.neutral!;
  return (
    <span className="chip" style={{ background: t.bg, color: t.text }}>
      <span className="chip__dot" style={{ background: t.dot }} />
      {children}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="section-label">{children}</div>;
}

/* Small inline glyphs (stroke = currentColor so they inherit text color). */
export function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Refined cog: rounded toothed ring + center hub */}
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function SunIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
