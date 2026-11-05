/**
 * Cumulative SESSION cost/token ledger — distinct from `CostBadge`'s
 * per-TURN strip. Sums `turn.completed` metrics (`TurnView.metrics`, set by
 * `lib/fold.ts`'s `turn.completed` branch) across every turn in the fold.
 * Rendered in the transcript header, right of the title. Pure functions —
 * no Vue — so the summation is unit-testable without mounting a component.
 */

import type { TurnView } from './fold.js';
import { formatCost } from './format.js';

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

/** Humanized session ledger for the transcript header — "This session:
 * $0.004". Cost is the one session-level number worth surfacing plainly;
 * token/time detail stays per-turn (CostBadge). Returns `''` when the
 * session has spent nothing genuine yet (brand-new session, or only
 * zero-cost turns) — callers hide the ledger entirely on an empty string. */
export function formatSessionLedger(totals: SessionLedgerTotals): string {
  const cost = formatCost(totals.costUsd);
  return cost ? `This session: ${cost}` : '';
}
