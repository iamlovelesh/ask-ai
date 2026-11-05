/**
 * M31 Coupons — follows the M01 Contacts / M09 Smart Lists convention
 * verbatim.
 *
 * Data home: `structures` table, `kind = 'coupon'` (`entities/model.ts`:
 * "M31: structures(coupon) + records(coupon_redemption)"). `config`
 * (JSON) is `{ discount_type, discount_value, valid_from, valid_until,
 * redemption_limit, product_ids }`. Seeded rows carry the generic
 * placeholder `{seeded:true,kind:'coupon'}` (`entities/seed-core.ts`), so
 * every reader falls back to a sane default (10% off, no window/limit/
 * restriction) when a field is absent — same "config absent" pattern as
 * M05 pipelines' `DEFAULT_STAGES`.
 *
 * `validate_coupon_for_order` (A09) is a READ-ONLY dry run per the brief
 * ("don't implement it as a write") — the actual redemption write
 * (records(kind='coupon_redemption') + order total recompute) is M32
 * Orders' `apply_coupon_to_order`, NOT this module (carried forward from
 * task-8's guide §10 redemption-kind-ownership note).
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10): every action on this
 * module's own `id` needs an action-scoped synthHint (`${slug}:id`).
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
import { parseJsonObject } from './json.js';

const MODULE = 'coupons';
const KIND = 'coupon';

export interface CouponConfig {
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  valid_from: number | null;
  valid_until: number | null;
  redemption_limit: number | null;
  product_ids: string[];
}

export function readCouponConfig(row: Row): CouponConfig {
  const config = parseJsonObject(row['config']);
  return {
    discount_type: config['discount_type'] === 'fixed' ? 'fixed' : 'percent',
    discount_value: typeof config['discount_value'] === 'number' ? (config['discount_value'] as number) : 10,
    valid_from: typeof config['valid_from'] === 'number' ? (config['valid_from'] as number) : null,
    valid_until: typeof config['valid_until'] === 'number' ? (config['valid_until'] as number) : null,
    redemption_limit: typeof config['redemption_limit'] === 'number' ? (config['redemption_limit'] as number) : null,
    product_ids: Array.isArray(config['product_ids']) ? (config['product_ids'] as string[]) : [],
  };
}

function writeCouponConfig(tx: StoreTx, id: string, config: CouponConfig, now: number): void {
  tx.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

export function getCouponRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Coupon '${id}' does not exist.`);
  return row;
}

export function countCouponRedemptions(tx: StoreTx, couponId: string): number {
  const row = tx.get(`SELECT COUNT(*) AS n FROM records WHERE kind = 'coupon_redemption' AND parent_id = ?`, [couponId]);
  return (row?.['n'] as number | null) ?? 0;
}

interface CouponView {
  id: string;
  name: string;
  code: string;
  status: string;
  discount_type: string;
  discount_value: number;
  valid_from: number | null;
  valid_until: number | null;
  redemption_limit: number | null;
  redemption_count: number;
  product_ids: string[];
  description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(db: StoreTx, row: Row): CouponView {
  const config = readCouponConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    code: row['slug'] as string,
    status: row['status'] as string,
    discount_type: config.discount_type,
    discount_value: config.discount_value,
    valid_from: config.valid_from,
    valid_until: config.valid_until,
    redemption_limit: config.redemption_limit,
    redemption_count: countCouponRedemptions(db, row['id'] as string),
    product_ids: config.product_ids,
    description: (row['description'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const couponView = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  status: z.string(),
  discount_type: z.string(),
  discount_value: z.number(),
  valid_from: z.number().nullable(),
  valid_until: z.number().nullable(),
  redemption_limit: z.number().nullable(),
  redemption_count: z.number(),
  product_ids: z.array(z.string()),
  description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

function slugify(name: string, id: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${base || 'coupon'}-${id}`;
}

// --- A01 create_coupon -----------------------------------------------------

const createCouponInput = z.strictObject({
  name: z.string().min(1),
  code: z.string().optional(),
  discount_type: z.enum(['percent', 'fixed']).optional(),
  discount_value: z.number().min(0).optional(),
  description: z.string().optional(),
});

const createCoupon: ActionDef<z.infer<typeof createCouponInput>, CouponView> = {
  id: 'M31.A01',
  slug: 'coupons.create_coupon',
  module: MODULE,
  name: 'Create coupon',
  description: 'Create a new discount coupon.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createCouponInput,
  outputSchema: couponView,
  searchCard: {
    synonyms: ['add coupon', 'new discount code'],
    examplePhrasings: ['Create a 20% off coupon called SPRING20'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: CouponConfig = {
      discount_type: input.discount_type ?? 'percent',
      discount_value: input.discount_value ?? 10,
      valid_from: null,
      valid_until: null,
      redemption_limit: null,
      product_ids: [],
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)`,
      [id, now, now, KIND, input.name, input.code ?? slugify(input.name, id), KIND, JSON.stringify(config), input.description ?? null],
    );
    return toView(ctx.db, getCouponRow(ctx.db, id));
  }),
};

// --- A02 get_coupon_details -------------------------------------------------

const getCouponDetailsInput = z.strictObject({ id: z.string() });

const getCouponDetails: ActionDef<z.infer<typeof getCouponDetailsInput>, CouponView> = {
  id: 'M31.A02',
  slug: 'coupons.get_coupon_details',
  module: MODULE,
  name: 'Get coupon details',
  description: 'Fetch a coupon and its live redemption count.',
  risk: 'read',
  entities: ['structures', 'records'],
  inputSchema: getCouponDetailsInput,
  outputSchema: couponView,
  searchCard: {
    synonyms: ['coupon details', 'look up coupon'],
    examplePhrasings: ['Show me this coupon'],
  },
  handler: async (input, ctx) => toView(ctx.db, getCouponRow(ctx.db, input.id)),
};

// --- A03 search_coupons -----------------------------------------------------

const searchCouponsInput = z.strictObject({
  status: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchCouponsInput = z.infer<typeof searchCouponsInput>;
const searchCouponsOutput = listOutputSchema(couponView);
type SearchCouponsOutput = ListOrSpill<CouponView>;

const searchCoupons: ActionDef<SearchCouponsInput, SearchCouponsOutput> = {
  id: 'M31.A03',
  slug: 'coupons.search_coupons',
  module: MODULE,
  name: 'Search coupons',
  description: 'Search non-archived coupons by common filters.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: searchCouponsInput,
  outputSchema: searchCouponsOutput,
  searchCard: {
    synonyms: ['find coupons', 'list discount codes'],
    examplePhrasings: ['Find all active coupons'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.query) {
      where.push('(name LIKE ? OR slug LIKE ?)');
      const like = `%${input.query}%`;
      params.push(like, like);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM structures WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map((r) => toView(ctx.db, r)), total, {
      idCapture: { db: ctx.db, table: 'structures', whereSql, params },
    });
  },
};

// --- A04 update_coupon_description -----------------------------------------------

const updateCouponDescriptionInput = z.strictObject({ id: z.string(), description: z.string() });

const updateCouponDescription: ActionDef<z.infer<typeof updateCouponDescriptionInput>, CouponView> = {
  id: 'M31.A04',
  slug: 'coupons.update_coupon_description',
  module: MODULE,
  name: 'Update coupon description',
  description: "Update a coupon's description.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateCouponDescriptionInput,
  outputSchema: couponView,
  searchCard: {
    synonyms: ['edit coupon description'],
    examplePhrasings: ["Update this coupon's description"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getCouponRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET description = ?, updated_at = ? WHERE id = ?`, [
      input.description,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(ctx.db, getCouponRow(ctx.db, input.id));
  }),
};

// --- A05 set_discount_value -----------------------------------------------

const setDiscountValueInput = z.strictObject({
  id: z.string(),
  discount_type: z.enum(['percent', 'fixed']),
  discount_value: z.number().min(0),
});

const setDiscountValue: ActionDef<z.infer<typeof setDiscountValueInput>, CouponView> = {
  id: 'M31.A05',
  slug: 'coupons.set_discount_value',
  module: MODULE,
  name: 'Set discount value',
  description: "Set a coupon's discount type and value.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setDiscountValueInput,
  outputSchema: couponView,
  searchCard: {
    synonyms: ['change discount', 'update coupon value'],
    examplePhrasings: ['Change this coupon to 25% off'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    if (input.discount_type === 'percent' && input.discount_value > 100) {
      throw new ActionError('VALIDATION', 'A percent discount must be between 0 and 100.');
    }
    const row = getCouponRow(ctx.db, input.id);
    const config = readCouponConfig(row);
    const now = ctx.clock.now();
    writeCouponConfig(ctx.db, input.id, { ...config, discount_type: input.discount_type, discount_value: input.discount_value }, now);
    return toView(ctx.db, getCouponRow(ctx.db, input.id));
  }),
};

// --- A06 set_coupon_validity_window -----------------------------------------------

const setCouponValidityWindowInput = z.strictObject({
  id: z.string(),
  valid_from: z.number().int().min(0).nullable().optional(),
  valid_until: z.number().int().min(0).nullable().optional(),
});

const setCouponValidityWindow: ActionDef<z.infer<typeof setCouponValidityWindowInput>, CouponView> = {
  id: 'M31.A06',
  slug: 'coupons.set_coupon_validity_window',
  module: MODULE,
  name: 'Set coupon validity window',
  description: "Set a coupon's valid_from/valid_until window.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setCouponValidityWindowInput,
  outputSchema: couponView,
  searchCard: {
    synonyms: ['set coupon dates', 'change coupon validity'],
    examplePhrasings: ['Make this coupon valid until the end of the month'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCouponRow(ctx.db, input.id);
    const config = readCouponConfig(row);
    const validFrom = input.valid_from === undefined ? config.valid_from : input.valid_from;
    const validUntil = input.valid_until === undefined ? config.valid_until : input.valid_until;
    if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
      throw new ActionError('VALIDATION', '`valid_from` must be before `valid_until`.');
    }
    writeCouponConfig(ctx.db, input.id, { ...config, valid_from: validFrom, valid_until: validUntil }, ctx.clock.now());
    return toView(ctx.db, getCouponRow(ctx.db, input.id));
  }),
};

// --- A07 set_redemption_limit -----------------------------------------------

const setRedemptionLimitInput = z.strictObject({ id: z.string(), redemption_limit: z.number().int().min(0).nullable() });

const setRedemptionLimit: ActionDef<z.infer<typeof setRedemptionLimitInput>, CouponView> = {
  id: 'M31.A07',
  slug: 'coupons.set_redemption_limit',
  module: MODULE,
  name: 'Set redemption limit',
  description: "Set a coupon's maximum redemption count (null = unlimited).",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setRedemptionLimitInput,
  outputSchema: couponView,
  searchCard: {
    synonyms: ['limit redemptions', 'cap coupon uses'],
    examplePhrasings: ['Limit this coupon to 100 uses'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCouponRow(ctx.db, input.id);
    const config = readCouponConfig(row);
    writeCouponConfig(ctx.db, input.id, { ...config, redemption_limit: input.redemption_limit }, ctx.clock.now());
    return toView(ctx.db, getCouponRow(ctx.db, input.id));
  }),
};

// --- A08 restrict_coupon_to_products -----------------------------------------------

const restrictCouponToProductsInput = z.strictObject({ id: z.string(), product_ids: z.array(z.string()) });

const restrictCouponToProducts: ActionDef<z.infer<typeof restrictCouponToProductsInput>, CouponView> = {
  id: 'M31.A08',
  slug: 'coupons.restrict_coupon_to_products',
  module: MODULE,
  name: 'Restrict coupon to products',
  description: 'Restrict a coupon to only apply to specific products (empty = unrestricted).',
  risk: 'write',
  entities: ['structures', 'products'],
  inputSchema: restrictCouponToProductsInput,
  outputSchema: couponView,
  searchCard: {
    synonyms: ['limit coupon to products', 'restrict discount'],
    examplePhrasings: ['Only let this coupon apply to the Pro Plan'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCouponRow(ctx.db, input.id);
    for (const productId of input.product_ids) {
      const product = ctx.db.get(`SELECT id FROM products WHERE id = ?`, [productId]);
      if (!product) throw new ActionError('NOT_FOUND', `Product '${productId}' does not exist.`);
    }
    const config = readCouponConfig(row);
    writeCouponConfig(ctx.db, input.id, { ...config, product_ids: input.product_ids }, ctx.clock.now());
    return toView(ctx.db, getCouponRow(ctx.db, input.id));
  }),
};

// --- A09 validate_coupon_for_order (READ-ONLY dry run) -----------------------------------------------

const validateCouponForOrderInput = z.strictObject({ coupon_id: z.string(), order_id: z.string() });
const validationOutput = z.object({
  coupon_id: z.string(),
  order_id: z.string(),
  valid: z.boolean(),
  reason: z.string().nullable(),
  discount_type: z.string(),
  discount_value: z.number(),
});

const validateCouponForOrder: ActionDef<z.infer<typeof validateCouponForOrderInput>, z.infer<typeof validationOutput>> = {
  id: 'M31.A09',
  slug: 'coupons.validate_coupon_for_order',
  module: MODULE,
  name: 'Validate coupon for order',
  description:
    'Read-only dry run: checks a coupon is active, within its validity window, under its redemption limit, and (if restricted) applies to at least one of the order\'s products. Does NOT redeem — see orders.apply_coupon_to_order.',
  risk: 'read',
  entities: ['structures', 'orders', 'line_items', 'records'],
  inputSchema: validateCouponForOrderInput,
  outputSchema: validationOutput,
  searchCard: {
    synonyms: ['check coupon validity', 'is this coupon valid for this order'],
    examplePhrasings: ['Is this coupon valid for this order?'],
  },
  handler: async (input, ctx) => {
    const coupon = getCouponRow(ctx.db, input.coupon_id);
    const order = ctx.db.get(`SELECT id FROM orders WHERE id = ?`, [input.order_id]);
    if (!order) throw new ActionError('NOT_FOUND', `Order '${input.order_id}' does not exist.`);
    const config = readCouponConfig(coupon);
    const base = { coupon_id: input.coupon_id, order_id: input.order_id, discount_type: config.discount_type, discount_value: config.discount_value };

    if (coupon['status'] !== 'active') {
      return { ...base, valid: false, reason: `Coupon status is '${coupon['status'] as string}', not active.` };
    }
    const now = ctx.clock.now();
    if (config.valid_from !== null && now < config.valid_from) {
      return { ...base, valid: false, reason: 'Coupon is not yet valid.' };
    }
    if (config.valid_until !== null && now > config.valid_until) {
      return { ...base, valid: false, reason: 'Coupon has expired.' };
    }
    if (config.redemption_limit !== null) {
      const used = countCouponRedemptions(ctx.db, input.coupon_id);
      if (used >= config.redemption_limit) {
        return { ...base, valid: false, reason: `Coupon has reached its redemption limit (${config.redemption_limit}).` };
      }
    }
    if (config.product_ids.length > 0) {
      const lineRows = ctx.db.all(`SELECT product_id FROM line_items WHERE parent_type = 'order' AND parent_id = ?`, [input.order_id]);
      const matches = lineRows.some((r) => config.product_ids.includes(r['product_id'] as string));
      if (!matches) {
        return { ...base, valid: false, reason: "Coupon is restricted to products not present on this order." };
      }
    }
    return { ...base, valid: true, reason: null };
  },
};

// --- A10 deactivate_coupon -----------------------------------------------

const deactivateCouponInput = z.strictObject({ id: z.string() });

const deactivateCoupon: ActionDef<z.infer<typeof deactivateCouponInput>, CouponView> = {
  id: 'M31.A10',
  slug: 'coupons.deactivate_coupon',
  module: MODULE,
  name: 'Deactivate coupon',
  description: 'Deactivate a coupon so it can no longer be redeemed.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: deactivateCouponInput,
  outputSchema: couponView,
  searchCard: {
    synonyms: ['disable coupon', 'turn off coupon'],
    examplePhrasings: ['Deactivate this coupon'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCouponRow(ctx.db, input.id);
    if (row['status'] === 'disabled') {
      throw new ActionError('CONFLICT', `Coupon '${input.id}' is already disabled.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'disabled', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(ctx.db, getCouponRow(ctx.db, input.id));
  }),
};

export const m31Coupons: ActionDef[] = [
  createCoupon as ActionDef,
  getCouponDetails as ActionDef,
  searchCoupons as ActionDef,
  updateCouponDescription as ActionDef,
  setDiscountValue as ActionDef,
  setCouponValidityWindow as ActionDef,
  setRedemptionLimit as ActionDef,
  restrictCouponToProducts as ActionDef,
  validateCouponForOrder as ActionDef,
  deactivateCoupon as ActionDef,
];

/** Tier-A discrimination: `status` counts over 25 coupon rows (3-way
 * active/expired/disabled) — verified via live `npm run smoke` output:
 * 'active' → 8, 'expired' → 7. Thin universe, same category as M08 tags/
 * M16 workflows/M23 booking pages — re-verify if the seed's coupon count
 * or status distribution ever changes. */
export const m31DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'coupons.search_coupons',
    paramsA: { status: 'active' },
    paramsB: { status: 'expired' },
    expectDifferentCounts: true,
  },
];

/** `entities[0] === 'structures'` with `kind = 'coupon'` — every action on
 * this module's own `id` needs an action-scoped hint. */
export const m31SynthHints: SynthHints = {
  'coupons.get_coupon_details:id': { table: 'structures', kind: KIND },
  'coupons.update_coupon_description:id': { table: 'structures', kind: KIND },
  'coupons.set_discount_value:id': { table: 'structures', kind: KIND },
  'coupons.set_coupon_validity_window:id': { table: 'structures', kind: KIND },
  'coupons.set_redemption_limit:id': { table: 'structures', kind: KIND },
  'coupons.restrict_coupon_to_products:id': { table: 'structures', kind: KIND },
  'coupons.deactivate_coupon:id': { table: 'structures', kind: KIND },
};
