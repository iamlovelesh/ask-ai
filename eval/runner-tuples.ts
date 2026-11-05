/**
 * Pure tuple-planning helpers for `eval/runner.ts` (Task 16, LLD §9.2):
 * which (scenario, agent, trial) tuples a given invocation should run, in
 * what order, and which of those a `--resume` run can skip. Kept
 * dependency-free (no HTTP, no process spawning, no fs beyond loading
 * scenario YAML) so `eval/test/runner.test.ts` can exercise resume/quick/
 * shard logic against fixtures without ever starting a server.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseScenario, type Scenario } from './types.js';

export type AgentSelection = 'optimized' | 'baseline' | 'both';

export interface Tuple {
  scenario: Scenario;
  agent: 'optimized' | 'baseline' | 'plandsl';
  trial: number;
}

/** One row as written to `results/<runid>/results.jsonl` by `eval/runner.ts`
 * — kept here (not in `runner.ts`) so `report.ts`/tests can import the
 * shape without pulling in the HTTP-driving half of the runner. */
export interface ResultRow {
  scenarioId: string;
  category: string;
  subtype?: string;
  agent: 'optimized' | 'baseline' | 'plandsl';
  trial: number;
  pass: boolean;
  turns: TurnResultRow[];
  ts: number;
}

export interface TurnResultRow {
  index: number;
  pass: boolean;
  failures: { kind: string; detail: string }[];
  status: string;
  complex: boolean;
  ttfurMs: number;
  totalMs: number;
  llmCalls: number;
  repairs: number;
  replans: number;
  searchRounds: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

// --- loading scenarios -------------------------------------------------------

/** Loads+validates every `*.yaml`/`*.yml` file directly under `dir` (no
 * recursion — `eval/scenarios/` is a flat directory per the brief),
 * sorted by `id` for deterministic tuple ordering across runs/shards. */
export function loadScenarios(dir: string): Scenario[] {
  const files = readdirSync(dir).filter((f) => extname(f) === '.yaml' || extname(f) === '.yml');
  const scenarios = files.map((f) => {
    const full = join(dir, f);
    const raw = parseYaml(readFileSync(full, 'utf-8'));
    return parseScenario(raw, full);
  });
  return scenarios.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- --quick stratified subset -----------------------------------------------

/**
 * Round-robins across distinct `category` buckets (each internally sorted
 * by `id`) so a 20-scenario subset of a large corpus still touches every
 * category rather than front-loading whichever one sorts first
 * alphabetically. Returns everything, unmodified order, if `scenarios.length
 * <= limit` (true for the 6-seed corpus this task ships — the stratification
 * only matters once Task 17 grows the corpus past 20).
 */
export function stratifiedQuickSubset(scenarios: readonly Scenario[], limit = 20): Scenario[] {
  if (scenarios.length <= limit) return [...scenarios];

  const byCategory = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    const bucket = byCategory.get(s.category);
    if (bucket) bucket.push(s);
    else byCategory.set(s.category, [s]);
  }
  const categories = [...byCategory.keys()].sort();
  const queues = categories.map((c) => [...(byCategory.get(c) as Scenario[])]);

  const out: Scenario[] = [];
  let anyLeft = true;
  while (out.length < limit && anyLeft) {
    anyLeft = false;
    for (const queue of queues) {
      if (out.length >= limit) break;
      const next = queue.shift();
      if (next) {
        out.push(next);
        anyLeft = true;
      }
    }
  }
  return out;
}

// --- sharding -----------------------------------------------------------------

export interface ShardSpec {
  k: number; // 1-based
  m: number;
}

/** Parses `"k/m"` (1-based `k`, `1 <= k <= m`). Throws on anything else —
 * a silently-ignored malformed `--shard` value would make a shard quietly
 * run the WHOLE corpus instead of its slice, which is worse than failing
 * loudly. */
export function parseShardSpec(raw: string): ShardSpec {
  const match = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (!match) throw new Error(`invalid --shard value '${raw}' — expected 'k/m', e.g. '1/4'`);
  const k = Number(match[1]);
  const m = Number(match[2]);
  if (!(m >= 1) || !(k >= 1) || k > m) {
    throw new Error(`invalid --shard value '${raw}' — need 1 <= k <= m`);
  }
  return { k, m };
}

export function scenariosForShard(scenarios: readonly Scenario[], shard: ShardSpec): Scenario[] {
  return scenarios.filter((_, i) => i % shard.m === shard.k - 1);
}

// --- tuple planning -------------------------------------------------------

export interface PlanTuplesOptions {
  agent: AgentSelection;
  trials: number;
  quick?: boolean;
  shard?: ShardSpec;
}

/**
 * The full (scenario, agent, trial) plan for one runner invocation. Order
 * is deterministic (scenario id, then optimized trials ascending, then
 * baseline) so `--resume` comparisons and JSONL diffs are stable across
 * runs. Baseline ALWAYS runs exactly 1 trial regardless of `--trials` (LLD
 * §8: "Baseline runs 1 trial — pass^k is measured on the optimized agent
 * only, disclosed").
 */
export function planTuples(scenarios: readonly Scenario[], opts: PlanTuplesOptions): Tuple[] {
  let selected = opts.quick ? stratifiedQuickSubset(scenarios, 20) : [...scenarios];
  if (opts.shard) selected = scenariosForShard(selected, opts.shard);
  selected = [...selected].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const trials = opts.quick ? 1 : Math.max(1, opts.trials);
  const tuples: Tuple[] = [];
  for (const scenario of selected) {
    if (opts.agent === 'optimized' || opts.agent === 'both') {
      for (let trial = 1; trial <= trials; trial += 1) {
        tuples.push({ scenario, agent: 'optimized', trial });
      }
    }
    if (opts.agent === 'baseline' || opts.agent === 'both') {
      tuples.push({ scenario, agent: 'baseline', trial: 1 });
    }
  }
  return tuples;
}

// --- resume -------------------------------------------------------------------

export function tupleKey(scenarioId: string, agent: string, trial: number): string {
  return `${scenarioId}::${agent}::t${trial}`;
}

/** Parses an existing `results.jsonl` (one JSON object per line; a
 * trailing partial/corrupt line — e.g. from a killed process mid-write —
 * is skipped rather than throwing, since `--resume`'s whole point is
 * tolerating an interrupted prior run) into the set of tuple keys already
 * completed. */
export function completedTuplesFrom(jsonlText: string): Set<string> {
  const done = new Set<string>();
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const row = JSON.parse(trimmed) as Partial<ResultRow>;
      if (row.scenarioId && row.agent && row.trial !== undefined) {
        done.add(tupleKey(row.scenarioId, row.agent, row.trial));
      }
    } catch {
      // Partial/corrupt trailing line from an interrupted prior run — skip.
    }
  }
  return done;
}

export function filterUncompleted(tuples: readonly Tuple[], completed: ReadonlySet<string>): Tuple[] {
  return tuples.filter((t) => !completed.has(tupleKey(t.scenario.id, t.agent, t.trial)));
}

// --- budget guard ---------------------------------------------------------

/** `true` once cumulative spend has reached (or passed) the ceiling — the
 * runner aborts remaining tuples and writes a partial report rather than
 * continuing past `EVAL_BUDGET_USD`/`--budget`. */
export function budgetExceeded(cumulativeUsd: number, limitUsd: number): boolean {
  return cumulativeUsd >= limitUsd;
}

export function sumResultCost(rows: readonly ResultRow[]): number {
  let total = 0;
  for (const row of rows) for (const turn of row.turns) total += turn.costUsd;
  return total;
}
