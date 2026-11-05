/**
 * Task 16 — schema round-trip for the 6 seed scenarios: every YAML file
 * under `eval/scenarios/` must parse cleanly against `scenarioSchema`,
 * survive a JSON round-trip unchanged, and cover at least the 6 required
 * shapes (one per: direct, multistep, followup, ambiguous+mustNotAsk,
 * unsupported, typo).
 *
 * Task 17 grows this directory into the full corpus (Batch A adds 40
 * scenarios atop the 6 seeds), so checks below assert the 6 seed shapes
 * are still PRESENT (a lower bound / subset check) rather than assuming
 * they are the ONLY scenarios in the directory.
 */

import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../runner-tuples.js';
import { parseScenario, scenarioSchema } from '../types.js';

const scenarios = loadScenarios(new URL('../scenarios', import.meta.url).pathname);

describe('seed scenario corpus', () => {
  it('ships at least the 6 seed scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
  });

  it('round-trips every scenario through JSON unchanged', () => {
    for (const scenario of scenarios) {
      const roundTripped = parseScenario(JSON.parse(JSON.stringify(scenario)), scenario.id);
      expect(roundTripped).toEqual(scenario);
    }
  });

  it('rejects an unknown field (strictObject)', () => {
    const withExtra = { ...scenarios[0], unknownField: 'nope' };
    expect(scenarioSchema.safeParse(withExtra).success).toBe(false);
  });

  it('rejects a category outside the LLD §9.1 8-way enum', () => {
    const bad = { ...scenarios[0], category: 'not-a-real-category' };
    expect(scenarioSchema.safeParse(bad).success).toBe(false);
  });

  it('covers one direct, one multistep, one followup, one ambiguous, one unsupported scenario', () => {
    // Lower-bound / subset check (matches this file's own header note):
    // later Task 17 batches add scenarios in OTHER `categorySchema` members
    // (e.g. `conditional`) atop these 6 seed shapes, so this must not
    // assert the category set is CLOSED to exactly these 5.
    const byCategory = new Set(scenarios.map((s) => s.category));
    for (const required of ['direct', 'multistep', 'followup', 'ambiguous', 'unsupported'] as const) {
      expect(byCategory.has(required)).toBe(true);
    }
  });

  it('covers the typo subtype and the no_repeat subtype', () => {
    const subtypes = new Set(scenarios.map((s) => s.subtype).filter((s): s is NonNullable<typeof s> => s !== undefined));
    // Lower bound, not exact-set (see file header): Task 17 Batch A adds
    // 'abstention'-subtype scenarios atop the 6 seeds, so this only checks
    // the two seed subtypes are still present.
    expect(subtypes.has('typo')).toBe(true);
    expect(subtypes.has('no_repeat')).toBe(true);
  });

  it('the multistep seed is the LLD §2.2 flagship — touches every module in that example', () => {
    const flagship = scenarios.find((s) => s.id === 'multistep-lead-sweep');
    expect(flagship).toBeDefined();
    const mustInclude = flagship?.turns[0]?.expect.planActions?.mustInclude ?? [];
    expect(mustInclude).toEqual(
      expect.arrayContaining([
        'leads.search_leads',
        'conversations.search_conversations',
        'core.anti_join',
        'appointments.search_appointments',
        'users.list_users',
        'core.distribute',
        'leads.assign_lead_owner',
        'tasks.create_task',
      ]),
    );
  });

  it('the ambiguous seed carries a mustNotAsk behavior check (no_repeat subtype)', () => {
    const ambiguous = scenarios.find((s) => s.subtype === 'no_repeat');
    expect(ambiguous).toBeDefined();
    const lastTurn = ambiguous?.turns.at(-1);
    expect(lastTurn?.expect.behavior?.mustNotAsk?.length).toBeGreaterThan(0);
  });

  it('every scenario has a non-empty turns array and a standard profile', () => {
    for (const scenario of scenarios) {
      expect(scenario.turns.length).toBeGreaterThan(0);
      expect(scenario.profile).toBe('standard');
    }
  });

  it('the unsupported seed asserts the EXACT refused status (I2, Task 16 review)', () => {
    const unsupported = scenarios.find((s) => s.category === 'unsupported');
    expect(unsupported?.turns[0]?.expect.behavior?.status).toBe('refused');
  });

  // --- I3 (Task 16 review): schema-level empty-expect rejection -------------

  it('rejects a turn whose expect is completely empty', () => {
    const empty = { ...scenarios[0], turns: [{ user: 'hi', expect: {} }] };
    expect(scenarioSchema.safeParse(empty).success).toBe(false);
  });

  it('rejects a turn whose expect only has an all-empty sub-object', () => {
    const vacuous = { ...scenarios[0], turns: [{ user: 'hi', expect: { behavior: {} } }] };
    expect(scenarioSchema.safeParse(vacuous).success).toBe(false);
  });

  it('accepts a turn with a single real assertion field', () => {
    const minimal = { ...scenarios[0], turns: [{ user: 'hi', expect: { behavior: { confirmation: false } } }] };
    expect(scenarioSchema.safeParse(minimal).success).toBe(true);
  });
});
