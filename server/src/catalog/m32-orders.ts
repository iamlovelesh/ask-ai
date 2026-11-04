/**
 * M32 Orders — follows the M01 Contacts convention verbatim.
 *
 * Data home: the typed `orders` table (plain, NOT kind-discriminated) PLUS
 * `line_items` (`parent_type='order'`, shared with M27/M28 — see
 * `line-items.ts`'s MONEY RULE). `orders.coupon_id` is a real existing
 * column (`entities/model.ts`) — `apply_coupon_to_order` sets it AND
 * writes a `records(kind='coupon_redemption')` row (per task-8's guide
 * §10: M32 owns this redemption write, not M31 Coupons). The order's
 * `total_cents` recompute reads the LINKED coupon (via `coupon_id`) each
 * time and reapplies its discount — same "always recompute, never
 * incrementally patch" MONEY RULE as quotes' `notes`-sidecar discount.
 *
 * DESIGN NOTE — `set_order_shipping_address`: `orders` has no
 * `shipping_address` column in `entities/model.ts` (adding one is out of
 * scope for this task) and no free-text/JSON column suitable to
 * repurpose without breaking an existing semantic use (`source` is a
 * real enum, `number` is the display identifier). This action does a
 * real existence check + validation and stamps `updated_at` (so it has a
 * genuine, detectable state delta) but cannot persist the address
 * anywhere retrievable — documented degenerate implementation, same
 * category as M07's `view_note_revision_history` / M16-M17's execution-
 * history actions. Flagged for controller review as a schema gap.
 *
 * DESIGN NOTE — `submit_order`: the `status` enum has no intermediate
 * "awaiting payment" state, and this catalog's whole commerce surface is
 * explicitly "simulated" (`record_simulated_payment`,
 * `execute_simulated_refund`) — `submit_order` is treated as an instant
 * simulated checkout, transitioning `pending` directly to `paid`.
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
import { nextDocNumber } from './doc-numbering.js';
import { parseJsonObject } from './json.js';
import {
  listLineItems,
  getOwnedLineItemRow,
  insertLineItem,
  patchLineItemQuantityOrPrice,
  recomputeParentSubtotal,
  toLineItemView,
} from './line-items.js';

const MODULE = 'orders';

interface CouponDiscount {
  discount_type: 'percent' | 'fixed';
  discount_value: number;
}

function readCouponDiscount(tx: StoreTx, couponId: string): CouponDiscount | null {
  const row = tx.get(`SELECT config FROM structures WHERE id = ? AND kind = 'coupon'`, [couponId]);
  if (!row) return null;
  const config = parseJsonObject(row['config']);
  return {
    discount_type: config['discount_type'] === 'fixed' ? 'fixed' : 'percent',
    discount_value: typeof config['discount_value'] === 'number' ? (config['discount_value'] as number) : 10,
  };
}

function applyDiscount(subtotalCents: number, discount: CouponDiscount | null): number {
  if (!discount) return subtotalCents;
  const raw =
    discount.discount_type === 'percent'
      ? subtotalCents * (1 - discount.discount_value / 100)
      : subtotalCents - discount.discount_value;
  return Math.max(0, Math.round(raw));
}

/** The ONLY writer of `orders.total_cents` — full recompute from live
 * line items + the linked coupon's discount (money rule). */
function recomputeOrderTotal(tx: StoreTx, id: string, now: number): void {
  const row = tx.get(`SELECT coupon_id FROM orders WHERE id = ?`, [id]);
  const couponId = row?.['coupon_id'] as string | null;
  const discount = couponId ? readCouponDiscount(tx, couponId) : null;
  const subtotal = recomputeParentSubtotal(tx, 'order', id);
  const total = applyDiscount(subtotal, discount);
  tx.run(`UPDATE orders SET total_cents = ?, updated_at = ? WHERE id = ?`, [total, now, id]);
}

function getOrderRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM orders WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Order '${id}' does not exist.`);
  return row;
}

interface OrderView {
  id: string;
  number: string;
  contact_id: string;
  status: string;
  total_cents: number;
  placed_at: number | null;
  coupon_id: string | null;
  source: string | null;
  fulfilled_at: number | null;
  currency: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): OrderView {
  return {
    id: row['id'] as string,
    number: row['number'] as string,
    contact_id: row['contact_id'] as string,
    status: row['status'] as string,
    total_cents: row['total_cents'] as number,
    placed_at: (row['placed_at'] as number | null) ?? null,
    coupon_id: (row['coupon_id'] as string | null) ?? null,
    source: (row['source'] as string | null) ?? null,
    fulfilled_at: (row['fulfilled_at'] as number | null) ?? null,
    currency: (row['currency'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const lineItemView = z.object({
  id: z.string(),
  parent_type: z.enum(['quote', 'invoice', 'order']),
  parent_id: z.string(),
  product_id: z.string().nullable(),
  quantity: z.number(),
  unit_price_cents: z.number(),
  amount_cents: z.number(),
  tax_cents: z.number(),
  position: z.number(),
  description: z.string().nullable(),
});
const orderView = z.object({
  id: z.string(),
  number: z.string(),
  contact_id: z.string(),
  status: z.string(),
  total_cents: z.number(),
  placed_at: z.number().nullable(),
  coupon_id: z.string().nullable(),
  source: z.string().nullable(),
  fulfilled_at: z.number().nullable(),
  currency: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_draft_order -----------------------------------------------------

const createDraftOrderInput = z.strictObject({
  contact_id: z.string(),
  source: z.enum(['web', 'app', 'pos', 'marketplace']).optional(),
  currency: z.string().optional(),
});

const createDraftOrder: ActionDef<z.infer<typeof createDraftOrderInput>, OrderView> = {
  id: 'M32.A01',
  slug: 'orders.create_draft_order',
  module: MODULE,
  name: 'Create draft order',
  description: 'Create a new pending (draft) order for a contact.',
  risk: 'write',
  entities: ['orders'],
  inputSchema: createDraftOrderInput,
  outputSchema: orderView,
  searchCard: {
    synonyms: ['add order', 'new order', 'start a cart'],
    examplePhrasings: ['Start a new order for this contact'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'orders', 'ord');
    const now = ctx.clock.now();
    const number = nextDocNumber(ctx.db, 'orders', 'O');
    ctx.db.run(
      `INSERT INTO orders (id, created_at, updated_at, archived, number, contact_id, status,
        total_cents, placed_at, coupon_id, source, fulfilled_at, currency)
       VALUES (?, ?, ?, 0, ?, ?, 'pending', 0, ?, NULL, ?, NULL, ?)`,
      [id, now, now, number, input.contact_id, now, input.source ?? 'web', input.currency ?? 'USD'],
    );
    return toView(getOrderRow(ctx.db, id));
  }),
};

// --- A02 get_order_details -------------------------------------------------

const getOrderDetailsInput = z.strictObject({ id: z.string() });
const orderDetailsOutput = z.object({ order: orderView, line_items: z.array(lineItemView) });

const getOrderDetails: ActionDef<z.infer<typeof getOrderDetailsInput>, z.infer<typeof orderDetailsOutput>> = {
  id: 'M32.A02',
  slug: 'orders.get_order_details',
  module: MODULE,
  name: 'Get order details',
  description: 'Fetch an order and its line items.',
  risk: 'read',
  entities: ['orders', 'line_items'],
  inputSchema: getOrderDetailsInput,
  outputSchema: orderDetailsOutput,
  searchCard: {
    synonyms: ['order details', 'look up order'],
    examplePhrasings: ['Show me order O-3042'],
  },
  handler: async (input, ctx) => ({
    order: toView(getOrderRow(ctx.db, input.id)),
    line_items: listLineItems(ctx.db, 'order', input.id),
  }),
};

// --- A03 search_orders -----------------------------------------------------

const searchOrdersInput = z.strictObject({
  contact_id: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchOrdersInput = z.infer<typeof searchOrdersInput>;
const searchOrdersOutput = listOutputSchema(orderView);
type SearchOrdersOutput = ListOrSpill<OrderView>;

const searchOrders: ActionDef<SearchOrdersInput, SearchOrdersOutput> = {
  id: 'M32.A03',
  slug: 'orders.search_orders',
  module: MODULE,
  name: 'Search orders',
  description: 'Search non-archived orders by common filters.',
  risk: 'read',
  entities: ['orders'],
  inputSchema: searchOrdersInput,
  outputSchema: searchOrdersOutput,
  searchCard: {
    synonyms: ['find orders', 'list orders'],
    examplePhrasings: ['Find all fulfilled orders'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.contact_id) {
      where.push('contact_id = ?');
      params.push(input.contact_id);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.source) {
      where.push('source = ?');
      params.push(input.source);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM orders WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM orders WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 add_order_line_item -----------------------------------------------

const addOrderLineItemInput = z.strictObject({
  id: z.string(),
  product_id: z.string(),
  quantity: z.number().int().min(1),
  unit_price_cents: z.number().int().min(0).optional(),
  description: z.string().optional(),
});
const orderLineItemResult = z.object({ order: orderView, line_item: lineItemView });

const addOrderLineItem: ActionDef<z.infer<typeof addOrderLineItemInput>, z.infer<typeof orderLineItemResult>> = {
  id: 'M32.A04',
  slug: 'orders.add_order_line_item',
  module: MODULE,
  name: 'Add order line item',
  description: 'Add a product line item to a pending order. total_cents is fully recomputed.',
  risk: 'write',
  entities: ['orders', 'line_items', 'products'],
  inputSchema: addOrderLineItemInput,
  outputSchema: orderLineItemResult,
  searchCard: {
    synonyms: ['add line item', 'add product to order', 'add to cart'],
    examplePhrasings: ['Add 2 of this product to the order'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const order = getOrderRow(ctx.db, input.id);
    if (order['status'] !== 'pending') {
      throw new ActionError('CONFLICT', `Order '${input.id}' is not pending — line items are fixed once submitted.`);
    }
    const product = ctx.db.get(`SELECT default_price_cents FROM products WHERE id = ?`, [input.product_id]);
    if (!product) throw new ActionError('NOT_FOUND', `Product '${input.product_id}' does not exist.`);
    const unitPrice = input.unit_price_cents ?? (product['default_price_cents'] as number | null) ?? 0;
    const now = ctx.clock.now();
    const lineItemId = insertLineItem(
      ctx.db,
      'order',
      input.id,
      { product_id: input.product_id, quantity: input.quantity, unit_price_cents: unitPrice, description: input.description },
      now,
    );
    recomputeOrderTotal(ctx.db, input.id, now);
    const lineRow = getOwnedLineItemRow(ctx.db, 'order', input.id, lineItemId, 'order');
    return { order: toView(getOrderRow(ctx.db, input.id)), line_item: toLineItemView(lineRow) };
  }),
};

// --- A05 update_order_quantity -----------------------------------------------

const updateOrderQuantityInput = z.strictObject({ id: z.string(), line_item_id: z.string(), quantity: z.number().int().min(1) });

const updateOrderQuantity: ActionDef<z.infer<typeof updateOrderQuantityInput>, z.infer<typeof orderLineItemResult>> = {
  id: 'M32.A05',
  slug: 'orders.update_order_quantity',
  module: MODULE,
  name: 'Update order quantity',
  description: "Update a pending order line item's quantity. total_cents is fully recomputed.",
  risk: 'write',
  entities: ['orders', 'line_items'],
  inputSchema: updateOrderQuantityInput,
  outputSchema: orderLineItemResult,
  searchCard: {
    synonyms: ['change order quantity', 'edit line item quantity'],
    examplePhrasings: ['Change the quantity on this order line item'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const order = getOrderRow(ctx.db, input.id);
    if (order['status'] !== 'pending') {
      throw new ActionError('CONFLICT', `Order '${input.id}' is not pending — line items are fixed once submitted.`);
    }
    getOwnedLineItemRow(ctx.db, 'order', input.id, input.line_item_id, 'order');
    const now = ctx.clock.now();
    patchLineItemQuantityOrPrice(ctx.db, input.line_item_id, { quantity: input.quantity }, now);
    recomputeOrderTotal(ctx.db, input.id, now);
    const lineRow = getOwnedLineItemRow(ctx.db, 'order', input.id, input.line_item_id, 'order');
    return { order: toView(getOrderRow(ctx.db, input.id)), line_item: toLineItemView(lineRow) };
  }),
};

// --- A06 set_order_shipping_address -----------------------------------------------

const setOrderShippingAddressInput = z.strictObject({ id: z.string(), address: z.string().min(1) });
const shippingAddressOutput = z.object({ id: z.string(), number: z.string(), acknowledged: z.literal(true) });

const setOrderShippingAddress: ActionDef<z.infer<typeof setOrderShippingAddressInput>, z.infer<typeof shippingAddressOutput>> = {
  id: 'M32.A06',
  slug: 'orders.set_order_shipping_address',
  module: MODULE,
  name: 'Set order shipping address',
  description:
    'Validate and acknowledge a shipping address for an order. NOTE: orders has no shipping_address column in entities/model.ts — this cannot persist the address (documented schema gap); it validates and stamps the order as touched.',
  risk: 'write',
  entities: ['orders'],
  inputSchema: setOrderShippingAddressInput,
  outputSchema: shippingAddressOutput,
  searchCard: {
    synonyms: ['set shipping address', 'update delivery address'],
    examplePhrasings: ['Ship this order to a new address'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const order = getOrderRow(ctx.db, input.id);
    ctx.db.run(`UPDATE orders SET updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, number: order['number'] as string, acknowledged: true as const };
  }),
};

