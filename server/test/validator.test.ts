import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  validate,
  parseRefGrammar,
  computePlanHash,
  repairPrompt,
  BUDGETS,
  type HandleRef,
} from '../src/agent/validator';
import { buildRegistry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef, ActionContext } from '../src/catalog/types';
import type { PlanOutcome, Plan } from '../src/agent/plan-schema';
import { CONFORMANCE_PLAN_OUTCOME } from './fixtures/conformance-plan';
import { listOutputSchema } from '../src/catalog/list-output';

// --- a fake registry whose field TYPES match the LLD §2.2 flagship
// example's literal params exactly (the real catalog's `leads.search_leads`
// uses virtual-clock epoch numbers for created_after/created_before, not
// the human-readable "2026-10-26" strings the LLD's illustrative JSON
// uses — a real-catalog-vs-illustrative-example mismatch that is NOT a
// validator bug. `buildRegistry` exists exactly so tests can supply
// purpose-built stubs instead of depending on catalog internals). -----------

function stubAction(slug: string, inputSchema: z.ZodType<unknown>): ActionDef {
  return {
    id: slug,
    slug,
    module: slug.split('.')[0] as string,
    name: slug,
    description: slug,
    risk: 'read',
    entities: [],
    inputSchema,
    outputSchema: z.unknown(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: async () => ({}),
  };
}

const conformanceRegistry = buildRegistry(
  [
    [
      stubAction(
        'leads.search_leads',
        z.strictObject({ created_after: z.string().optional(), created_before: z.string().optional() }),
      ),
      stubAction(
        'leads.assign_lead_owner',
        z.strictObject({ lead_id: z.string(), owner_id: z.string() }),
      ),
      stubAction(
        'conversations.search_conversations',
        z.strictObject({ contact_ids: z.array(z.string()).optional(), has_inbound_reply: z.boolean().optional() }),
      ),
      stubAction(
        'appointments.search_appointments',
        z.strictObject({ contact_ids: z.array(z.string()).optional(), status: z.string().optional() }),
      ),
      stubAction('users.list_users', z.strictObject({ role: z.string().optional(), active: z.boolean().optional() })),
      stubAction(
        'tasks.create_task',
        z.strictObject({
          title: z.string(),
          contact_id: z.string(),
          owner_id: z.string(),
          due_date: z.string(),
        }),
      ),
    ],
  ],
  coreOps,
);

function noHandles(): HandleRef[] {
  return [];
}

describe('validator — conformance example (LLD §2.2 flagship)', () => {
  it('validates OK and produces a plan + planHash + stepOrder', () => {
    const result = validate(CONFORMANCE_PLAN_OUTCOME as PlanOutcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan).toBeDefined();
      expect(result.planHash).toBeDefined();
      expect(result.stepOrder).toBeDefined();
      expect(result.stepOrder).toEqual(['s1', 's6', 's2', 's3', 's4', 's5', 's7', 's8', 's9']);
    }
  });

  it('hash is stable across key order', () => {
    const resultA = validate(CONFORMANCE_PLAN_OUTCOME as PlanOutcome, new Set(), noHandles(), conformanceRegistry);
    expect(resultA.ok).toBe(true);

    // Same plan, every object's keys reordered (steps array order preserved
    // — only object key order within each step/param/when/expects changes).
    const reordered: PlanOutcome = {
      kind: 'plan',
      plan: {
        steps: CONFORMANCE_PLAN_OUTCOME.plan.steps.map((s) => {
          const entries = Object.entries(s).reverse();
          return Object.fromEntries(entries) as unknown as Plan['steps'][number];
        }),
        goal: CONFORMANCE_PLAN_OUTCOME.plan.goal,
      },
    };
    const resultB = validate(reordered, new Set(), noHandles(), conformanceRegistry);
    expect(resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) {
      expect(resultA.planHash).toBe(resultB.planHash);
    }
  });

  it('planHash is independent of JSON.stringify key order directly', () => {
    const planA: Plan = { goal: 'g', steps: [{ id: 's1', action: 'a.b', params: { x: 1, y: 2 }, dependsOn: [] }] };
    const planB: Plan = { goal: 'g', steps: [{ id: 's1', action: 'a.b', params: { y: 2, x: 1 }, dependsOn: [] }] };
    expect(computePlanHash(planA)).toBe(computePlanHash(planB));
  });
});

