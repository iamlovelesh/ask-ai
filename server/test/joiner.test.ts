import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkStratum, joinerRepair, type CompletedStep } from '../src/agent/joiner';
import { __setTestFetch, __setTestSpans, __setTestBackoffOptions, costMeter } from '../src/llm/client';
import { openSpans, type Spans } from '../src/events/trace';
import type { Plan, Step } from '../src/agent/plan-schema';

function step(overrides: Partial<Step> & { id: string; action: string }): Step {
  return { params: {}, dependsOn: [], ...overrides };
}

function plan(steps: Step[]): Plan {
  return { goal: 'test goal', steps };
}

describe('checkStratum — expects.nonEmpty', () => {
  it('detects a nonEmpty violation when a read with expects came back empty', () => {
    const p = plan([step({ id: 's1', action: 'leads.search_leads', expects: { nonEmpty: true } })]);
    const completed: Record<string, CompletedStep> = { s1: { result: { items: [], total: 0 } } };

    const verdict = checkStratum(p, completed, []);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violation.stepId).toBe('s1');
      expect(verdict.violation.expect).toBe('nonEmpty');
      expect(verdict.violation.actual).toBe('0 rows');
      expect(verdict.violation.summary).toContain('leads.search_leads');
    }
  });

  it('ok-case: a satisfied nonEmpty expectation costs zero LLM calls', () => {
    const p = plan([step({ id: 's1', action: 'leads.search_leads', expects: { nonEmpty: true } })]);
    const completed: Record<string, CompletedStep> = { s1: { result: { items: [{ id: 'l1' }], total: 5 } } };

    const verdict = checkStratum(p, completed, []);

    expect(verdict).toEqual({ ok: true });
    // No network/LLM seam was ever touched — checkStratum is plain sync code.
  });
});

describe('checkStratum — count bounds (minCount/maxCount)', () => {
  it('detects a minCount violation', () => {
    const p = plan([step({ id: 's1', action: 'users.list_users', expects: { minCount: 3 } })]);
    const completed: Record<string, CompletedStep> = { s1: { result: { items: [{ id: 'u1' }], total: 1 } } };

    const verdict = checkStratum(p, completed, []);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violation.expect).toBe('minCount:3');
      expect(verdict.violation.actual).toBe('1 rows');
    }
  });

  it('detects a maxCount violation', () => {
    const p = plan([step({ id: 's1', action: 'leads.search_leads', expects: { maxCount: 10 } })]);
    const completed: Record<string, CompletedStep> = { s1: { result: { items: [], total: 42 } } };

    const verdict = checkStratum(p, completed, []);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violation.expect).toBe('maxCount:10');
      expect(verdict.violation.actual).toBe('42 rows');
    }
  });

  it('passes when the count is within [minCount, maxCount]', () => {
    const p = plan([step({ id: 's1', action: 'leads.search_leads', expects: { minCount: 1, maxCount: 10 } })]);
    const completed: Record<string, CompletedStep> = { s1: { result: { items: [], total: 5 } } };

    expect(checkStratum(p, completed, [])).toEqual({ ok: true });
  });
});

describe('checkStratum — filter/anti_join zero-from-nonzero', () => {
  it('detects core.anti_join producing 0 from a non-empty input', () => {
    const p = plan([
      step({ id: 's1', action: 'leads.search_leads' }),
      step({
        id: 's2',
        action: 'core.anti_join',
        params: { in: '$s1.items', key: 'contact_id', exclude: '$s3.items', excludeKey: 'contact_id' },
        dependsOn: ['s1'],
      }),
    ]);
    const completed: Record<string, CompletedStep> = {
      s1: { result: { items: [{ id: 'l1' }, { id: 'l2' }], total: 2 } },
      s2: { result: { items: [], total: 0 } },
    };

    const verdict = checkStratum(p, completed, []);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violation.stepId).toBe('s2');
      expect(verdict.violation.expect).toBe('nonZeroOutputFromNonZeroInput');
    }
  });

  it('does NOT flag a filter that legitimately zeroed an already-empty input', () => {
    const p = plan([
      step({ id: 's1', action: 'leads.search_leads' }),
      step({
        id: 's2',
        action: 'core.filter',
        params: { in: '$s1.items', field: 'status', op: 'eq', value: 'x' },
        dependsOn: ['s1'],
      }),
    ]);
    const completed: Record<string, CompletedStep> = {
      s1: { result: { items: [], total: 0 } },
      s2: { result: { items: [], total: 0 } },
    };

    expect(checkStratum(p, completed, [])).toEqual({ ok: true });
  });

  it('does NOT flag a filter that produced a non-empty result', () => {
    const p = plan([
      step({ id: 's1', action: 'leads.search_leads' }),
      step({
        id: 's2',
        action: 'core.filter',
        params: { in: '$s1.items', field: 'status', op: 'eq', value: 'x' },
        dependsOn: ['s1'],
      }),
    ]);
    const completed: Record<string, CompletedStep> = {
      s1: { result: { items: [{ id: 'l1' }], total: 3 } },
      s2: { result: { items: [{ id: 'l1' }], total: 3 } },
    };

    expect(checkStratum(p, completed, [])).toEqual({ ok: true });
  });
});

