#!/usr/bin/env tsx
/**
 * `npm run benchmark:report` (Task 16, LLD §9.2) — reads every
 * `results/*\/results.jsonl` the runner has written, computes the report
 * math (`eval/report-math.ts`), and renders `docs/BENCHMARK.md`: pass^1/
 * pass^3 per category, TTFUR+E2E p50/p95 split direct/complex per agent,
 * tokens+cost per request and per successful task, baseline deltas, and a
 * VERBATIM `docs/TARGETS.md` comparison table with a MET/MISSED column.
 *
 * The `TARGETS` constant below is a byte-for-byte mirror of the numbers
 * committed in `docs/TARGETS.md` §1/§2 — if that file's numbers ever
 * change, this constant must change with it (there is no markdown
 * parser here; keeping the targets as a typed constant is more robust
 * against incidental prose edits in TARGETS.md than scraping its tables).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type Agent,
  baselineDeltaPoints,
  byCategory,
  costStats,
  latencyBucket,
  pass1Rate,
  pass3Rate,
  repairRateComplex,
} from './report-math.js';
import type { ResultRow } from './runner-tuples.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

// --- docs/TARGETS.md §1/§2, mirrored (see header comment) -------------------

const TARGETS = {
  directTtfurP50Ms: 2000,
  directTtfurP95Ms: 4000,
  complexPlanReadyP50Ms: 4000,
  complexE2eP50Ms: 12_000,
  complexE2eP95Ms: 25_000,
  optimizedSuccessRateMin: 0.85,
  baselineDeltaPointsMin: 15,
  costPerSuccessfulTaskMaxUsd: 0.01,
  repairRateComplexAssumptionMax: 0.35,
} as const;

// --- loading results ----------------------------------------------------------

/** Reads every `results/<runid>/results.jsonl` under `resultsRoot`,
 * skipping unparseable trailing lines the same way `eval/runner-
 * tuples.ts`'s `completedTuplesFrom` does (an interrupted run can leave a
 * partial last line). */
export function loadAllResults(resultsRoot: string): ResultRow[] {
  if (!existsSync(resultsRoot)) return [];
  const rows: ResultRow[] = [];
  for (const runDir of readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!runDir.isDirectory()) continue;
    const path = join(resultsRoot, runDir.name, 'results.jsonl');
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        rows.push(JSON.parse(trimmed) as ResultRow);
      } catch {
        // Partial/corrupt trailing line — skip.
      }
    }
  }
  return rows;
}

// --- markdown rendering --------------------------------------------------------

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function fmtUsd(usd: number | undefined): string {
  return usd === undefined ? 'n/a' : `$${usd.toFixed(4)}`;
}

function renderPassTable(rows: readonly ResultRow[], agent: Agent): string {
  const byCat = byCategory(rows, (group) => ({ p1: pass1Rate(group, agent), p3: pass3Rate(group, agent) }));
  const categories = Object.keys(byCat).sort();
  if (categories.length === 0) return '_(no rows for this agent)_\n';

  const hasAnyPass3 = categories.some((c) => byCat[c]?.p3 !== undefined);
  const header = hasAnyPass3
    ? '| Category | pass^1 | pass^3 |\n|---|---|---|\n'
    : '| Category | pass^1 |\n|---|---|\n';
  const lines = categories.map((c) => {
    const { p1, p3 } = byCat[c] as { p1: ReturnType<typeof pass1Rate>; p3: ReturnType<typeof pass3Rate> };
    const p1Cell = `${fmtPct(p1.rate)} (${p1.passed}/${p1.total})`;
    if (!hasAnyPass3) return `| ${c} | ${p1Cell} |`;
    const p3Cell = p3 ? `${fmtPct(p3.rate)} (${p3.passed}/${p3.total})` : 'n/a (<3 trials)';
    return `| ${c} | ${p1Cell} | ${p3Cell} |`;
  });
  return header + lines.join('\n') + '\n';
}

function renderLatencyTable(rows: readonly ResultRow[], agent: Agent): string {
  const direct = latencyBucket(rows, agent, false);
  const complex = latencyBucket(rows, agent, true);
  return (
    '| Bucket | n | TTFUR p50 | TTFUR p95 | E2E p50 | E2E p95 |\n' +
    '|---|---|---|---|---|---|\n' +
    `| direct | ${direct.count} | ${fmtMs(direct.p50TtfurMs)} | ${fmtMs(direct.p95TtfurMs)} | ${fmtMs(direct.p50E2eMs)} | ${fmtMs(direct.p95E2eMs)} |\n` +
    `| complex | ${complex.count} | ${fmtMs(complex.p50TtfurMs)} | ${fmtMs(complex.p95TtfurMs)} | ${fmtMs(complex.p50E2eMs)} | ${fmtMs(complex.p95E2eMs)} |\n`
  );
}

function renderCostTable(rows: readonly ResultRow[], agent: Agent): string {
  const stats = costStats(rows, agent);
  return (
    '| Requests | avg tokens in | avg tokens out | avg cost/request | cost/successful task |\n' +
    '|---|---|---|---|---|\n' +
    `| ${stats.requests} | ${stats.avgTokensInPerRequest.toFixed(0)} | ${stats.avgTokensOutPerRequest.toFixed(0)} | ${fmtUsd(stats.avgCostPerRequestUsd)} | ${fmtUsd(stats.costPerSuccessfulTaskUsd)} |\n`
  );
}

