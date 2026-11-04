#!/usr/bin/env tsx
/**
 * eval/smoke.ts — the Tier A/B smoke harness (LLD §9.3 / task-8 brief).
 *
 * For every registered `ActionDef` (every module file wired into
 * `module-index.ts`, plus `coreOps`): synthesize a minimal valid input
 * (`catalog/testing.ts#synthesizeInput`), run the handler inside a real
 * CRM transaction, and assert EITHER a typed success (output passes
 * `outputSchema.safeParse`) OR an expected `ActionError`. Writes additionally
 * assert a state delta: at least one of the action's declared `entities`
 * tables changed row count or `MAX(updated_at)` — this is how a handler that
 * silently no-ops (accepts input, mutates nothing) gets caught.
 *
 * Tier-A filter-discrimination (`MODULE_DISCRIMINATION_CHECKS`, LLD §9.3):
 * for every `{action, paramsA, paramsB}` pair, call `action` twice and
 * assert the two `total`s differ — catches an accepted-but-silently-ignored
 * filter param, the #1 codegen bug per the LLD review finding.
 *
 * Runs against a SCRATCH COPY of the committed template DB (`resetCrm` into
 * a throwaway 'smoke' profile) — the committed
 * `server/data/crm-standard.template.db` is never opened for writing.
 *
 * Usage:
 *   npm run smoke                     # every registered action
 *   npm run smoke -- --module m01     # only M01's actions
 *   npm run smoke -- --modules m01-m05
 */

import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from '../server/src/catalog/registry.js';
import { MODULE_DISCRIMINATION_CHECKS } from '../server/src/catalog/module-index.js';
import { synthesizeInput } from '../server/src/catalog/testing.js';
import { ActionError } from '../server/src/catalog/types.js';
import type { ActionDef, ActionContext } from '../server/src/catalog/types.js';
import type { DiscriminationCheck } from '../server/src/catalog/discrimination.js';
import { getCrm, type Crm, type StoreTx } from '../server/src/store/db.js';
import { resetCrm } from '../server/src/store/reset.js';
import { VirtualClock } from '../server/src/store/clock.js';

const SMOKE_PROFILE = 'smoke';
const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(here, '../server/data/crm-standard.template.db');

// --- CLI args ---------------------------------------------------------------

interface ModuleRange {
  from: number;
  to: number;
}

function parseModuleToken(token: string): number {
  const match = /^m(\d{2})$/i.exec(token.trim());
  if (!match?.[1]) {
    throw new Error(`invalid module token '${token}' — expected e.g. 'm01'`);
  }
  return Number(match[1]);
}

function parseArgs(argv: readonly string[]): { moduleRange?: ModuleRange } {
  const moduleIdx = argv.indexOf('--module');
  if (moduleIdx !== -1) {
    const token = argv[moduleIdx + 1];
    if (!token) throw new Error('--module requires a value, e.g. --module m01');
    const n = parseModuleToken(token);
    return { moduleRange: { from: n, to: n } };
  }
  const rangeIdx = argv.indexOf('--modules');
  if (rangeIdx !== -1) {
    const token = argv[rangeIdx + 1];
    if (!token) throw new Error('--modules requires a value, e.g. --modules m01-m05');
    const [a, b] = token.split('-');
    if (!a || !b) throw new Error(`invalid --modules range '${token}' — expected e.g. 'm01-m05'`);
    return { moduleRange: { from: parseModuleToken(a), to: parseModuleToken(b) } };
  }
  return {};
}

function moduleNumOf(id: string): number | undefined {
  const match = /^M(\d{2})\./.exec(id);
  return match?.[1] ? Number(match[1]) : undefined;
}

// --- generic state-delta assertion -------------------------------------------

interface EntitySnapshot {
  table: string;
  rows: number;
  /** rows whose `updated_at` equals the handler's pinned clock value. */
  touchedAtNow: number;
}

function countRows(db: StoreTx, table: string): number {
  const row = db.get(`SELECT COUNT(*) AS n FROM ${table}`);
  return typeof row?.['n'] === 'number' ? (row['n'] as number) : 0;
}

