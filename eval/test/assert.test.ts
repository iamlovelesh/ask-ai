/**
 * Task 16 — assertion engine (`eval/assert.ts`) unit tests on fixture
 * event transcripts. Every expectation kind gets at least one pass and one
 * fail case, per the brief's Step 1.
 */

import { describe, expect, it } from 'vitest';
import { assertTurn, isComplexTurn, snapshotStateChecks } from '../assert';
import type { SqlDb } from '../db';
import type { Event } from '../../server/src/events/types';

// --- fixture builders ---------------------------------------------------------

function planReady(action: string, params: Record<string, unknown> = {}, extraSteps: { action: string; params?: Record<string, unknown> }[] = []): Event {
  const steps = [
    { id: 's1', action, params, dependsOn: [] },
    ...extraSteps.map((s, i) => ({ id: `s${i + 2}`, action: s.action, params: s.params ?? {}, dependsOn: [] })),
  ];
  return {
    t: 'plan.ready',
    turnId: 't1',
    outcome: { kind: 'plan', plan: { goal: 'test', steps } },
    planRev: 0,
    planHash: 'h1',
    llm: { model: 'x', tokensIn: 1, tokensOut: 1, tokensCached: 0, costUsd: 0, latencyMs: 1, attempt: 1 },
  };
}

function clarifyReady(question: string): Event {
  return {
    t: 'plan.ready',
    turnId: 't1',
    outcome: { kind: 'clarify', question },
    planRev: 0,
    planHash: 'h1',
    llm: { model: 'x', tokensIn: 1, tokensOut: 1, tokensCached: 0, costUsd: 0, latencyMs: 1, attempt: 1 },
  };
}

function answerFinal(text: string): Event {
  return { t: 'answer.final', turnId: 't1', text };
}

function turnCompleted(status: 'done' | 'clarify' | 'refused' | 'failed' | 'cancelled'): Event {
  return {
    t: 'turn.completed',
    turnId: 't1',
    status,
    metrics: {
      ttfurMs: 100,
      totalMs: 200,
      llmCalls: 1,
      repairs: 0,
      replans: 0,
      searchRounds: 0,
      tokensIn: 10,
      tokensOut: 10,
      costUsd: 0.001,
      stepsOk: 1,
      stepsFailed: 0,
    },
  };
}

function confirmationRequired(): Event {
  return {
    t: 'confirmation.required',
    turnId: 't1',
    confirmId: 'cf1',
    planRev: 0,
    planHash: 'h1',
    stepId: 's1',
    scope: { actions: ['x'], affectedCount: 1, targetSample: [], description: 'x' },
  };
}

function fakeDb(row: Record<string, unknown> | undefined): SqlDb {
  return { get: () => row, close: () => {} };
}

// --- planActions ---------------------------------------------------------

describe('assertTurn — planActions', () => {
  it('passes when mustInclude is present and mustNotInclude is absent', () => {
    const events = [planReady('leads.search_leads')];
    const result = assertTurn(events, { planActions: { mustInclude: ['leads.search_leads'], mustNotInclude: ['leads.create_lead'] } }, fakeDb(undefined));
    expect(result.pass).toBe(true);
  });

  it('fails when a required action is missing', () => {
    const events = [planReady('leads.search_leads')];
    const result = assertTurn(events, { planActions: { mustInclude: ['leads.create_lead'] } }, fakeDb(undefined));
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.kind).toBe('planActions');
  });

  it('fails when a forbidden action is present', () => {
    const events = [planReady('leads.search_leads')];
    const result = assertTurn(events, { planActions: { mustNotInclude: ['leads.search_leads'] } }, fakeDb(undefined));
    expect(result.pass).toBe(false);
  });

  it('orderFree:false passes an in-order subsequence', () => {
    const events = [planReady('leads.search_leads', {}, [{ action: 'core.anti_join' }, { action: 'tasks.create_task' }])];
    const result = assertTurn(
      events,
      { planActions: { mustInclude: ['leads.search_leads', 'tasks.create_task'], orderFree: false } },
      fakeDb(undefined),
    );
    expect(result.pass).toBe(true);
  });

  it('orderFree:false fails an out-of-order sequence', () => {
    const events = [planReady('tasks.create_task', {}, [{ action: 'leads.search_leads' }])];
    const result = assertTurn(
      events,
      { planActions: { mustInclude: ['leads.search_leads', 'tasks.create_task'], orderFree: false } },
      fakeDb(undefined),
    );
    expect(result.pass).toBe(false);
  });
});

// --- paramChecks ---------------------------------------------------------

