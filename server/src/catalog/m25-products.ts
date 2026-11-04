/**
 * M25 Products — follows the M01 Contacts convention verbatim.
 *
 * Data home: the typed `products` table (plain, NOT kind-discriminated —
 * the bare `id` field resolves correctly via `entities[0]`, no synthHint
 * needed). `add_product_variant`/`update_product_variant` operate on the
 * SAME `products.prices` JSON array M26 Prices owns — see
 * `product-prices.ts`'s header comment for the full data-home rationale
 * (a "variant" and a "price" are modeled as the same array entry) and the
 * inventory-storage design note (no dedicated DDL column; `prices` is
 * upgraded from a bare array to `{prices, inventory_quantity}`).
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';
import {
  readProductPrices,
  writeProductPrices,
  nextPriceId,
  getPriceEntry,
  type PriceEntry,
} from './product-prices.js';

const MODULE = 'products';

interface ProductView {
  id: string;
  name: string;
  sku: string | null;
  type: string;
  status: string;
  category: string | null;
  default_price_cents: number | null;
  currency: string | null;
  description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): ProductView {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    sku: (row['sku'] as string | null) ?? null,
    type: row['type'] as string,
    status: row['status'] as string,
    category: (row['category'] as string | null) ?? null,
    default_price_cents: (row['default_price_cents'] as number | null) ?? null,
    currency: (row['currency'] as string | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getProductRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Product '${id}' does not exist.`);
  return row;
}

const productView = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  category: z.string().nullable(),
  default_price_cents: z.number().nullable(),
  currency: z.string().nullable(),
  description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

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

// --- A01 create_product -----------------------------------------------------

const createProductInput = z.strictObject({
  name: z.string().min(1),
  sku: z.string().optional(),
  type: z.enum(['physical', 'digital', 'service']).optional(),
  category: z.string().optional(),
  default_price_cents: z.number().int().min(0).optional(),
  currency: z.string().optional(),
  description: z.string().optional(),
});
type CreateProductInput = z.infer<typeof createProductInput>;

const createProduct: ActionDef<CreateProductInput, ProductView> = {
  id: 'M25.A01',
  slug: 'products.create_product',
  module: MODULE,
  name: 'Create product',
  description: 'Create a new sellable product.',
  risk: 'write',
  entities: ['products'],
  inputSchema: createProductInput,
  outputSchema: productView,
  searchCard: {
    synonyms: ['add product', 'new product'],
    examplePhrasings: ['Create a new product called Pro Plan'],
  },
  jit: 'Set a default price via default_price_cents, or add one later with prices.create_product_price.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'products', 'prod');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO products (id, created_at, updated_at, archived, name, sku, type, status, category,
        default_price_cents, currency, prices, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        now,
        input.name,
        input.sku ?? `SKU-${id}`,
        input.type ?? 'physical',
        input.category ?? null,
        input.default_price_cents ?? null,
        input.currency ?? 'USD',
        JSON.stringify({ prices: [], inventory_quantity: null }),
        input.description ?? null,
      ],
    );
    return toView(getProductRow(ctx.db, id));
  }),
};

// --- A02 get_product_details -------------------------------------------------

const getProductDetailsInput = z.strictObject({ id: z.string() });

const getProductDetails: ActionDef<z.infer<typeof getProductDetailsInput>, ProductView> = {
  id: 'M25.A02',
  slug: 'products.get_product_details',
  module: MODULE,
  name: 'Get product details',
  description: 'Fetch a single product by id.',
  risk: 'read',
  entities: ['products'],
  inputSchema: getProductDetailsInput,
  outputSchema: productView,
  searchCard: {
    synonyms: ['product details', 'look up product'],
    examplePhrasings: ['Show me product prod_42'],
  },
  handler: async (input, ctx) => toView(getProductRow(ctx.db, input.id)),
};

// --- A03 search_products -----------------------------------------------------

const searchProductsInput = z.strictObject({
  query: z.string().optional(),
  type: z.enum(['physical', 'digital', 'service']).optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchProductsInput = z.infer<typeof searchProductsInput>;
const searchProductsOutput = listOutputSchema(productView);
type SearchProductsOutput = ListOrSpill<ProductView>;

const searchProducts: ActionDef<SearchProductsInput, SearchProductsOutput> = {
  id: 'M25.A03',
  slug: 'products.search_products',
  module: MODULE,
  name: 'Search products',
  description: 'Search non-archived products by name and common filters.',
  risk: 'read',
  entities: ['products'],
  inputSchema: searchProductsInput,
  outputSchema: searchProductsOutput,
  searchCard: {
    synonyms: ['find products', 'list products'],
    examplePhrasings: ['Find all digital products', 'Search products named Pro'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('name LIKE ?');
      params.push(`%${input.query}%`);
    }
    if (input.type) {
      where.push('type = ?');
      params.push(input.type);
    }
    if (input.category) {
      where.push('category = ?');
      params.push(input.category);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM products WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM products WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 update_product_details -----------------------------------------------

const updateProductDetailsInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({
      name: z.string().min(1).optional(),
      category: z.string().optional(),
      description: z.string().optional(),
      type: z.enum(['physical', 'digital', 'service']).optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateProductDetails: ActionDef<z.infer<typeof updateProductDetailsInput>, ProductView> = {
  id: 'M25.A04',
  slug: 'products.update_product_details',
  module: MODULE,
  name: 'Update product details',
  description: 'Patch editable fields on a product.',
  risk: 'write',
  entities: ['products'],
  inputSchema: updateProductDetailsInput,
  outputSchema: productView,
  searchCard: {
    synonyms: ['edit product', 'update product'],
    examplePhrasings: ["Update this product's description"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getProductRow(ctx.db, input.id);
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE products SET ${setSql}, updated_at = ? WHERE id = ?`, [
      ...values,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getProductRow(ctx.db, input.id));
  }),
};

// --- A05 archive_product -------------------------------------------------------

const archiveProductInput = z.strictObject({ id: z.string() });
const archiveProductOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const archiveProduct: ActionDef<z.infer<typeof archiveProductInput>, z.infer<typeof archiveProductOutput>> = {
  id: 'M25.A05',
  slug: 'products.archive_product',
  module: MODULE,
  name: 'Archive product',
  description: 'Soft-delete a product and mark it archived (idempotent).',
  risk: 'destructive',
  entities: ['products'],
  inputSchema: archiveProductInput,
  outputSchema: archiveProductOutput,
  searchCard: {
    synonyms: ['delete product', 'remove product'],
    examplePhrasings: ['Archive this product'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.id);
    ctx.db.run(`UPDATE products SET archived = 1, status = 'archived', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, archived: true as const };
  }),
};

// --- A06 add_product_variant -----------------------------------------------

const addProductVariantInput = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  sku: z.string().optional(),
  amount_cents: z.number().int().min(0),
  currency: z.string().optional(),
  interval: z.enum(['one_time', 'day', 'week', 'month', 'year']).optional(),
});
const variantResultOutput = z.object({ id: z.string(), name: z.string(), variant: priceEntryView });
type VariantResultOutput = z.infer<typeof variantResultOutput>;

const addProductVariant: ActionDef<z.infer<typeof addProductVariantInput>, VariantResultOutput> = {
  id: 'M25.A06',
  slug: 'products.add_product_variant',
  module: MODULE,
  name: 'Add product variant',
  description: 'Add a new variant (price-list entry with its own name/SKU) to a product.',
  risk: 'write',
  entities: ['products'],
  inputSchema: addProductVariantInput,
  outputSchema: variantResultOutput,
  searchCard: {
    synonyms: ['add variant', 'new product variant'],
    examplePhrasings: ['Add a Large variant to this product'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.id);
    const config = readProductPrices(row);
    const variant: PriceEntry = {
      id: nextPriceId(config.prices, input.id),
      name: input.name ?? null,
      sku: input.sku ?? null,
      amount_cents: input.amount_cents,
      currency: input.currency ?? 'USD',
      interval: input.interval ?? 'one_time',
      trial_days: null,
      is_default: config.prices.length === 0,
      archived: false,
    };
    const now = ctx.clock.now();
    writeProductPrices(ctx.db, input.id, { ...config, prices: [...config.prices, variant] }, now);
    return { id: input.id, name: row['name'] as string, variant };
  }),
};

// --- A07 update_product_variant -----------------------------------------------

const updateProductVariantInput = z.strictObject({
  id: z.string(),
  variant_id: z.string(),
  patch: z
    .strictObject({
      name: z.string().optional(),
      sku: z.string().optional(),
      amount_cents: z.number().int().min(0).optional(),
      currency: z.string().optional(),
      interval: z.enum(['one_time', 'day', 'week', 'month', 'year']).optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateProductVariant: ActionDef<z.infer<typeof updateProductVariantInput>, VariantResultOutput> = {
  id: 'M25.A07',
  slug: 'products.update_product_variant',
  module: MODULE,
  name: 'Update product variant',
  description: 'Patch an existing product variant (name/SKU/amount/currency/interval).',
  risk: 'write',
  entities: ['products'],
  inputSchema: updateProductVariantInput,
  outputSchema: variantResultOutput,
  searchCard: {
    synonyms: ['edit variant', 'update product variant'],
    examplePhrasings: ["Update this product variant's price"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.id);
    const config = readProductPrices(row);
    const existing = getPriceEntry(config.prices, input.variant_id, input.id);
    const patch = Object.fromEntries(Object.entries(input.patch).filter(([, v]) => v !== undefined));
    const updated: PriceEntry = { ...existing, ...patch };
    const prices = config.prices.map((p) => (p.id === updated.id ? updated : p));
    writeProductPrices(ctx.db, input.id, { ...config, prices }, ctx.clock.now());
    return { id: input.id, name: row['name'] as string, variant: updated };
  }),
};

// --- A08 set_product_sku -----------------------------------------------------

const setProductSkuInput = z.strictObject({ id: z.string(), sku: z.string().min(1) });

const setProductSku: ActionDef<z.infer<typeof setProductSkuInput>, ProductView> = {
  id: 'M25.A08',
  slug: 'products.set_product_sku',
  module: MODULE,
  name: 'Set product SKU',
  description: "Set a product's own top-level SKU.",
  risk: 'write',
  entities: ['products'],
  inputSchema: setProductSkuInput,
  outputSchema: productView,
  searchCard: {
    synonyms: ['set SKU', 'update product SKU'],
    examplePhrasings: ["Change this product's SKU to NEW-SKU-01"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getProductRow(ctx.db, input.id);
    ctx.db.run(`UPDATE products SET sku = ?, updated_at = ? WHERE id = ?`, [
      input.sku,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getProductRow(ctx.db, input.id));
  }),
};

// --- A09 set_inventory_quantity -----------------------------------------------

const setInventoryQuantityInput = z.strictObject({ id: z.string(), quantity: z.number().int().min(0) });
const inventoryOutput = z.object({ id: z.string(), name: z.string(), inventory_quantity: z.number().nullable() });

const setInventoryQuantity: ActionDef<z.infer<typeof setInventoryQuantityInput>, z.infer<typeof inventoryOutput>> = {
  id: 'M25.A09',
  slug: 'products.set_inventory_quantity',
  module: MODULE,
  name: 'Set inventory quantity',
  description: 'Set the tracked on-hand inventory quantity for a product.',
  risk: 'write',
  entities: ['products'],
  inputSchema: setInventoryQuantityInput,
  outputSchema: inventoryOutput,
  searchCard: {
    synonyms: ['set stock', 'update inventory'],
    examplePhrasings: ['Set this product to 50 units in stock'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getProductRow(ctx.db, input.id);
    const config = readProductPrices(row);
    writeProductPrices(ctx.db, input.id, { ...config, inventory_quantity: input.quantity }, ctx.clock.now());
    return { id: input.id, name: row['name'] as string, inventory_quantity: input.quantity };
  }),
};

// --- A10 get_inventory_availability -----------------------------------------------

const getInventoryAvailabilityInput = z.strictObject({ id: z.string() });
const inventoryAvailabilityOutput = z.object({
  id: z.string(),
  name: z.string(),
  inventory_quantity: z.number().nullable(),
  in_stock: z.boolean(),
});

const getInventoryAvailability: ActionDef<
  z.infer<typeof getInventoryAvailabilityInput>,
  z.infer<typeof inventoryAvailabilityOutput>
> = {
  id: 'M25.A10',
  slug: 'products.get_inventory_availability',
  module: MODULE,
  name: 'Get inventory availability',
  description:
    'Check whether a product is in stock. A product with no tracked quantity is treated as always available (untracked).',
  risk: 'read',
  entities: ['products'],
  inputSchema: getInventoryAvailabilityInput,
  outputSchema: inventoryAvailabilityOutput,
  searchCard: {
    synonyms: ['check stock', 'is this in stock'],
    examplePhrasings: ['Is this product in stock?'],
  },
  handler: async (input, ctx) => {
    const row = getProductRow(ctx.db, input.id);
    const config = readProductPrices(row);
    const inStock = config.inventory_quantity === null ? true : config.inventory_quantity > 0;
    return { id: input.id, name: row['name'] as string, inventory_quantity: config.inventory_quantity, in_stock: inStock };
  },
};

export const m25Products: ActionDef[] = [
  createProduct as ActionDef,
  getProductDetails as ActionDef,
  searchProducts as ActionDef,
  updateProductDetails as ActionDef,
  archiveProduct as ActionDef,
  addProductVariant as ActionDef,
  updateProductVariant as ActionDef,
  setProductSku as ActionDef,
  setInventoryQuantity as ActionDef,
  getInventoryAvailability as ActionDef,
];

/** Tier-A discrimination: `status` counts over 160 products — verified via
 * live `npm run smoke` output: 'active' → 139, 'archived' → 21. */
export const m25DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'products.search_products',
    paramsA: { status: 'active' },
    paramsB: { status: 'archived' },
    expectDifferentCounts: true,
  },
];

/** `products` is a plain (non-kind-discriminated) table — every id field
 * resolves correctly via `entities[0]`/`DEFAULT_HINTS` with no module-level
 * hint needed. */
export const m25SynthHints: SynthHints = {};
