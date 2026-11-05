/**
 * Relative session-rail timestamp: "Xm ago"/"Xh ago" under 24h old, else an
 * absolute date. Compared against the BROWSER's real clock (`Date.now()`),
 * not the server's pinned `VirtualClock` — this is a client-side display
 * nicety over `updated_at`, which is a real wall-clock epoch ms regardless
 * of what domain time the server itself reasons in.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function relativeTime(epochMs: number, now: number = Date.now()): string {
  const diffMs = now - epochMs;
  // A future/invalid timestamp (clock skew, pinned fixture data newer than
  // "now") has no sensible "ago" phrasing — fall back to the absolute date.
  if (!Number.isFinite(diffMs) || diffMs < 0 || diffMs >= DAY_MS) {
    return new Date(epochMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  if (diffMs < MINUTE_MS) return 'just now';
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  return `${Math.floor(diffMs / HOUR_MS)}h ago`;
}
