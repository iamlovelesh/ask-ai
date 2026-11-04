/**
 * Task 16 — report math (`eval/report-math.ts`) on synthetic rows:
 * nearest-rank p50/p95, pass^3 = all-3-trials, cost-per-successful-task
 * (including the cost of retries inside a passing trial), and the
 * baseline delta.
 */

import { describe, expect, it } from 'vitest';
import {
  baselineDeltaPoints,
  costStats,
  latencyBucket,
  pass1Rate,
  pass3Rate,
  percentile,
  repairRateComplex,
} from '../report-math';
import type { ResultRow, TurnResultRow } from '../runner-tuples';

function turn(partial: Partial<TurnResultRow> = {}): TurnResultRow {
  return {
    index: 0,
    pass: true,
    failures: [],
    status: 'done',
    complex: false,
    ttfurMs: 1000,
    totalMs: 2000,
    llmCalls: 1,
    repairs: 0,
    replans: 0,
    searchRounds: 0,
    tokensIn: 100,
    tokensOut: 100,
    costUsd: 0.001,
    ...partial,
  };
}

function row(partial: Partial<ResultRow> & Pick<ResultRow, 'scenarioId' | 'agent' | 'trial'>): ResultRow {
  return { category: 'direct', pass: true, turns: [turn()], ts: 0, ...partial };
}

// --- percentile (nearest-rank) ------------------------------------------------

describe('percentile', () => {
  it('matches server/src/api/metrics.ts\'s nearest-rank formula', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });
});

// --- pass^1 / pass^3 ----------------------------------------------------------

describe('pass1Rate', () => {
  it('computes the fraction of trial-1 rows that passed, for one agent', () => {
    const rows: ResultRow[] = [
      row({ scenarioId: 'a', agent: 'optimized', trial: 1, pass: true }),
      row({ scenarioId: 'b', agent: 'optimized', trial: 1, pass: false }),
      row({ scenarioId: 'a', agent: 'baseline', trial: 1, pass: true }),
    ];
    expect(pass1Rate(rows, 'optimized')).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(pass1Rate(rows, 'baseline')).toEqual({ passed: 1, total: 1, rate: 1 });
  });
});

describe('pass3Rate', () => {
  it('is undefined when no scenario has 3 recorded trials', () => {
    const rows: ResultRow[] = [row({ scenarioId: 'a', agent: 'optimized', trial: 1 })];
    expect(pass3Rate(rows, 'optimized')).toBeUndefined();
  });

  it('requires ALL of trials 1-3 to pass', () => {
    const rows: ResultRow[] = [
      row({ scenarioId: 'a', agent: 'optimized', trial: 1, pass: true }),
      row({ scenarioId: 'a', agent: 'optimized', trial: 2, pass: true }),
      row({ scenarioId: 'a', agent: 'optimized', trial: 3, pass: true }),
      row({ scenarioId: 'b', agent: 'optimized', trial: 1, pass: true }),
      row({ scenarioId: 'b', agent: 'optimized', trial: 2, pass: false }),
      row({ scenarioId: 'b', agent: 'optimized', trial: 3, pass: true }),
    ];
    expect(pass3Rate(rows, 'optimized')).toEqual({ passed: 1, total: 2, rate: 0.5 });
  });
});

// --- latencyBucket (direct vs complex) ---------------------------------------

describe('latencyBucket', () => {
  it('splits by the turn-level complex flag, not scenario category', () => {
    const rows: ResultRow[] = [
      row({ scenarioId: 'a', agent: 'optimized', trial: 1, turns: [turn({ ttfurMs: 1000, totalMs: 2000, complex: false })] }),
      row({ scenarioId: 'b', agent: 'optimized', trial: 1, turns: [turn({ ttfurMs: 3000, totalMs: 9000, complex: true })] }),
    ];
    const direct = latencyBucket(rows, 'optimized', false);
    const complex = latencyBucket(rows, 'optimized', true);
    expect(direct.count).toBe(1);
    expect(direct.p50TtfurMs).toBe(1000);
    expect(complex.count).toBe(1);
    expect(complex.p50E2eMs).toBe(9000);
  });

  it('computes p50/p95 across multiple turns', () => {
    const turns = [100, 200, 300, 400, 500].map((ms) => turn({ ttfurMs: ms, totalMs: ms * 2 }));
    const rows: ResultRow[] = [row({ scenarioId: 'a', agent: 'optimized', trial: 1, turns })];
    const bucket = latencyBucket(rows, 'optimized', false);
    expect(bucket.count).toBe(5);
    expect(bucket.p50TtfurMs).toBe(300);
    expect(bucket.p95TtfurMs).toBe(500);
  });
});

