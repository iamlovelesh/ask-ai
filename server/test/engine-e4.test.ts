import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validate, looksLikeEntityId, type Provenance } from '../src/agent/validator';
import { buildRegistry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef } from '../src/catalog/types';
import type { PlanOutcome } from '../src/events/types';

const getContact: ActionDef = {
  id: 'contacts.get_contact_details', slug: 'contacts.get_contact_details', module: 'contacts',
  name: 'Get contact', description: 'd', risk: 'read', entities: ['contacts'],
  inputSchema: z.strictObject({ id: z.string() }), outputSchema: z.any(),
  searchCard: { synonyms: [], examplePhrasings: [] }, handler: async () => ({}),
};
const search: ActionDef = {
  id: 'contacts.search_contacts', slug: 'contacts.search_contacts', module: 'contacts',
  name: 'Search', description: 'd', risk: 'read', entities: ['contacts'],
  inputSchema: z.strictObject({ query: z.string().optional() }),
  outputSchema: z.union([
    z.object({ items: z.array(z.object({ id: z.string() })), total: z.number() }),
    z.object({ __spill: z.literal(true), total: z.number(), sample: z.array(z.object({ id: z.string() })) }),
  ]),
  searchCard: { synonyms: [], examplePhrasings: [] }, handler: async () => ({ items: [], total: 0 }),
};
const registry = buildRegistry([[getContact, search]], coreOps);

function plan(id: string): PlanOutcome {
  return { kind: 'plan', plan: { goal: 'g', steps: [{ id: 's1', action: 'contacts.get_contact_details', params: { id }, dependsOn: [] }] } };
}

describe('E4 — id provenance guard', () => {
  it('derives id-shape from the entity model (programmatic prefixes)', () => {
    expect(looksLikeEntityId('con_1')).toBe(true);
    expect(looksLikeEntityId('course_2_lsn_1')).toBe(true); // composite
    expect(looksLikeEntityId('struct_5')).toBe(true);
    expect(looksLikeEntityId('liam volkov')).toBe(false);
    expect(looksLikeEntityId('q1_2026')).toBe(false); // not a real prefix
    expect(looksLikeEntityId('xyz_9')).toBe(false); // unknown prefix
  });

  it('flags a fabricated id (con_1 for "liam volkov", empty memory) → ID_NOT_PROVENANCED demanding a lookup', () => {
    const prov: Provenance = { knownIds: new Set(), userText: 'get details for liam volkov' };
    const verdict = validate(plan('con_1'), new Set(), [], registry, prov);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      const err = verdict.errors.find((e) => e.code === 'ID_NOT_PROVENANCED');
      expect(err).toBeDefined();
      expect(err?.message.toLowerCase()).toContain('lookup');
    }
  });

  it('allows an id present in working-memory knownIds', () => {
    const prov: Provenance = { knownIds: new Set(['con_1']), userText: 'get that contact' };
    const verdict = validate(plan('con_1'), new Set(), [], registry, prov);
    expect(verdict.ok).toBe(true);
  });

  it('allows an id the user typed verbatim', () => {
    const prov: Provenance = { knownIds: new Set(), userText: 'show me con_1 please' };
    const verdict = validate(plan('con_1'), new Set(), [], registry, prov);
    expect(verdict.ok).toBe(true);
  });

  it('allows a $ref-resolved id (never a literal) — prior-step provenance', () => {
    const prov: Provenance = { knownIds: new Set(), userText: 'find liam and open his contact' };
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'contacts.search_contacts', params: { query: 'liam' }, dependsOn: [] },
          { id: 's2', action: 'contacts.get_contact_details', params: { id: '$s1.items[0].id' }, dependsOn: ['s1'] },
        ],
      },
    };
    const verdict = validate(outcome, new Set(), [], registry, prov);
    expect(verdict.ok).toBe(true);
  });

  it('is skipped entirely when no provenance context is supplied (backward compat)', () => {
    const verdict = validate(plan('con_1'), new Set(), [], registry);
    expect(verdict.ok).toBe(true);
  });

  // P4: a wrong-SHAPE fabricated id ("cam_8"/"campaign_16" for "campaign 8")
  // has an unknown prefix, so `looksLikeEntityId` is false and the old guard
  // let it through to the confirmation gate → NOT_FOUND (marketing NEW-1).
  // The guard must flag ANY unprovenanced, non-name literal in an id param.
  it('flags an unprovenanced wrong-shape id literal (unknown prefix) → ID_NOT_PROVENANCED', () => {
    const prov: Provenance = { knownIds: new Set(), userText: 'launch campaign 8 for me' };
    for (const fake of ['cam_8', 'campaign_16']) {
      const verdict = validate(plan(fake), new Set(), [], registry, prov);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.errors.some((e) => e.code === 'ID_NOT_PROVENANCED')).toBe(true);
      }
    }
  });

  it('still allows an unprovenanced-shape id the user typed verbatim (even weird shape)', () => {
    const prov: Provenance = { knownIds: new Set(), userText: 'use cam_8 as the id' };
    const verdict = validate(plan('cam_8'), new Set(), [], registry, prov);
    expect(verdict.ok).toBe(true);
  });
});
