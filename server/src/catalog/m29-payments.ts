/**
 * M29 Payments — follows the M01 Contacts convention verbatim.
 *
 * Data home: the typed `payments` table, `kind = 'payment'`
 * (`entities/model.ts`: "M29 Payments (+ M33 Refunds via kind)" — ONE
 * physical table backs both modules, discriminated by `kind: 'payment' |
 * 'refund'`). There is NO separate allocations table/column —
 * `payments.invoice_id` (a real column, already on the table) IS the
 * allocation: `allocate_payment_to_invoice` sets it, `
 * remove_payment_allocation` clears it. A payment can be allocated to at
 * most one invoice at a time (the schema has one `invoice_id` column, not
 * a list) — documented judgment call per the brief's "check model for
 * allocation storage; if none, allocations in payments JSON — document."
 * No JSON config column exists on `payments` either, so there is nothing
 * to put in a JSON sidecar here; the FK column IS the allocation record.
 *
 * `get_payment_failure_details`: `payments` has no dedicated
 * `failure_reason` column, and no action in this catalog ever transitions
 * a payment to `status='failed'` (only seed data can produce one) — the
 * reason returned is a generic, honestly-labeled simulated-decline
 * message built from the row's own `reference` column, not a persisted
 * structured reason. Documented degenerate implementation, same category
 * as M07's `view_note_revision_history` / M16-M17's execution-history
 * actions.
 *
 * KIND-BLINDNESS NOTE: `payments` is a second kind of shared-table
 * (alongside `structures`/`records`/`participations`), discriminated by
 * `kind` (the default `SynthHint` column, no `column:` override needed).
 * Every bare `id` field here means "a payment-kind row" and needs a
 * `${slug}:id` scoped hint (M33 Refunds needs the `kind:'refund'`
 * counterpart on the SAME table). The `payment_id` field name (used by
 * THIS module's `allocate_payment_to_invoice`/`remove_payment_allocation`
 * and by M33's `create_refund_request`/`check_refundable_balance`) always
 * means "the ORIGINAL settled payment-kind row" catalog-wide — declared
 * here as a FLAT override of `testing.ts`'s kind-blind `payment_id`
 * default (both M29 and M33 redeclare the identical value, order-
 * independent, harmless redundancy).
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

const MODULE = 'payments';
const KIND = 'payment';

export function getPaymentRow(db: StoreTx, id: string, kind: 'payment' | 'refund' = KIND): Row {
  const row = db.get(`SELECT * FROM payments WHERE id = ? AND kind = ?`, [id, kind]);
  if (!row) {
    throw new ActionError('NOT_FOUND', `${kind === 'refund' ? 'Refund' : 'Payment'} '${id}' does not exist.`);
  }
  return row;
}

export interface PaymentView {
  id: string;
  kind: string;
  contact_id: string | null;
  invoice_id: string | null;
  order_id: string | null;
  subscription_id: string | null;
  parent_payment_id: string | null;
  status: string;
  method: string | null;
  amount_cents: number;
  processed_at: number | null;
  reference: string | null;
  currency: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

export function toPaymentView(row: Row): PaymentView {
  return {
    id: row['id'] as string,
    kind: row['kind'] as string,
    contact_id: (row['contact_id'] as string | null) ?? null,
    invoice_id: (row['invoice_id'] as string | null) ?? null,
    order_id: (row['order_id'] as string | null) ?? null,
    subscription_id: (row['subscription_id'] as string | null) ?? null,
    parent_payment_id: (row['parent_payment_id'] as string | null) ?? null,
    status: row['status'] as string,
    method: (row['method'] as string | null) ?? null,
    amount_cents: row['amount_cents'] as number,
    processed_at: (row['processed_at'] as number | null) ?? null,
    reference: (row['reference'] as string | null) ?? null,
    currency: (row['currency'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

export const paymentView = z.object({
  id: z.string(),
  kind: z.string(),
  contact_id: z.string().nullable(),
  invoice_id: z.string().nullable(),
  order_id: z.string().nullable(),
  subscription_id: z.string().nullable(),
  parent_payment_id: z.string().nullable(),
  status: z.string(),
  method: z.string().nullable(),
  amount_cents: z.number(),
  processed_at: z.number().nullable(),
  reference: z.string().nullable(),
  currency: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

/** Recompute an invoice's `amount_paid_cents` from its live succeeded
 * payment-kind allocations, marking it paid once fully covered (money
 * rule: always a full recompute, never an incremental +/-). */
