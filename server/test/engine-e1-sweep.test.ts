/**
 * Engine-wave E1 follow-up — catalog-wide SWEEP (the genericity proof).
 *
 * `engine-e1-followup.test.ts` proves the fix on one representative module
 * (`leads.search_leads`). This file proves it's actually GENERIC: every
 * registered action whose output can spill (`list-output.ts`'s
 * `listOutputSchema` union) is invoked with the BROADEST valid input (every
 * eligible action here has an input schema where every filtering field is
 * optional, so `{}` is a legitimate — and the most-matching — call), against
 * a profile DB copied from the committed template (`resetCrm`, never the
 * template itself) with small tables topped up so every table/kind this
 * sweep touches comfortably exceeds the 50-row spill threshold.
 *
 * For every spill observed:
 *   - `total <= SPILL_IDLIST_CAP` (1000)  → `idList` MUST be populated and
 *     `idList.length === total` (the follow-up's whole point: the executor
 *     can hydrate ALL N, not just the 20-row sample).
 *   - `total >  SPILL_IDLIST_CAP`         → `idList` MUST be absent — the
 *     documented safety cap staying an honest TRUNCATED_INPUT rather than a
 *     half-enumerated id set.
 *
 * EXCLUDED_ACTIONS (below) are the brief-sanctioned "handful of bespoke"
 * cases — joins/aggregates/in-memory-derived lists, or lists scoped by an
 * extra per-call parameter (a specific parent id/category) that a
 * table-wide floor-boost can't target. Each has a one-line reason. They are
 * NOT wired to `idCapture` in production (see `task-hydration-report.md`)
 * and so are excluded from the behavioral assertion here too — this list
 * IS the accounting of what's covered vs. not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { registry } from '../src/catalog/registry';
import { SPILL_IDLIST_CAP } from '../src/catalog/list-output';
import type { ActionContext, ActionDef } from '../src/catalog/types';
import { openCrm, closeRegistered, crmDbPath, type Crm, type Row, type StoreTx } from '../src/store/db';
import { resetCrm } from '../src/store/reset';
import { VirtualClock } from '../src/store/clock';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE = 'test-e1-sweep';
const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(here, '../data/crm-standard.template.db');

function cleanupProfileFiles(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

/** Bespoke / parent-scoped exceptions (brief-sanctioned, documented) — see
 * the file header and `task-hydration-report.md`. */
const EXCLUDED_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['contacts.view_contact_activity_timeline', '3-table union (notes/tasks/messages), heterogeneous ids'],
  ['notes.view_note_revision_history', 'synthetic version entries sharing one note id; never spills'],
  ['tags.list_records_with_tag', '2-table union (contacts/companies), heterogeneous ids'],
  ['message_templates.search_templates', 'JS `channel` filter after the SQL fetch — whereSql under-covers the true match set'],
  ['workflows.get_workflow_execution_history', 'per-record JSON execution log, not a queryable table of ids'],
  ['event_triggers.list_event_triggers', 'JS `event_type` filter after the SQL fetch — whereSql under-covers the true match set'],
  ['event_triggers.get_trigger_firing_history', 'per-record JSON firing log, not a queryable table of ids'],
  ['availability.find_available_slots', 'computed availability slots, not DB rows'],
  ['prices.list_product_prices', 'price entries live inside the product JSON config, not a table'],
  ['media_assets.search_media_assets', 'JS `folder` filter over an acknowledged non-generic 200-row pool bound'],
  ['media_assets.list_asset_references', 'computed scan of other modules\' JSON configs'],
  ['lessons.search_lessons', 'lessons live inside the course JSON config, not a table'],
  ['users.view_user_audit_activity', '3-table union (tasks/notes/support_tickets), heterogeneous ids'],
  ['teams.get_team_workload', 'in-memory per-user aggregate, not raw rows'],
  ['custom_fields.list_fields_for_module', 'scoped by kind AND a required per-call `module` (category) — a table-wide kind floor-boost cannot target one category'],
  ['forms.list_form_submissions', 'scoped by kind AND a required per-call parent form id — a table-wide kind floor-boost cannot target one parent'],
  ['companies.list_company_contacts', 'scoped by a required per-call company id — a table-wide floor-boost cannot target one company'],
  ['smart_lists.preview_matching_records', "scoped by one smart list's own (arbitrary, seed-authored) filter_rules — not reliably boostable generically"],
]);

function isListOrSpillAction(def: ActionDef): boolean {
  const schema = def.outputSchema as unknown;
  if (!(schema instanceof z.ZodUnion)) return false;
  const u = schema as unknown as { def?: { options?: readonly unknown[] }; options?: readonly unknown[] };
  const options = u.def?.options ?? u.options;
  if (!Array.isArray(options)) return false;
  return options.some((opt) => {
    if (!(opt instanceof z.ZodObject)) return false;
    const shape = (opt as unknown as { shape: Record<string, unknown> }).shape;
    return shape['__spill'] !== undefined;
  });
}

function ctx(db: StoreTx): ActionContext {
  return { db, clock: new VirtualClock(), idempotencyKey: `sweep:${Math.random()}`, format: 'concise' };
}

