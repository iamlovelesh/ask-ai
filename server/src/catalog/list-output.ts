/**
 * List-output / SPILL convention (task-8 brief deviation (b); LLD §2.1/§9.3:
 * "list outputs cap at 50 rows inline — larger sets return a spill marker").
 *
 * Every module author returning a list-shaped result uses
 * `listOutputSchema(itemSchema)` for `outputSchema` and `toListOrSpill(rows,
 * total)` to build the value. `rows` MUST already be LIMIT-ed to `SPILL_CAP`
 * by the SQL query (or equivalent); `total` is the TRUE total match count
 * (a separate `COUNT(*)`, not `rows.length`).
 *
 * Shape is exact and normative for this task:
 *   - `total <= SPILL_CAP`  → `{ items: T[], total }`                (inline)
 *   - `total >  SPILL_CAP`  → `{ __spill: true, total, sample: T[] }` (spill)
 *
 * The executor (a later task) recognizes the `__spill` discriminator and
 * converts it into a `RefHandle` (LLD §2.5) instead of inlining a large
 * result set into planner context.
 */

import { z } from 'zod';
import type { StoreTx } from '../store/db.js';

export const SPILL_CAP = 50;
export const SPILL_SAMPLE_SIZE = 20;

/** Safety cap on a captured full idList (engine-wave E1 follow-up) —
 * `forEachHardCap` (`agent/validator.ts#BUDGETS.forEachHardCap`, 500) × 2.
 * NOT imported directly: `agent/validator.ts` depends (transitively, via
 * `catalog/registry.ts`) on every catalog module including this file, so an
 * import the other way would cycle. `test/list-output.test.ts` cross-checks
 * this literal against `BUDGETS.forEachHardCap * 2` so the two can't drift
 * silently. Beyond this many matching rows, `captureSpillIdList` abandons
 * the capture (returns `undefined`) rather than storing a half-enumerated
 * id set — the executor's existing TRUNCATED_INPUT fallback applies. */
export const SPILL_IDLIST_CAP = 1000;

export function listSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), total: z.number() });
}

export function spillSchema<T extends z.ZodTypeAny>(item: T) {
  // `idList`/`query` are OPTIONAL hydration channels (engine-wave E1): when a
  // handler can cheaply enumerate the COMPLETE matching id set (or a
  // re-runnable flat-equality `query` descriptor), it passes them so the
  // executor can later hydrate the FULL set for a bulk consumer (core op /
  // forEach), instead of silently operating on the 20-row `sample`. Absent,
  // the executor honestly fails a bulk consumer with TRUNCATED_INPUT rather
  // than computing on a page.
  return z.object({
    __spill: z.literal(true),
    total: z.number(),
    sample: z.array(item),
    idList: z.array(z.string()).optional(),
    query: z.record(z.string(), z.unknown()).optional(),
  });
}

/** Union output schema: inline list OR spill marker. */
export function listOutputSchema<T extends z.ZodTypeAny>(item: T) {
  return z.union([listSchema(item), spillSchema(item)]);
}

export type ListOrSpill<T> =
  | { items: T[]; total: number }
  | {
      __spill: true;
      total: number;
      sample: T[];
      // `| undefined` (not bare optional) to match zod's `.optional()`
      // inference under `exactOptionalPropertyTypes`.
      idList?: string[] | undefined;
      query?: Record<string, unknown> | undefined;
    };

/** Optional hydration channel for a spilled result (engine-wave E1). A
 * handler that can cheaply enumerate the COMPLETE matching id set passes
 * `idList`; one whose match set is a flat column-equality filter may instead
 * pass a `query` descriptor the `RefStore` can re-run. Either lets the
 * executor hydrate the FULL set for a bulk consumer instead of the 20-row
 * sample. Omitting both is always safe — the executor then fails a bulk
 * consumer honestly (TRUNCATED_INPUT) rather than computing on a page. */
export interface SpillHydration {
  idList?: string[];
  query?: Record<string, unknown>;
}