// NOTE: MAX(updated_at) alone is NOT a reliable delta signal against the real
// 50k-row template — the seed data's own max updated_at can already exceed
// the pinned VirtualClock value, so a single-row update at `now` doesn't
// move the table max. Counting rows stamped at the EXACT pinned `now` is the
// robust generic signal: it increases by exactly 1 on a successful write and
// is vanishingly unlikely to coincide with pre-existing seed timestamps.
function countTouchedAtNow(db: StoreTx, table: string, now: number): number {
  const row = db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE updated_at = ?`, [now]);
  return typeof row?.['n'] === 'number' ? (row['n'] as number) : 0;
}

function snapshot(db: StoreTx, entities: readonly string[], now: number): EntitySnapshot[] {
  return entities.map((table) => ({
    table,
    rows: countRows(db, table),
    touchedAtNow: countTouchedAtNow(db, table, now),
  }));
}

function hasDelta(before: readonly EntitySnapshot[], after: readonly EntitySnapshot[]): boolean {
  return before.some((b, i) => {
    const a = after[i];
    return a !== undefined && (a.rows !== b.rows || a.touchedAtNow !== b.touchedAtNow);
  });
}

// --- per-action smoke check ---------------------------------------------------

type Status = 'PASS' | 'FAIL';

interface CheckResult {
  label: string;
  status: Status;
  detail?: string;
  ms: number;
}

function extractTotal(result: unknown): number | undefined {
  if (result && typeof result === 'object' && 'total' in result) {
    const total = (result as { total: unknown }).total;
    return typeof total === 'number' ? total : undefined;
  }
  return undefined;
}

async function smokeAction(def: ActionDef, crm: Crm, clock: VirtualClock): Promise<CheckResult> {
  const start = performance.now();
  const isWrite = def.risk !== 'read';
  try {
    if (isWrite && def.entities.length === 0) {
      return {
        label: def.slug,
        status: 'FAIL',
        detail: `risk='${def.risk}' action declares no entities — cannot assert a state delta`,
        ms: performance.now() - start,
      };
    }

    const input = crm.tx((db) => synthesizeInput(def, db));

    let before: EntitySnapshot[] = [];
    if (isWrite) {
      before = crm.tx((db) => snapshot(db, def.entities, clock.now()));
    }

    let output: unknown;
    let thrown: unknown;
    try {
      output = await crm.tx((db) => {
        const ctx: ActionContext = {
          db,
          clock,
          idempotencyKey: `smoke:${def.slug}:0`,
          format: 'concise',
        };
        return def.handler(input, ctx);
      });
    } catch (err) {
      thrown = err;
    }

    if (thrown !== undefined) {
      if (thrown instanceof ActionError) {
        return {
          label: def.slug,
          status: 'PASS',
          detail: `expected ActionError ${thrown.code}`,
          ms: performance.now() - start,
        };
      }
      throw thrown;
    }

    const parsed = def.outputSchema.safeParse(output);
    if (!parsed.success) {
      return {
        label: def.slug,
        status: 'FAIL',
        detail: `output failed outputSchema: ${parsed.error.message}`,
        ms: performance.now() - start,
      };
    }

    if (isWrite) {
      const after = crm.tx((db) => snapshot(db, def.entities, clock.now()));
      if (!hasDelta(before, after)) {
        return {
          label: def.slug,
          status: 'FAIL',
          detail: 'write produced no detectable state delta (row count / updated_at unchanged)',
          ms: performance.now() - start,
        };
      }
    }

    return { label: def.slug, status: 'PASS', ms: performance.now() - start };
  } catch (err) {
    return {
      label: def.slug,
      status: 'FAIL',
      detail: err instanceof Error ? err.message : String(err),
      ms: performance.now() - start,
    };
  }
}

// --- Tier-A discrimination check ----------------------------------------------

async function runDiscriminationCheck(check: DiscriminationCheck, crm: Crm): Promise<CheckResult> {
  const start = performance.now();
  const label = `${check.action} [discrimination]`;
  const def = registry.get(check.action);
  if (!def) {
    return { label, status: 'FAIL', detail: `action '${check.action}' not registered`, ms: performance.now() - start };
  }
  try {
    const [totalA, totalB] = await crm.tx(async (db) => {
      const ctxA: ActionContext = { db, clock: new VirtualClock(), idempotencyKey: `smoke:disc:${check.action}:A`, format: 'concise' };
      const resultA = await def.handler(check.paramsA, ctxA);
      const ctxB: ActionContext = { db, clock: new VirtualClock(), idempotencyKey: `smoke:disc:${check.action}:B`, format: 'concise' };
      const resultB = await def.handler(check.paramsB, ctxB);
      return [extractTotal(resultA), extractTotal(resultB)];
    });
    if (totalA === undefined || totalB === undefined) {
      return {
        label,
        status: 'FAIL',
        detail: 'target action output has no numeric `total` field',
        ms: performance.now() - start,
      };
    }
    if (totalA === totalB) {
      return {
        label,
        status: 'FAIL',
        detail: `paramsA→total=${totalA} paramsB→total=${totalB} (expected different counts — filter may be ignored)`,
        ms: performance.now() - start,
      };
    }
    return { label, status: 'PASS', detail: `${totalA} vs ${totalB}`, ms: performance.now() - start };
  } catch (err) {
    return { label, status: 'FAIL', detail: err instanceof Error ? err.message : String(err), ms: performance.now() - start };
  }
}

// --- reporting -----------------------------------------------------------------

function printSummary(results: readonly CheckResult[]): void {
  const idWidth = Math.max(...results.map((r) => r.label.length), 20);
  console.log('');
  console.log('action'.padEnd(idWidth) + '  status  ms      detail');
  console.log('-'.repeat(idWidth + 60));
  for (const r of results) {
    const ms = r.ms.toFixed(1).padStart(6);
    console.log(`${r.label.padEnd(idWidth)}  ${r.status.padEnd(6)}  ${ms}  ${r.detail ?? ''}`);
  }
  console.log('-'.repeat(idWidth + 60));
  const passed = results.filter((r) => r.status === 'PASS').length;
  console.log(`${passed}/${results.length} passed`);
  console.log('');
}

// --- main ------------------------------------------------------------------------

async function main(): Promise<void> {
  const { moduleRange } = parseArgs(process.argv.slice(2));

  await resetCrm(SMOKE_PROFILE, TEMPLATE_PATH);
  const crm = getCrm(SMOKE_PROFILE);
  // Each action gets a DISTINCT pinned "now" (base + index). The state-delta
  // check below detects a write by counting rows stamped at the exact write
  // timestamp — if every action shared one `now`, a later write touching a
  // row an earlier action already stamped at that same `now` would produce
  // no detectable delta even though it genuinely mutated the row.
  const baseNow = new VirtualClock().now();

  let actions = registry.all();
  if (moduleRange) {
    actions = actions.filter((def) => {
      const n = moduleNumOf(def.id);
      return n !== undefined && n >= moduleRange.from && n <= moduleRange.to;
    });
  }
  actions = [...actions].sort((a, b) => a.id.localeCompare(b.id));

  if (actions.length === 0) {
    console.error('No actions matched the given module filter.');
    process.exit(1);
  }

  const results: CheckResult[] = [];
  for (let i = 0; i < actions.length; i++) {
    const def = actions[i];
    if (!def) continue;
    const actionClock = new VirtualClock(baseNow + i + 1);
    results.push(await smokeAction(def, crm, actionClock));
  }

  let discChecks = MODULE_DISCRIMINATION_CHECKS;
  if (moduleRange) {
    discChecks = discChecks.filter((check) => {
      const def = registry.get(check.action);
      const n = def ? moduleNumOf(def.id) : undefined;
      return n !== undefined && n >= moduleRange.from && n <= moduleRange.to;
    });
  }
  for (const check of discChecks) {
    results.push(await runDiscriminationCheck(check, crm));
  }

  printSummary(results);
  crm.close();

  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.error(`smoke FAILED: ${failed.length} of ${results.length} checks failed.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke harness crashed:', err);
  process.exit(1);
});
