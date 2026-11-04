/**
 * M30 Subscriptions — follows the M01 Contacts convention verbatim.
 *
 * Data home: the typed `subscriptions` table (plain, NOT kind-
 * discriminated — the bare `id` field resolves correctly via
 * `entities[0]`, no synthHint needed).
 *
 * DESIGN NOTE — `quantity` has no dedicated column. `update_subscription_
 * quantity` treats `subscriptions.amount_cents` as the authoritative
 * recurring charge and recomputes it as `linkedProduct.default_price_cents
 * * quantity` at write time — `quantity` itself is never separately
 * persisted, only its EFFECT on `amount_cents` is, which is the only
 * thing `preview_next_subscription_invoice` (money/billing preview) ever
 * actually needs to read back. This is a modeling simplification (no
 * schema hack / sidecar needed, unlike quotes.notes or payments.reference
 * elsewhere in this batch) — flagged for controller review.
 *
 * DESIGN NOTE — `trial_end` reuses `current_period_end` while
 * `status='trialing'`: the "current period" DURING a trial IS the trial
 * period, so there is no separate column needed; `set_subscription_
 * trial_end` is guarded to only apply while trialing.
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

const MODULE = 'subscriptions';
const INTERVAL_MS: Record<string, number> = {
  day: 1000 * 60 * 60 * 24,
  week: 1000 * 60 * 60 * 24 * 7,
  month: 1000 * 60 * 60 * 24 * 30,
  year: 1000 * 60 * 60 * 24 * 365,
};

function getSubscriptionRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM subscriptions WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Subscription '${id}' does not exist.`);
  return row;
}

function getProductDefaultPrice(db: StoreTx, productId: string): number {
  const row = db.get(`SELECT default_price_cents FROM products WHERE id = ?`, [productId]);
  if (!row) throw new ActionError('NOT_FOUND', `Product '${productId}' does not exist.`);
  return (row['default_price_cents'] as number | null) ?? 0;
}

interface SubscriptionView {
  id: string;
  contact_id: string;
  product_id: string;
  status: string;
  interval: string;
  amount_cents: number | null;
  current_period_start: number | null;
  current_period_end: number | null;
  started_at: number | null;
  coupon_id: string | null;
  cancelled_at: number | null;
  currency: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): SubscriptionView {
  return {
    id: row['id'] as string,
    contact_id: row['contact_id'] as string,
    product_id: row['product_id'] as string,
    status: row['status'] as string,
    interval: row['interval'] as string,
    amount_cents: (row['amount_cents'] as number | null) ?? null,
    current_period_start: (row['current_period_start'] as number | null) ?? null,
    current_period_end: (row['current_period_end'] as number | null) ?? null,
    started_at: (row['started_at'] as number | null) ?? null,
    coupon_id: (row['coupon_id'] as string | null) ?? null,
    cancelled_at: (row['cancelled_at'] as number | null) ?? null,
    currency: (row['currency'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const subscriptionView = z.object({
  id: z.string(),
  contact_id: z.string(),
  product_id: z.string(),
  status: z.string(),
  interval: z.string(),
  amount_cents: z.number().nullable(),
  current_period_start: z.number().nullable(),
  current_period_end: z.number().nullable(),
  started_at: z.number().nullable(),
  coupon_id: z.string().nullable(),
  cancelled_at: z.number().nullable(),
  currency: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_subscription -----------------------------------------------------

const createSubscriptionInput = z.strictObject({
  contact_id: z.string(),
  product_id: z.string(),
  interval: z.enum(['day', 'week', 'month', 'year']).optional(),
  amount_cents: z.number().int().min(0).optional(),
  coupon_id: z.string().optional(),
  currency: z.string().optional(),
});

const createSubscription: ActionDef<z.infer<typeof createSubscriptionInput>, SubscriptionView> = {
  id: 'M30.A01',
  slug: 'subscriptions.create_subscription',
  module: MODULE,
  name: 'Create subscription',
  description: 'Create a new subscription for a contact in trialing status.',
  risk: 'write',
  entities: ['subscriptions', 'products'],
  inputSchema: createSubscriptionInput,
  outputSchema: subscriptionView,
  searchCard: {
    synonyms: ['add subscription', 'new subscription'],
    examplePhrasings: ['Start a subscription for this contact'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const defaultPrice = getProductDefaultPrice(ctx.db, input.product_id);
    const id = nextId(ctx.db, 'subscriptions', 'sub');
    const now = ctx.clock.now();
    const interval = input.interval ?? 'month';
    const periodMs = INTERVAL_MS[interval] ?? INTERVAL_MS['month'];
    ctx.db.run(
      `INSERT INTO subscriptions (id, created_at, updated_at, archived, contact_id, product_id, status,
        interval, amount_cents, current_period_start, current_period_end, started_at, coupon_id,
        cancelled_at, currency)
       VALUES (?, ?, ?, 0, ?, ?, 'trialing', ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        id,
        now,
        now,
        input.contact_id,
        input.product_id,
        interval,
        input.amount_cents ?? defaultPrice,
        now,
        now + (periodMs as number),
        now,
        input.coupon_id ?? null,
        input.currency ?? 'USD',
      ],
    );
    return toView(getSubscriptionRow(ctx.db, id));
  }),
};

// --- A02 get_subscription_details -------------------------------------------------

const getSubscriptionDetailsInput = z.strictObject({ id: z.string() });

const getSubscriptionDetails: ActionDef<z.infer<typeof getSubscriptionDetailsInput>, SubscriptionView> = {
  id: 'M30.A02',
  slug: 'subscriptions.get_subscription_details',
  module: MODULE,
  name: 'Get subscription details',
  description: 'Fetch a subscription by id.',
  risk: 'read',
  entities: ['subscriptions'],
  inputSchema: getSubscriptionDetailsInput,
  outputSchema: subscriptionView,
  searchCard: {
    synonyms: ['subscription details', 'look up subscription'],
    examplePhrasings: ['Show me this subscription'],
  },
  handler: async (input, ctx) => toView(getSubscriptionRow(ctx.db, input.id)),
};

// --- A03 search_subscriptions -------------------------------------------------

const searchSubscriptionsInput = z.strictObject({
  contact_id: z.string().optional(),
  status: z.string().optional(),
  product_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchSubscriptionsInput = z.infer<typeof searchSubscriptionsInput>;
const searchSubscriptionsOutput = listOutputSchema(subscriptionView);
type SearchSubscriptionsOutput = ListOrSpill<SubscriptionView>;

const searchSubscriptions: ActionDef<SearchSubscriptionsInput, SearchSubscriptionsOutput> = {
  id: 'M30.A03',
  slug: 'subscriptions.search_subscriptions',
  module: MODULE,
  name: 'Search subscriptions',
  description: 'Search non-archived subscriptions by common filters.',
  risk: 'read',
  entities: ['subscriptions'],
  inputSchema: searchSubscriptionsInput,
  outputSchema: searchSubscriptionsOutput,
  searchCard: {
    synonyms: ['find subscriptions', 'list subscriptions'],
    examplePhrasings: ['Find all active subscriptions'],
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
    if (input.product_id) {
      where.push('product_id = ?');
      params.push(input.product_id);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM subscriptions WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM subscriptions WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 change_subscription_plan -------------------------------------------------

const changeSubscriptionPlanInput = z.strictObject({ id: z.string(), product_id: z.string(), amount_cents: z.number().int().min(0).optional() });

const changeSubscriptionPlan: ActionDef<z.infer<typeof changeSubscriptionPlanInput>, SubscriptionView> = {
  id: 'M30.A04',
  slug: 'subscriptions.change_subscription_plan',
  module: MODULE,
  name: 'Change subscription plan',
  description: "Switch a subscription to a different product/plan.",
  risk: 'write',
  entities: ['subscriptions', 'products'],
  inputSchema: changeSubscriptionPlanInput,
  outputSchema: subscriptionView,
  searchCard: {
    synonyms: ['change plan', 'upgrade subscription', 'downgrade subscription'],
    examplePhrasings: ['Move this subscription to the Pro plan'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const sub = getSubscriptionRow(ctx.db, input.id);
    if (sub['status'] === 'cancelled') {
      throw new ActionError('CONFLICT', `Subscription '${input.id}' is cancelled.`);
    }
    const defaultPrice = getProductDefaultPrice(ctx.db, input.product_id);
    ctx.db.run(`UPDATE subscriptions SET product_id = ?, amount_cents = ?, updated_at = ? WHERE id = ?`, [
      input.product_id,
      input.amount_cents ?? defaultPrice,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getSubscriptionRow(ctx.db, input.id));
  }),
};

// --- A05 update_subscription_quantity -------------------------------------------------

const updateSubscriptionQuantityInput = z.strictObject({ id: z.string(), quantity: z.number().int().min(1) });
const quantityResultOutput = z.object({ subscription: subscriptionView, quantity: z.number() });

const updateSubscriptionQuantity: ActionDef<z.infer<typeof updateSubscriptionQuantityInput>, z.infer<typeof quantityResultOutput>> = {
  id: 'M30.A05',
  slug: 'subscriptions.update_subscription_quantity',
  module: MODULE,
  name: 'Update subscription quantity',
  description:
    "Rescale a subscription's recurring charge for a new seat/unit quantity (amount_cents = product.default_price_cents * quantity).",
  risk: 'write',
  entities: ['subscriptions', 'products'],
  inputSchema: updateSubscriptionQuantityInput,
  outputSchema: quantityResultOutput,
  searchCard: {
    synonyms: ['change seat count', 'update quantity'],
    examplePhrasings: ['This customer now has 5 seats instead of 3'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const sub = getSubscriptionRow(ctx.db, input.id);
    const unitPrice = getProductDefaultPrice(ctx.db, sub['product_id'] as string);
    const amountCents = unitPrice * input.quantity;
    ctx.db.run(`UPDATE subscriptions SET amount_cents = ?, updated_at = ? WHERE id = ?`, [
      amountCents,
      ctx.clock.now(),
      input.id,
    ]);
    return { subscription: toView(getSubscriptionRow(ctx.db, input.id)), quantity: input.quantity };
  }),
};

// --- A06 set_subscription_trial_end -------------------------------------------------

const setSubscriptionTrialEndInput = z.strictObject({ id: z.string(), trial_end: z.number().int().min(0) });

const setSubscriptionTrialEnd: ActionDef<z.infer<typeof setSubscriptionTrialEndInput>, SubscriptionView> = {
  id: 'M30.A06',
  slug: 'subscriptions.set_subscription_trial_end',
  module: MODULE,
  name: 'Set subscription trial end',
  description: "Set when a trialing subscription's trial ends (stored as current_period_end while trialing).",
  risk: 'write',
  entities: ['subscriptions'],
  inputSchema: setSubscriptionTrialEndInput,
  outputSchema: subscriptionView,
  searchCard: {
    synonyms: ['extend trial', 'set trial end date', 'more time before we start charging their card'],
    examplePhrasings: [
      "Extend this customer's trial by a week",
      'Give this subscriber more time before we start charging their card',
    ],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const sub = getSubscriptionRow(ctx.db, input.id);
    if (sub['status'] !== 'trialing') {
      throw new ActionError('CONFLICT', `Subscription '${input.id}' is not trialing (status: ${sub['status'] as string}).`);
    }
    ctx.db.run(`UPDATE subscriptions SET current_period_end = ?, updated_at = ? WHERE id = ?`, [
      input.trial_end,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getSubscriptionRow(ctx.db, input.id));
  }),
};

// --- A07 pause_subscription -------------------------------------------------

const pauseSubscriptionInput = z.strictObject({ id: z.string() });

const pauseSubscription: ActionDef<z.infer<typeof pauseSubscriptionInput>, SubscriptionView> = {
  id: 'M30.A07',
  slug: 'subscriptions.pause_subscription',
  module: MODULE,
  name: 'Pause subscription',
  description: 'Pause an active subscription.',
  risk: 'write',
  entities: ['subscriptions'],
  inputSchema: pauseSubscriptionInput,
  outputSchema: subscriptionView,
  searchCard: {
    synonyms: ['pause subscription', 'put subscription on hold'],
    examplePhrasings: ['Pause this subscription for now'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const sub = getSubscriptionRow(ctx.db, input.id);
    if (sub['status'] !== 'active') {
      throw new ActionError('CONFLICT', `Subscription '${input.id}' is not active (status: ${sub['status'] as string}).`);
    }
    ctx.db.run(`UPDATE subscriptions SET status = 'paused', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getSubscriptionRow(ctx.db, input.id));
  }),
};

// --- A08 resume_subscription -------------------------------------------------

const resumeSubscriptionInput = z.strictObject({ id: z.string() });

const resumeSubscription: ActionDef<z.infer<typeof resumeSubscriptionInput>, SubscriptionView> = {
  id: 'M30.A08',
  slug: 'subscriptions.resume_subscription',
  module: MODULE,
  name: 'Resume subscription',
  description: 'Resume a paused subscription.',
  risk: 'write',
  entities: ['subscriptions'],
  inputSchema: resumeSubscriptionInput,
  outputSchema: subscriptionView,
  searchCard: {
    synonyms: ['resume subscription', 'unpause subscription'],
    examplePhrasings: ['Resume this paused subscription'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const sub = getSubscriptionRow(ctx.db, input.id);
    if (sub['status'] !== 'paused') {
      throw new ActionError('CONFLICT', `Subscription '${input.id}' is not paused (status: ${sub['status'] as string}).`);
    }
    ctx.db.run(`UPDATE subscriptions SET status = 'active', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getSubscriptionRow(ctx.db, input.id));
  }),
};

// --- A09 cancel_subscription -------------------------------------------------

const cancelSubscriptionInput = z.strictObject({ id: z.string() });

const cancelSubscription: ActionDef<z.infer<typeof cancelSubscriptionInput>, SubscriptionView> = {
  id: 'M30.A09',
  slug: 'subscriptions.cancel_subscription',
  module: MODULE,
  name: 'Cancel subscription',
  description: 'Cancel a subscription.',
  risk: 'destructive',
  entities: ['subscriptions'],
  inputSchema: cancelSubscriptionInput,
  outputSchema: subscriptionView,
  searchCard: {
    synonyms: ['cancel subscription', 'end subscription'],
    examplePhrasings: ['Cancel this subscription, the customer is churning'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const sub = getSubscriptionRow(ctx.db, input.id);
    if (sub['status'] === 'cancelled') {
      throw new ActionError('CONFLICT', `Subscription '${input.id}' is already cancelled.`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      input.id,
    ]);
    return toView(getSubscriptionRow(ctx.db, input.id));
  }),
};

// --- A10 preview_next_subscription_invoice -------------------------------------------------

const previewNextSubscriptionInvoiceInput = z.strictObject({ id: z.string() });
const previewOutput = z.object({
  id: z.string(),
  product_id: z.string(),
  amount_cents: z.number().nullable(),
  unit_price_cents: z.number(),
  currency: z.string().nullable(),
  interval: z.string(),
  next_period_start: z.number().nullable(),
  next_period_end: z.number().nullable(),
});

const previewNextSubscriptionInvoice: ActionDef<
  z.infer<typeof previewNextSubscriptionInvoiceInput>,
  z.infer<typeof previewOutput>
> = {
  id: 'M30.A10',
  slug: 'subscriptions.preview_next_subscription_invoice',
  module: MODULE,
  name: 'Preview next subscription invoice',
  description: "Compute the amount and period of a subscription's next invoice from its price and quantity-adjusted amount_cents. Pure read.",
  risk: 'read',
  entities: ['subscriptions', 'products'],
  inputSchema: previewNextSubscriptionInvoiceInput,
  outputSchema: previewOutput,
  searchCard: {
    synonyms: ['preview next charge', 'what will this customer be billed'],
    examplePhrasings: ["What's this subscription's next invoice amount?"],
  },
  handler: async (input, ctx) => {
    const sub = getSubscriptionRow(ctx.db, input.id);
    const unitPrice = getProductDefaultPrice(ctx.db, sub['product_id'] as string);
    const periodMs = INTERVAL_MS[sub['interval'] as string] ?? INTERVAL_MS['month'];
    const periodEnd = (sub['current_period_end'] as number | null) ?? ctx.clock.now();
    return {
      id: input.id,
      product_id: sub['product_id'] as string,
      amount_cents: (sub['amount_cents'] as number | null) ?? null,
      unit_price_cents: unitPrice,
      currency: (sub['currency'] as string | null) ?? null,
      interval: sub['interval'] as string,
      next_period_start: periodEnd,
      next_period_end: periodEnd + (periodMs as number),
    };
  },
};

export const m30Subscriptions: ActionDef[] = [
  createSubscription as ActionDef,
  getSubscriptionDetails as ActionDef,
  searchSubscriptions as ActionDef,
  changeSubscriptionPlan as ActionDef,
  updateSubscriptionQuantity as ActionDef,
  setSubscriptionTrialEnd as ActionDef,
  pauseSubscription as ActionDef,
  resumeSubscription as ActionDef,
  cancelSubscription as ActionDef,
  previewNextSubscriptionInvoice as ActionDef,
];

/** Tier-A discrimination: `status` counts over 260 subscriptions —
 * verified via live `npm run smoke` output: 'active' → 154, 'cancelled' →
 * 48. */
export const m30DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'subscriptions.search_subscriptions',
    paramsA: { status: 'active' },
    paramsB: { status: 'cancelled' },
    expectDifferentCounts: true,
  },
];

/** `subscriptions` is a plain (non-kind-discriminated) table — every id
 * field resolves correctly via `entities[0]`/`DEFAULT_HINTS` (`product_id`
 * → products, `coupon_id` → structures/coupon already built in). */
export const m30SynthHints: SynthHints = {};
