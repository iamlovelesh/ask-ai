/**
 * Shared `line_items` CRUD + MONEY-RULE total recompute for M27 Quotes, M28
 * Invoices, and M32 Orders — the three `parent_type` values the merged
 * `line_items` table carries (entities/model.ts: "M27/M28/M32 line items
 * (merged child)"). Factored here so the three modules don't each
 * re-implement the identical insert/patch/recompute shape (coding-style:
 * many small files, no duplication) — same category as
 * `conversation-utils.ts` (M11/M12/M13) and `calendar-availability.ts`
 * (M20/M22).
 *
 * MONEY RULE (binding, task-9-brief): a parent doc's `total_cents` is
 * ALWAYS fully recomputed from its live `line_items` rows — never
 * incrementally patched — so it can never drift out of sync with the
 * line items that actually exist. `recomputeParentTotal` is the ONLY
 * writer of `total_cents`; every line-item mutation (insert/update) calls
 * it immediately after. `entities/seed-commerce.ts`'s own seed generator
 * sums `amount_cents` only (not `+ tax_cents`) into each doc's
 * `total_cents` — this file matches that exact convention, so a freshly
 * recomputed total on a seeded doc with no further edits is unchanged.
 */
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { nextId } from './next-id.js';

export type LineItemParentType = 'quote' | 'invoice' | 'order';

export interface LineItemView {
  id: string;
  parent_type: LineItemParentType;
  parent_id: string;
  product_id: string | null;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  tax_cents: number;
  position: number;
  description: string | null;
}

export function toLineItemView(row: Row): LineItemView {
  return {
    id: row['id'] as string,
    parent_type: row['parent_type'] as LineItemParentType,
    parent_id: row['parent_id'] as string,
    product_id: (row['product_id'] as string | null) ?? null,
    quantity: row['quantity'] as number,
    unit_price_cents: row['unit_price_cents'] as number,
    amount_cents: row['amount_cents'] as number,
    tax_cents: row['tax_cents'] as number,
    position: row['position'] as number,
    description: (row['description'] as string | null) ?? null,
  };
}

export function listLineItems(tx: StoreTx, parentType: LineItemParentType, parentId: string): LineItemView[] {
  const rows = tx.all(
    `SELECT * FROM line_items WHERE parent_type = ? AND parent_id = ? AND archived = 0 ORDER BY position ASC`,
    [parentType, parentId],
  );
  return rows.map(toLineItemView);
}

/** Fetch a line item, validating it actually belongs to `(parentType, parentId)`. */
export function getOwnedLineItemRow(
  tx: StoreTx,
  parentType: LineItemParentType,
  parentId: string,
  lineItemId: string,
  parentNoun: string,
): Row {
  const row = tx.get(
    `SELECT * FROM line_items WHERE id = ? AND parent_type = ? AND parent_id = ? AND archived = 0`,
    [lineItemId, parentType, parentId],
  );
  if (!row) {
    throw new ActionError(
      'NOT_FOUND',
      `Line item '${lineItemId}' does not exist on ${parentNoun} '${parentId}'.`,
    );
  }
  return row;
}

/** Insert a new line item at the next `position` for `(parentType, parentId)`. */
export function insertLineItem(
  tx: StoreTx,
  parentType: LineItemParentType,
  parentId: string,
  input: { product_id: string; quantity: number; unit_price_cents: number; description?: string | null | undefined },
  now: number,
): string {
  const posRow = tx.get(
    `SELECT COALESCE(MAX(position), -1) AS max_pos FROM line_items WHERE parent_type = ? AND parent_id = ?`,
    [parentType, parentId],
  );
  const position = ((posRow?.['max_pos'] as number | null) ?? -1) + 1;
  const id = nextId(tx, 'line_items', 'li');
  const amountCents = input.unit_price_cents * input.quantity;
  tx.run(
    `INSERT INTO line_items (id, created_at, updated_at, archived, parent_type, parent_id, product_id,
      quantity, unit_price_cents, amount_cents, tax_cents, position, description)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      now,
      now,
      parentType,
      parentId,
      input.product_id,
      input.quantity,
      input.unit_price_cents,
      amountCents,
      position,
      input.description ?? null,
    ],
  );
  return id;
}

/** Patch an existing line item's `quantity`/`unit_price_cents`, recomputing `amount_cents`. */
export function patchLineItemQuantityOrPrice(
  tx: StoreTx,
  lineItemId: string,
  patch: { quantity?: number | undefined; unit_price_cents?: number | undefined },
  now: number,
): void {
  const row = tx.get(`SELECT quantity, unit_price_cents FROM line_items WHERE id = ?`, [lineItemId]);
  const quantity = patch.quantity ?? (row?.['quantity'] as number);
  const unitPriceCents = patch.unit_price_cents ?? (row?.['unit_price_cents'] as number);
  tx.run(
    `UPDATE line_items SET quantity = ?, unit_price_cents = ?, amount_cents = ?, updated_at = ? WHERE id = ?`,
    [quantity, unitPriceCents, quantity * unitPriceCents, now, lineItemId],
  );
}

/**
 * The ONLY writer of a parent doc's `total_cents` — always a full
 * `SUM(amount_cents)` recompute, matching the seed generator's convention
 * of excluding `tax_cents` from the header total (tax is tracked per-line
 * and, for orders, computed on demand by M34 `calculate_tax_for_order`).
 */
export function recomputeParentSubtotal(tx: StoreTx, parentType: LineItemParentType, parentId: string): number {
  const row = tx.get(
    `SELECT COALESCE(SUM(amount_cents), 0) AS subtotal FROM line_items
     WHERE parent_type = ? AND parent_id = ? AND archived = 0`,
    [parentType, parentId],
  );
  return (row?.['subtotal'] as number | null) ?? 0;
}
