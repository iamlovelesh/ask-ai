/**
 * Shared display-number generation for M27 Quotes (`Q-{n}`), M28 Invoices
 * (`INV-{n}`), and M32 Orders (`O-{n}`) — the `number` column each of those
 * tables carries (entities/model.ts), distinct from the row's own `id`.
 * Mirrors `next-id.ts#nextId`'s "derive from current MAX, correct under the
 * single-writer-per-transaction invariant" approach, but scans the
 * `number` column (format `{prefix}-{n}`, per `entities/seed-commerce.ts`'s
 * own `Q-1000`/`INV-2000`/`O-3000` seeding) instead of `id`.
 */
import type { StoreTx } from '../store/db.js';

/**
 * Generate the next `{prefix}-{n}` display number for `table`'s `number`
 * column. `prefix` must match the table's existing convention exactly
 * (`'Q'`, `'INV'`, `'O'`) so the regex split lands correctly.
 */
export function nextDocNumber(tx: StoreTx, table: string, prefix: string): string {
  const rows = tx.all(`SELECT number FROM ${table} WHERE number LIKE ?`, [`${prefix}-%`]);
  let maxN = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const row of rows) {
    const match = re.exec(String(row['number'] ?? ''));
    if (match) {
      const n = Number(match[1]);
      if (n > maxN) maxN = n;
    }
  }
  return `${prefix}-${maxN + 1}`;
}
