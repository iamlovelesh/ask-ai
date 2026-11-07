import { describe, expect, it } from 'vitest';
import { formatSessionLedger, sumSessionMetrics } from '../ledger.js';
import type { TurnView } from '../fold.js';

function turn(partial: Partial<TurnView> & Pick<TurnView, 'turnId' | 'userText'>): TurnView {
  return {
    stepOrder: [],
    steps: {},
    activity: [],
    deltaText: '',
    memoryOps: [],
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
  it('humanizes the session cost — "This session: $0.004"', () => {
    const str = formatSessionLedger({ totalMs: 1500, tokensIn: 900, tokensOut: 600, costUsd: 0.0169, llmCalls: 3 });
    expect(str).toBe('This session: $0.0169');
  });

  it('returns an empty string when the session has spent nothing genuine yet', () => {
    const str = formatSessionLedger({ totalMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, llmCalls: 0 });
    expect(str).toBe('');
  });

  it('hides the ledger for a zero-cost session even if time/tokens were spent', () => {
    const str = formatSessionLedger({ totalMs: 200, tokensIn: 10, tokensOut: 5, costUsd: 0, llmCalls: 1 });
    expect(str).toBe('');
  });
});
