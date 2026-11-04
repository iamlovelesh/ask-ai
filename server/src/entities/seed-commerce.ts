/**
 * Catalog + money: products, quotes/invoices/orders (+ their `line_items`),
 * subscriptions, payments/refunds.
 *
 * Invoices carry the "scenario-material guarantee": at least `minOverdue`
 * invoices with status `issued` and `due_date` more than 15 days before now.
 */

import type { SeedCtx } from './seed-context.js';
import { insert, nextId, pastTimestamp, pick, chance, weightedPick } from './seed-context.js';
import { PRODUCT_WORDS } from './seed-data.js';

const DAY_MS = 1000 * 60 * 60 * 24;

export function generateProducts(ctx: SeedCtx, count: number): { ids: string[]; priceByProduct: Map<string, number> } {
  const ids: string[] = [];
  const priceByProduct = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'prod');
    const name = `${pick(ctx, PRODUCT_WORDS)} ${pick(ctx, PRODUCT_WORDS)}`;
    const price = 10_00 + ctx.rng.int(990_00);
    const createdAt = pastTimestamp(ctx, 600, 0);
    priceByProduct.set(id, price);
    insert(ctx, 'products', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      name,
      sku: `SKU-${id}`,
      type: pick(ctx, ['physical', 'digital', 'service']),
      status: chance(ctx, 0.85) ? 'active' : 'archived',
      category: pick(ctx, PRODUCT_WORDS),
      default_price_cents: price,
      currency: 'USD',
      prices: JSON.stringify([{ id: `${id}_p1`, amount_cents: price, currency: 'USD', interval: 'month' }]),
      description: `${name} — seeded product.`,
    });
    ids.push(id);
  }
  return { ids, priceByProduct };
}

/** Inserts `line_items` for a parent doc and returns the summed total. */
function generateLineItems(
  ctx: SeedCtx,
  parentType: 'quote' | 'invoice' | 'order',
  parentId: string,
  productIds: string[],
  priceByProduct: Map<string, number>,
  createdAt: number,
): number {
  const count = 1 + ctx.rng.int(3);
  let total = 0;
  for (let pos = 0; pos < count; pos++) {
    const id = nextId(ctx, 'li');
    const productId = pick(ctx, productIds);
    const unitPrice = priceByProduct.get(productId) ?? 10_00 + ctx.rng.int(200_00);
    const qty = 1 + ctx.rng.int(5);
    const amount = unitPrice * qty;
    const tax = Math.round(amount * 0.08);
    total += amount;
    insert(ctx, 'line_items', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      parent_type: parentType,
      parent_id: parentId,
      product_id: productId,
      quantity: qty,
      unit_price_cents: unitPrice,
      amount_cents: amount,
      tax_cents: tax,
      position: pos,
      description: null,
    });
  }
  return total;
}

const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;

export function generateQuotes(
  ctx: SeedCtx,
  contactIds: string[],
  companyIds: string[],
  ownerIds: string[],
  productIds: string[],
  priceByProduct: Map<string, number>,
  count: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'quote');
    const createdAt = pastTimestamp(ctx, 300, 0);
    const total = generateLineItems(ctx, 'quote', id, productIds, priceByProduct, createdAt);
    insert(ctx, 'quotes', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      number: `Q-${1000 + i}`,
      contact_id: pick(ctx, contactIds),
      company_id: chance(ctx, 0.5) && companyIds.length > 0 ? pick(ctx, companyIds) : null,
      status: pick(ctx, QUOTE_STATUSES),
      total_cents: total,
      owner_id: pick(ctx, ownerIds),
      valid_until: createdAt + 30 * DAY_MS,
      currency: 'USD',
      notes: null,
    });
    ids.push(id);
  }
  return ids;
}

