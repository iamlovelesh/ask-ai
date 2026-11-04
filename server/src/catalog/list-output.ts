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

export const SPILL_CAP = 50;
export const SPILL_SAMPLE_SIZE = 20;

export function listSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), total: z.number() });
}

export function spillSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ __spill: z.literal(true), total: z.number(), sample: z.array(item) });
}

/** Union output schema: inline list OR spill marker. */
export function listOutputSchema<T extends z.ZodTypeAny>(item: T) {
  return z.union([listSchema(item), spillSchema(item)]);
}

export type ListOrSpill<T> =
  | { items: T[]; total: number }
  | { __spill: true; total: number; sample: T[] };

/**
 * Build the list-or-spill value. `rows` should already be capped to
 * `cap` rows by the caller's query (e.g. `LIMIT 50`); when `total` exceeds
 * `cap`, only the first `sampleSize` of `rows` are kept as the `sample`.
 */
export function toListOrSpill<T>(
  rows: readonly T[],
  total: number,
  cap: number = SPILL_CAP,
  sampleSize: number = SPILL_SAMPLE_SIZE,
): ListOrSpill<T> {
  if (total <= cap) return { items: [...rows], total };
  return { __spill: true, total, sample: rows.slice(0, sampleSize) };
}