describe('validator — unknown slug (Review Focus 3: repairable, never throws)', () => {
  it('returns {ok:false} with an UNKNOWN_SLUG error, does not throw', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: { goal: 'g', steps: [{ id: 's1', action: 'bogus.does_not_exist', params: {}, dependsOn: [] }] },
    };
    expect(() => validate(outcome, new Set(), noHandles(), conformanceRegistry)).not.toThrow();
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'UNKNOWN_SLUG')).toBe(true);
    }
  });

  it('repairPrompt produces a targeted message mentioning the bad slug', () => {
    const plan: Plan = { goal: 'g', steps: [{ id: 's1', action: 'bogus.does_not_exist', params: {}, dependsOn: [] }] };
    const prompt = repairPrompt(plan, [
      { code: 'UNKNOWN_SLUG', stepId: 's1', message: "Step 's1' references unknown action slug 'bogus.does_not_exist'." },
    ]);
    expect(prompt).toContain('bogus.does_not_exist');
    expect(prompt).toContain('UNKNOWN_SLUG');
  });

  it('repairPrompt echoes the previous plan in WIRE shape (string-encoded params), not the narrowed shape (code-review fix, docs/SPIKES.md §1c)', () => {
    const plan: Plan = {
      goal: 'g',
      steps: [{ id: 's1', action: 'leads.search_leads', params: { status: 'open' }, dependsOn: [] }],
    };
    const prompt = repairPrompt(plan, [{ code: 'UNKNOWN_SLUG', stepId: 's1', message: 'irrelevant for this test' }]);
    // `params` must appear as a JSON-encoded STRING (escaped quotes around
    // an object: `"params":"{\"status\":\"open\"}"`), never as a bare JSON
    // object — this is the exact shape `flatPlanOutcomeSchema`'s wire
    // schema demands back from the model.
    expect(prompt).toContain('"params":"{\\"status\\":\\"open\\"}"');
    expect(prompt).not.toContain('"params":{"status":"open"}');
  });

  it('forbids downgrading to clarify when the plan can simply be fixed (Fix 3c)', () => {
    const plan: Plan = {
      goal: 'g',
      steps: [{ id: 's1', action: 'leads.search_leads', params: { status: 'open' }, dependsOn: [] }],
    };
    const prompt = repairPrompt(plan, [{ code: 'UNKNOWN_SLUG', stepId: 's1', message: 'irrelevant' }]);
    expect(prompt).toContain('Do NOT downgrade to `clarify`');
    expect(prompt.toLowerCase()).toContain('genuinely missing');
  });
});

describe('validator — $item outside forEach', () => {
  it('errors when $item is used in a step with no forEach', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'tasks.create_task', params: { title: '$item.name' }, dependsOn: [] },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'ITEM_OUTSIDE_FOREACH')).toBe(true);
    }
  });

  it('does NOT error when $item is used inside a forEach step', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's0', action: 'users.list_users', params: {}, dependsOn: [] },
          {
            id: 's1',
            action: 'tasks.create_task',
            params: { contact_id: '$item.id' },
            dependsOn: ['s0'],
            forEach: '$s0.items',
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(true);
  });
});

describe('validator — cycle detection', () => {
  it('errors with CYCLE when two steps depend on each other', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: ['s2'] },
          { id: 's2', action: 'users.list_users', params: {}, dependsOn: ['s1'] },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'CYCLE')).toBe(true);
    }
  });

  it('does not false-positive on a valid diamond dependency graph', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: [] },
          { id: 's2', action: 'users.list_users', params: {}, dependsOn: ['s1'] },
          { id: 's3', action: 'users.list_users', params: {}, dependsOn: ['s1'] },
          { id: 's4', action: 'users.list_users', params: {}, dependsOn: ['s2', 's3'] },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(true);
  });

  it('errors with CYCLE on a self-reference (a step depending on itself)', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: { goal: 'g', steps: [{ id: 's1', action: 'users.list_users', params: {}, dependsOn: ['s1'] }] },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'CYCLE')).toBe(true);
    }
  });
});