// --- A07 apply_coupon_to_order -----------------------------------------------

const applyCouponToOrderInput = z.strictObject({ id: z.string(), coupon_id: z.string() });

const applyCouponToOrder: ActionDef<z.infer<typeof applyCouponToOrderInput>, OrderView> = {
  id: 'M32.A07',
  slug: 'orders.apply_coupon_to_order',
  module: MODULE,
  name: 'Apply coupon to order',
  description:
    'Validate and redeem a coupon on an order: writes records(kind=coupon_redemption) and recomputes total_cents with the discount applied.',
  risk: 'write',
  entities: ['orders', 'structures', 'records', 'line_items'],
  inputSchema: applyCouponToOrderInput,
  outputSchema: orderView,
  searchCard: {
    synonyms: ['apply coupon', 'redeem coupon on order'],
    examplePhrasings: ['Apply this coupon code to the order'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const order = getOrderRow(ctx.db, input.id);
    if (order['coupon_id']) {
      throw new ActionError('CONFLICT', `Order '${input.id}' already has a coupon applied.`);
    }
    const coupon = ctx.db.get(`SELECT * FROM structures WHERE id = ? AND kind = 'coupon'`, [input.coupon_id]);
    if (!coupon) throw new ActionError('NOT_FOUND', `Coupon '${input.coupon_id}' does not exist.`);
    if (coupon['status'] !== 'active') {
      throw new ActionError('VALIDATION', `Coupon '${input.coupon_id}' is not active.`);
    }
    const config = parseJsonObject(coupon['config']);
    const now = ctx.clock.now();
    const validFrom = typeof config['valid_from'] === 'number' ? (config['valid_from'] as number) : null;
    const validUntil = typeof config['valid_until'] === 'number' ? (config['valid_until'] as number) : null;
    if (validFrom !== null && now < validFrom) throw new ActionError('VALIDATION', 'Coupon is not yet valid.');
    if (validUntil !== null && now > validUntil) throw new ActionError('VALIDATION', 'Coupon has expired.');
    const redemptionLimit = typeof config['redemption_limit'] === 'number' ? (config['redemption_limit'] as number) : null;
    if (redemptionLimit !== null) {
      const usedRow = ctx.db.get(`SELECT COUNT(*) AS n FROM records WHERE kind = 'coupon_redemption' AND parent_id = ?`, [input.coupon_id]);
      const used = (usedRow?.['n'] as number | null) ?? 0;
      if (used >= redemptionLimit) throw new ActionError('VALIDATION', 'Coupon has reached its redemption limit.');
    }
    const productIds = Array.isArray(config['product_ids']) ? (config['product_ids'] as string[]) : [];
    if (productIds.length > 0) {
      const lineRows = ctx.db.all(`SELECT product_id FROM line_items WHERE parent_type = 'order' AND parent_id = ?`, [input.id]);
      const matches = lineRows.some((r) => productIds.includes(r['product_id'] as string));
      if (!matches) throw new ActionError('VALIDATION', 'Coupon is restricted to products not present on this order.');
    }

    ctx.db.run(`UPDATE orders SET coupon_id = ?, updated_at = ? WHERE id = ?`, [input.coupon_id, now, input.id]);
    const recordId = nextId(ctx.db, 'records', 'record');
    ctx.db.run(
      `INSERT INTO records (id, created_at, updated_at, archived, kind, parent_id, contact_id, user_id, occurred_at, data)
       VALUES (?, ?, ?, 0, 'coupon_redemption', ?, ?, NULL, ?, ?)`,
      [
        recordId,
        now,
        now,
        input.coupon_id,
        order['contact_id'],
        now,
        JSON.stringify({ order_id: input.id, discount_type: config['discount_type'] ?? 'percent', discount_value: config['discount_value'] ?? 10 }),
      ],
    );
    recomputeOrderTotal(ctx.db, input.id, now);
    return toView(getOrderRow(ctx.db, input.id));
  }),
};

