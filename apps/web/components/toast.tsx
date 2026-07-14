"use client";

// Global toast system (FR-AP-070). API errors are surfaced as human-readable
// toasts mapped from the uniform `{ code, message, details[] }` envelope —
// never raw stack traces.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ErrorEnvelope } from "@snapcrawl/shared";

type ToastTone = "danger" | "success" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string;
}

interface ToastApi {
  show: (t: { tone?: ToastTone; message: string; detail?: string }) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  /** Map an error envelope (or plain string) to a danger toast. */
  error: (e: ErrorEnvelope | string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>.");
  return ctx;
}

const AUTODISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (t: { tone?: ToastTone; message: string; detail?: string }) => {
      const id = (idRef.current += 1);
      setItems((cur) => [
        ...cur,
        { id, tone: t.tone ?? "info", message: t.message, detail: t.detail },
      ]);
      window.setTimeout(() => dismiss(id), AUTODISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (message) => show({ tone: "success", message }),
      info: (message) => show({ tone: "info", message }),
      error: (e) => {
        if (typeof e === "string") {
          show({ tone: "danger", message: e });
          return;
        }
        const detail = e.details?.length
          ? e.details
              .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
              .join(" · ")
          : undefined;
        show({ tone: "danger", message: e.message || "Something went wrong.", detail });
      },
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="toast-region"
        role="region"
        aria-live="polite"
        aria-label="Notifications"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast--${t.tone}`}
            role={t.tone === "danger" ? "alert" : "status"}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="toast__message">{t.message}</div>
              {t.detail ? <div className="toast__detail">{t.detail}</div> : null}
            </div>
            <button
              type="button"
              className="toast__close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