describe('validator — dangling step ref (Review Focus: CRITICAL)', () => {
  it('a $sN ref to a step id that does not exist anywhere in the plan is UNKNOWN_STEP_REF', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          {
            id: 's1',
            action: 'leads.search_leads',
            params: { created_after: '$s99.value' },
            dependsOn: [],
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'UNKNOWN_STEP_REF')).toBe(true);
      // must NOT also silently pass through as ok:true — this was the bug.
      expect(result.errors.some((e) => e.code === 'REF_GRAMMAR')).toBe(false);
    }
  });

  it('a forEach target pointing at a nonexistent step id is also UNKNOWN_STEP_REF', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [{ id: 's1', action: 'tasks.create_task', params: {}, dependsOn: [], forEach: '$s99.items' }],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'UNKNOWN_STEP_REF')).toBe(true);
    }
  });
});

describe('validator — duplicate step ids (Review Focus: Important)', () => {
  it('two steps sharing the same id is DUPLICATE_STEP_ID, not a silent collapse', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: [] },
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: [] },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'DUPLICATE_STEP_ID')).toBe(true);
    }
  });
});

describe('validator — ref must be within the referencing step\'s dependsOn closure (Review Focus: Important)', () => {
  it('a ref to a step that exists but is not in dependsOn (directly or transitively) is MISSING_DEPENDENCY', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: [] },
          {
            id: 's2',
            action: 'leads.search_leads',
            params: { created_after: '$s1.now' },
            dependsOn: [], // BUG: refs $s1 but never declares the dependency
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'MISSING_DEPENDENCY')).toBe(true);
    }
  });

  it('a ref satisfied via a TRANSITIVE dependency (s3 deps s2 deps s1, s3 refs $s1) is VALID', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: [] },
          { id: 's2', action: 'users.list_users', params: {}, dependsOn: ['s1'] },
          {
            id: 's3',
            action: 'leads.search_leads',
            params: { created_after: '$s1.now' },
            dependsOn: ['s2'],
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(true);
  });

  it('the same rule applies to a forEach target, not just params', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: [] },
          { id: 's2', action: 'tasks.create_task', params: {}, dependsOn: [], forEach: '$s1.items' },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'MISSING_DEPENDENCY')).toBe(true);
    }
  });
});

describe('validator — when.value is an opaque literal (Review Focus: Important)', () => {
  it('a dollar-amount literal in when.value ("$100") is NOT treated as a malformed ref', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: [] },
          {
            id: 's2',
            action: 'users.list_users',
            params: {},
            dependsOn: ['s1'],
            when: { ref: '$s1.total', op: 'gt', value: '$100' },
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(true);
  });

  it('when.ref itself is still grammar-checked', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'users.list_users', params: {}, dependsOn: [] },
          {
            id: 's2',
            action: 'users.list_users',
            params: {},
            dependsOn: ['s1'],
            when: { ref: '$turn1.s1', op: 'nonempty' },
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_GRAMMAR')).toBe(true);
    }
  });
});

describe('validator — other outcome kinds pass through without plan-shaped checks', () => {
  it.each(['search', 'clarify', 'unsupported', 'respond'] as const)('%s outcome is ok with no plan/planHash', (kind) => {
    const outcome: PlanOutcome =
      kind === 'search'
        ? { kind, queries: ['q'] }
        : kind === 'clarify'
          ? { kind, question: 'Which one?' }
          : kind === 'unsupported'
            ? { kind, reason: 'nope' }
            : { kind, text: 'ok' };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan).toBeUndefined();
    }
  });
});

describe('validator — dependsOn referencing an unknown step', () => {
  it('errors with UNKNOWN_DEP', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: { goal: 'g', steps: [{ id: 's1', action: 'users.list_users', params: {}, dependsOn: ['s_missing'] }] },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'UNKNOWN_DEP')).toBe(true);
    }
  });
});

