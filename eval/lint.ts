#!/usr/bin/env tsx
/**
 * Coverage linter (Task 16, LLD §9.1/§9.3) — checks the scenario corpus
 * under `eval/scenarios/` against the coverage gate Task 17's full corpus
 * must eventually satisfy:
 *   - every catalog MODULE touched by ≥2 scenarios (an action slug's
 *     module prefix, e.g. `leads.search_leads` → module `leads`)
 *   - every scenario CATEGORY (LLD §9.1's 8-way enum) has ≥2 scenarios
 *   - every scenario SUBTYPE that appears at all has ≥2 scenarios
 *   - no scenario embeds an ABSOLUTE DATE outside the pinned
 *     `VIRTUAL_NOW` convention (LLD §3.2: "hardcoded in scenarios — never
 *     'today'" — this check flags YYYY-MM-DD-shaped literals in a
 *     scenario's `user` text or `paramChecks`/`state` values that are NOT
 *     `2026-11-04` or `2026-11-05`, the two dates already in play for the
 *     pinned clock and "yesterday" offsets most scenarios will want)
 *   - every turn declares at least one REAL assertion (I3, Task 16
 *     review) — belt-and-suspenders alongside `eval/types.ts`'s own
 *     schema `.refine()`, for any scenario value that reached this
 *     linter without going through `parseScenario`
 *
 * This task (16) ships 6 SEED scenarios purely to validate the machinery
 * — they do NOT and are not expected to pass this gate (6 scenarios can't
 * cover 50 modules ×2). Task 17's corpus is what this linter actually
 * gates; `--allow-partial` suppresses the module/category/subtype
 * coverage checks (keeping only the date-hygiene check) for exactly that
 * reason, and `npm run eval:lint` (wired for Task 17) runs it WITHOUT that
 * flag once the full corpus lands.
 */

import { pathToFileURL } from 'node:url';
import { loadScenarios } from './runner-tuples.js';
import { actionSlugsTouchedBy, hasRealAssertion, type Scenario } from './types.js';

export interface LintIssue {
  kind: 'module-coverage' | 'category-coverage' | 'subtype-coverage' | 'absolute-date' | 'empty-expect';
  detail: string;
}

export interface LintOptions {
  /** When `true`, skip the module/category/subtype ≥2 checks — only the
   * date-hygiene check runs. Used while the corpus is still small
   * (Task 16's 6 seed scenarios; Task 17 removes this). */
  allowPartialCoverage?: boolean;
  minPerModule?: number;
  minPerCategory?: number;
  minPerSubtype?: number;
}

const DEFAULTS: Required<Omit<LintOptions, 'allowPartialCoverage'>> = {
  minPerModule: 2,
  minPerCategory: 2,
  minPerSubtype: 2,
};

function moduleOf(slug: string): string {
  const dot = slug.indexOf('.');
  return dot >= 0 ? slug.slice(0, dot) : slug;
}

// --- module coverage -----------------------------------------------------

function checkModuleCoverage(scenarios: readonly Scenario[], min: number): LintIssue[] {
  const countByModule = new Map<string, number>();
  for (const scenario of scenarios) {
    const modules = new Set(actionSlugsTouchedBy(scenario).map(moduleOf));
    for (const m of modules) countByModule.set(m, (countByModule.get(m) ?? 0) + 1);
  }
  const issues: LintIssue[] = [];
  for (const [module, count] of countByModule) {
    if (count < min) {
      issues.push({ kind: 'module-coverage', detail: `module '${module}' touched by only ${count} scenario(s) (need >= ${min})` });
    }
  }
  return issues;
}

// --- category / subtype coverage --------------------------------------------

