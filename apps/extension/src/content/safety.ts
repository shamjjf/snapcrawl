// Safety controls (FR-EX-070). The crawler must NEVER click an element whose
// visible text, aria-label, title, or value matches (case-insensitive, trimmed,
// whole-word) an entry of the destructive blocklist; such elements are recorded
// as blocked instead of clicked.
//
// ⚠ CLAUDE.md: any change under this file MUST update safety.test.ts in the
// same commit.

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The text sources checked against the blocklist (FR-EX-070). */
export function safetyTexts(el: Element): string[] {
  const out: string[] = [];
  const aria = el.getAttribute("aria-label");
  if (aria) out.push(aria);
  const title = el.getAttribute("title");
  if (title) out.push(title);
  if (el.tagName === "INPUT") {
    const value = (el as HTMLInputElement).value;
    if (value) out.push(value);
  }
  if (el.textContent) out.push(el.textContent);
  return out;
}

/** Whole-word / whole-phrase match, so "send" blocks "Send" but not "Resend". */
function phraseMatches(text: string, needle: string): boolean {
  if (text === needle) return true;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(text);
}

/** Is `el` destructive per the (session's) blocklist? Empty list = nothing blocked. */
export function isDestructive(el: Element, blocklist: readonly string[]): boolean {
  const needles = blocklist.map(normalize).filter(Boolean);
  if (needles.length === 0) return false;
  for (const raw of safetyTexts(el)) {
    const text = normalize(raw);
    for (const needle of needles) {
      if (phraseMatches(text, needle)) return true;
    }
  }
  return false;
}
