/**
 * Pure report math (Task 16, LLD §9.2 report tables): percentiles,
 * pass^1/pass^3, latency buckets split direct/complex, and cost-per-
 * successful-task — all operating on already-parsed `ResultRow[]` so
 * `eval/test/report.test.ts` can exercise every formula against synthetic
 * rows with no filesystem/HTTP involved. `eval/report.ts` (the CLI) is the
 * only consumer that touches disk.
 */

import type { ResultRow, TurnResultRow } from './runner-tuples.js';

export type Agent = 'optimized' | 'baseline';

/** Nearest-rank percentile — the SAME formula `server/src/api/metrics.ts`
 * uses, so a benchmark table and a live `/api/metrics` query of the same
 * data always agree. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx] as number;
}

function turnsOf(rows: readonly ResultRow[], agent: Agent): TurnResultRow[] {
  return rows.filter((r) => r.agent === agent).flatMap((r) => r.turns);
}

// --- pass^1 / pass^3 ---------------------------------------------------------

export interface PassRate {
  passed: number;
  total: number;
  rate: number;
}

/** Fraction of trial-1 rows (one per scenario, for `agent`) that passed
 * overall. This is "pass on a single sampled trial" — the standard pass^1
 * definition. */
export function pass1Rate(rows: readonly ResultRow[], agent: Agent): PassRate {
  const trial1 = rows.filter((r) => r.agent === agent && r.trial === 1);
  const passed = trial1.filter((r) => r.pass).length;
  return { passed, total: trial1.length, rate: trial1.length === 0 ? 0 : passed / trial1.length };
}

/**
 * Fraction of scenarios (for `agent`) that passed on EVERY one of trials
 * 1–3 — only meaningful once ≥3 trials were actually run; returns
 * `undefined` when no scenario has 3+ recorded trials for this agent
 * (LLD §8: baseline is 1-trial-only by design, so this is always
 * `undefined` for `'baseline'`).
 */
export function pass3Rate(rows: readonly ResultRow[], agent: Agent): PassRate | undefined {
  const byScenario = new Map<string, ResultRow[]>();
  for (const r of rows) {
    if (r.agent !== agent) continue;
    const bucket = byScenario.get(r.scenarioId);
    if (bucket) bucket.push(r);
    else byScenario.set(r.scenarioId, [r]);
  }
  const eligible = [...byScenario.values()].filter((group) => {
    const trials = new Set(group.map((r) => r.trial));
    return trials.has(1) && trials.has(2) && trials.has(3);
  });
  if (eligible.length === 0) return undefined;

  const passed = eligible.filter((group) =>
    [1, 2, 3].every((trial) => group.find((r) => r.trial === trial)?.pass === true),
  ).length;
  return { passed, total: eligible.length, rate: passed / eligible.length };
}

export function byCategory<T>(
  rows: readonly ResultRow[],
  compute: (rowsInCategory: ResultRow[]) => T,
): Record<string, T> {
  const groups = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const bucket = groups.get(r.category);
    if (bucket) bucket.push(r);
    else groups.set(r.category, [r]);
  }
  const out: Record<string, T> = {};
  for (const [category, group] of groups) out[category] = compute(group);
  return out;
}

// --- latency (direct vs complex, per docs/TARGETS.md §1) --------------------

export interface LatencyBucket {
  count: number;
  p50TtfurMs: number;
  p95TtfurMs: number;
  p50E2eMs: number;
  p95E2eMs: number;
}

export function latencyBucket(rows: readonly ResultRow[], agent: Agent, complex: boolean): LatencyBucket {
  const turns = turnsOf(rows, agent).filter((t) => t.complex === complex);
  const ttfur = turns.map((t) => t.ttfurMs).sort((a, b) => a - b);
  const e2e = turns.map((t) => t.totalMs).sort((a, b) => a - b);
  return {
    count: turns.length,
    p50TtfurMs: percentile(ttfur, 0.5),
    p95TtfurMs: percentile(ttfur, 0.95),
    p50E2eMs: percentile(e2e, 0.5),
    p95E2eMs: percentile(e2e, 0.95),
  };
}

// --- tokens / cost ------------------------------------------------------------

export interface CostStats {
  requests: number;
  avgTokensInPerRequest: number;
  avgTokensOutPerRequest: number;
  avgCostPerRequestUsd: number;
  /** `undefined` when no trial for this agent passed — "no successful
   * task" rather than a divide-by-zero `0`. */
  costPerSuccessfulTaskUsd: number | undefined;
}

export function costStats(rows: readonly ResultRow[], agent: Agent): CostStats {
  const agentRows = rows.filter((r) => r.agent === agent);
  const turns = agentRows.flatMap((r) => r.turns);
  const requests = turns.length;
  const totalTokensIn = turns.reduce((s, t) => s + t.tokensIn, 0);
  const totalTokensOut = turns.reduce((s, t) => s + t.tokensOut, 0);
  const totalCost = turns.reduce((s, t) => s + t.costUsd, 0);

  // Cost per SUCCESSFUL task (docs/TARGETS.md §2): sum of every passing
  // trial's turn costs (which already includes the cost of any
  // repair/replan/search retries inside that trial — "including retries"
  // per the brief) divided by the count of passing trials. Failed trials'
  // cost is deliberately excluded from this ratio's numerator AND
  // denominator — it's reported separately as `avgCostPerRequestUsd`.
  const passingRows = agentRows.filter((r) => r.pass);
  const successfulCost = passingRows.reduce((s, r) => s + r.turns.reduce((ts, t) => ts + t.costUsd, 0), 0);

  return {
    requests,
    avgTokensInPerRequest: requests === 0 ? 0 : totalTokensIn / requests,
    avgTokensOutPerRequest: requests === 0 ? 0 : totalTokensOut / requests,
    avgCostPerRequestUsd: requests === 0 ? 0 : totalCost / requests,
    costPerSuccessfulTaskUsd: passingRows.length === 0 ? undefined : successfulCost / passingRows.length,
  };
}

// --- repair-rate assumption (complex turns, optimized agent only) ----------

/** Fraction of COMPLEX turns (for `agent`) that triggered at least one
 * repair/replan/search round — docs/TARGETS.md §2's pre-registered
 * stability ASSUMPTION, not a pass/fail gate. */
export function repairRateComplex(rows: readonly ResultRow[], agent: Agent): PassRate {
  const complexTurns = turnsOf(rows, agent).filter((t) => t.complex);
  const triggered = complexTurns.filter((t) => t.repairs + t.replans + t.searchRounds > 0).length;
  return { passed: triggered, total: complexTurns.length, rate: complexTurns.length === 0 ? 0 : triggered / complexTurns.length };
}

// --- baseline delta -------------------------------------------------------

/** `optimized pass^1 - baseline pass^1`, in PERCENTAGE POINTS (e.g. `18`
 * means optimized is 18pp ahead of baseline) — `docs/TARGETS.md §2`'s
 * "optimized ≥ baseline + 15 points". */
export function baselineDeltaPoints(rows: readonly ResultRow[]): number {
  const opt = pass1Rate(rows, 'optimized');
  const base = pass1Rate(rows, 'baseline');
  return (opt.rate - base.rate) * 100;
}
