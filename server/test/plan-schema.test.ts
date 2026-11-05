import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { planOutcomeSchema, valueSchema } from '../src/agent/plan-schema';
import { CONFORMANCE_PLAN_OUTCOME } from './fixtures/conformance-plan';

/** Walks a compiled JSON Schema for `$ref` cycles — a `$ref` is only a
 * problem here if following it (through `definitions`/`$defs`) revisits a
 * definition already on the current path, i.e. an actual self/mutual
 * reference loop. A `$ref` to an already-fully-resolved, non-cyclic
 * definition is fine; this only flags true cycles. */
function hasRefCycle(root: unknown): boolean {
  const defs: Record<string, unknown> =
    ((root as Record<string, unknown>)?.definitions as Record<string, unknown>) ??
    ((root as Record<string, unknown>)?.['$defs'] as Record<string, unknown>) ??
    {};

  function resolve(ref: string): unknown {
    const key = ref.replace(/^#\/(definitions|\$defs)\//, '');
    return defs[key];
  }

  function walk(node: unknown, pathDefs: Set<string>): boolean {
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some((n) => walk(n, pathDefs));
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') {
      const key = obj.$ref.replace(/^#\/(definitions|\$defs)\//, '');
      if (pathDefs.has(key)) return true; // genuine cycle
      const target = resolve(obj.$ref);
      if (target === undefined) return false;
      return walk(target, new Set(pathDefs).add(key));
    }
    return Object.values(obj).some((v) => walk(v, pathDefs));
  }

  return walk(root, new Set());
}

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

  it('schema converts to JSON Schema without self-references (docs/SPIKES.md §1)', () => {
    // Mirror @ai-sdk/provider-utils' zod4Schema() conversion exactly
    // (default useReferences=false): target draft-7, io:'input',
    // reused:'inline'. This is the actual call path `generateObject` takes
    // for a raw Zod schema — reproducing it here (rather than a looser
    // z.toJSONSchema() call) is what makes this test a faithful regression
    // guard for the cross-provider 400s documented in SPIKES.md §1.
    const jsonSchema = z.toJSONSchema(planOutcomeSchema, {
      target: 'draft-7',
      io: 'input',
      reused: 'inline',
    });
    expect(hasRefCycle(jsonSchema)).toBe(false);
    // The OpenAI-specific defect (`propertyNames` is not permitted in
    // strict mode) must also be gone — `z.record()` emits `propertyNames`
    // even for a plain `z.string()` key schema, so `params` must NOT use
    // `z.record` at all (see `plan-schema.ts`'s `stepSchema.params`).
    expect(JSON.stringify(jsonSchema)).not.toContain('propertyNames');
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
