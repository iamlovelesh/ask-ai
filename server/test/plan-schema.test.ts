import { describe, it, expect } from 'vitest';
import { planOutcomeSchema, valueSchema } from '../src/agent/plan-schema';
import { CONFORMANCE_PLAN_OUTCOME } from './fixtures/conformance-plan';

describe('plan-schema — PlanOutcome', () => {
  it('parses the LLD §2.2 conformance example (the flagship plan)', () => {
    const result = planOutcomeSchema.safeParse(CONFORMANCE_PLAN_OUTCOME);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('plan');
    }
  });

  it('parses each of the 5 PlanOutcome kinds', () => {
    const cases: unknown[] = [
      { kind: 'plan', plan: { goal: 'g', steps: [] } },
      { kind: 'search', queries: ['find overdue invoices'] },
      { kind: 'clarify', question: 'Which pipeline do you mean?' },
      { kind: 'unsupported', reason: 'No action exists for that.' },
      { kind: 'respond', text: 'Sure thing.' },
    ];
    for (const c of cases) {
      expect(planOutcomeSchema.safeParse(c).success).toBe(true);
    }
  });

  it('rejects an outcome with an unknown `kind`', () => {
    const result = planOutcomeSchema.safeParse({ kind: 'bogus', plan: { goal: 'g', steps: [] } });
    expect(result.success).toBe(false);
  });

  it('rejects a step with extra/unknown fields (strictObject)', () => {
    const result = planOutcomeSchema.safeParse({
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [{ id: 's1', action: 'a.b', params: {}, dependsOn: [], notAField: true }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a when/expects-bearing step', () => {
    const result = planOutcomeSchema.safeParse({
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          {
            id: 's1',
            action: 'a.b',
            params: {},
            dependsOn: [],
            when: { ref: '$s0.items', op: 'nonempty' },
            expects: { nonEmpty: true, maxCount: 500, minCount: 1 },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid `when.op`', () => {
    const result = planOutcomeSchema.safeParse({
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [{ id: 's1', action: 'a.b', params: {}, dependsOn: [], when: { ref: '$s0', op: 'between' } }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('plan-schema — Value', () => {
  it('accepts JSON literals, ref strings, nested arrays, and nested objects', () => {
    const cases = ['hello', '$s1.items[*].id', 42, true, null, [1, '$item.id', { nested: true }], { a: { b: 1 } }];
    for (const c of cases) {
      expect(valueSchema.safeParse(c).success).toBe(true);
    }
  });

  it('rejects a value that is neither a literal nor a plain object/array', () => {
    expect(valueSchema.safeParse(undefined).success).toBe(false);
    expect(valueSchema.safeParse(() => {}).success).toBe(false);
  });
});