function recomputeInvoiceAllocation(tx: StoreTx, invoiceId: string, now: number): void {
  const row = tx.get(
    `SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments
     WHERE kind = 'payment' AND status = 'succeeded' AND invoice_id = ?`,
    [invoiceId],
  );
  const paid = (row?.['paid'] as number | null) ?? 0;
  const invoice = tx.get(`SELECT total_cents, status FROM invoices WHERE id = ?`, [invoiceId]);
  if (!invoice) return;
  const total = invoice['total_cents'] as number;
  if (paid >= total && total > 0) {
    tx.run(`UPDATE invoices SET amount_paid_cents = ?, status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?`, [
      paid,
      now,
      now,
      invoiceId,
    ]);
  } else {
    const nextStatus = invoice['status'] === 'paid' ? 'issued' : (invoice['status'] as string);
    tx.run(`UPDATE invoices SET amount_paid_cents = ?, status = ?, paid_at = NULL, updated_at = ? WHERE id = ?`, [
      paid,
      nextStatus,
      now,
      invoiceId,
    ]);
  }
}

// --- A01 create_payment_request -----------------------------------------------

const createPaymentRequestInput = z.strictObject({
  contact_id: z.string(),
  invoice_id: z.string().optional(),
  order_id: z.string().optional(),
  subscription_id: z.string().optional(),
  amount_cents: z.number().int().min(1),
  method: z.enum(['card', 'bank', 'cash', 'other']).optional(),
  currency: z.string().optional(),
});

const createPaymentRequest: ActionDef<z.infer<typeof createPaymentRequestInput>, PaymentView> = {
  id: 'M29.A01',
  slug: 'payments.create_payment_request',
  module: MODULE,
  name: 'Create payment request',
  description: 'Create a pending payment request for a contact.',
  risk: 'write',
  entities: ['payments'],
  inputSchema: createPaymentRequestInput,
  outputSchema: paymentView,
  searchCard: {
    synonyms: ['request payment', 'new payment request'],
    examplePhrasings: ['Create a payment request for $50'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'payments', 'pay');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO payments (id, created_at, updated_at, archived, kind, contact_id, invoice_id, order_id,
        subscription_id, parent_payment_id, status, method, amount_cents, processed_at, reference, currency)
       VALUES (?, ?, ?, 0, 'payment', ?, ?, ?, ?, NULL, 'pending', ?, ?, NULL, ?, ?)`,
      [
        id,
        now,
        now,
        input.contact_id,
        input.invoice_id ?? null,
        input.order_id ?? null,
        input.subscription_id ?? null,
        input.method ?? 'card',
        input.amount_cents,
        `pay_ref_${id}`,
        input.currency ?? 'USD',
      ],
    );
    return toPaymentView(getPaymentRow(ctx.db, id));
  }),
};

// --- A02 get_payment_request -------------------------------------------------

const getPaymentRequestInput = z.strictObject({ id: z.string() });

const getPaymentRequest: ActionDef<z.infer<typeof getPaymentRequestInput>, PaymentView> = {
  id: 'M29.A02',
  slug: 'payments.get_payment_request',
  module: MODULE,
  name: 'Get payment request',
  description: 'Fetch a payment (request or settled) by id.',
  risk: 'read',
  entities: ['payments'],
  inputSchema: getPaymentRequestInput,
  outputSchema: paymentView,
  searchCard: {
    synonyms: ['payment request details', 'look up payment request'],
    examplePhrasings: ['Show me this payment request'],
  },
  handler: async (input, ctx) => toPaymentView(getPaymentRow(ctx.db, input.id)),
};

// --- A03 cancel_unpaid_payment_request -------------------------------------------------

const cancelUnpaidPaymentRequestInput = z.strictObject({ id: z.string() });

const cancelUnpaidPaymentRequest: ActionDef<z.infer<typeof cancelUnpaidPaymentRequestInput>, PaymentView> = {
  id: 'M29.A03',
  slug: 'payments.cancel_unpaid_payment_request',
  module: MODULE,
  name: 'Cancel unpaid payment request',
  description: 'Cancel a payment request that has not been settled.',
  risk: 'destructive',
  entities: ['payments'],
  inputSchema: cancelUnpaidPaymentRequestInput,
  outputSchema: paymentView,
  searchCard: {
    synonyms: ['cancel payment request'],
    examplePhrasings: ['Cancel this payment request, the customer backed out'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPaymentRow(ctx.db, input.id);
    if (row['status'] !== 'pending') {
      throw new ActionError('CONFLICT', `Payment '${input.id}' is not pending (status: ${row['status'] as string}).`);
    }
    ctx.db.run(`UPDATE payments SET status = 'cancelled', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toPaymentView(getPaymentRow(ctx.db, input.id));
  }),
};