function met(actual: boolean): string {
  return actual ? 'MET' : 'MISSED';
}

function renderTargetsTable(rows: readonly ResultRow[]): string {
  const directLat = latencyBucket(rows, 'optimized', false);
  const complexLat = latencyBucket(rows, 'optimized', true);
  const optSuccess = pass1Rate(rows, 'optimized');
  const deltaPts = baselineDeltaPoints(rows);
  const costStatsOpt = costStats(rows, 'optimized');
  const repair = repairRateComplex(rows, 'optimized');

  const costPerSuccessOk = costStatsOpt.costPerSuccessfulTaskUsd !== undefined && costStatsOpt.costPerSuccessfulTaskUsd < TARGETS.costPerSuccessfulTaskMaxUsd;

  const lines: string[] = [
    '| Metric | Target | Actual | Status |',
    '|---|---|---|---|',
    `| Direct TTFUR p50 | < ${TARGETS.directTtfurP50Ms}ms | ${fmtMs(directLat.p50TtfurMs)} | ${met(directLat.p50TtfurMs < TARGETS.directTtfurP50Ms)} |`,
    `| Direct TTFUR p95 | < ${TARGETS.directTtfurP95Ms}ms | ${fmtMs(directLat.p95TtfurMs)} | ${met(directLat.p95TtfurMs < TARGETS.directTtfurP95Ms)} |`,
    `| Complex plan.ready p50 | < ${TARGETS.complexPlanReadyP50Ms}ms | ${fmtMs(complexLat.p50TtfurMs)} | ${met(complexLat.p50TtfurMs < TARGETS.complexPlanReadyP50Ms)} |`,
    `| Complex E2E p50 | < ${TARGETS.complexE2eP50Ms}ms | ${fmtMs(complexLat.p50E2eMs)} | ${met(complexLat.p50E2eMs < TARGETS.complexE2eP50Ms)} |`,
    `| Complex E2E p95 | < ${TARGETS.complexE2eP95Ms}ms | ${fmtMs(complexLat.p95E2eMs)} | ${met(complexLat.p95E2eMs < TARGETS.complexE2eP95Ms)} |`,
    `| Optimized task success (pass^1) | >= ${fmtPct(TARGETS.optimizedSuccessRateMin)} | ${fmtPct(optSuccess.rate)} | ${met(optSuccess.rate >= TARGETS.optimizedSuccessRateMin)} |`,
    `| Optimized vs baseline delta | >= +${TARGETS.baselineDeltaPointsMin}pp | ${deltaPts >= 0 ? '+' : ''}${deltaPts.toFixed(1)}pp | ${met(deltaPts >= TARGETS.baselineDeltaPointsMin)} |`,
    `| Cost per successful task (optimized) | < ${fmtUsd(TARGETS.costPerSuccessfulTaskMaxUsd)} | ${fmtUsd(costStatsOpt.costPerSuccessfulTaskUsd)} | ${met(costPerSuccessOk)} |`,
    `| Repair-rate on complex turns (assumption, not a gate) | < ${fmtPct(TARGETS.repairRateComplexAssumptionMax)} | ${fmtPct(repair.rate)} | ${met(repair.rate < TARGETS.repairRateComplexAssumptionMax)} |`,
  ];
  return lines.join('\n') + '\n';
}

export function renderBenchmarkMarkdown(rows: readonly ResultRow[]): string {
  // MockLLM runs never write into results/*.jsonl via the real runner path
  // (eval/test/runner-e2e.test.ts writes to its own throwaway results dir) —
  // see docs/TARGETS.md §4's exclusion note.
  const generatedAt = new Date().toISOString();

  return [
    '# Ask AI — Benchmark Results',
    '',
    `_Generated ${generatedAt} by \`eval/report.ts\` from ${rows.length} recorded (scenario, trial, agent) row(s)._`,
    '',
    '## Pass rate — optimized agent',
    '',
    renderPassTable(rows, 'optimized'),
    '## Pass rate — baseline agent',
    '',
    renderPassTable(rows, 'baseline'),
    '## Latency — optimized agent (direct vs complex, LLD §9.2/docs/TARGETS.md §1 bucketing)',
    '',
    renderLatencyTable(rows, 'optimized'),
    '## Latency — baseline agent',
    '',
    renderLatencyTable(rows, 'baseline'),
    '## Tokens + cost — optimized agent',
    '',
    renderCostTable(rows, 'optimized'),
    '## Tokens + cost — baseline agent',
    '',
    renderCostTable(rows, 'baseline'),
    '## docs/TARGETS.md comparison',
    '',
    renderTargetsTable(rows),
    '',
    '_Targets were pre-committed in `docs/TARGETS.md` before any benchmark run — see that file for definitions and measurement conditions._',
    '',
  ].join('\n');
}

// --- CLI ------------------------------------------------------------------

export async function main(): Promise<void> {
  const resultsRoot = resolve(REPO_ROOT, 'results');
  const rows = loadAllResults(resultsRoot);
  const markdown = renderBenchmarkMarkdown(rows);
  const outPath = resolve(REPO_ROOT, 'docs/BENCHMARK.md');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown);
  console.log(`[eval] wrote ${outPath} from ${rows.length} row(s) across results/*/results.jsonl`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
