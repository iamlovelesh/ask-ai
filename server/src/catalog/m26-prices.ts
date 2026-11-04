/**
 * M26 Prices — the SAME `products.prices` JSON array M25's
 * `add_product_variant`/`update_product_variant` write (see
 * `product-prices.ts`'s header for the full rationale). Every action here
 * takes `product_id` (plain `products` table — already covered by
 * `testing.ts`'s `DEFAULT_HINTS`, no synthHint needed) plus a `price_id`
 * identifying an entry inside that product's array.
 *
 * KNOWN SMOKE LIMITATION (documented, same category as M22
 * `remove_time_block`'s precedent): `price_id` addresses an entry inside a
 * JSON array, not a row in a SQL table — `synthesizeInput` has no way to
 * pull a real existing price id out of a specific synthesized product's
 * array (each field is resolved independently; there is no cross-field
 * correlation between the `product_id` picked for one field and a
 * `price_id` picked for another). Every `price_id`-taking action below
 * does a REAL existence check and a REAL mutation when given a valid
 * `price_id` — `get_price_details`/`update_price_label`/`set_price_amount`/
 * `set_price_currency`/`set_billing_interval`/`set_trial_period`/
 * `archive_price` will legitimately 404 under smoke's synthesized input
 * (an honest "expected ActionError" PASS, not a masked bug) rather than
 * silently succeed on a made-up id.
 */

import { z } from 'zod';
import type { ActionDef } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import type { SynthHints } from './synth-hints.js';
import {
  readProductPrices,
  writeProductPrices,
  nextPriceId,
  getPriceEntry,
  type PriceEntry,
} from './product-prices.js';

const MODULE = 'prices';

function getProductRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Product '${id}' does not exist.`);
  return row;
}

const priceEntryView = z.object({
  id: z.string(),
  name: z.string().nullable(),
  sku: z.string().nullable(),
  amount_cents: z.number(),
  currency: z.string(),
  interval: z.enum(['one_time', 'day', 'week', 'month', 'year']),
  trial_days: z.number().nullable(),
  is_default: z.boolean(),
  archived: z.boolean(),
});
type PriceEntryView = z.infer<typeof priceEntryView>;

function syncDefaultPriceCents(tx: StoreTx, productId: string, config: ReturnType<typeof readProductPrices>, now: number): void {
  const def = config.prices.find((p) => p.is_default && !p.archived);
  tx.run(`UPDATE products SET default_price_cents = ?, updated_at = ? WHERE id = ?`, [
    def?.amount_cents ?? null,
    now,
    productId,
  ]);
}

// --- A01 create_product_price -----------------------------------------------

const createProductPriceInput = z.strictObject({
  product_id: z.string(),
  amount_cents: z.number().int().min(0),
  currency: z.string().optional(),
  interval: z.enum(['one_time', 'day', 'week', 'month', 'year']).optional(),
});
const priceResultOutput = z.object({ product_id: z.string(), price: priceEntryView });
type PriceResultOutput = z.infer<typeof priceResultOutput>;

const createProductPrice: ActionDef<z.infer<typeof createProductPriceInput>, PriceResultOutput> = {
  id: 'M26.A01',
  slug: 'prices.create_product_price',
  module: MODULE,
  name: 'Create product price',
  description: 'Add a new price-list entry to a product.',
  risk: 'write',
  entities: ['products'],
  inputSchema: createProductPriceInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['add price', 'new product price'],
    examplePhrasings: ['Add a yearly price option to this product'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(getProductRow(ctx.db, input.product_id));
    const price: PriceEntry = {
      id: nextPriceId(config.prices, input.product_id),
      name: null,
      sku: null,
      amount_cents: input.amount_cents,
      currency: input.currency ?? 'USD',
      interval: input.interval ?? 'one_time',
      trial_days: null,
      is_default: config.prices.length === 0,
      archived: false,
    };
    const now = ctx.clock.now();
    const nextConfig = { ...config, prices: [...config.prices, price] };
    writeProductPrices(ctx.db, input.product_id, nextConfig, now);
    if (price.is_default) syncDefaultPriceCents(ctx.db, input.product_id, nextConfig, now);
    return { product_id: input.product_id, price };
  }),
};

// --- A02 get_price_details -------------------------------------------------

const getPriceDetailsInput = z.strictObject({ product_id: z.string(), price_id: z.string() });

const getPriceDetails: ActionDef<z.infer<typeof getPriceDetailsInput>, PriceResultOutput> = {
  id: 'M26.A02',
  slug: 'prices.get_price_details',
  module: MODULE,
  name: 'Get price details',
  description: 'Fetch a single price-list entry.',
  risk: 'read',
  entities: ['products'],
  inputSchema: getPriceDetailsInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['price details', 'look up price'],
    examplePhrasings: ['Show me this price option'],
  },
  handler: async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    const price = getPriceEntry(config.prices, input.price_id, input.product_id);
    return { product_id: input.product_id, price };
  },
};

// --- A03 list_product_prices -----------------------------------------------

const listProductPricesInput = z.strictObject({ product_id: z.string() });
const listProductPricesOutput = listOutputSchema(priceEntryView);
type ListProductPricesOutput = ListOrSpill<PriceEntryView>;

const listProductPrices: ActionDef<z.infer<typeof listProductPricesInput>, ListProductPricesOutput> = {
  id: 'M26.A03',
  slug: 'prices.list_product_prices',
  module: MODULE,
  name: 'List product prices',
  description: 'List the non-archived price-list entries for a product.',
  risk: 'read',
  entities: ['products'],
  inputSchema: listProductPricesInput,
  outputSchema: listProductPricesOutput,
  searchCard: {
    synonyms: ['all prices for product', 'show pricing options'],
    examplePhrasings: ['What prices does this product have?'],
  },
  handler: async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    const active = config.prices.filter((p) => !p.archived);
    return toListOrSpill(active, active.length);
  },
};

// --- A04 update_price_label -----------------------------------------------

const updatePriceLabelInput = z.strictObject({ product_id: z.string(), price_id: z.string(), name: z.string().min(1) });

const updatePriceLabel: ActionDef<z.infer<typeof updatePriceLabelInput>, PriceResultOutput> = {
  id: 'M26.A04',
  slug: 'prices.update_price_label',
  module: MODULE,
  name: 'Update price label',
  description: "Rename a price-list entry's display label.",
  risk: 'write',
  entities: ['products'],
  inputSchema: updatePriceLabelInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['rename price', 'relabel price'],
    examplePhrasings: ['Rename this price option to "Annual"'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    const existing = getPriceEntry(config.prices, input.price_id, input.product_id);
    const updated: PriceEntry = { ...existing, name: input.name };
    const prices = config.prices.map((p) => (p.id === updated.id ? updated : p));
    writeProductPrices(ctx.db, input.product_id, { ...config, prices }, ctx.clock.now());
    return { product_id: input.product_id, price: updated };
  }),
};

// --- A05 set_price_amount -----------------------------------------------

const setPriceAmountInput = z.strictObject({
  product_id: z.string(),
  price_id: z.string(),
  amount_cents: z.number().int().min(0),
});

const setPriceAmount: ActionDef<z.infer<typeof setPriceAmountInput>, PriceResultOutput> = {
  id: 'M26.A05',
  slug: 'prices.set_price_amount',
  module: MODULE,
  name: 'Set price amount',
  description: "Set a price-list entry's amount.",
  risk: 'write',
  entities: ['products'],
  inputSchema: setPriceAmountInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['change price', 'update price amount'],
    examplePhrasings: ['Change this price to $49'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    const existing = getPriceEntry(config.prices, input.price_id, input.product_id);
    const updated: PriceEntry = { ...existing, amount_cents: input.amount_cents };
    const prices = config.prices.map((p) => (p.id === updated.id ? updated : p));
    const now = ctx.clock.now();
    const nextConfig = { ...config, prices };
    writeProductPrices(ctx.db, input.product_id, nextConfig, now);
    if (updated.is_default) syncDefaultPriceCents(ctx.db, input.product_id, nextConfig, now);
    return { product_id: input.product_id, price: updated };
  }),
};

// --- A06 set_price_currency -----------------------------------------------

const setPriceCurrencyInput = z.strictObject({ product_id: z.string(), price_id: z.string(), currency: z.string().min(1) });

const setPriceCurrency: ActionDef<z.infer<typeof setPriceCurrencyInput>, PriceResultOutput> = {
  id: 'M26.A06',
  slug: 'prices.set_price_currency',
  module: MODULE,
  name: 'Set price currency',
  description: "Set a price-list entry's currency code.",
  risk: 'write',
  entities: ['products'],
  inputSchema: setPriceCurrencyInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['change price currency'],
    examplePhrasings: ['Set this price to EUR'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    const existing = getPriceEntry(config.prices, input.price_id, input.product_id);
    const updated: PriceEntry = { ...existing, currency: input.currency };
    const prices = config.prices.map((p) => (p.id === updated.id ? updated : p));
    writeProductPrices(ctx.db, input.product_id, { ...config, prices }, ctx.clock.now());
    return { product_id: input.product_id, price: updated };
  }),
};

// --- A07 set_billing_interval -----------------------------------------------

const setBillingIntervalInput = z.strictObject({
  product_id: z.string(),
  price_id: z.string(),
  interval: z.enum(['one_time', 'day', 'week', 'month', 'year']),
});

const setBillingInterval: ActionDef<z.infer<typeof setBillingIntervalInput>, PriceResultOutput> = {
  id: 'M26.A07',
  slug: 'prices.set_billing_interval',
  module: MODULE,
  name: 'Set billing interval',
  description: "Set a price-list entry's recurring billing interval.",
  risk: 'write',
  entities: ['products'],
  inputSchema: setBillingIntervalInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['change billing interval', 'set price interval'],
    examplePhrasings: ['Make this price bill yearly instead of monthly'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    const existing = getPriceEntry(config.prices, input.price_id, input.product_id);
    const updated: PriceEntry = { ...existing, interval: input.interval };
    const prices = config.prices.map((p) => (p.id === updated.id ? updated : p));
    writeProductPrices(ctx.db, input.product_id, { ...config, prices }, ctx.clock.now());
    return { product_id: input.product_id, price: updated };
  }),
};

// --- A08 set_trial_period -----------------------------------------------

const setTrialPeriodInput = z.strictObject({
  product_id: z.string(),
  price_id: z.string(),
  trial_days: z.number().int().min(0).nullable(),
});

const setTrialPeriod: ActionDef<z.infer<typeof setTrialPeriodInput>, PriceResultOutput> = {
  id: 'M26.A08',
  slug: 'prices.set_trial_period',
  module: MODULE,
  name: 'Set trial period',
  description: "Set a price-list entry's free-trial length in days (null clears it).",
  risk: 'write',
  entities: ['products'],
  inputSchema: setTrialPeriodInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['set free trial', 'add trial period'],
    examplePhrasings: ['Give this price a 14 day free trial'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    const existing = getPriceEntry(config.prices, input.price_id, input.product_id);
    const updated: PriceEntry = { ...existing, trial_days: input.trial_days };
    const prices = config.prices.map((p) => (p.id === updated.id ? updated : p));
    writeProductPrices(ctx.db, input.product_id, { ...config, prices }, ctx.clock.now());
    return { product_id: input.product_id, price: updated };
  }),
};

// --- A09 set_default_product_price -----------------------------------------------

const setDefaultProductPriceInput = z.strictObject({ product_id: z.string(), price_id: z.string() });

const setDefaultProductPrice: ActionDef<z.infer<typeof setDefaultProductPriceInput>, PriceResultOutput> = {
  id: 'M26.A09',
  slug: 'prices.set_default_product_price',
  module: MODULE,
  name: 'Set default product price',
  description: "Mark one price-list entry as the product's default (and sync products.default_price_cents).",
  risk: 'write',
  entities: ['products'],
  inputSchema: setDefaultProductPriceInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['set default price', 'make this the main price'],
    examplePhrasings: ['Make this the default price for the product'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    getPriceEntry(config.prices, input.price_id, input.product_id); // existence check
    const prices = config.prices.map((p) => ({ ...p, is_default: p.id === input.price_id }));
    const now = ctx.clock.now();
    const nextConfig = { ...config, prices };
    writeProductPrices(ctx.db, input.product_id, nextConfig, now);
    syncDefaultPriceCents(ctx.db, input.product_id, nextConfig, now);
    const updated = prices.find((p) => p.id === input.price_id) as PriceEntry;
    return { product_id: input.product_id, price: updated };
  }),
};

// --- A10 archive_price -----------------------------------------------

const archivePriceInput = z.strictObject({ product_id: z.string(), price_id: z.string() });

const archivePrice: ActionDef<z.infer<typeof archivePriceInput>, PriceResultOutput> = {
  id: 'M26.A10',
  slug: 'prices.archive_price',
  module: MODULE,
  name: 'Archive price',
  description: 'Soft-delete a price-list entry (idempotent).',
  risk: 'destructive',
  entities: ['products'],
  inputSchema: archivePriceInput,
  outputSchema: priceResultOutput,
  searchCard: {
    synonyms: ['delete price', 'remove price option'],
    examplePhrasings: ['Remove that price option'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.product_id);
    const config = readProductPrices(row);
    const existing = getPriceEntry(config.prices, input.price_id, input.product_id);
    const updated: PriceEntry = { ...existing, archived: true, is_default: false };
    const prices = config.prices.map((p) => (p.id === updated.id ? updated : p));
    const now = ctx.clock.now();
    const nextConfig = { ...config, prices };
    writeProductPrices(ctx.db, input.product_id, nextConfig, now);
    if (existing.is_default) syncDefaultPriceCents(ctx.db, input.product_id, nextConfig, now);
    return { product_id: input.product_id, price: updated };
  }),
};

export const m26Prices: ActionDef[] = [
  createProductPrice as ActionDef,
  getPriceDetails as ActionDef,
  listProductPrices as ActionDef,
  updatePriceLabel as ActionDef,
  setPriceAmount as ActionDef,
  setPriceCurrency as ActionDef,
  setBillingInterval as ActionDef,
  setTrialPeriod as ActionDef,
  setDefaultProductPrice as ActionDef,
  archivePrice as ActionDef,
];

/** No catalog-wide list/search action exists in this module (every action
 * is scoped to one `product_id`'s own price list) — same empty-array
 * convention as M22's case. */
export const m26DiscriminationChecks: DiscriminationCheck[] = [];

/** `product_id` already resolves via `testing.ts`'s `DEFAULT_HINTS`;
 * `price_id` cannot be resolved against a real SQL table (see file header
 * "KNOWN SMOKE LIMITATION") so there is no hint that would help it. */
export const m26SynthHints: SynthHints = {};