function invoiceDueDate(ctx: SeedCtx, status: string, createdAt: number): number {
  if (status === 'paid') return createdAt + 10 * DAY_MS + ctx.rng.int(20 * DAY_MS);
  // 40% of plain "issued" invoices land in the past (some incidentally >15d
  // overdue too — real buffer on top of the explicit reserved batch).
  if (status === 'issued' && chance(ctx, 0.4)) return ctx.now - ctx.rng.int(40 * DAY_MS);
  return ctx.now + ctx.rng.int(45 * DAY_MS);
}

export function generateInvoices(
  ctx: SeedCtx,
  contactIds: string[],
  ownerIds: string[],
  quoteIds: string[],
  productIds: string[],
  priceByProduct: Map<string, number>,
  total: number,
  minOverdue: number,
): string[] {
  const ids: string[] = [];

  function makeInvoice(idx: number, forceOverdue: boolean): void {
    const id = nextId(ctx, 'inv');
    const createdAt = pastTimestamp(ctx, 200, 20);
    const lineTotal = generateLineItems(ctx, 'invoice', id, productIds, priceByProduct, createdAt);

    const status = forceOverdue ? 'issued' : weightedPick(ctx, ['draft', 'issued', 'paid', 'void'], [0.1, 0.35, 0.5, 0.05]);
    const dueDate = forceOverdue
      ? ctx.now - (16 + ctx.rng.int(75)) * DAY_MS
      : invoiceDueDate(ctx, status, createdAt);
    const issuedAt = status === 'draft' ? null : Math.min(createdAt, dueDate - 5 * DAY_MS);
    const paidAt = status === 'paid' ? dueDate - ctx.rng.int(5 * DAY_MS) : null;
    const amountPaid = status === 'paid' ? lineTotal : forceOverdue ? 0 : status === 'void' ? 0 : chance(ctx, 0.2) ? lineTotal : 0;

    insert(ctx, 'invoices', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      number: `INV-${2000 + idx}`,
      contact_id: pick(ctx, contactIds),
      status,
      total_cents: lineTotal,
      amount_paid_cents: amountPaid,
      due_date: dueDate,
      issued_at: issuedAt,
      paid_at: paidAt,
      quote_id: chance(ctx, 0.35) && quoteIds.length > 0 ? pick(ctx, quoteIds) : null,
      owner_id: pick(ctx, ownerIds),
      currency: 'USD',
    });
    ids.push(id);
  }

  for (let i = 0; i < minOverdue; i++) makeInvoice(i, true);
  for (let i = minOverdue; i < total; i++) makeInvoice(i, false);
  return ids;
}

const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'cancelled', 'refunded'] as const;

export function generateOrders(
  ctx: SeedCtx,
  contactIds: string[],
  couponIds: string[],
  productIds: string[],
  priceByProduct: Map<string, number>,
  count: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'ord');
    const createdAt = pastTimestamp(ctx, 250, 0);
    const total = generateLineItems(ctx, 'order', id, productIds, priceByProduct, createdAt);
    const status = pick(ctx, ORDER_STATUSES);
    insert(ctx, 'orders', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      number: `O-${3000 + i}`,
      contact_id: pick(ctx, contactIds),
      status,
      total_cents: total,
      placed_at: createdAt,
      coupon_id: chance(ctx, 0.25) && couponIds.length > 0 ? pick(ctx, couponIds) : null,
      source: pick(ctx, ['web', 'app', 'pos', 'marketplace']),
      fulfilled_at: status === 'fulfilled' || status === 'refunded' ? createdAt + 3 * DAY_MS : null,
      currency: 'USD',
    });
    ids.push(id);
  }
  return ids;
}

const INTERVAL_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