// --- cost / tokens -------------------------------------------------------

describe('costStats', () => {
  it('cost-per-successful-task includes the cost of retries inside a PASSING trial', () => {
    // Trial 'a' passed overall but its turn's cost already reflects a
    // repair/replan retry baked into costUsd (that's how the real pipeline
    // reports it — repairs/replans are extra llmCalls inside the SAME
    // turn's TurnMetrics.costUsd, not separate turns).
    const rows: ResultRow[] = [
      row({ scenarioId: 'a', agent: 'optimized', trial: 1, pass: true, turns: [turn({ costUsd: 0.02, repairs: 1 })] }),
      // Trial 'b' FAILED — its cost must be excluded from the ratio.
      row({ scenarioId: 'b', agent: 'optimized', trial: 1, pass: false, turns: [turn({ costUsd: 5.0 })] }),
    ];
    const stats = costStats(rows, 'optimized');
    expect(stats.costPerSuccessfulTaskUsd).toBeCloseTo(0.02, 6);
    expect(stats.avgCostPerRequestUsd).toBeCloseTo((0.02 + 5.0) / 2, 6); // per-request average DOES include the failure
  });

  it('is undefined when nothing passed', () => {
    const rows: ResultRow[] = [row({ scenarioId: 'a', agent: 'optimized', trial: 1, pass: false })];
    expect(costStats(rows, 'optimized').costPerSuccessfulTaskUsd).toBeUndefined();
  });

  it('averages tokens per request', () => {
    const rows: ResultRow[] = [
      row({ scenarioId: 'a', agent: 'optimized', trial: 1, turns: [turn({ tokensIn: 100, tokensOut: 50 }), turn({ tokensIn: 300, tokensOut: 150 })] }),
    ];
    const stats = costStats(rows, 'optimized');
    expect(stats.requests).toBe(2);
    expect(stats.avgTokensInPerRequest).toBe(200);
    expect(stats.avgTokensOutPerRequest).toBe(100);
  });
});

// --- repair rate ---------------------------------------------------------

describe('repairRateComplex', () => {
  it('counts complex turns with any repair/replan/search activity', () => {
    const rows: ResultRow[] = [
      row({ scenarioId: 'a', agent: 'optimized', trial: 1, turns: [turn({ complex: true, repairs: 1 })] }),
      row({ scenarioId: 'b', agent: 'optimized', trial: 1, turns: [turn({ complex: true, repairs: 0, replans: 0, searchRounds: 0 })] }),
      row({ scenarioId: 'c', agent: 'optimized', trial: 1, turns: [turn({ complex: false, repairs: 1 })] }), // excluded: not complex
    ];
    expect(repairRateComplex(rows, 'optimized')).toEqual({ passed: 1, total: 2, rate: 0.5 });
  });
});

// --- baseline delta ---------------------------------------------------------

describe('baselineDeltaPoints', () => {
  it('is optimized pass^1 minus baseline pass^1, in percentage points', () => {
    const rows: ResultRow[] = [
      row({ scenarioId: 'a', agent: 'optimized', trial: 1, pass: true }),
      row({ scenarioId: 'b', agent: 'optimized', trial: 1, pass: true }),
      row({ scenarioId: 'a', agent: 'baseline', trial: 1, pass: false }),
      row({ scenarioId: 'b', agent: 'baseline', trial: 1, pass: true }),
    ];
    // optimized: 2/2 = 100%; baseline: 1/2 = 50% -> delta = 50pp
    expect(baselineDeltaPoints(rows)).toBeCloseTo(50, 6);
  });
});