describe('validator — ref grammar', () => {
  it.each(['$s1', '$s1.items', '$s1.items[*].id', '$r_t3_s1', '$r_t3_s1.sample[*].name'])(
    'accepts well-formed ref %s',
    (ref) => {
      expect(parseRefGrammar(ref)).not.toBeNull();
    },
  );

  it.each(['$turn3.s1', '$s', '$s1..bad', '$foo', 'plain string', '$item[*]extra'])(
    'rejects malformed ref %s',
    (ref) => {
      expect(parseRefGrammar(ref)).toBeNull();
    },
  );

  it('flags a malformed whole-value ref as REF_GRAMMAR', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: { goal: 'g', steps: [{ id: 's1', action: 'leads.search_leads', params: { created_after: '$turn3.s1' }, dependsOn: [] }] },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_GRAMMAR')).toBe(true);
    }
  });

  it('flags an unknown cross-turn handle', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: { goal: 'g', steps: [{ id: 's1', action: 'leads.assign_lead_owner', params: { lead_id: '$r_t3_s1.id', owner_id: 'u_1' }, dependsOn: [] }] },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'UNKNOWN_HANDLE')).toBe(true);
    }
  });

  it('accepts a known cross-turn handle', () => {
    const handles: HandleRef[] = [{ ref: 'r_t3_s1', entityType: 'leads' }];
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: { goal: 'g', steps: [{ id: 's1', action: 'leads.assign_lead_owner', params: { lead_id: '$r_t3_s1.id', owner_id: 'u_1' }, dependsOn: [] }] },
    };
    const result = validate(outcome, new Set(), handles, conformanceRegistry);
    expect(result.ok).toBe(true);
  });

  it('forEach target must be a ref, not a literal', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [{ id: 's1', action: 'tasks.create_task', params: {}, dependsOn: [], forEach: 'not_a_ref' }],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'FOREACH_NOT_REF')).toBe(true);
    }
  });
});

describe('validator — literal param schema compile', () => {
  it('flags a literal param that fails the action inputSchema', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [{ id: 's1', action: 'users.list_users', params: { active: 'yes' }, dependsOn: [] }],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'PARAM_SCHEMA')).toBe(true);
    }
  });

  it('flags an unknown param key', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [{ id: 's1', action: 'users.list_users', params: { not_a_real_field: 1 }, dependsOn: [] }],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'UNKNOWN_PARAM')).toBe(true);
    }
  });

  it('skips a param containing an embedded ref template even though it looks like a literal string', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's0', action: 'users.list_users', params: {}, dependsOn: [] },
          {
            id: 's1',
            action: 'tasks.create_task',
            params: { title: 'Follow up with $item.name', contact_id: '$item.id', owner_id: '$item.id', due_date: '2026-11-05' },
            dependsOn: ['s0'],
            forEach: '$s0.items',
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), conformanceRegistry);
    expect(result.ok).toBe(true);
  });
});

describe('validator — id-fabrication guard (ID_NOT_RESOLVED)', () => {
  const idRegistry = buildRegistry(
    [
      [
        stubAction('orders.apply_coupon_to_order', z.strictObject({ id: z.string(), coupon_id: z.string() })),
        // an `*_id` field typed as an ENUM (non-id semantic) — the guard's
        // allow-list must leave it untouched (only PLAIN strings are checked).
        stubAction('billing.set_tier', z.strictObject({ id: z.string(), tier_id: z.enum(['free', 'paid']) })),
      ],
    ],
    coreOps,
  );

  it('a quoted NAME in a coupon_id field is ID_NOT_RESOLVED (repairable)', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'orders.apply_coupon_to_order', params: { id: 'order_1', coupon_id: 'coupon 5' }, dependsOn: [] },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), idRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'ID_NOT_RESOLVED')).toBe(true);
    }
  });

  it('an entity-shaped literal id (struct_200) is accepted', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'orders.apply_coupon_to_order', params: { id: 'order_1', coupon_id: 'struct_200' }, dependsOn: [] },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), idRegistry);
    expect(result.ok).toBe(true);
  });

  it('a $ref in an id field is accepted (never a fabricated literal)', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's0', action: 'orders.apply_coupon_to_order', params: { id: 'order_1', coupon_id: 'struct_1' }, dependsOn: [] },
          {
            id: 's1',
            action: 'orders.apply_coupon_to_order',
            params: { id: 'order_2', coupon_id: '$s0.items[*].id' },
            dependsOn: ['s0'],
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), idRegistry);
    expect(result.ok).toBe(true);
  });

  it('an enum-typed *_id field is left untouched (allow-list: only plain strings)', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [{ id: 's1', action: 'billing.set_tier', params: { id: 'struct_1', tier_id: 'free' }, dependsOn: [] }],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), idRegistry);
    expect(result.ok).toBe(true);
  });
});

