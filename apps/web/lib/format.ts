// Small date/format helpers. Response schemas coerce timestamps to `Date`, so
// these accept Date | string | null and render a stable placeholder for empties.

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human duration between two timestamps; when `end` is null, elapsed until now. */
export function fmtDuration(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
): string {
  if (!start) return "—";
  const s = start instanceof Date ? start : new Date(start);
  if (Number.isNaN(s.getTime())) return "—";
  const endMs = end ? (end instanceof Date ? end : new Date(end)).getTime() : Date.now();
  const ms = endMs - s.getTime();
  if (ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