/** Generic row clone: copy every column from `source` into a new row in
 * `table`, overwriting only `id`. No table-specific knowledge — works for
 * any table because the schema has no UNIQUE constraint beyond the primary
 * key (`entities/model.ts`). */
function cloneRow(db: StoreTx, table: string, source: Row, newId: string): void {
  const cols = Object.keys(source);
  const vals = cols.map((c) => (c === 'id' ? newId : source[c]));
  const placeholders = cols.map(() => '?').join(',');
  db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, vals as unknown[]);
}

/** Ensure `table` (no discriminator column) has at least `floor` non-archived
 * rows, by cloning an existing row as many times as needed. */
function ensureFloorPlain(db: StoreTx, table: string, floor: number): void {
  const countRow = db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE archived = 0`);
  let n = (countRow?.['n'] as number) ?? 0;
  if (n >= floor) return;
  const sample = db.get(`SELECT * FROM ${table} WHERE archived = 0 LIMIT 1`);
  if (!sample) return;
  for (let i = 0; n < floor; i++, n++) {
    cloneRow(db, table, sample, `${String(sample['id'])}_sweep${i}`);
  }
}

/** Ensure EVERY distinct value of `discCol` already present in `table` has
 * at least `floor` non-archived rows. Fully generic: it boosts whatever
 * kinds exist, it never names one — the per-handler `kind` constant stays
 * production code's business, not the test's. */
function ensureFloorPerDiscriminator(db: StoreTx, table: string, discCol: string, floor: number): void {
  const kinds = db.all(`SELECT DISTINCT ${discCol} AS k FROM ${table}`);
  for (const row of kinds) {
    const kind = row['k'];
    if (kind === null || kind === undefined) continue;
    const countRow = db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${discCol} = ? AND archived = 0`, [kind]);
    let n = (countRow?.['n'] as number) ?? 0;
    if (n >= floor) continue;
    const sample = db.get(`SELECT * FROM ${table} WHERE ${discCol} = ? AND archived = 0 LIMIT 1`, [kind]);
    if (!sample) continue;
    for (let i = 0; n < floor; i++, n++) {
      cloneRow(db, table, sample, `${String(sample['id'])}_sweep${i}`);
    }
  }
}

let crm: Crm;
const FLOOR = 60;

beforeAll(async () => {
  cleanupProfileFiles();
  await resetCrm(PROFILE, TEMPLATE_PATH);
  crm = openCrm(PROFILE);
  crm.tx((db) => {
    for (const table of ['events', 'users', 'teams', 'courses']) ensureFloorPlain(db, table, FLOOR);
    for (const table of ['structures', 'content_items', 'participations']) {
      ensureFloorPerDiscriminator(db, table, 'kind', FLOOR);
    }
    return undefined;
  });
});

afterAll(() => {
  closeRegistered(PROFILE);
  cleanupProfileFiles();
});

describe('engine-e1 follow-up — catalog-wide idList-on-spill sweep', () => {
  const eligible = registry
    .all()
    .filter((def) => def.risk === 'read' && isListOrSpillAction(def) && !EXCLUDED_ACTIONS.has(def.slug));

  it('found a non-trivial set of eligible list/search actions to sweep', () => {
    expect(eligible.length).toBeGreaterThanOrEqual(30);
  });

  let spilledCount = 0;
  let hydratedCount = 0;
  let overCapCount = 0;

  for (const def of eligible) {
    it(`${def.slug} — spill (if any) carries a complete idList, honoring the ${SPILL_IDLIST_CAP}-id safety cap`, async () => {
      const output = await crm.tx((db) => def.handler({}, ctx(db)));
      const parsed = def.outputSchema.safeParse(output);
      expect(parsed.success, parsed.success ? undefined : JSON.stringify((parsed as { error?: unknown }).error)).toBe(true);

      if (!output || typeof output !== 'object' || !('__spill' in output)) return; // didn't spill — nothing to assert
      spilledCount += 1;
      const spill = output as { __spill: true; total: number; idList?: string[] };
      if (spill.total <= SPILL_IDLIST_CAP) {
        hydratedCount += 1;
        expect(spill.idList, `${def.slug}: expected a populated idList (total=${spill.total})`).toBeDefined();
        expect(spill.idList).toHaveLength(spill.total);
      } else {
        overCapCount += 1;
        expect(spill.idList, `${def.slug}: total ${spill.total} exceeds the safety cap — idList must stay unset`).toBeUndefined();
      }
    });
  }

  it('sweep coverage: a meaningful share of eligible actions actually spilled and were exercised', () => {
    // Guards against a vacuously-passing sweep (e.g. the floor-boost silently
    // no-op-ing) — most eligible actions, called with `{}`, should spill
    // against the boosted/already-large template data.
    expect(spilledCount).toBeGreaterThanOrEqual(25);
    expect(hydratedCount).toBeGreaterThanOrEqual(20);
    // eslint-disable-next-line no-console
    console.log(
      `[engine-e1-sweep] eligible=${eligible.length} spilled=${spilledCount} hydrated(<=cap)=${hydratedCount} overCap=${overCapCount}`,
    );
  });
});
