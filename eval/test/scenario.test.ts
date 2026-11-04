/**
 * Task 16 — schema round-trip for the 6 seed scenarios: every YAML file
 * under `eval/scenarios/` must parse cleanly against `scenarioSchema`,
 * survive a JSON round-trip unchanged, and cover exactly the 6 required
 * shapes (one per: direct, multistep, followup, ambiguous+mustNotAsk,
 * unsupported, typo).
 */

import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../runner-tuples';
import { parseScenario, scenarioSchema } from '../types';

const scenarios = loadScenarios(new URL('../scenarios', import.meta.url).pathname);

describe('seed scenario corpus', () => {
  it('ships exactly 6 scenarios', () => {
    expect(scenarios).toHaveLength(6);
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
    const byCategory = new Set(scenarios.map((s) => s.category));
    expect(byCategory).toEqual(new Set(['direct', 'multistep', 'followup', 'ambiguous', 'unsupported']));
  });

  it('covers the typo subtype and the no_repeat subtype', () => {
    const subtypes = new Set(scenarios.map((s) => s.subtype).filter((s): s is NonNullable<typeof s> => s !== undefined));
    expect(subtypes).toEqual(new Set(['typo', 'no_repeat']));
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
});