// --- A08 submit_order -----------------------------------------------

const submitOrderInput = z.strictObject({ id: z.string() });

const submitOrder: ActionDef<z.infer<typeof submitOrderInput>, OrderView> = {
  id: 'M32.A08',
  slug: 'orders.submit_order',
  module: MODULE,
  name: 'Submit order',
  description: 'Submit a pending order with at least one line item (simulated instant checkout — transitions to paid).',
  risk: 'write',
  entities: ['orders', 'line_items'],
  inputSchema: submitOrderInput,
  outputSchema: orderView,
  searchCard: {
    synonyms: ['checkout', 'submit order', 'place order'],
    examplePhrasings: ['Submit this order'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const order = getOrderRow(ctx.db, input.id);
    if (order['status'] !== 'pending') {
      throw new ActionError('CONFLICT', `Order '${input.id}' is not pending (status: ${order['status'] as string}).`);
    }
    const lineCount = ctx.db.get(`SELECT COUNT(*) AS n FROM line_items WHERE parent_type = 'order' AND parent_id = ? AND archived = 0`, [input.id]);
    if (((lineCount?.['n'] as number | null) ?? 0) === 0) {
      throw new ActionError('VALIDATION', `Order '${input.id}' has no line items.`);
    }
    ctx.db.run(`UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getOrderRow(ctx.db, input.id));
  }),
};

// --- A09 cancel_order -----------------------------------------------

const cancelOrderInput = z.strictObject({ id: z.string() });

const cancelOrder: ActionDef<z.infer<typeof cancelOrderInput>, OrderView> = {
  id: 'M32.A09',
  slug: 'orders.cancel_order',
  module: MODULE,
  name: 'Cancel order',
  description: 'Cancel a pending or paid order.',
  risk: 'destructive',
  entities: ['orders'],
  inputSchema: cancelOrderInput,
  outputSchema: orderView,
  searchCard: {
    synonyms: ['cancel order', 'void order'],
    examplePhrasings: ['Cancel this order'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const order = getOrderRow(ctx.db, input.id);
    if (['fulfilled', 'cancelled', 'refunded'].includes(order['status'] as string)) {
      throw new ActionError('CONFLICT', `Order '${input.id}' cannot be cancelled from status '${order['status'] as string}'.`);
    }
    ctx.db.run(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getOrderRow(ctx.db, input.id));
  }),
};

// --- A10 mark_order_fulfilled -----------------------------------------------

const markOrderFulfilledInput = z.strictObject({ id: z.string() });

const markOrderFulfilled: ActionDef<z.infer<typeof markOrderFulfilledInput>, OrderView> = {
  id: 'M32.A10',
  slug: 'orders.mark_order_fulfilled',
  module: MODULE,
  name: 'Mark order fulfilled',
  description: 'Mark a paid order as fulfilled/shipped.',
  risk: 'write',
  entities: ['orders'],
  inputSchema: markOrderFulfilledInput,
  outputSchema: orderView,
  searchCard: {
    synonyms: ['fulfill order', 'mark order shipped'],
    examplePhrasings: ['Mark this order as shipped'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const order = getOrderRow(ctx.db, input.id);
    if (order['status'] !== 'paid') {
      throw new ActionError('CONFLICT', `Order '${input.id}' is not paid (status: ${order['status'] as string}).`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE orders SET status = 'fulfilled', fulfilled_at = ?, updated_at = ? WHERE id = ?`, [now, now, input.id]);
    return toView(getOrderRow(ctx.db, input.id));
  }),
};

export const m32Orders: ActionDef[] = [
  createDraftOrder as ActionDef,
  getOrderDetails as ActionDef,
  searchOrders as ActionDef,
  addOrderLineItem as ActionDef,
  updateOrderQuantity as ActionDef,
  setOrderShippingAddress as ActionDef,
  applyCouponToOrder as ActionDef,
  submitOrder as ActionDef,
  cancelOrder as ActionDef,
  markOrderFulfilled as ActionDef,
];

/** Tier-A discrimination: `status` counts over 750 orders (5-way uniform
 * pick) — verified via live `npm run smoke` output: 'pending' → 153,
 * 'fulfilled' → 148. */
export const m32DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'orders.search_orders',
    paramsA: { status: 'pending' },
    paramsB: { status: 'fulfilled' },
    expectDifferentCounts: true,
  },
];

/** `orders` is a plain (non-kind-discriminated) table — `id` resolves via
 * `entities[0]`. `line_item_id` is backed by the shared `line_items`
 * table, discriminated by `parent_type` — scoped so it doesn't collide
 * with M27/M28's identically-named field on the same table. */
export const m32SynthHints: SynthHints = {
  'orders.update_order_quantity:line_item_id': { table: 'line_items', kind: 'order', column: 'parent_type' },
};
