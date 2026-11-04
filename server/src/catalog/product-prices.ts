/**
 * Shared `products.prices` JSON helpers for M25 Products and M26 Prices
 * (task 9 batch 4). `entities/model.ts#MODULE_MAP` collapses M26 into
 * "products.prices" — ONE physical JSON column backs both modules'
 * entries:
 *   - M26 Prices CRUDs plain price entries (amount/currency/interval/trial).
 *   - M25's `add_product_variant`/`update_product_variant` are the SAME
 *     entries from the product's own perspective, extended with an
 *     optional `name` (the variant label, e.g. "Large") and `sku`
 *     (variant-specific SKU) — there is no separate `variants` column in
 *     `entities/model.ts`, so "a variant" and "a price" are modeled as the
 *     SAME array entry (judgment call — flagged for controller review).
 *
 * DESIGN NOTE — inventory storage: M25's `set_inventory_quantity`/
 * `get_inventory_availability` need a numeric slot `products` has no
 * dedicated column for. Rather than inventing a new DDL column (out of
 * scope for this task) or overloading an unrelated column, the JSON
 * stored in `products.prices` is upgraded from a bare array (the seed
 * generator's shape: `entities/seed-commerce.ts#generateProducts` writes
 * `JSON.stringify([{...}])`) to an object `{ prices: PriceEntry[],
 * inventory_quantity: number | null }`. `readProductPrices` normalizes
 * BOTH shapes transparently (legacy bare array → `{prices: array,
 * inventory_quantity: null}`), so every pre-seeded product keeps working
 * with no migration step; every write from this task writes the new
 * object shape going forward. Same category as M05 pipelines'
 * `DEFAULT_STAGES` / M20 calendars' `config.availability` absent-config
 * fallback pattern.
 */
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';

export interface PriceEntry {
  id: string;
  name: string | null;
  sku: string | null;
  amount_cents: number;
  currency: string;
  interval: 'one_time' | 'day' | 'week' | 'month' | 'year';
  trial_days: number | null;
  is_default: boolean;
  archived: boolean;
}

export interface ProductPricesConfig {
  prices: PriceEntry[];
  inventory_quantity: number | null;
}

/** Normalize one entry to the FULL `PriceEntry` shape — the seed
 * generator's legacy entries only carry `{id, amount_cents, currency,
 * interval}` (`entities/seed-commerce.ts#generateProducts`), missing the
 * fields this task's M25/M26 actions added (`name`, `sku`, `trial_days`,
 * `is_default`, `archived`). Without this normalization a seeded entry
 * fails `priceEntryView`'s output schema the first time it's read back. */
function normalizeEntry(raw: Partial<PriceEntry> & { id: string; amount_cents: number; currency: string; interval: PriceEntry['interval'] }): PriceEntry {
  return {
    id: raw.id,
    name: raw.name ?? null,
    sku: raw.sku ?? null,
    amount_cents: raw.amount_cents,
    currency: raw.currency,
    interval: raw.interval,
    trial_days: raw.trial_days ?? null,
    is_default: raw.is_default ?? true,
    archived: raw.archived ?? false,
  };
}

export function readProductPrices(row: Row): ProductPricesConfig {
  const raw = row['prices'];
  if (typeof raw !== 'string' || raw.length === 0) return { prices: [], inventory_quantity: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // Legacy/seed shape: a bare array, no inventory tracked yet.
      return { prices: (parsed as PriceEntry[]).map(normalizeEntry), inventory_quantity: null };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const prices = Array.isArray(obj['prices']) ? (obj['prices'] as PriceEntry[]).map(normalizeEntry) : [];
      const inv = obj['inventory_quantity'];
      return { prices, inventory_quantity: typeof inv === 'number' ? inv : null };
    }
    return { prices: [], inventory_quantity: null };
  } catch {
    return { prices: [], inventory_quantity: null };
  }
}

export function writeProductPrices(tx: StoreTx, productId: string, config: ProductPricesConfig, now: number): void {
  tx.run(`UPDATE products SET prices = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(config),
    now,
    productId,
  ]);
}

/** Max-based next price/variant id (`{productId}_p{n}`) — same "derive from
 * current max among entries CURRENTLY in the array" principle as
 * `next-id.ts#nextId` (SQL tables) and `calendar-availability.ts#nextBlockId`
 * (another in-config array) — a freed number (from an archived/removed
 * entry) may be reused, which is fine: it never collides with anything
 * CURRENTLY live. */
export function nextPriceId(entries: readonly PriceEntry[], productId: string): string {
  const re = new RegExp(`^${productId}_p(\\d+)$`);
  let maxN = 0;
  for (const entry of entries) {
    const match = re.exec(entry.id);
    if (match) {
      const n = Number(match[1]);
      if (n > maxN) maxN = n;
    }
  }
  return `${productId}_p${maxN + 1}`;
}

export function getPriceEntry(entries: readonly PriceEntry[], priceId: string, productId: string): PriceEntry {
  const entry = entries.find((e) => e.id === priceId && !e.archived);
  if (!entry) {
    throw new ActionError('NOT_FOUND', `Price/variant '${priceId}' does not exist on product '${productId}'.`);
  }
  return entry;
}
