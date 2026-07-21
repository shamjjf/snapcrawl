import { useEffect, useRef, type RefObject } from "react";

// Modal keyboard behaviour (FR-AP-073). A dialog that isn't focus-managed is a
// keyboard trap in reverse: focus stays on whatever was behind it, Tab walks off
// into the page under the overlay, and Esc does nothing. This hook gives a modal
// the three things a keyboard/AT user needs:
//
//   1. focus moves INTO the dialog when it opens (first focusable, or the
//      container itself as a fallback — so give the container tabIndex={-1});
//   2. Tab / Shift+Tab CYCLE within the dialog instead of leaving it;
//   3. focus RETURNS to the element that opened it when it closes.
//
// Esc-to-close is handled here too, with stopPropagation, so a nested dialog
// (e.g. the delete confirm over the screenshot viewer) closes only itself.

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
): void {
  // Keep the latest onClose without making it an effect dependency: callers pass
  // inline arrows, so depending on its identity would re-run the trap (and
  // re-steal focus) on every parent render. The effect should re-run only when
  // the dialog actually opens or closes.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;

    // Remember who to hand focus back to (the thumbnail, the row action…).
    const restoreTo = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        // Skip anything not actually rendered (display:none etc.).
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus in. Prefer the first control; fall back to the container.
    (focusables()[0] ?? container).focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        container!.focus();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const activeEl = document.activeElement;
      const outside = !container!.contains(activeEl);
      if (e.shiftKey && (activeEl === firstEl || outside)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (activeEl === lastEl || outside)) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Only steal focus back if it's still inside the closing dialog, so we
      // don't yank it away from wherever the user has since moved.
      if (restoreTo && container.contains(document.activeElement)) {
        restoreTo.focus?.();
      }
    };
    // onClose is intentionally read through a ref, not depended on — see above.
  }, [ref, active]);
}