// --- A04 record_simulated_payment -------------------------------------------------

const recordSimulatedPaymentInput = z.strictObject({
  id: z.string().optional(),
  contact_id: z.string().optional(),
  invoice_id: z.string().optional(),
  order_id: z.string().optional(),
  subscription_id: z.string().optional(),
  amount_cents: z.number().int().min(1).optional(),
  method: z.enum(['card', 'bank', 'cash', 'other']).optional(),
  currency: z.string().optional(),
});

const recordSimulatedPayment: ActionDef<z.infer<typeof recordSimulatedPaymentInput>, PaymentView> = {
  id: 'M29.A04',
  slug: 'payments.record_simulated_payment',
  module: MODULE,
  name: 'Record simulated payment',
  description:
    'Record a simulated payment: settles an existing pending request (if id is given) or creates and settles a fresh one.',
  risk: 'write',
  entities: ['payments'],
  inputSchema: recordSimulatedPaymentInput,
  outputSchema: paymentView,
  searchCard: {
    synonyms: ['record payment', 'simulate payment'],
    examplePhrasings: ['Record a payment of $100 for this contact'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const now = ctx.clock.now();
    if (input.id) {
      getPaymentRow(ctx.db, input.id); // existence check
      // Unconditional UPDATE (idempotent in effect, observably a write) even
      // if the row is already 'succeeded' — an early-return-when-unchanged
      // here would be a silent no-op with no detectable state delta (the
      // exact task-8 fix-round-1 lesson re-applied).
      ctx.db.run(`UPDATE payments SET status = 'succeeded', processed_at = ?, updated_at = ? WHERE id = ?`, [
        now,
        now,
        input.id,
      ]);
      return toPaymentView(getPaymentRow(ctx.db, input.id));
    }
    if (!input.contact_id || !input.amount_cents) {
      throw new ActionError('VALIDATION', 'Either `id` (existing request) or `contact_id` + `amount_cents` (fresh payment) is required.');
    }
    const id = nextId(ctx.db, 'payments', 'pay');
    ctx.db.run(
      `INSERT INTO payments (id, created_at, updated_at, archived, kind, contact_id, invoice_id, order_id,
        subscription_id, parent_payment_id, status, method, amount_cents, processed_at, reference, currency)
       VALUES (?, ?, ?, 0, 'payment', ?, ?, ?, ?, NULL, 'succeeded', ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        now,
        input.contact_id,
        input.invoice_id ?? null,
        input.order_id ?? null,
        input.subscription_id ?? null,
        input.method ?? 'card',
        input.amount_cents,
        now,
        `pay_ref_${id}`,
        input.currency ?? 'USD',
      ],
    );
    return toPaymentView(getPaymentRow(ctx.db, id));
  }),
};

// --- A05 get_payment_details -------------------------------------------------

const getPaymentDetailsInput = z.strictObject({ id: z.string() });

const getPaymentDetails: ActionDef<z.infer<typeof getPaymentDetailsInput>, PaymentView> = {
  id: 'M29.A05',
  slug: 'payments.get_payment_details',
  module: MODULE,
  name: 'Get payment details',
  description: 'Fetch a settled or pending payment by id.',
  risk: 'read',
  entities: ['payments'],
  inputSchema: getPaymentDetailsInput,
  outputSchema: paymentView,
  searchCard: {
    synonyms: ['payment details', 'look up payment'],
    examplePhrasings: ['Show me this payment'],
  },
  handler: async (input, ctx) => toPaymentView(getPaymentRow(ctx.db, input.id)),
};

// --- A06 search_payments -------------------------------------------------

const searchPaymentsInput = z.strictObject({
  contact_id: z.string().optional(),
  status: z.string().optional(),
  method: z.string().optional(),
  invoice_id: z.string().optional(),
  order_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchPaymentsInput = z.infer<typeof searchPaymentsInput>;
const searchPaymentsOutput = listOutputSchema(paymentView);
type SearchPaymentsOutput = ListOrSpill<PaymentView>;

const searchPayments: ActionDef<SearchPaymentsInput, SearchPaymentsOutput> = {
  id: 'M29.A06',
  slug: 'payments.search_payments',
  module: MODULE,
  name: 'Search payments',
  description: "Search non-archived payment-kind rows (not refunds) by common filters.",
  risk: 'read',
  entities: ['payments'],
  inputSchema: searchPaymentsInput,
  outputSchema: searchPaymentsOutput,
  searchCard: {
    synonyms: ['find payments', 'list payments'],
    examplePhrasings: ['Find all failed payments'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. This excludes refunds — see refunds.search_refund_requests.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', `kind = '${KIND}'`];
    const params: unknown[] = [];
    if (input.contact_id) {
      where.push('contact_id = ?');
      params.push(input.contact_id);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.method) {
      where.push('method = ?');
      params.push(input.method);
    }
    if (input.invoice_id) {
      where.push('invoice_id = ?');
      params.push(input.invoice_id);
    }
    if (input.order_id) {
      where.push('order_id = ?');
      params.push(input.order_id);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM payments WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM payments WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toPaymentView), total, {
      idCapture: { db: ctx.db, table: 'payments', whereSql, params },
    });
  },
};

// --- A07 allocate_payment_to_invoice -------------------------------------------------

const allocatePaymentToInvoiceInput = z.strictObject({ payment_id: z.string(), invoice_id: z.string() });
const allocationOutput = z.object({
  payment: paymentView,
  invoice: z.object({ id: z.string(), status: z.string(), total_cents: z.number(), amount_paid_cents: z.number().nullable() }),
});

const allocatePaymentToInvoice: ActionDef<z.infer<typeof allocatePaymentToInvoiceInput>, z.infer<typeof allocationOutput>> = {
  id: 'M29.A07',
  slug: 'payments.allocate_payment_to_invoice',
  module: MODULE,
  name: 'Allocate payment to invoice',
  description:
    "Link a succeeded payment to an invoice (payments.invoice_id IS the allocation record) and recompute the invoice's amount_paid_cents, marking it paid once covered.",
  risk: 'write',
  entities: ['payments', 'invoices'],
  inputSchema: allocatePaymentToInvoiceInput,
  outputSchema: allocationOutput,
  searchCard: {
    synonyms: ['allocate payment', 'apply payment to invoice'],
    examplePhrasings: ['Apply this payment to the invoice'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const payment = getPaymentRow(ctx.db, input.payment_id);
    if (payment['status'] !== 'succeeded') {
      throw new ActionError('CONFLICT', `Payment '${input.payment_id}' has not succeeded (status: ${payment['status'] as string}).`);
    }
    const existingInvoiceId = payment['invoice_id'] as string | null;
    if (existingInvoiceId && existingInvoiceId !== input.invoice_id) {
      throw new ActionError('CONFLICT', `Payment '${input.payment_id}' is already allocated to invoice '${existingInvoiceId}'.`);
    }
    const invoice = ctx.db.get(`SELECT id FROM invoices WHERE id = ?`, [input.invoice_id]);
    if (!invoice) throw new ActionError('NOT_FOUND', `Invoice '${input.invoice_id}' does not exist.`);
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE payments SET invoice_id = ?, updated_at = ? WHERE id = ?`, [
      input.invoice_id,
      now,
      input.payment_id,
    ]);
    recomputeInvoiceAllocation(ctx.db, input.invoice_id, now);
    const invoiceRow = ctx.db.get(`SELECT id, status, total_cents, amount_paid_cents FROM invoices WHERE id = ?`, [
      input.invoice_id,
    ]) as Row;
    return {
      payment: toPaymentView(getPaymentRow(ctx.db, input.payment_id)),
      invoice: {
        id: invoiceRow['id'] as string,
        status: invoiceRow['status'] as string,
        total_cents: invoiceRow['total_cents'] as number,
        amount_paid_cents: (invoiceRow['amount_paid_cents'] as number | null) ?? null,
      },
    };
  }),
};

