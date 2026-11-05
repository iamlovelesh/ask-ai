/**
 * Shared number formatters for the slim mono metric strips (`CostBadge`'s
 * per-turn cost strip, `lib/ledger.ts`'s cumulative session ledger). A
 * genuinely-zero/unknown value renders as `null` (never a "0ms"/"$0.0000"
 * placeholder) — callers filter nulls out before joining, so a field with
 * nothing genuine to show is omitted entirely rather than padded.
 */

export function formatMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // A real but sub-millisecond duration rounds to 0 — show "<1ms" rather
  // than a misleading "0ms" (which reads as "unmeasured/instant").
  if (ms < 1) return '<1ms';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function formatTokens(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

export function formatCost(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return `$${usd.toFixed(4)}`;
}
