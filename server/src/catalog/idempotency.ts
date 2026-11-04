/**
 * Idempotent-write convention (task-8 brief deviation (a)). Every mutating
 * handler in every module wraps its body with `withIdempotentWrite` so a
 * retried/duplicate executor call carrying the SAME `ctx.idempotencyKey`
 * (`${turnId}:${planRev}:${stepId}:${itemIndex}`, LLD §2.1/§5.3) returns the
 * ORIGINAL result snapshot instead of re-applying the write (e.g. inserting
 * a second row on a retried `create_*` call).
 *
 * The `idempotency` table is catalog-owned infrastructure, not a CRM
 * business entity — it intentionally does NOT live in
 * `entities/model.ts#ENTITY_MODEL`. It is created lazily
 * (`CREATE TABLE IF NOT EXISTS`) on first use inside the caller's existing
 * transaction, so it works against the already-committed template DB with
 * zero migration step and is safe to call on every write (cheap no-op after
 * the first call).
 */

import type { StoreTx } from '../store/db.js';
import type { ActionContext } from './types.js';

const IDEMPOTENCY_DDL = `CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at INT NOT NULL
)`;

/** Idempotent (CREATE TABLE IF NOT EXISTS) — safe to call every time. */
export function ensureIdempotencyTable(db: StoreTx): void {
  db.run(IDEMPOTENCY_DDL);
}

/** Returns the stored result snapshot for `key`, or `undefined` on first use. */
export function getIdempotentResult<O>(db: StoreTx, key: string): O | undefined {
  ensureIdempotencyTable(db);
  const row = db.get('SELECT result FROM idempotency WHERE key = ?', [key]);
  if (!row) return undefined;
  return JSON.parse(row['result'] as string) as O;
}

/** Store a result snapshot for `key`. A second write for the same key is a no-op. */
export function storeIdempotentResult(db: StoreTx, key: string, result: unknown, now: number): void {
  ensureIdempotencyTable(db);
  db.run('INSERT OR IGNORE INTO idempotency (key, result, created_at) VALUES (?, ?, ?)', [
    key,
    JSON.stringify(result),
    now,
  ]);
}

/**
 * Wrap a write handler body so replays with the same `ctx.idempotencyKey`
 * short-circuit to the stored snapshot. Apply to every handler whose `risk`
 * is `'write' | 'destructive' | 'bulk' | 'external'` — this is the
 * Task-8 standard every module copies verbatim.
 *
 * Usage:
 * ```ts
 * handler: withIdempotentWrite(async (input, ctx) => { ...mutate... }),
 * ```
 */
export function withIdempotentWrite<I, O>(
  run: (input: I, ctx: ActionContext) => Promise<O>,
): (input: I, ctx: ActionContext) => Promise<O> {
  return async (input, ctx) => {
    const cached = getIdempotentResult<O>(ctx.db, ctx.idempotencyKey);
    if (cached !== undefined) return cached;
    const result = await run(input, ctx);
    storeIdempotentResult(ctx.db, ctx.idempotencyKey, result, ctx.clock.now());
    return result;
  };
}
