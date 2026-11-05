#!/usr/bin/env tsx
/**
 * Vacuous-floor sweep (Task 17 hardening, defect 3).
 *
 * A `state` check that uses `equals`/`gte`/`lte` (NOT `countDelta`) is an
 * ABSOLUTE assertion against the db at assert-time — the LLD explicitly
 * allows this ("checks that genuinely want an absolute bound ... rather
 * than a before/after delta", `eval/types.ts`). That's correct for a
 * READ-only turn verifying a known universe count (e.g. "165 invoices are
 * overdue" after a pure `list_overdue_invoices` search) — matching the
 * pristine baseline IS the point there.
 *
 * It's a BUG when the turn's expected plan also includes a non-`read`
 * risk action (write/destructive/bulk/external — i.e. the turn is
 * supposed to MUTATE state) and the chosen absolute floor is already
 * satisfied by the PRISTINE template, untouched by any turn. Such a
 * check would pass even if the mutating action never fired — exactly the
 * `followup-leads-assign`/`followup-tickets-assign` bug class found and
 * fixed during Task 17 Batch C (see task-17-c-report.md Concern #2:
 * "Baseline-count traps in `gte` floors ... a vacuous assertion that
 * would pass even if the write never landed").
 *
 * This script is the generalization of that one-off manual check: for
 * every `state` check across the WHOLE corpus that isn't already
 * baseline-relative (`countDelta`), it re-runs the check's query against
 * a throwaway copy of the pristine template db and reports whether the
 * untouched baseline alone already satisfies the assertion. A row is
 * flagged `VACUOUS` only when ALL of:
 *   (a) the owning turn's `planActions.mustInclude` contains at least one
 *       action whose catalog-declared `risk` is NOT `'read'` (so the turn
 *       is supposed to change something),
 *   (b) the turn is actually expected to SUCCEED at that mutation — i.e.
 *       its `behavior.status` (when asserted) is `'done'`, not
 *       `'failed'`/`'refused'`/`'cancelled'`/`'clarify'`. A `failure`
 *       category scenario asserting the write never landed (state
 *       equals its pre-turn baseline, by design — see
 *       `failure-appointments-transient-exhausted.yaml`) is CORRECT, not
 *       vacuous, even though its plan names a non-read action, AND
 *   (c) the untouched pristine baseline already satisfies the
 *       equals/gte/lte comparator on its own.
 * Turns with no non-read action, or an expected-no-effect status, are
 * reported as `read-only-turn` — an absolute check matching baseline
 * there is correct, not a bug, and is never auto-fixed.
 *
 * Usage: `npx tsx eval/scripts/floor-sweep.ts [--scenarios <dir>] [--verbose]`
 * `--verbose` prints every check (not just flagged ones).
 */

import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { numericScalarOf, openReadOnly, scalarOf, type SqlDb } from '../db.js';
import { loadScenarios } from '../runner-tuples.js';
import type { Scenario, StateCheck } from '../types.js';
// Reads the catalog's declared `risk` per action slug — read-only import,
// same convention `eval/runner.ts` already uses for server internals.
// `registry.ts` is NOT one of the paths this task is forbidden to touch
// (that list is plan-schema.ts/planner.ts/pipeline.ts/scripts//docs/SPIKES.md)
// and this script only ever calls `.get()` on it.
import { registry } from '../../server/src/catalog/registry.js';

export interface SweepRow {
  scenarioId: string;
  turnIndex: number; // 1-based
  query: string;
  comparator: string;
  baseline: unknown;
  turnActions: readonly string[];
  hasNonReadAction: boolean;
  satisfiesBaseline: boolean;
  flag: 'VACUOUS' | 'ok' | 'read-only-turn';
}

function isNonReadAction(slug: string): boolean {
  const def = registry.get(slug);
  // Unknown slug (shouldn't happen for a lint-clean corpus): treat
  // conservatively as "might mutate" rather than silently skip it.
  return def === undefined || def.risk !== 'read';
}

/** `true` iff the turn's OWN `behavior.status` assertion says the
 * mutation is expected to actually land (`'done'`, or unasserted —
 * absence of a `status` assertion defaults to the common case of a
 * successful turn). `'failed'`/`'refused'`/`'cancelled'`/`'clarify'` all
 * mean the write is expected NOT to take effect, so a state check that
 * matches the untouched baseline there is the scenario working as
 * designed, not a vacuous floor. */
function expectsMutationToLand(turn: Scenario['turns'][number]): boolean {
  const status = turn.expect.behavior?.status;
  return status === undefined || status === 'done';
}