function checkEnumCoverage(
  scenarios: readonly Scenario[],
  keyOf: (s: Scenario) => string | undefined,
  min: number,
  kind: LintIssue['kind'],
  label: string,
): LintIssue[] {
  const counts = new Map<string, number>();
  for (const s of scenarios) {
    const key = keyOf(s);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const issues: LintIssue[] = [];
  for (const [key, count] of counts) {
    if (count < min) issues.push({ kind, detail: `${label} '${key}' has only ${count} scenario(s) (need >= ${min})` });
  }
  return issues;
}

// --- absolute-date hygiene --------------------------------------------------

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** The pinned virtual clock date, plus one day of slack for "yesterday"/
 * relative-window scenarios that hardcode a date one day earlier (LLD §3.2
 * `VIRTUAL_NOW` default). Any OTHER absolute date is almost certainly a
 * scenario author having typed a real wall-clock "today" by mistake. */
const ALLOWED_DATES = new Set(['2026-11-04', '2026-11-05']);

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

function checkAbsoluteDates(scenarios: readonly Scenario[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const scenario of scenarios) {
    const strings: string[] = [];
    collectStrings(scenario, strings);
    const found = new Set<string>();
    for (const s of strings) {
      for (const match of s.matchAll(DATE_RE)) {
        const date = match[0];
        if (!ALLOWED_DATES.has(date)) found.add(date);
      }
    }
    if (found.size > 0) {
      issues.push({
        kind: 'absolute-date',
        detail: `scenario '${scenario.id}' embeds non-pinned absolute date(s) [${[...found].join(', ')}] — use a relative/VIRTUAL_NOW-derived date instead`,
      });
    }
  }
  return issues;
}

// --- empty-expect (I3, Task 16 review — defense in depth alongside the
// schema's own `.refine()`: a scenario loaded from a source that bypassed
// `parseScenario` — e.g. hand-built in a test fixture — would otherwise
// slip an all-empty `expect` past this linter undetected) -----------------

function checkEmptyExpect(scenarios: readonly Scenario[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const scenario of scenarios) {
    scenario.turns.forEach((turn, i) => {
      if (!hasRealAssertion(turn.expect)) {
        issues.push({
          kind: 'empty-expect',
          detail: `scenario '${scenario.id}' turn #${i + 1} declares no real assertion — every turn must assert at least one of planActions/paramChecks/state/response/behavior`,
        });
      }
    });
  }
  return issues;
}

// --- public entry point -----------------------------------------------------

export function lintScenarios(scenarios: readonly Scenario[], opts: LintOptions = {}): LintIssue[] {
  const minPerModule = opts.minPerModule ?? DEFAULTS.minPerModule;
  const minPerCategory = opts.minPerCategory ?? DEFAULTS.minPerCategory;
  const minPerSubtype = opts.minPerSubtype ?? DEFAULTS.minPerSubtype;

  const issues: LintIssue[] = [...checkAbsoluteDates(scenarios), ...checkEmptyExpect(scenarios)];
  if (!opts.allowPartialCoverage) {
    issues.push(
      ...checkModuleCoverage(scenarios, minPerModule),
      ...checkEnumCoverage(scenarios, (s) => s.category, minPerCategory, 'category-coverage', 'category'),
      ...checkEnumCoverage(scenarios, (s) => s.subtype, minPerSubtype, 'subtype-coverage', 'subtype'),
    );
  }
  return issues;
}

// --- CLI ------------------------------------------------------------------

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx === -1 ? undefined : argv[idx + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const allowPartialCoverage = argv.includes('--allow-partial');
  const dir = flagValue(argv, '--scenarios') ?? new URL('scenarios', import.meta.url).pathname;

  const scenarios = loadScenarios(dir);
  const issues = lintScenarios(scenarios, { allowPartialCoverage });

  if (issues.length === 0) {
    console.log(`[eval:lint] ${scenarios.length} scenario(s), 0 issues.`);
    return;
  }
  console.error(`[eval:lint] ${scenarios.length} scenario(s), ${issues.length} issue(s):`);
  for (const issue of issues) console.error(`  - [${issue.kind}] ${issue.detail}`);
  process.exit(1);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
