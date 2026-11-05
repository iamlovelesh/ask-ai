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

/**
 * Build the list-or-spill value. `rows` should already be capped to
 * `cap` rows by the caller's query (e.g. `LIMIT 50`); when `total` exceeds
 * `cap`, only the first `sampleSize` of `rows` are kept as the `sample`.
 * `hydration` (optional) carries the full-set hydration channel — see
 * `SpillHydration`.
 */
export function toListOrSpill<T>(
  rows: readonly T[],
  total: number,
  cap: number = SPILL_CAP,
  sampleSize: number = SPILL_SAMPLE_SIZE,
  hydration?: SpillHydration,
): ListOrSpill<T> {
  if (total <= cap) return { items: [...rows], total };
  const spill: { __spill: true; total: number; sample: T[]; idList?: string[]; query?: Record<string, unknown> } = {
    __spill: true,
    total,
    sample: rows.slice(0, sampleSize),
  };
  if (hydration?.idList !== undefined) spill.idList = hydration.idList;
  if (hydration?.query !== undefined) spill.query = hydration.query;
  return spill;
}