describe('assertTurn — paramChecks', () => {
  it('passes an equals check against a literal param', () => {
    const events = [planReady('companies.search_companies', { industry: 'software' })];
    const result = assertTurn(
      events,
      { paramChecks: [{ action: 'companies.search_companies', param: 'industry', equals: 'software' }] },
      fakeDb(undefined),
    );
    expect(result.pass).toBe(true);
  });

  it('passes a contains check (case-insensitive substring)', () => {
    const events = [planReady('companies.search_companies', { industry: 'Enterprise Software' })];
    const result = assertTurn(
      events,
      { paramChecks: [{ action: 'companies.search_companies', param: 'industry', contains: 'software' }] },
      fakeDb(undefined),
    );
    expect(result.pass).toBe(true);
  });

  it('fails when the param does not match', () => {
    const events = [planReady('companies.search_companies', { industry: 'healthcare' })];
    const result = assertTurn(
      events,
      { paramChecks: [{ action: 'companies.search_companies', param: 'industry', equals: 'software' }] },
      fakeDb(undefined),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.kind).toBe('paramChecks');
  });

  it('fails when no step for the action exists in the plan', () => {
    const events = [planReady('leads.search_leads')];
    const result = assertTurn(
      events,
      { paramChecks: [{ action: 'companies.search_companies', param: 'industry', equals: 'software' }] },
      fakeDb(undefined),
    );
    expect(result.pass).toBe(false);
  });
});

// --- state (SQL + countDelta) ----------------------------------------------

describe('assertTurn — state', () => {
  it('equals passes when the live value matches', () => {
    const result = assertTurn([], { state: [{ query: 'SELECT 1 AS n', equals: 5 }] }, fakeDb({ n: 5 }));
    expect(result.pass).toBe(true);
  });

  it('gte/lte bound checks', () => {
    const passResult = assertTurn([], { state: [{ query: 'q', gte: 3, lte: 10 }] }, fakeDb({ n: 7 }));
    expect(passResult.pass).toBe(true);
    const failResult = assertTurn([], { state: [{ query: 'q', gte: 3, lte: 10 }] }, fakeDb({ n: 11 }));
    expect(failResult.pass).toBe(false);
  });

  it('snapshotStateChecks captures the pre-turn value only for countDelta checks', () => {
    const before = snapshotStateChecks(fakeDb({ n: 9 }), [
      { query: 'SELECT COUNT(*) AS n FROM leads', countDelta: 1 },
      { query: 'SELECT COUNT(*) AS n FROM leads', equals: 9 },
    ]);
    expect(before).toEqual([9, undefined]);
  });

  it('countDelta passes when after - before matches exactly', () => {
    const result = assertTurn([], { state: [{ query: 'SELECT COUNT(*) AS n FROM leads', countDelta: 1 }] }, fakeDb({ n: 10 }), [9]);
    expect(result.pass).toBe(true);
  });

  it('countDelta fails on a mismatched delta', () => {
    const failResult = assertTurn([], { state: [{ query: 'q', countDelta: 2 }] }, fakeDb({ n: 10 }), [9]);
    expect(failResult.pass).toBe(false);
    expect(failResult.failures[0]?.kind).toBe('state');
  });
});

// --- response ---------------------------------------------------------------

describe('assertTurn — response', () => {
  it('mustMention passes when the phrase is present (case-insensitive)', () => {
    const events = [answerFinal('leads.search_leads: 12 record(s)')];
    const result = assertTurn(events, { response: { mustMention: ['LEADS.SEARCH_LEADS'] } }, fakeDb(undefined));
    expect(result.pass).toBe(true);
  });

  it('mustNotClaim fails when the forbidden phrase is present', () => {
    const events = [answerFinal('Done — successfully filed the return.')];
    const result = assertTurn(events, { response: { mustNotClaim: ['successfully'] } }, fakeDb(undefined));
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.kind).toBe('response');
  });
});

// --- behavior ---------------------------------------------------------------

describe('assertTurn — behavior', () => {
  it('confirmation:true passes when confirmation.required fired', () => {
    const events = [confirmationRequired()];
    const result = assertTurn(events, { behavior: { confirmation: true } }, fakeDb(undefined));
    expect(result.pass).toBe(true);
  });

  it('confirmation:false fails when a confirmation unexpectedly fired', () => {
    const events = [confirmationRequired()];
    const result = assertTurn(events, { behavior: { confirmation: false } }, fakeDb(undefined));
    expect(result.pass).toBe(false);
  });

  it('clarify:true passes when turn.completed.status is clarify', () => {
    const events = [turnCompleted('clarify')];
    const result = assertTurn(events, { behavior: { clarify: true } }, fakeDb(undefined));
    expect(result.pass).toBe(true);
  });

  it('mustNotAsk fails when the clarify question re-asks a known field', () => {
    const events = [clarifyReady('What industry are you targeting?')];
    const result = assertTurn(events, { behavior: { mustNotAsk: ['industry'] } }, fakeDb(undefined));
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.detail).toContain('industry');
  });

  it('mustNotAsk passes when the clarify question avoids known fields', () => {
    const events = [clarifyReady('Which channel should we use — email or SMS?')];
    const result = assertTurn(events, { behavior: { mustNotAsk: ['industry'] } }, fakeDb(undefined));
    expect(result.pass).toBe(true);
  });
});

// --- isComplexTurn ------------------------------------------------------------

describe('isComplexTurn', () => {
  it('a single-step plan is NOT complex', () => {
    expect(isComplexTurn([planReady('leads.search_leads')])).toBe(false);
  });

  it('a multi-step plan IS complex', () => {
    expect(isComplexTurn([planReady('leads.search_leads', {}, [{ action: 'tasks.create_task' }])])).toBe(true);
  });

  it('a non-plan outcome is NOT complex', () => {
    expect(isComplexTurn([clarifyReady('Which channel?')])).toBe(false);
  });
});