/** Everything needed to re-run a handler's OWN search WHERE clause as
 * `SELECT id FROM <table> WHERE <whereSql>` (same bind params, no LIMIT) to
 * capture the COMPLETE matching id set for a spilled result (engine-wave E1
 * follow-up). `table` may include a SQL alias the handler's clause expects
 * (e.g. `'conversations c'`). This is the SAME where-clause/params the
 * handler already built for its `COUNT(*)` + page query — not a second,
 * independently-derived query — so it is generic by construction: any
 * handler whose spilled set is exactly "rows matching one table's WHERE
 * clause" gets a correct full idList for free by passing this through
 * `toListOrSpill`'s `idCapture` option, with no per-handler special-casing.
 */
export interface SpillIdCaptureSpec {
  db: StoreTx;
  table: string;
  whereSql: string;
  params: readonly unknown[];
}

/** Capture the complete matching id set for `spec` (engine-wave E1
 * follow-up), bounded by `SPILL_IDLIST_CAP`. Fetches one row beyond the cap
 * and, if present, abandons the capture (`undefined`) rather than storing a
 * half-enumerated list — the caller then leaves `idList` unset and the
 * executor's existing TRUNCATED_INPUT fallback applies. */
export function captureSpillIdList(
  spec: SpillIdCaptureSpec,
  cap: number = SPILL_IDLIST_CAP,
): string[] | undefined {
  const rows = spec.db.all(`SELECT id FROM ${spec.table} WHERE ${spec.whereSql} LIMIT ?`, [
    ...spec.params,
    cap + 1,
  ]);
  if (rows.length > cap) return undefined;
  return rows.map((r) => String(r['id']));
}

export interface ToListOrSpillOptions {
  cap?: number;
  sampleSize?: number;
  /** Full-id-set capture spec (engine-wave E1 follow-up) — see
   * `SpillIdCaptureSpec`. Used by the ~generic case: a handler whose
   * spilled rows are exactly "one table, one WHERE clause". Ignored when
   * `hydration` is also given. */
  idCapture?: SpillIdCaptureSpec;
  /** Pre-computed hydration channel for handlers whose match set is NOT a
   * single-table WHERE clause (joins, multi-table unions, in-memory
   * derived/aggregated lists) — supply an already-known `idList` or
   * re-runnable `query` directly. See `SpillHydration`. */
  hydration?: SpillHydration;
}

/**
 * Build the list-or-spill value. `rows` should already be capped to
 * `cap` rows by the caller's query (e.g. `LIMIT 50`); when `total` exceeds
 * `cap`, only the first `sampleSize` of `rows` are kept as the `sample`.
 * `opts.idCapture`/`opts.hydration` (both optional, see `ToListOrSpillOptions`)
 * carry the full-set hydration channel — omitting both is always safe (the
 * executor then fails a bulk consumer honestly with TRUNCATED_INPUT rather
 * than computing on the sample page).
 */
export function toListOrSpill<T>(
  rows: readonly T[],
  total: number,
  opts: ToListOrSpillOptions = {},
): ListOrSpill<T> {
  const cap = opts.cap ?? SPILL_CAP;
  const sampleSize = opts.sampleSize ?? SPILL_SAMPLE_SIZE;
  if (total <= cap) return { items: [...rows], total };
  const spill: { __spill: true; total: number; sample: T[]; idList?: string[]; query?: Record<string, unknown> } = {
    __spill: true,
    total,
    sample: rows.slice(0, sampleSize),
  };
  const capturedIdList = opts.idCapture ? captureSpillIdList(opts.idCapture) : undefined;
  const hydration: SpillHydration | undefined =
    opts.hydration ?? (capturedIdList !== undefined ? { idList: capturedIdList } : undefined);
  if (hydration?.idList !== undefined) spill.idList = hydration.idList;
  if (hydration?.query !== undefined) spill.query = hydration.query;
  return spill;
}
