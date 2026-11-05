import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validate } from '../src/agent/validator';
import { buildRegistry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef } from '../src/catalog/types';
import type { Plan, PlanOutcome } from '../src/events/types';

function searchAction(slug: string, itemShape: z.ZodRawShape): ActionDef {
  const item = z.object(itemShape);
  const out = z.union([
    z.object({ items: z.array(item), total: z.number() }),
    z.object({ __spill: z.literal(true), total: z.number(), sample: z.array(item) }),
  ]);
  return {
    id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug,
    risk: 'read', entities: [slug.split('.')[0] as string],
    inputSchema: z.any(), outputSchema: out,
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: async () => ({ items: [], total: 0 }),
  };
}

function mkPlan(steps: Plan['steps']): PlanOutcome {
  return { kind: 'plan', plan: { goal: 'g', steps } };
}

const registry = buildRegistry(
  [[searchAction('invoices.search_invoices', { id: z.string(), total_cents: z.number(), status: z.string() })]],
  coreOps,
);

describe('E2 — core-op field validation (FIELD_NOT_IN_SCHEMA)', () => {
  it('flags a core.filter field that is not on the producing item schema and lists the real fields', () => {
    const outcome = mkPlan([
      { id: 's1', action: 'invoices.search_invoices', params: {}, dependsOn: [] },
      { id: 's2', action: 'core.filter', params: { in: '$s1.items', field: 'amount_cents', op: 'gt', value: 0 }, dependsOn: ['s1'] },
    ]);
    const verdict = validate(outcome, new Set(), [], registry);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      const err = verdict.errors.find((e) => e.code === 'FIELD_NOT_IN_SCHEMA');
      expect(err).toBeDefined();
      expect(err?.message).toContain('total_cents');
      expect(err?.message).toContain('amount_cents');
    }
  });

  it('accepts a core.filter on a field that exists', () => {
    const outcome = mkPlan([
      { id: 's1', action: 'invoices.search_invoices', params: {}, dependsOn: [] },
      { id: 's2', action: 'core.filter', params: { in: '$s1.items', field: 'total_cents', op: 'gt', value: 0 }, dependsOn: ['s1'] },
    ]);
    const verdict = validate(outcome, new Set(), [], registry);
    expect(verdict.ok).toBe(true);
  });

  it('flags core.pluck on a bad field too', () => {
    const outcome = mkPlan([
      { id: 's1', action: 'invoices.search_invoices', params: {}, dependsOn: [] },
      { id: 's2', action: 'core.pluck', params: { in: '$s1.items', field: 'closed_won_date' }, dependsOn: ['s1'] },
    ]);
    const verdict = validate(outcome, new Set(), [], registry);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.some((e) => e.code === 'FIELD_NOT_IN_SCHEMA')).toBe(true);
  });

  it('skips the check when the list ref is non-introspectable (cross-turn handle)', () => {
    const outcome = mkPlan([
      { id: 's2', action: 'core.filter', params: { in: '$r_t2_s1', field: 'whatever', op: 'eq', value: 1 }, dependsOn: [] },
    ]);
    const verdict = validate(outcome, new Set(), [{ ref: 'r_t2_s1', entityType: 'leads' }], registry);
    // no FIELD_NOT_IN_SCHEMA (can't introspect a handle's row shape)
    if (!verdict.ok) expect(verdict.errors.some((e) => e.code === 'FIELD_NOT_IN_SCHEMA')).toBe(false);
  });
});