describe('checkStratum — forEach source emptiness (upcoming stratum)', () => {
  it('flags an upcoming forEach whose (completed) source resolved to 0 items', () => {
    const p = plan([
      step({ id: 's1', action: 'core.anti_join', params: { in: '$s0.items', key: 'id', exclude: '$s0.items', excludeKey: 'id' } }),
      step({ id: 's2', action: 'leads.assign_lead_owner', forEach: '$s1.items', dependsOn: ['s1'] }),
    ]);
    const completed: Record<string, CompletedStep> = { s1: { result: { items: [], total: 0 } } };
    const upcoming = p.steps.filter((s) => s.id === 's2');

    const verdict = checkStratum(p, completed, upcoming);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violation.stepId).toBe('s2');
      expect(verdict.violation.expect).toBe('forEachSourceNonEmpty');
    }
  });

  it('does not flag a forEach whose source is non-empty', () => {
    const p = plan([
      step({ id: 's1', action: 'leads.search_leads' }),
      step({ id: 's2', action: 'leads.assign_lead_owner', forEach: '$s1.items', dependsOn: ['s1'] }),
    ]);
    const completed: Record<string, CompletedStep> = { s1: { result: { items: [{ id: 'l1' }], total: 1 } } };
    const upcoming = p.steps.filter((s) => s.id === 's2');

    expect(checkStratum(p, completed, upcoming)).toEqual({ ok: true });
  });
});

describe('joinerRepair — one llmCall, returns a decision', () => {
  let spansPath: string;
  let spans: Spans;

  beforeEach(() => {
    costMeter.__resetForTest();
    delete process.env['EVAL_BUDGET_USD'];
    spansPath = join(tmpdir(), `ask-ai-joiner-spans-${randomUUID()}.db`);
    spans = openSpans(spansPath);
    __setTestSpans(spans);
    __setTestBackoffOptions({ baseMs: 1 });
  });

  afterEach(() => {
    __setTestFetch(undefined);
    __setTestSpans(undefined);
    __setTestBackoffOptions(undefined);
    spans.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = spansPath + suffix;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it('returns a "proceed" decision parsed from the mocked LLM response', async () => {
    // Wire shape (docs/SPIKES.md §1c) — joinerRepair now requests
    // `wireJoinerDecisionSchema`: ALL 3 fields always present.
    const decision = { decision: 'proceed', patchedSteps: [], question: null };
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          id: `gen_${randomUUID()}`,
          model: 'anthropic/claude-haiku-4.5',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(decision) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44, cost: 0.0001 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    __setTestFetch(fakeFetch);

    const p = plan([step({ id: 's1', action: 'leads.search_leads', expects: { nonEmpty: true } })]);
    const result = await joinerRepair({
      plan: p,
      violation: { stepId: 's1', expect: 'nonEmpty', actual: '0 rows', summary: 'empty' },
      summaries: ['leads.search_leads: 0 leads'],
      model: 'anthropic/claude-haiku-4.5',
      turnId: `turn_${randomUUID()}`,
    });

    expect(result.decision).toBe('proceed');
    expect(result.patchedSteps).toBeUndefined();
    expect(typeof result.spanId).toBe('string');
    expect(result.usage.tokensIn).toBe(40);
  });

  it('returns a "patch" decision with the patched steps', async () => {
    // Wire shape (docs/SPIKES.md §1c): patchedSteps are wire `Step`s —
    // `params` is a JSON-encoded string, `forEach`/`when`/`expects` always
    // present with their sentinel/null wire defaults.
    const patched = {
      decision: 'patch',
      patchedSteps: [
        {
          id: 's1',
          action: 'leads.search_leads',
          params: JSON.stringify({ created_after: '2026-10-01' }),
          dependsOn: [],
          forEach: '',
          when: { ref: '', op: 'eq', value: null },
          expects: { nonEmpty: null, maxCount: null, minCount: null },
        },
      ],
      question: null,
    };
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          id: `gen_${randomUUID()}`,
          model: 'anthropic/claude-haiku-4.5',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(patched) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50, cost: 0.0001 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    __setTestFetch(fakeFetch);

    const p = plan([step({ id: 's1', action: 'leads.search_leads', expects: { nonEmpty: true } })]);
    const result = await joinerRepair({
      plan: p,
      violation: { stepId: 's1', expect: 'nonEmpty', actual: '0 rows', summary: 'empty' },
      summaries: [],
      model: 'anthropic/claude-haiku-4.5',
      turnId: `turn_${randomUUID()}`,
    });

    expect(result.decision).toBe('patch');
    expect(result.patchedSteps).toHaveLength(1);
    expect(result.patchedSteps?.[0]?.id).toBe('s1');
    // The wire `params` STRING must round-trip back to the real object —
    // `toStep`'s JSON.parse, not a leftover string (code-review follow-up,
    // docs/SPIKES.md §1c).
    expect(result.patchedSteps?.[0]?.params).toEqual({ created_after: '2026-10-01' });
  });
});