export function generateSubscriptions(
  ctx: SeedCtx,
  contactIds: string[],
  productIds: string[],
  priceByProduct: Map<string, number>,
  couponIds: string[],
  count: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'sub');
    const interval = weightedPick(ctx, ['day', 'week', 'month', 'year'], [0.02, 0.08, 0.6, 0.3]);
    const intervalMs = (INTERVAL_DAYS[interval] ?? 30) * DAY_MS;
    const startedAt = pastTimestamp(ctx, 500, 0);
    const periodStart = Math.min(ctx.now, startedAt + intervalMs * ctx.rng.int(20));
    const status = weightedPick(ctx, ['trialing', 'active', 'past_due', 'cancelled', 'paused'], [0.08, 0.6, 0.1, 0.15, 0.07]);
    const productId = pick(ctx, productIds);
    insert(ctx, 'subscriptions', {
      id,
      created_at: startedAt,
      updated_at: startedAt,
      archived: 0,
      contact_id: pick(ctx, contactIds),
      product_id: productId,
      status,
      interval,
      amount_cents: priceByProduct.get(productId) ?? 29_00,
      current_period_start: periodStart,
      current_period_end: periodStart + intervalMs,
      started_at: startedAt,
      coupon_id: chance(ctx, 0.2) && couponIds.length > 0 ? pick(ctx, couponIds) : null,
      cancelled_at: status === 'cancelled' ? periodStart + ctx.rng.int(intervalMs) : null,
      currency: 'USD',
    });
    ids.push(id);
  }
  return ids;
}

export function generatePayments(
  ctx: SeedCtx,
  contactIds: string[],
  invoiceIds: string[],
  orderIds: string[],
  subscriptionIds: string[],
  paymentCount: number,
  refundCount: number,
): void {
  interface Successful {
    id: string;
    amountCents: number;
    invoiceId: string | null;
    orderId: string | null;
    contactId: string;
  }
  const successful: Successful[] = [];

  for (let i = 0; i < paymentCount; i++) {
    const id = nextId(ctx, 'pay');
    const target = weightedPick(ctx, ['invoice', 'order', 'subscription'] as const, [0.4, 0.35, 0.25]);
    const invoiceId = target === 'invoice' && invoiceIds.length > 0 ? pick(ctx, invoiceIds) : null;
    const orderId = target === 'order' && orderIds.length > 0 ? pick(ctx, orderIds) : null;
    const subscriptionId = target === 'subscription' && subscriptionIds.length > 0 ? pick(ctx, subscriptionIds) : null;
    const status = weightedPick(ctx, ['pending', 'succeeded', 'failed', 'refunded'], [0.05, 0.75, 0.1, 0.1]);
    const amount = 20_00 + ctx.rng.int(2000_00);
    const contactId = pick(ctx, contactIds);
    const processedAt = pastTimestamp(ctx, 250, 0);
    insert(ctx, 'payments', {
      id,
      created_at: processedAt,
      updated_at: processedAt,
      archived: 0,
      kind: 'payment',
      contact_id: contactId,
      invoice_id: invoiceId,
      order_id: orderId,
      subscription_id: subscriptionId,
      parent_payment_id: null,
      status,
      method: pick(ctx, ['card', 'bank', 'cash', 'other']),
      amount_cents: amount,
      processed_at: processedAt,
      reference: `pay_ref_${id}`,
      currency: 'USD',
    });
    if (status === 'succeeded') successful.push({ id, amountCents: amount, invoiceId, orderId, contactId });
  }

  for (let i = 0; i < refundCount && successful.length > 0; i++) {
    const original = pick(ctx, successful);
    const id = nextId(ctx, 'pay');
    const refundAmount = Math.max(1, Math.round(original.amountCents * (0.3 + ctx.rng.int(70) / 100)));
    const processedAt = pastTimestamp(ctx, 60, 0);
    insert(ctx, 'payments', {
      id,
      created_at: processedAt,
      updated_at: processedAt,
      archived: 0,
      kind: 'refund',
      contact_id: original.contactId,
      invoice_id: original.invoiceId,
      order_id: original.orderId,
      subscription_id: null,
      parent_payment_id: original.id,
      status: 'succeeded',
      method: pick(ctx, ['card', 'bank', 'cash', 'other']),
      amount_cents: refundAmount,
      processed_at: processedAt,
      reference: `refund_ref_${id}`,
      currency: 'USD',
    });
  }
}
