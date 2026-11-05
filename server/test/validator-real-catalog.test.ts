/**
 * Validator checks exercised against the REAL catalog registry (not stub
 * actions) — review Fix #5: the id-fabrication heuristic must pass real
 * composite entity ids, and the ref-path check must work against a real
 * action's `outputSchema`.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../src/catalog/registry';
import { validate, type HandleRef } from '../src/agent/validator';
import type { PlanOutcome } from '../src/agent/plan-schema';

const registry = createRegistry();
const noHandles: HandleRef[] = [];

describe('validator (real catalog) — id-fabrication heuristic does NOT false-positive on composite ids', () => {
  // Real composite entity ids the old `^[a-z]+_\d+$` regex wrongly rejected.
  it.each(['course_2_lsn_1', 'community_12_ch_1', 'funnel_7_step_2', 'struct_5_p1', 'con_1', 'course_2', 'apt_4'])(
    'accepts composite/simple id %s in an *_id param',
    (id) => {
      const outcome: PlanOutcome = {
        kind: 'plan',
        plan: {
          goal: 'g',
          steps: [
            {
              id: 's1',
              action: 'enrollments.enroll_learner_in_course',
              params: { contact_id: 'con_1', course_id: id },
              dependsOn: [],
            },
          ],
        },
      };
      const result = validate(outcome, new Set(), noHandles, registry);
      // No ID_NOT_RESOLVED for a real id shape (other unrelated errors would
      // be a test bug, but the point here is specifically the id heuristic).
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === 'ID_NOT_RESOLVED')).toBe(false);
      }
    },
  );

  it.each(['coupon 5', 'Summer Sale', 'premium plan', '4'])('flags the name/ordinal literal %s as ID_NOT_RESOLVED', (name) => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          {
            id: 's1',
            action: 'orders.apply_coupon_to_order',
            params: { id: 'ord_1', coupon_id: name },
            dependsOn: [],
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'ID_NOT_RESOLVED')).toBe(true);
    }
  });
});

describe('validator (real catalog) — ref-path against a real action outputSchema', () => {
  it('$s1.id on coupons.search_coupons (list output) is REF_PATH_MISMATCH', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'coupons.search_coupons', params: { status: 'active' }, dependsOn: [] },
          {
            id: 's2',
            action: 'orders.apply_coupon_to_order',
            params: { id: 'ord_1', coupon_id: '$s1.id' },
            dependsOn: ['s1'],
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_PATH_MISMATCH')).toBe(true);
    }
  });

  it('$s1.items[*].id on coupons.search_coupons is a VALID path (couponView has id)', () => {
    // NOTE: valid as a PATH; whether it is bound to a scalar vs array param
    // is the separate arity check below — here we bind it to an ARRAY param
    // so only the path check applies.
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'coupons.search_coupons', params: { status: 'active' }, dependsOn: [] },
          {
            id: 's2',
            action: 'coupons.restrict_coupon_to_products',
            params: { id: 'struct_1', product_ids: '$s1.items[*].id' },
            dependsOn: ['s1'],
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles, registry);
    expect(result.ok).toBe(true);
  });
});

describe('validator (real catalog) — array-pluck into a scalar param (REF_PATH_MISMATCH)', () => {
  it('an items[*] pluck bound to a SCALAR *_id param is flagged', () => {
    // enrollments.enroll_learner_in_course.course_id is z.string() (scalar).
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'coupons.search_coupons', params: { status: 'active' }, dependsOn: [] },
          {
            id: 's2',
            action: 'enrollments.enroll_learner_in_course',
            params: { contact_id: 'con_1', course_id: '$s1.items[*].id' },
            dependsOn: ['s1'],
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'REF_PATH_MISMATCH')).toBe(true);
    }
  });

  it('the same pluck bound to an ARRAY param is accepted', () => {
    // coupons.restrict_coupon_to_products.product_ids is z.array(z.string()).
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'coupons.search_coupons', params: { status: 'active' }, dependsOn: [] },
          {
            id: 's2',
            action: 'coupons.restrict_coupon_to_products',
            params: { id: 'struct_1', product_ids: '$s1.items[*].id' },
            dependsOn: ['s1'],
          },
        ],
      },
    };
    const result = validate(outcome, new Set(), noHandles, registry);
    expect(result.ok).toBe(true);
  });
});