describe('validator — ref-path vs output schema (REF_PATH_MISMATCH)', () => {
  function outAction(slug: string, outputSchema: z.ZodType<unknown>): ActionDef {
    return {
      id: slug,
      slug,
      module: slug.split('.')[0] as string,
      name: slug,
      description: slug,
      risk: 'read',
      entities: [],
      inputSchema: z.strictObject({ id: z.string().optional(), course_id: z.string().optional() }),
      outputSchema,
      searchCard: { synonyms: [], examplePhrasings: [] },
      handler: async () => ({}),
    };
  }
  const itemView = z.object({ id: z.string(), name: z.string() });
  const refPathRegistry = buildRegistry(
    [
      [
        outAction('courses.search_courses', listOutputSchema(itemView)), // list output
        outAction('courses.get_course_details', itemView), // single-record output
        outAction('enrollments.enroll', z.unknown()), // consumer; opaque output
      ],
    ],
    coreOps,
  );

  function planWith(ref: string, producer = 'courses.search_courses', forEach?: string): PlanOutcome {
    const consumer: Record<string, unknown> = { id: 's2', action: 'enrollments.enroll', params: { course_id: ref }, dependsOn: ['s1'] };
    if (forEach !== undefined) {
      consumer['params'] = {};
      consumer['forEach'] = forEach;
    }
    return {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: producer, params: {}, dependsOn: [] },
          consumer as unknown as Plan['steps'][number],
        ],
      },
    };
  }

  it('$s1.id on a LIST-output action is REF_PATH_MISMATCH (should be items[*].id)', () => {
    const result = validate(planWith('$s1.id'), new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_PATH_MISMATCH')).toBe(true);
      const msg = result.errors.find((e) => e.code === 'REF_PATH_MISMATCH')?.message ?? '';
      expect(msg).toContain('items[*].id');
    }
  });

  it('$s1.items[*].id on a list output is VALID', () => {
    const result = validate(planWith('$s1.items[*].id'), new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(true);
  });

  it('$s1.total on a list output is VALID', () => {
    const result = validate(planWith('$s1.total'), new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(true);
  });

  it('$s1.items[*].bogus (field absent from the row schema) is REF_PATH_MISMATCH', () => {
    const result = validate(planWith('$s1.items[*].bogus'), new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_PATH_MISMATCH')).toBe(true);
    }
  });

  it('$s1.id on a SINGLE-record output (the row has id) is VALID', () => {
    const result = validate(planWith('$s1.id', 'courses.get_course_details'), new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(true);
  });

  it('an opaque (z.unknown) producer output is SKIPPED, never a false positive', () => {
    const result = validate(planWith('$s1.anything', 'enrollments.enroll'), new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(true);
  });

  it('forEach over bare $s1 (list output) does NOT trigger REF_PATH_MISMATCH', () => {
    const result = validate(planWith('unused', 'courses.search_courses', '$s1'), new Set(), noHandles(), refPathRegistry);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_PATH_MISMATCH')).toBe(false);
    }
  });

  it('forEach over $s1.items[*].bogus is REF_PATH_MISMATCH', () => {
    const result = validate(planWith('unused', 'courses.search_courses', '$s1.items[*].bogus'), new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_PATH_MISMATCH')).toBe(true);
    }
  });

  it('when.ref is also path-checked ($s1.id on a list output → REF_PATH_MISMATCH)', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'courses.search_courses', params: {}, dependsOn: [] },
          {
            id: 's2',
            action: 'enrollments.enroll',
            params: {},
            dependsOn: ['s1'],
            when: { ref: '$s1.id', op: 'nonempty' },
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_PATH_MISMATCH')).toBe(true);
    }
  });

  it('when.ref $s1.items (valid array path on a list output) is accepted', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'courses.search_courses', params: {}, dependsOn: [] },
          {
            id: 's2',
            action: 'enrollments.enroll',
            params: {},
            dependsOn: ['s1'],
            when: { ref: '$s1.items', op: 'nonempty' },
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles(), refPathRegistry);
    expect(result.ok).toBe(true);
  });
});

describe('BUDGETS (LLD §5.1)', () => {
  it('matches the canonical values', () => {
    expect(BUDGETS).toEqual({
      maxLlmCallsPerTurn: 6,
      maxRepairs: 2,
      maxReplans: 2,
      maxSearchRounds: 2,
      turnTimeoutMs: 120_000,
      confirmTargetThreshold: 50,
      forEachHardCap: 500,
    });
  });
});
