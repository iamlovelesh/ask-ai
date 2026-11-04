/**
 * Shared runtime id generation (task-8 fix round 1 — reviewer IMPORTANT
 * finding: don't let every module re-derive its own `SUBSTR(id, N)` magic
 * number).
 *
 * Runtime handlers (unlike the seed generators, which have a shared
 * `nextId(ctx, prefix)` counter over `SeedCtx`) have no shared counter, so
 * `nextId` derives the next `{prefix}_{n}` number from the current max
 * in-table — correct under the single-writer-per-transaction invariant
 * (`crm.tx`): two concurrent callers can't race because handlers never run
 * outside a transaction, and `StoreTx` only ever has one live write
 * transaction at a time per the store's design.
 */
import type { StoreTx } from '../store/db.js';

/**
 * Generate the next `{prefix}_{n}` id for `table`, where `table`'s ids
 * follow the `{prefix}_{n}` convention (entities/model.ts). `prefix` must
 * be the table's EXACT id prefix (e.g. `'con'` for `contacts`, `'task'`
 * for `tasks`) — the `SUBSTR` offset is derived from its length, so every
 * caller gets the right split with no hardcoded column-position magic
 * number.
 */
export function nextId(tx: StoreTx, table: string, prefix: string): string {
  // "{prefix}_" is `prefix.length + 1` chars; SUBSTR is 1-indexed, so the
  // numeric suffix starts one position after that.
  const offset = prefix.length + 2;
  const row = tx.get(
    `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) AS max_n FROM ${table} WHERE id LIKE ?`,
    [offset, `${prefix}_%`],
  );
  const maxN = row && typeof row['max_n'] === 'number' ? (row['max_n'] as number) : 0;
  return `${prefix}_${maxN + 1}`;
}
