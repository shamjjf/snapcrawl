// Interactability filter (FR-EX-021). Keeps only elements a user could actually
// click: attached, enabled, rendered, sized, and hit-testable at their centre.
//
// Layout-dependent checks (size + hit-test) need a real layout engine, so they
// are the part proven in the browser; unit tests mock getBoundingClientRect /
// elementFromPoint to exercise the logic (test DOMs have no layout).

export function isInteractable(el: Element): boolean {
  if (!el.isConnected) return false; // detached from the document
  if (isDisabled(el)) return false;

  const style = safeComputedStyle(el);
  if (style) {
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false; // rendered size > 0

  return isHitTestable(el, rect);
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled === true) return true;
  return el.getAttribute("aria-disabled") === "true";
}

function safeComputedStyle(el: Element): CSSStyleDeclaration | null {
  try {
    return getComputedStyle(el);
  } catch {
    return null;
  }
}

/** Is `el` the top-most element at its centre (or does it wrap / is it wrapped
 *  by the top-most element)? Elements scrolled out of view are NOT rejected —
 *  they're still interactable, we just can't hit-test them at this scroll pos. */
function isHitTestable(el: Element, rect: DOMRect): boolean {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const vw = view?.innerWidth ?? 0;
  const vh = view?.innerHeight ?? 0;
  if (cx < 0 || cy < 0 || cx > vw || cy > vh) return true; // off-screen: keep

  const top = doc.elementFromPoint(cx, cy);
  if (!top) return false;
  return el === top || el.contains(top) || top.contains(el);
}
