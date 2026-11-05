import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  planOutcomeSchema,
  valueSchema,
  flatPlanOutcomeSchema,
  wireStepSchema,
  toPlanOutcome,
  toStep,
  FlatOutcomeShapeError,
  type FlatPlanOutcome,
  type WireStep,
} from '../src/agent/plan-schema';
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

/** A fully sentinel-filled wire step (no `forEach`/`when`/`expects`
 * clause) — the baseline every test below starts from and overrides. */
function wireStep(overrides: Partial<WireStep> = {}): WireStep {
  return {
    id: 's1',
    action: 'a.b',
    params: '{}',
    dependsOn: [],
    forEach: '',
    when: { ref: '', op: 'eq', value: null },
    expects: { nonEmpty: null, maxCount: null, minCount: null },
    ...overrides,
  };
}

describe('plan-schema — FlatPlanOutcome (docs/SPIKES.md §1c)', () => {
  const emptyWirePlan = { goal: '', steps: [] };
  const base: FlatPlanOutcome = {
    kind: 'plan',
    plan: emptyWirePlan,
    queries: [],
    question: null,
    reason: null,
    text: null,
  };

  it('compiled JSON Schema has no union (oneOf/anyOf) ANYWHERE, no $ref cycles, no propertyNames, no empty/typeless schema, ALL properties required', () => {
    // Same exact conversion call as the `planOutcomeSchema` self-reference
    // test above (mirrors @ai-sdk/provider-utils' zod4Schema()) — but this
    // is the schema actually handed to `generateObject` now (by
    // `planner.ts`'s `plan()` and `pipeline.ts`'s repair call site), so
    // THIS is the regression guard for round 1's root-`oneOf`, round 2's
    // nested-`anyOf`-via-nullable-object, AND round 3's `params`/`value`
    // empty-schema + optional-field defects (docs/SPIKES.md §1/§1a/§1b/
    // §1c) that `planOutcomeSchema`'s own `z.discriminatedUnion` still has
    // (intentionally — it's never sent to a provider; see this file's
    // header). Checks the WHOLE tree, every nesting level.
    const jsonSchema = z.toJSONSchema(flatPlanOutcomeSchema, {
      target: 'draft-7',
      io: 'input',
      reused: 'inline',
    });
    const serialized = JSON.stringify(jsonSchema);
    expect((jsonSchema as Record<string, unknown>)['type']).toBe('object');
    expect(serialized).not.toContain('"oneOf"');
    expect(serialized).not.toContain('"anyOf"');
    expect(serialized).not.toContain('propertyNames');
    // No empty/typeless schema `{}` anywhere (round 3's `params`/`value`
    // defect) — every leaf must at least declare a `"type"` key.
    expect(/:\{\}/.test(serialized)).toBe(false);
    expect(hasRefCycle(jsonSchema)).toBe(false);

    // Every object in the tree lists ALL of its own properties in
    // `required` (round 3's other defect — OpenAI strict mode rejects any
    // omitted key) — walk the tree checking `Object.keys(properties)` ⊆
    // `required` wherever both exist.
    function assertAllPropertiesRequired(node: unknown): void {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const n of node) assertAllPropertiesRequired(n);
        return;
      }
      const obj = node as Record<string, unknown>;
      const props = obj['properties'];
      if (props !== undefined && typeof props === 'object' && props !== null) {
        const required = new Set((obj['required'] as string[] | undefined) ?? []);
        for (const key of Object.keys(props)) {
          expect(required.has(key)).toBe(true);
        }
      }
      for (const v of Object.values(obj)) assertAllPropertiesRequired(v);
    }
    assertAllPropertiesRequired(jsonSchema);
  });

  it('toStep round-trips params through the JSON-encoded string', () => {
    const wire = wireStep({ params: '{"a":1,"b":"$s1.id"}' });
    expect(toStep(wire)).toEqual({ id: 's1', action: 'a.b', params: { a: 1, b: '$s1.id' }, dependsOn: [] });
  });

  it('toStep throws FlatOutcomeShapeError on invalid JSON in params', () => {
    expect(() => toStep(wireStep({ params: 'not json' }))).toThrow(FlatOutcomeShapeError);
    expect(() => toStep(wireStep({ params: '[1,2,3]' }))).toThrow(FlatOutcomeShapeError); // not an object
  });

  it('toStep strips forEach/when/expects sentinels back to undefined', () => {
    const wire = wireStep();
    const step = toStep(wire);
    expect(step.forEach).toBeUndefined();
    expect(step.when).toBeUndefined();
    expect(step.expects).toBeUndefined();
  });

  it('toStep materializes a real forEach/when/expects when present', () => {
    const wire = wireStep({
      forEach: '$s2.items',
      when: { ref: '$s1.items', op: 'nonempty', value: null },
      expects: { nonEmpty: true, maxCount: null, minCount: 1 },
    });
    const step = toStep(wire);
    expect(step.forEach).toBe('$s2.items');
    expect(step.when).toEqual({ ref: '$s1.items', op: 'nonempty', value: null });
    expect(step.expects).toEqual({ nonEmpty: true, minCount: 1 });
  });

  it('toPlanOutcome narrows each of the 5 kinds back to the discriminated PlanOutcome union', () => {
    const realWirePlan = { goal: 'g', steps: [wireStep({ id: 's1', action: 'a.b' })] };
    expect(toPlanOutcome({ ...base, kind: 'plan', plan: realWirePlan })).toEqual({
      kind: 'plan',
      plan: { goal: 'g', steps: [{ id: 's1', action: 'a.b', params: {}, dependsOn: [] }] },
    });
    expect(toPlanOutcome({ ...base, kind: 'search', queries: ['q'] })).toEqual({ kind: 'search', queries: ['q'] });
    expect(toPlanOutcome({ ...base, kind: 'clarify', question: 'which?' })).toEqual({
      kind: 'clarify',
      question: 'which?',
    });
    expect(toPlanOutcome({ ...base, kind: 'unsupported', reason: 'no action' })).toEqual({
      kind: 'unsupported',
      reason: 'no action',
    });
    expect(toPlanOutcome({ ...base, kind: 'respond', text: 'hi' })).toEqual({ kind: 'respond', text: 'hi' });
  });

  it('toPlanOutcome throws FlatOutcomeShapeError when the active-kind field is still its sentinel/null', () => {
    // `plan`/`queries` use a SENTINEL (empty plan / empty array), not
    // `null` — see `flatPlanOutcomeSchema`'s header for why — so `base`
    // above (kind:'plan' with the sentinel empty plan) is already the
    // "forgot to fill it in" case.
    expect(() => toPlanOutcome(base)).toThrow(FlatOutcomeShapeError);
    expect(() => toPlanOutcome({ ...base, kind: 'search' })).toThrow(FlatOutcomeShapeError);
    expect(() => toPlanOutcome({ ...base, kind: 'clarify' })).toThrow(FlatOutcomeShapeError);
    expect(() => toPlanOutcome({ ...base, kind: 'unsupported' })).toThrow(FlatOutcomeShapeError);
    expect(() => toPlanOutcome({ ...base, kind: 'respond' })).toThrow(FlatOutcomeShapeError);
  });

  it('flatPlanOutcomeSchema requires every field present (no key may be omitted)', () => {
    // A response missing a key entirely (rather than its default/sentinel
    // value) must fail zod validation too — that's the all-fields-required
    // shape OpenAI's strict mode enforces via the schema's own `required`
    // array (see this file's header comment).
    const result = flatPlanOutcomeSchema.safeParse({ kind: 'respond', text: 'hi' });
    expect(result.success).toBe(false);
  });

  it('flatPlanOutcomeSchema accepts the full sentinel-filled shape for every kind', () => {
    const cases: FlatPlanOutcome[] = [
      { ...base, kind: 'plan', plan: { goal: 'g', steps: [wireStep()] } },
      { ...base, kind: 'search', queries: ['q'] },
      { ...base, kind: 'clarify', question: 'which?' },
      { ...base, kind: 'unsupported', reason: 'no action' },
      { ...base, kind: 'respond', text: 'hi' },
    ];
    for (const c of cases) {
      expect(flatPlanOutcomeSchema.safeParse(c).success).toBe(true);
    }
  });

  it('wireStepSchema rejects a step missing forEach/when/expects (they must be present, not omitted)', () => {
    const bare = { id: 's1', action: 'a.b', params: '{}', dependsOn: [] };
    expect(wireStepSchema.safeParse(bare).success).toBe(false);
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