/** Mirrors `eval/assert.ts`'s own (unexported) `deepEqual` — scalar
 * strict-equality, falling back to a `JSON.stringify` compare for
 * objects/arrays. Reimplemented locally rather than importing a private
 * helper; `equals` checks aren't only numeric (e.g. `owner_id` string
 * columns), unlike `gte`/`lte`/`countDelta` which are always numeric. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Evaluates one `state` check's comparator against the row the query
 * returns on the pristine template. Returns `undefined` for a
 * `countDelta`-only check (filtered out by the caller before this is
 * reached) or a check with none of the four comparators (can't occur per
 * `stateCheckSchema`, but TypeScript can't see that from this fn alone). */
function evaluateComparator(
  check: StateCheck,
  row: Record<string, unknown> | undefined,
): { label: string; baseline: unknown; satisfies: boolean } | undefined {
  if (check.equals !== undefined) {
    const baseline = scalarOf(row);
    return { label: `equals ${JSON.stringify(check.equals)}`, baseline, satisfies: deepEqual(baseline, check.equals) };
  }
  if (check.gte !== undefined) {
    const baseline = numericScalarOf(row, check.query);
    return { label: `gte ${check.gte}`, baseline, satisfies: baseline >= check.gte };
  }
  if (check.lte !== undefined) {
    const baseline = numericScalarOf(row, check.query);
    return { label: `lte ${check.lte}`, baseline, satisfies: baseline <= check.lte };
  }
  return undefined;
}

export function sweepScenario(scenario: Scenario, db: SqlDb): SweepRow[] {
  const rows: SweepRow[] = [];
  scenario.turns.forEach((turn, i) => {
    const turnActions = turn.expect.planActions?.mustInclude ?? [];
    const hasNonReadAction = turnActions.some(isNonReadAction) && expectsMutationToLand(turn);
    for (const check of turn.expect.state ?? []) {
      if (check.countDelta !== undefined) continue; // already baseline-relative, can't be vacuous this way
      const evaluated = evaluateComparator(check, db.get(check.query));
      if (!evaluated) continue; // state check with neither equals/gte/lte/countDelta can't occur, but be defensive
      const flag: SweepRow['flag'] = !hasNonReadAction ? 'read-only-turn' : evaluated.satisfies ? 'VACUOUS' : 'ok';
      rows.push({
        scenarioId: scenario.id,
        turnIndex: i + 1,
        query: check.query,
        comparator: evaluated.label,
        baseline: evaluated.baseline,
        turnActions,
        hasNonReadAction,
        satisfiesBaseline: evaluated.satisfies,
        flag,
      });
    }
  });
  return rows;
}

export function sweepCorpus(scenarios: readonly Scenario[], db: SqlDb): SweepRow[] {
  return scenarios.flatMap((s) => sweepScenario(s, db));
}

// --- CLI --------------------------------------------------------------------

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx === -1 ? undefined : argv[idx + 1];
}

function printTable(rows: readonly SweepRow[]): void {
  const widths = { scenario: 34, turn: 4, flag: 16, baseline: 9, comparator: 14 };
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
  console.log(`${pad('scenario', widths.scenario)} ${pad('turn', widths.turn)} ${pad('flag', widths.flag)} ${pad('baseline', widths.baseline)} ${pad('comparator', widths.comparator)} query`);
  for (const r of rows) {
    console.log(
      `${pad(r.scenarioId, widths.scenario)} ${pad(String(r.turnIndex), widths.turn)} ${pad(r.flag, widths.flag)} ${pad(String(r.baseline), widths.baseline)} ${pad(r.comparator, widths.comparator)} ${r.query}`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose');
  const scenariosDir = flagValue(argv, '--scenarios') ?? new URL('../scenarios', import.meta.url).pathname;
  const repoRoot = join(fileURLToPath(new URL('../..', import.meta.url)));
  const templatePath = join(repoRoot, 'server/data/crm-standard.template.db');

  const tmpDir = mkdtempSync(join(tmpdir(), 'floor-sweep-'));
  const tmpDb = join(tmpDir, 'crm-pristine.db');
  copyFileSync(templatePath, tmpDb);

  const db = openReadOnly(tmpDb);
  try {
    const scenarios = loadScenarios(scenariosDir);
    const rows = sweepCorpus(scenarios, db);
    const vacuous = rows.filter((r) => r.flag === 'VACUOUS');
    const readOnly = rows.filter((r) => r.flag === 'read-only-turn');
    const ok = rows.filter((r) => r.flag === 'ok');

    printTable(verbose ? rows : vacuous);

    console.log('');
    console.log(
      `[floor-sweep] ${scenarios.length} scenario(s), ${rows.length} non-countDelta state check(s): ` +
        `${ok.length} ok, ${readOnly.length} read-only-turn (absolute check against baseline is correct), ${vacuous.length} VACUOUS.`,
    );
    if (vacuous.length > 0) {
      console.error(`[floor-sweep] ${vacuous.length} VACUOUS floor(s) — a mutating turn's state check is already satisfied by the untouched pristine baseline.`);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
