#!/usr/bin/env tsx
/**
 * scripts/probe.ts — the retrieval recall gate (LLD §4 / Task 10).
 *
 * Loads `eval/probes/retrieval.yaml` (60 queries: ≥20 paraphrase, ≥12 typo,
 * rest direct — each `{q, category, expect: [acceptable slugs]}`), runs
 * `retrieve()` per probe with an empty session, and checks whether ANY
 * expected slug landed in the top-20 cards. Reports recall@20 overall and
 * per-category, and exits non-zero if overall recall < 0.95.
 *
 * Usage: `npm run probe` (wired in package.json → `tsx scripts/probe.ts`).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { retrieve } from '../server/src/agent/retrieval.js';

export const RECALL_GATE = 0.95;

const here = dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = resolve(here, '../eval/probes/retrieval.yaml');

export type Category = 'direct' | 'paraphrase' | 'typo';

export interface Probe {
  q: string;
  category: Category;
  expect: string[];
}

export interface ProbeResult {
  probe: Probe;
  hit: boolean;
  rank: number; // -1 if not found in top 20
  ms: number;
}

/** Exported (not just used by `main`) so `server/test/probe-runner.test.ts`
 * can smoke-test the runner's parsing/scoring logic against a small fixture
 * without re-running the full 60-query catalog probe (that's `npm run
 * probe`'s job, invoked separately — see this task's report). */
export function loadProbes(path: string): Probe[] {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a YAML list of probes at the top level.`);
  }
  return parsed.map((entry, i) => {
    const rec = entry as Record<string, unknown>;
    if (typeof rec['q'] !== 'string' || rec['q'].length === 0) {
      throw new Error(`${path}[${i}]: missing/invalid 'q'.`);
    }
    if (rec['category'] !== 'direct' && rec['category'] !== 'paraphrase' && rec['category'] !== 'typo') {
      throw new Error(`${path}[${i}]: 'category' must be one of direct|paraphrase|typo.`);
    }
    if (!Array.isArray(rec['expect']) || rec['expect'].length === 0 || !rec['expect'].every((s) => typeof s === 'string')) {
      throw new Error(`${path}[${i}]: 'expect' must be a non-empty string array.`);
    }
    return { q: rec['q'], category: rec['category'], expect: rec['expect'] as string[] };
  });
}

export function runProbe(probe: Probe): ProbeResult {
  const { cards, ms } = retrieve(probe.q, { usedActionSlugs: [], activeModules: [] });
  const slugs = cards.map((c) => c.slug);
  let rank = -1;
  for (const expected of probe.expect) {
    const idx = slugs.indexOf(expected);
    if (idx !== -1 && (rank === -1 || idx < rank)) rank = idx;
  }
  return { probe, hit: rank !== -1, ms };
}

export function recallOf(results: readonly ProbeResult[]): number {
  if (results.length === 0) return 1;
  return results.filter((r) => r.hit).length / results.length;
}

function moduleCoverage(probes: readonly Probe[]): Set<string> {
  const modules = new Set<string>();
  for (const p of probes) {
    for (const slug of p.expect) {
      const dot = slug.indexOf('.');
      if (dot > 0) modules.add(slug.slice(0, dot));
    }
  }
  return modules;
}

function main(): void {
  const probes = loadProbes(PROBES_PATH);

  const byCategory = { direct: 0, paraphrase: 0, typo: 0 } as Record<Category, number>;
  for (const p of probes) byCategory[p.category]++;

  const results = probes.map(runProbe);

  console.log(`Loaded ${probes.length} probes (direct=${byCategory.direct}, paraphrase=${byCategory.paraphrase}, typo=${byCategory.typo}), covering ${moduleCoverage(probes).size} modules.\n`);

  console.log('| category   | n  | hits | recall@20 |');
  console.log('|------------|----|------|-----------|');
  for (const category of ['direct', 'paraphrase', 'typo'] as Category[]) {
    const subset = results.filter((r) => r.probe.category === category);
    const hits = subset.filter((r) => r.hit).length;
    console.log(`| ${category.padEnd(10)} | ${String(subset.length).padEnd(2)} | ${String(hits).padEnd(4)} | ${recallOf(subset).toFixed(3)}     |`);
  }
  const overall = recallOf(results);
  console.log(`| ${'OVERALL'.padEnd(10)} | ${String(results.length).padEnd(2)} | ${String(results.filter((r) => r.hit).length).padEnd(4)} | ${overall.toFixed(3)}     |`);

  const misses = results.filter((r) => !r.hit);
  if (misses.length > 0) {
    console.log('\nMisses:');
    for (const m of misses) {
      console.log(`  [${m.probe.category}] "${m.probe.q}" — expected one of [${m.probe.expect.join(', ')}]`);
    }
  }

  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
  console.log(`\nTotal retrieve() time: ${totalMs.toFixed(1)}ms across ${results.length} queries.`);

  if (overall < RECALL_GATE) {
    console.error(`\nprobe FAILED: recall@20 ${overall.toFixed(3)} < gate ${RECALL_GATE}.`);
    process.exit(1);
  }
  console.log(`\nprobe PASSED: recall@20 ${overall.toFixed(3)} >= gate ${RECALL_GATE}.`);
  process.exit(0);
}

// Only run when invoked directly (`tsx scripts/probe.ts` / `npm run probe`)
// — NOT when imported (e.g. by `server/test/probe-runner.test.ts`), so a
// test importing this module for its pure functions never also triggers a
// real file read + `process.exit`.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
