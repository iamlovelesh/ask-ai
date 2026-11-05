/**
 * Cumulative SESSION cost/token ledger — distinct from `CostBadge`'s
 * per-TURN strip. Sums `turn.completed` metrics (`TurnView.metrics`, set by
 * `lib/fold.ts`'s `turn.completed` branch) across every turn in the fold.
 * Rendered in the transcript header, right of the title. Pure functions —
 * no Vue — so the summation is unit-testable without mounting a component.
 */

import type { TurnView } from './fold.js';
import { formatCost, formatMs, formatTokens } from './format.js';

export interface SessionLedgerTotals {
  totalMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  llmCalls: number;
}

/** A turn still running, or one that errored before `turn.completed` ever
 * fired, has no `metrics` and contributes nothing to the sum. */
export function sumSessionMetrics(turns: readonly TurnView[]): SessionLedgerTotals {
  const totals: SessionLedgerTotals = { totalMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, llmCalls: 0 };
  for (const turn of turns) {
    const m = turn.metrics;
    if (!m) continue;
    totals.totalMs += m.totalMs;
    totals.tokensIn += m.tokensIn;
    totals.tokensOut += m.tokensOut;
    totals.costUsd += m.costUsd;
    totals.llmCalls += m.llmCalls;
  }
  return totals;
}

/** Formats session totals into the same slim mono strip style as
 * `CostBadge` — any zero/unknown field is omitted entirely, never padded
 * out as "0ms"/"$0.0000". Returns `''` when every field is zero (e.g. a
 * brand-new session with no completed turns yet) — callers should hide the
 * ledger entirely on an empty string. */
export function formatSessionLedger(totals: SessionLedgerTotals): string {
  const parts = [
    formatMs(totals.totalMs),
    formatTokens(totals.tokensIn + totals.tokensOut),
    formatCost(totals.costUsd),
  ].filter((p): p is string => p !== null);
  if (totals.llmCalls > 1) parts.push(`${totals.llmCalls} llm calls`);
  return parts.join('  ');
}
