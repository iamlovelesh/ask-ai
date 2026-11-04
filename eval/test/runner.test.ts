/**
 * Task 16 — `eval/runner-tuples.ts` (pure tuple planning) and
 * `eval/runner.ts`'s `parseArgs` (pure CLI parsing). No HTTP, no spawned
 * server — exactly the "resume skips completed tuples" + planning-logic
 * tests the brief's Step 1 calls for.
 */

import { describe, expect, it } from 'vitest';
import {
  budgetExceeded,
  completedTuplesFrom,
  filterUncompleted,
  loadScenarios,
  parseShardSpec,
  planTuples,
  scenariosForShard,
  stratifiedQuickSubset,
  sumResultCost,
  tupleKey,
  type ResultRow,
} from '../runner-tuples.js';
import { parseArgs, shardProfileName } from '../runner.js';
import type { Scenario } from '../types.js';

function scenario(id: string, category: Scenario['category'] = 'direct'): Scenario {
  return { id, category, profile: 'standard', turns: [{ user: 'hi', expect: {} }] };
}

// --- loadScenarios (against the real 6 seed YAML files) ---------------------

describe('loadScenarios', () => {
  it('loads and validates every seed scenario YAML', () => {
    const scenarios = loadScenarios(new URL('../scenarios', import.meta.url).pathname);
    expect(scenarios.length).toBe(6);
    expect(scenarios.map((s) => s.id)).toContain('multistep-lead-sweep');
    // sorted by id
    const ids = scenarios.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
  });
});

// --- stratifiedQuickSubset ----------------------------------------------------

describe('stratifiedQuickSubset', () => {
  it('returns everything unmodified when under the limit', () => {
    const scenarios = [scenario('a'), scenario('b')];
    expect(stratifiedQuickSubset(scenarios, 20)).toEqual(scenarios);
  });

  it('round-robins across categories when over the limit', () => {
    const scenarios = [
      ...Array.from({ length: 10 }, (_, i) => scenario(`direct-${i}`, 'direct')),
      ...Array.from({ length: 10 }, (_, i) => scenario(`followup-${i}`, 'followup')),
    ];
    const subset = stratifiedQuickSubset(scenarios, 4);
    expect(subset).toHaveLength(4);
    const categories = subset.map((s) => s.category);
    expect(categories.filter((c) => c === 'direct')).toHaveLength(2);
    expect(categories.filter((c) => c === 'followup')).toHaveLength(2);
  });
});

// --- sharding -----------------------------------------------------------------

describe('parseShardSpec / scenariosForShard', () => {
  it('parses a valid k/m spec', () => {
    expect(parseShardSpec('2/4')).toEqual({ k: 2, m: 4 });
  });

  it('rejects malformed or out-of-range specs', () => {
    expect(() => parseShardSpec('0/4')).toThrow();
    expect(() => parseShardSpec('5/4')).toThrow();
    expect(() => parseShardSpec('nope')).toThrow();
  });

  it('splits scenarios into disjoint, exhaustive shards', () => {
    const scenarios = Array.from({ length: 7 }, (_, i) => scenario(`s${i}`));
    const shard1 = scenariosForShard(scenarios, { k: 1, m: 3 });
    const shard2 = scenariosForShard(scenarios, { k: 2, m: 3 });
    const shard3 = scenariosForShard(scenarios, { k: 3, m: 3 });
    const union = [...shard1, ...shard2, ...shard3].map((s) => s.id).sort();
    expect(union).toEqual(scenarios.map((s) => s.id).sort());
    // disjoint
    expect(shard1.filter((s) => shard2.includes(s))).toHaveLength(0);
  });
});

// --- planTuples -----------------------------------------------------------

describe('planTuples', () => {
  const scenarios = [scenario('a'), scenario('b')];

  it('expands optimized agent across N trials', () => {
    const tuples = planTuples(scenarios, { agent: 'optimized', trials: 3 });
    expect(tuples).toHaveLength(6);
    expect(tuples.filter((t) => t.agent === 'optimized')).toHaveLength(6);
    expect(tuples.filter((t) => t.trial === 1)).toHaveLength(2);
  });

  it('baseline always runs exactly 1 trial, even if --trials is higher', () => {
    const tuples = planTuples(scenarios, { agent: 'baseline', trials: 5 });
    expect(tuples).toHaveLength(2);
    expect(tuples.every((t) => t.trial === 1 && t.agent === 'baseline')).toBe(true);
  });

  it("agent:'both' includes optimized x N trials + baseline x 1", () => {
    const tuples = planTuples(scenarios, { agent: 'both', trials: 2 });
    expect(tuples.filter((t) => t.agent === 'optimized')).toHaveLength(4);
    expect(tuples.filter((t) => t.agent === 'baseline')).toHaveLength(2);
  });

  it('--quick forces exactly 1 trial regardless of --trials', () => {
    const tuples = planTuples(scenarios, { agent: 'optimized', trials: 3, quick: true });
    expect(tuples).toHaveLength(2);
  });
});

// --- resume: completedTuplesFrom / filterUncompleted ------------------------

function row(scenarioId: string, agent: 'optimized' | 'baseline', trial: number, pass = true): ResultRow {
  return { scenarioId, category: 'direct', agent, trial, pass, turns: [], ts: 0 };
}

