/**
 * Task 16 — coverage linter (`eval/lint.ts`) on synthetic gaps: module
 * coverage <2, category coverage <2, subtype coverage <2, and a
 * non-pinned absolute date embedded in a scenario.
 */

import { describe, expect, it } from 'vitest';
import { lintScenarios } from '../lint.js';
import { loadScenarios } from '../runner-tuples.js';
import type { Scenario } from '../types.js';

/** Default `turns` carries a real (if trivial) assertion — `expect: {}`
 * would itself now trip the `empty-expect` check (I3, Task 16 review),
 * which would bleed into every test in this file that doesn't care about
 * that specific check and only overrides `turns` when it does. */
function scenario(overrides: Partial<Scenario> & Pick<Scenario, 'id' | 'category'>): Scenario {
  return {
    profile: 'standard',
    turns: [{ user: 'hi', expect: { response: { mustMention: ['x'] } } }],
    ...overrides,
  };
}

describe('lintScenarios — module coverage', () => {
  it('flags a module touched by only 1 scenario', () => {
    const scenarios = [
      scenario({ id: 'a', category: 'direct', turns: [{ user: 'x', expect: { planActions: { mustInclude: ['leads.search_leads'] } } }] }),
      scenario({ id: 'b', category: 'direct', turns: [{ user: 'y', expect: { planActions: { mustInclude: ['companies.search_companies'] } } }] }),
      scenario({ id: 'c', category: 'direct', turns: [{ user: 'z', expect: { planActions: { mustInclude: ['companies.search_companies'] } } }] }),
    ];
    const issues = lintScenarios(scenarios, { minPerCategory: 1, minPerSubtype: 1 });
    expect(issues.some((i) => i.kind === 'module-coverage' && i.detail.includes("'leads'"))).toBe(true);
    expect(issues.some((i) => i.kind === 'module-coverage' && i.detail.includes("'companies'"))).toBe(false);
  });

  it('passes once every module has >= min scenarios', () => {
    const scenarios = [
      scenario({ id: 'a', category: 'direct', turns: [{ user: 'x', expect: { planActions: { mustInclude: ['leads.search_leads'] } } }] }),
      scenario({ id: 'b', category: 'direct', turns: [{ user: 'y', expect: { planActions: { mustInclude: ['leads.search_leads'] } } }] }),
    ];
    const issues = lintScenarios(scenarios, { minPerCategory: 1, minPerSubtype: 1 });
    expect(issues.filter((i) => i.kind === 'module-coverage')).toHaveLength(0);
  });
});

describe('lintScenarios — category/subtype coverage', () => {
  it('flags a category with only 1 scenario', () => {
    const scenarios = [scenario({ id: 'a', category: 'unsupported' }), scenario({ id: 'b', category: 'direct' }), scenario({ id: 'c', category: 'direct' })];
    const issues = lintScenarios(scenarios, { minPerModule: 0 });
    expect(issues.some((i) => i.kind === 'category-coverage' && i.detail.includes("'unsupported'"))).toBe(true);
  });

  it('flags a subtype with only 1 scenario', () => {
    const scenarios = [
      scenario({ id: 'a', category: 'direct', subtype: 'typo' }),
      scenario({ id: 'b', category: 'direct' }),
      scenario({ id: 'c', category: 'direct' }),
    ];
    const issues = lintScenarios(scenarios, { minPerModule: 0, minPerCategory: 0 });
    expect(issues.some((i) => i.kind === 'subtype-coverage' && i.detail.includes("'typo'"))).toBe(true);
  });

  it('--allow-partial (allowPartialCoverage) suppresses module/category/subtype checks', () => {
    const scenarios = [scenario({ id: 'a', category: 'unsupported' })];
    const issues = lintScenarios(scenarios, { allowPartialCoverage: true });
    expect(issues.filter((i) => i.kind !== 'absolute-date')).toHaveLength(0);
  });
});

describe('lintScenarios — absolute-date hygiene', () => {
  it('flags a non-pinned absolute date in the user text', () => {
    const scenarios = [
      scenario({ id: 'a', category: 'direct', turns: [{ user: 'Find leads created on 2025-01-01', expect: { response: { mustMention: ['x'] } } }] }),
    ];
    const issues = lintScenarios(scenarios, { allowPartialCoverage: true });
    expect(issues.some((i) => i.kind === 'absolute-date' && i.detail.includes('2025-01-01'))).toBe(true);
  });

  it('allows the pinned VIRTUAL_NOW dates', () => {
    const scenarios = [
      scenario({ id: 'a', category: 'direct', turns: [{ user: 'As of 2026-11-04, find leads', expect: { response: { mustMention: ['x'] } } }] }),
    ];
    const issues = lintScenarios(scenarios, { allowPartialCoverage: true });
    expect(issues.filter((i) => i.kind === 'absolute-date')).toHaveLength(0);
  });

  it('flags a date embedded in a paramCheck value too, not just free text', () => {
    const scenarios = [
      scenario({
        id: 'a',
        category: 'direct',
        turns: [{ user: 'x', expect: { paramChecks: [{ action: 'leads.search_leads', param: 'created_after', equals: '2025-06-01' }] } }],
      }),
    ];
    const issues = lintScenarios(scenarios, { allowPartialCoverage: true });
    expect(issues.some((i) => i.kind === 'absolute-date')).toBe(true);
  });
});

describe('lintScenarios — empty-expect (I3, Task 16 review)', () => {
  it('flags a turn with an all-empty sub-object expect, even under --allow-partial', () => {
    const scenarios = [scenario({ id: 'a', category: 'direct', turns: [{ user: 'x', expect: { behavior: {} } }] })];
    const issues = lintScenarios(scenarios, { allowPartialCoverage: true });
    expect(issues.some((i) => i.kind === 'empty-expect')).toBe(true);
  });

  it('does not flag a turn with a real assertion', () => {
    const scenarios = [scenario({ id: 'a', category: 'direct', turns: [{ user: 'x', expect: { behavior: { confirmation: false } } }] })];
    const issues = lintScenarios(scenarios, { allowPartialCoverage: true });
    expect(issues.filter((i) => i.kind === 'empty-expect')).toHaveLength(0);
  });
});

describe('lintScenarios — real seed corpus (allowPartialCoverage:true)', () => {
  it('the 6 shipped seeds have no absolute-date hygiene issues', () => {
    const scenarios = loadScenarios(new URL('../scenarios', import.meta.url).pathname);
    const issues = lintScenarios(scenarios, { allowPartialCoverage: true });
    expect(issues).toEqual([]);
  });
});
