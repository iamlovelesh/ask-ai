/**
 * Minimal read-only sqlite accessor for `eval/assert.ts`'s `state` checks
 * (LLD §9.1/§9.2). Deliberately NOT `server/src/store/db.ts`'s `Crm` —
 * that module owns a WRITE transaction + DDL-apply lifecycle tied to the
 * live server process; the runner is a SEPARATE process reading the SAME
 * on-disk sqlite file (WAL mode tolerates multiple readers across
 * processes) purely to evaluate `state` assertions. A single `get()` per
 * query is all `assert.ts` needs.
 *
 * Safe across `/admin/reset`: `resetCrm` (server/src/store/reset.ts)
 * replaces the CRM file's CONTENT in place (`copyFileSync` onto the
 * existing path, not unlink+recreate), and every `.get()` here is its own
 * fresh auto-commit read — sqlite re-checks the on-disk WAL/db header at
 * the start of each implicit transaction, so a long-lived `SqlDb` handle
 * sees post-reset data on its next query without needing to be reopened.
 */

import { DatabaseSync } from 'node:sqlite';

export interface SqlDb {
  /** Runs `sql` and returns its single row (or `undefined` if no rows
   * matched) — every `state` check's `query` is expected to be a `SELECT`
   * returning exactly one row. */
  get(sql: string, params?: readonly unknown[]): Record<string, unknown> | undefined;
  close(): void;
}

class ReadOnlySqlDb implements SqlDb {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    // No options object: `server/src/store/db.ts` opens the same way, and
    // this accessor never issues a write statement — it only ever calls
    // `.get()` against `SELECT` queries, so "read-only" is a usage
    // discipline here, not an sqlite-enforced open mode.
    this.db = new DatabaseSync(filePath);
  }

  get(sql: string, params: readonly unknown[] = []): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params as never[])) as Record<string, unknown> | undefined;
  }

  close(): void {
    this.db.close();
  }
}

export function openReadOnly(filePath: string): SqlDb {
  return new ReadOnlySqlDb(filePath);
}

/** Pulls the single scalar value out of a one-row/one-column result row —
 * the shape every `state` check's `query` is expected to produce (e.g.
 * `SELECT COUNT(*) AS n FROM leads WHERE ...`). Returns `undefined` for a
 * missing row (no rows matched); the column NAME is never assumed. */
export function scalarOf(row: Record<string, unknown> | undefined): unknown {
  if (row === undefined) return undefined;
  const values = Object.values(row);
  return values.length > 0 ? values[0] : undefined;
}

/** `scalarOf`, coerced to a finite number (for `countDelta`/`gte`/`lte`) —
 * throws a descriptive error rather than silently comparing against `NaN`,
 * which would make every `gte`/`lte`/`countDelta` check vacuously pass or
 * fail in a confusing way. */
export function numericScalarOf(row: Record<string, unknown> | undefined, query: string): number {
  const value = scalarOf(row);
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`state check query did not return a numeric scalar: '${query}' -> ${JSON.stringify(value)}`);
  }
  return n;
}