describe('completedTuplesFrom / filterUncompleted — resume', () => {
  it('builds a tuple-key set from valid JSONL lines', () => {
    const jsonl = [row('a', 'optimized', 1), row('a', 'optimized', 2)].map((r) => JSON.stringify(r)).join('\n');
    const done = completedTuplesFrom(jsonl);
    expect(done.has(tupleKey('a', 'optimized', 1))).toBe(true);
    expect(done.has(tupleKey('a', 'optimized', 2))).toBe(true);
    expect(done.has(tupleKey('a', 'optimized', 3))).toBe(false);
  });

  it('tolerates a partial/corrupt trailing line (killed mid-write)', () => {
    const good = JSON.stringify(row('a', 'optimized', 1));
    const jsonl = `${good}\n{"scenarioId":"a","age`; // truncated
    const done = completedTuplesFrom(jsonl);
    expect(done.has(tupleKey('a', 'optimized', 1))).toBe(true);
    expect(done.size).toBe(1);
  });

  it('--resume skips exactly the tuples already present in a fixture JSONL', () => {
    const scenarios = [scenario('a'), scenario('b')];
    const allTuples = planTuples(scenarios, { agent: 'optimized', trials: 2 });
    expect(allTuples).toHaveLength(4);

    const priorRunJsonl = [row('a', 'optimized', 1), row('a', 'optimized', 2)].map((r) => JSON.stringify(r)).join('\n');
    const completed = completedTuplesFrom(priorRunJsonl);
    const remaining = filterUncompleted(allTuples, completed);

    expect(remaining).toHaveLength(2);
    expect(remaining.every((t) => t.scenario.id === 'b')).toBe(true);
  });
});

// --- budget guard --------------------------------------------------------

describe('budgetExceeded / sumResultCost', () => {
  it('sums cost across every turn in every row', () => {
    const rows: ResultRow[] = [
      { scenarioId: 'a', category: 'direct', agent: 'optimized', trial: 1, pass: true, ts: 0, turns: [turnWithCost(0.01), turnWithCost(0.02)] },
      { scenarioId: 'b', category: 'direct', agent: 'optimized', trial: 1, pass: true, ts: 0, turns: [turnWithCost(0.005)] },
    ];
    expect(sumResultCost(rows)).toBeCloseTo(0.035, 6);
  });

  it('trips once cumulative spend reaches the limit', () => {
    expect(budgetExceeded(24.999, 25)).toBe(false);
    expect(budgetExceeded(25, 25)).toBe(true);
    expect(budgetExceeded(25.5, 25)).toBe(true);
  });
});

function turnWithCost(costUsd: number): ResultRow['turns'][number] {
  return {
    index: 0,
    pass: true,
    failures: [],
    status: 'done',
    complex: false,
    ttfurMs: 1,
    totalMs: 1,
    llmCalls: 1,
    repairs: 0,
    replans: 0,
    searchRounds: 0,
    tokensIn: 1,
    tokensOut: 1,
    costUsd,
  };
}

// --- parseArgs / shardProfileName --------------------------------------------

describe('parseArgs', () => {
  it('defaults to the optimized agent, 3 trials', () => {
    const opts = parseArgs([]);
    expect(opts.agent).toBe('optimized');
    expect(opts.trials).toBe(3);
    expect(opts.quick).toBe(false);
    expect(opts.resume).toBe(false);
  });

  it('--baseline is an alias for --agent baseline', () => {
    expect(parseArgs(['--baseline']).agent).toBe('baseline');
  });

  it('parses --shard, --trials, --budget, --run-id', () => {
    const opts = parseArgs(['--shard', '2/4', '--trials', '5', '--budget', '10', '--run-id', 'myrun']);
    expect(opts.shard).toEqual({ k: 2, m: 4 });
    expect(opts.trials).toBe(5);
    expect(opts.budgetUsd).toBe(10);
    expect(opts.runId).toBe('myrun');
  });

  it('rejects an invalid --agent value', () => {
    expect(() => parseArgs(['--agent', 'nonsense'])).toThrow();
  });

  it('--server-url without --profile is accepted at parse time (validated later by main())', () => {
    const opts = parseArgs(['--server-url', 'http://localhost:4000']);
    expect(opts.serverUrl).toBe('http://localhost:4000');
    expect(opts.profile).toBeUndefined();
  });

  it('resolves --mock-llm-script to an ABSOLUTE path (the spawned server child runs with cwd=server/, so a relative path would resolve against the wrong directory and ENOENT)', () => {
    const opts = parseArgs(['--mock-llm-script', 'eval/mock-scripts/direct-search-leads.json']);
    expect(opts.mockLlmScript).toBeDefined();
    expect(opts.mockLlmScript?.startsWith('/')).toBe(true);
    expect(opts.mockLlmScript).toContain('eval/mock-scripts/direct-search-leads.json');
  });
});

describe('shardProfileName', () => {
  it('is deterministic and filesystem-safe', () => {
    expect(shardProfileName('2026-11-05T00-00-00', { k: 1, m: 4 })).toBe('evalrun-2026-11-05T00-00-00-s1');
    expect(shardProfileName('run:with/bad:chars', undefined)).toMatch(/^evalrun-[a-zA-Z0-9-]+$/);
  });
});