// --- A08 remove_payment_allocation -------------------------------------------------

const removePaymentAllocationInput = z.strictObject({ payment_id: z.string() });

const removePaymentAllocation: ActionDef<z.infer<typeof removePaymentAllocationInput>, z.infer<typeof allocationOutput>> = {
  id: 'M29.A08',
  slug: 'payments.remove_payment_allocation',
  module: MODULE,
  name: 'Remove payment allocation',
  description: "Unlink a payment from its invoice and recompute the invoice's amount_paid_cents.",
  risk: 'write',
  entities: ['payments', 'invoices'],
  inputSchema: removePaymentAllocationInput,
  outputSchema: allocationOutput,
  searchCard: {
    synonyms: ['unallocate payment', 'remove payment from invoice'],
    examplePhrasings: ['Remove this payment from the invoice, it was applied by mistake'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const payment = getPaymentRow(ctx.db, input.payment_id);
    const invoiceId = payment['invoice_id'] as string | null;
    if (!invoiceId) {
      throw new ActionError('CONFLICT', `Payment '${input.payment_id}' is not allocated to any invoice.`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE payments SET invoice_id = NULL, updated_at = ? WHERE id = ?`, [now, input.payment_id]);
    recomputeInvoiceAllocation(ctx.db, invoiceId, now);
    const invoiceRow = ctx.db.get(`SELECT id, status, total_cents, amount_paid_cents FROM invoices WHERE id = ?`, [
      invoiceId,
    ]) as Row;
    return {
      payment: toPaymentView(getPaymentRow(ctx.db, input.payment_id)),
      invoice: {
        id: invoiceRow['id'] as string,
        status: invoiceRow['status'] as string,
        total_cents: invoiceRow['total_cents'] as number,
        amount_paid_cents: (invoiceRow['amount_paid_cents'] as number | null) ?? null,
      },
    };
  }),
};

// --- A09 generate_payment_receipt -------------------------------------------------

const generatePaymentReceiptInput = z.strictObject({ id: z.string() });
const receiptOutput = z.object({
  id: z.string(),
  receipt_number: z.string(),
  amount_cents: z.number(),
  currency: z.string().nullable(),
  method: z.string().nullable(),
  status: z.string(),
  processed_at: z.number().nullable(),
  contact_id: z.string().nullable(),
  invoice_id: z.string().nullable(),
  order_id: z.string().nullable(),
});

const generatePaymentReceipt: ActionDef<z.infer<typeof generatePaymentReceiptInput>, z.infer<typeof receiptOutput>> = {
  id: 'M29.A09',
  slug: 'payments.generate_payment_receipt',
  module: MODULE,
  name: 'Generate payment receipt',
  description: 'Compute a receipt for a payment. Pure read — no state change needed beyond the receipt itself.',
  risk: 'read',
  entities: ['payments'],
  inputSchema: generatePaymentReceiptInput,
  outputSchema: receiptOutput,
  searchCard: {
    synonyms: ['get receipt', 'payment receipt'],
    examplePhrasings: ['Generate a receipt for this payment'],
  },
  handler: async (input, ctx) => {
    const row = getPaymentRow(ctx.db, input.id);
    return {
      id: input.id,
      receipt_number: `RCPT-${input.id}`,
      amount_cents: row['amount_cents'] as number,
      currency: (row['currency'] as string | null) ?? null,
      method: (row['method'] as string | null) ?? null,
      status: row['status'] as string,
      processed_at: (row['processed_at'] as number | null) ?? null,
      contact_id: (row['contact_id'] as string | null) ?? null,
      invoice_id: (row['invoice_id'] as string | null) ?? null,
      order_id: (row['order_id'] as string | null) ?? null,
    };
  },
};

// --- A10 get_payment_failure_details -------------------------------------------------

const getPaymentFailureDetailsInput = z.strictObject({ id: z.string() });
const failureDetailsOutput = z.object({ id: z.string(), status: z.string(), failure_reason: z.string() });

const getPaymentFailureDetails: ActionDef<z.infer<typeof getPaymentFailureDetailsInput>, z.infer<typeof failureDetailsOutput>> = {
  id: 'M29.A10',
  slug: 'payments.get_payment_failure_details',
  module: MODULE,
  name: 'Get payment failure details',
  description: 'Fetch the (simulated) failure reason for a failed payment.',
  risk: 'read',
  entities: ['payments'],
  inputSchema: getPaymentFailureDetailsInput,
  outputSchema: failureDetailsOutput,
  searchCard: {
    synonyms: ['why did this payment fail', 'payment failure reason'],
    examplePhrasings: ['Why did this payment fail?'],
  },
  handler: async (input, ctx) => {
    const row = getPaymentRow(ctx.db, input.id);
    if (row['status'] !== 'failed') {
      throw new ActionError('VALIDATION', `Payment '${input.id}' is not in a failed state (status: ${row['status'] as string}).`);
    }
    return {
      id: input.id,
      status: 'failed',
      failure_reason: `Simulated processor decline (reference: ${row['reference'] as string | null}).`,
    };
  },
};

export const m29Payments: ActionDef[] = [
  createPaymentRequest as ActionDef,
  getPaymentRequest as ActionDef,
  cancelUnpaidPaymentRequest as ActionDef,
  recordSimulatedPayment as ActionDef,
  getPaymentDetails as ActionDef,
  searchPayments as ActionDef,
  allocatePaymentToInvoice as ActionDef,
  removePaymentAllocation as ActionDef,
  generatePaymentReceipt as ActionDef,
  getPaymentFailureDetails as ActionDef,
];

/** Tier-A discrimination: `status` counts over 765 payment-kind rows —
 * verified via live `npm run smoke` output: 'succeeded' → 561, 'failed' →
 * 80. */
export const m29DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'payments.search_payments',
    paramsA: { status: 'succeeded' },
    paramsB: { status: 'failed' },
    expectDifferentCounts: true,
  },
];

/** `payments` is a shared mega-table (`kind: 'payment'|'refund'`) — every
 * bare `id` field here needs a `${slug}:id` scoped hint to `kind:'payment'`
 * (M33 Refunds declares the `kind:'refund'` counterpart on the same
 * table). `payment_id` is a FLAT override (not scoped) since its meaning —
 * "the original settled payment-kind row" — is unambiguous catalog-wide;
 * `testing.ts`'s own `DEFAULT_HINTS.payment_id` has no `kind` filter
 * (kind-blind), so this module-level hint takes precedence. */
export const m29SynthHints: SynthHints = {
  'payments.get_payment_request:id': { table: 'payments', kind: 'payment' },
  'payments.cancel_unpaid_payment_request:id': { table: 'payments', kind: 'payment' },
  'payments.record_simulated_payment:id': { table: 'payments', kind: 'payment' },
  'payments.get_payment_details:id': { table: 'payments', kind: 'payment' },
  'payments.generate_payment_receipt:id': { table: 'payments', kind: 'payment' },
  'payments.get_payment_failure_details:id': { table: 'payments', kind: 'payment' },
  payment_id: { table: 'payments', kind: 'payment' },
};
