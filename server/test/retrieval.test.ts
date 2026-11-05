import { describe, it, expect } from 'vitest';
import { retrieve, renderCards, scoreCard, computeSessionBoost, computeModuleCohesion, diversify } from '../src/agent/retrieval';
import type { SessionCtx } from '../src/agent/retrieval';

function emptySession(): SessionCtx {
  return { usedActionSlugs: [], activeModules: [] };
}

describe('retrieval — scoreCard weights (LLD §4)', () => {
  it('combines bm25/session/module at the documented 0.70/0.20/0.10 weights', () => {
    expect(scoreCard(1, 0, 0)).toBeCloseTo(0.7, 6);
    expect(scoreCard(0, 1, 0)).toBeCloseTo(0.2, 6);
    expect(scoreCard(0, 0, 1)).toBeCloseTo(0.1, 6);
    expect(scoreCard(1, 1, 1)).toBeCloseTo(1.0, 6);
    expect(scoreCard(0, 0, 0)).toBe(0);
  });
});

describe('retrieval — computeSessionBoost / computeModuleCohesion', () => {
  it('session boost is 1 only when the exact slug was already used this session', () => {
    const session: SessionCtx = { usedActionSlugs: ['contacts.create_contact'], activeModules: [] };
    expect(computeSessionBoost('contacts.create_contact', session)).toBe(1);
    expect(computeSessionBoost('contacts.search_contacts', session)).toBe(0);
  });

  it('module cohesion is 1 only when the module is in activeModules', () => {
    const session: SessionCtx = { usedActionSlugs: [], activeModules: ['invoices'] };
    expect(computeModuleCohesion('invoices', session)).toBe(1);
    expect(computeModuleCohesion('contacts', session)).toBe(0);
  });
});

describe('retrieval — diversify (≤4/module cap)', () => {
  it('caps any single module at 4 entries even if it dominates the raw ranking', () => {
    const sorted = Array.from({ length: 10 }, (_, i) => ({ module: 'contacts', score: 10 - i })).concat(
      Array.from({ length: 10 }, (_, i) => ({ module: 'leads', score: 9 - i })),
    );
    sorted.sort((a, b) => b.score - a.score);
    const picked = diversify(sorted, 4, 20);
    const counts = new Map<string, number>();
    for (const p of picked) counts.set(p.module, (counts.get(p.module) ?? 0) + 1);
    expect(counts.get('contacts')).toBeLessThanOrEqual(4);
    expect(counts.get('leads')).toBeLessThanOrEqual(4);
  });

  it('respects the overall limit', () => {
    const sorted = Array.from({ length: 50 }, (_, i) => ({ module: `m${i % 30}`, score: 50 - i }));
    const picked = diversify(sorted, 4, 20);
    expect(picked.length).toBeLessThanOrEqual(20);
  });

  it('keeps score-descending priority within the cap', () => {
    const sorted = [
      { module: 'a', score: 5 },
      { module: 'a', score: 4 },
      { module: 'b', score: 3 },
      { module: 'a', score: 2 },
    ];
    const picked = diversify(sorted, 1, 20);
    expect(picked.map((p) => p.module)).toEqual(['a', 'b']);
    expect(picked[0]!.score).toBe(5);
  });
});

describe('retrieve() — against the real 500-action catalog', () => {
  it('returns at most 24 cards (20 ranked + ≤4 reserved resolvers), each with a slug/text/score', () => {
    const result = retrieve('create a contact', emptySession());
    expect(result.cards.length).toBeLessThanOrEqual(24);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    for (const card of result.cards) {
      expect(typeof card.slug).toBe('string');
      expect(typeof card.text).toBe('string');
      expect(typeof card.score).toBe('number');
    }
  });

  it('ranks the obviously-correct action at or near the top for a direct query', () => {
    const result = retrieve('create a new contact', emptySession());
    const slugs = result.cards.map((c) => c.slug);
    expect(slugs).toContain('contacts.create_contact');
    expect(slugs.indexOf('contacts.create_contact')).toBeLessThan(5);
  });

  it('never returns more than 4 cards from the same module', () => {
    // A broad query ("search") should match `search_*` actions across many
    // modules — the ≤4/module diversification must still hold end-to-end.
    const result = retrieve('search', emptySession());
    const perModule = new Map<string, number>();
    for (const card of result.cards) {
      const module = card.slug.split('.')[0] as string;
      perModule.set(module, (perModule.get(module) ?? 0) + 1);
    }
    for (const [, count] of perModule) {
      expect(count).toBeLessThanOrEqual(4);
    }
  });

  it('tolerates a typo (fuzzy: 0.2) and still surfaces the intended action', () => {
    const result = retrieve('creat a contct', emptySession());
    const slugs = result.cards.map((c) => c.slug);
    expect(slugs).toContain('contacts.create_contact');
  });

  it('reserves the module resolver when the query names an entity to update (TRIAGE C1)', () => {
    // "update calendar 6's timezone" matches the calendars.* update verbs; the
    // calendars.list_calendars resolver must be reserved so the planner can
    // resolve the name instead of fabricating `calendar_6`.
    const result = retrieve("update calendar 6's timezone", emptySession());
    const slugs = result.cards.map((c) => c.slug);
    expect(slugs).toContain('calendars.list_calendars');
    expect(result.cards.length).toBeLessThanOrEqual(24);
  });

  it('keeps the ≤24-card ceiling even with resolver reservation', () => {
    for (const q of ['update a company', 'overdue invoices for a contact', 'pipeline opportunities']) {
      const result = retrieve(q, emptySession());
      expect(result.cards.length).toBeLessThanOrEqual(24);
    }
  });

  it('sessionBoost raises a slug the session already used, for an otherwise-tied query', () => {
    const q = 'contact';
    const withoutSession = retrieve(q, emptySession());
    const rankWithout = withoutSession.cards.findIndex((c) => c.slug === 'contacts.get_contact_details');

    const withSession = retrieve(q, { usedActionSlugs: ['contacts.get_contact_details'], activeModules: [] });
    const rankWith = withSession.cards.findIndex((c) => c.slug === 'contacts.get_contact_details');

    expect(rankWithout).toBeGreaterThanOrEqual(0);
    expect(rankWith).toBeGreaterThanOrEqual(0);
    expect(rankWith).toBeLessThanOrEqual(rankWithout);

    const scoreWithout = withoutSession.cards[rankWithout]!.score;
    const scoreWith = withSession.cards[rankWith]!.score;
    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });
});

describe('renderCards', () => {
  it('joins each card text with a newline', () => {
    const cards = [
      { slug: 'a.b', text: 'a.b — B: desc', score: 1 },
      { slug: 'c.d', text: 'c.d — D: desc', score: 0.5 },
    ];
    expect(renderCards(cards)).toBe('a.b — B: desc\nc.d — D: desc');
  });

  it('produces a compact, informative line per real action', () => {
    const result = retrieve('create a new contact', emptySession());
    const card = result.cards.find((c) => c.slug === 'contacts.create_contact');
    expect(card).toBeDefined();
    expect(card!.text).toContain('contacts.create_contact');
    expect(card!.text).toContain('Create contact');
  });
});
