import { describe, expect, it } from 'vitest';
import { formatSessionLedger, sumSessionMetrics } from '../ledger.js';
import type { TurnView } from '../fold.js';

function turn(partial: Partial<TurnView> & Pick<TurnView, 'turnId' | 'userText'>): TurnView {
  return {
    stepOrder: [],
    steps: {},
    activity: [],
    deltaText: '',
    ...partial,
  };
}

const METRICS_BASE = {
  ttfurMs: 0,
  repairs: 0,
  replans: 0,
  searchRounds: 0,
  stepsOk: 1,
  stepsFailed: 0,
};

describe('sumSessionMetrics', () => {
  it('sums metrics across every completed turn', () => {
    const turns = [
      turn({
        turnId: 't1',
        userText: 'a',
        metrics: { ...METRICS_BASE, totalMs: 100, tokensIn: 10, tokensOut: 5, costUsd: 0.001, llmCalls: 1 },
      }),
      turn({
        turnId: 't2',
        userText: 'b',
        metrics: { ...METRICS_BASE, totalMs: 250, tokensIn: 20, tokensOut: 15, costUsd: 0.002, llmCalls: 2 },
      }),
    ];
    expect(sumSessionMetrics(turns)).toEqual({
      totalMs: 350,
      tokensIn: 30,
      tokensOut: 20,
      costUsd: 0.003,
      llmCalls: 3,
    });
  });

  it('skips turns with no metrics (still running or errored before completion)', () => {
    const turns = [
      turn({ turnId: 't1', userText: 'running now' }), // no metrics yet
      turn({
        turnId: 't2',
        userText: 'done',
        metrics: { ...METRICS_BASE, totalMs: 50, tokensIn: 1, tokensOut: 1, costUsd: 0, llmCalls: 1 },
      }),
    ];
    expect(sumSessionMetrics(turns)).toEqual({ totalMs: 50, tokensIn: 1, tokensOut: 1, costUsd: 0, llmCalls: 1 });
  });

  it('returns all-zero totals for an empty turn list', () => {
    expect(sumSessionMetrics([])).toEqual({ totalMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, llmCalls: 0 });
  });
});

describe('formatSessionLedger', () => {
  it('formats every non-zero field, two-space joined, mono-strip style', () => {
    const str = formatSessionLedger({ totalMs: 1500, tokensIn: 900, tokensOut: 600, costUsd: 0.0169, llmCalls: 3 });
    expect(str).toBe('1.5s  1.5k tok  $0.0169  3 llm calls');
  });

  it('omits every zero field rather than padding with 0ms/$0.0000', () => {
    const str = formatSessionLedger({ totalMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, llmCalls: 0 });
    expect(str).toBe('');
  });

  it('omits llmCalls when there is exactly one call (same rule as CostBadge)', () => {
    const str = formatSessionLedger({ totalMs: 200, tokensIn: 10, tokensOut: 5, costUsd: 0.001, llmCalls: 1 });
    expect(str).not.toContain('llm calls');
  });
});
