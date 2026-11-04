/**
 * M33 Refunds — follows the M01 Contacts convention verbatim.
 *
 * Data home: the SAME typed `payments` table M29 Payments owns,
 * `kind = 'refund'` (`entities/model.ts`: "M29 Payments (+ M33 Refunds via
 * kind)"). `parent_payment_id` points at the ORIGINAL payment-kind row.
 *
 * STATUS VOCABULARY (chosen to match the seed generator's own
 * convention): `requested` → `approved` → `succeeded` (executed), or
 * `requested`/`approved` → `rejected` (terminal). `entities/seed-
 * commerce.ts#generatePayments`'s refund rows are seeded directly at
 * `status='succeeded'` (i.e. already-executed, bypassing the
 * request/approve steps) — this module's own `execute_simulated_refund`
 * writes the SAME terminal value, so a seeded refund and a
 * freshly-executed one are indistinguishable to every read action here.
 *
 * DESIGN NOTE — reason/rejection_reason storage: `payments` has no
 * dedicated free-text "reason" column. `reference` (the only free-text
 * column, normally a plain `pay_ref_*`/`refund_ref_*` string per the seed
 * generator) doubles as a small JSON sidecar: `{reason, rejection_reason}`
 * for refund-kind rows THIS module creates. `readRefundMeta` is resilient
 * to the legacy plain-string shape (seeded rows: `refund_ref_<id>`) —
 * treated as `{reason: null, rejection_reason: null}` with the raw string
 * preserved for display — same "legacy shape vs. new shape" pattern as
 * `product-prices.ts`/`m27-quotes.ts`'s sidecars elsewhere in this batch.
 *
 * `payment_id` always means "the original settled payment-kind row" — see
 * `m29-payments.ts`'s header for the shared flat-hint rationale (declared
 * in both modules, redundant but harmless).
 */

import { z } from 'zod';
import type { ActionDef } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';
import { getPaymentRow } from './m29-payments.js';

const MODULE = 'refunds';
const KIND = 'refund';

interface RefundMeta {
  reason: string | null;
  rejection_reason: string | null;
}

function readRefundMeta(row: Row): RefundMeta {
  const raw = row['reference'];
  if (typeof raw !== 'string' || raw.length === 0) return { reason: null, rejection_reason: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        reason: typeof obj['reason'] === 'string' ? obj['reason'] : null,
        rejection_reason: typeof obj['rejection_reason'] === 'string' ? obj['rejection_reason'] : null,
      };
    }
    return { reason: null, rejection_reason: null };
  } catch {
    // Legacy plain string (seed's `refund_ref_<id>`) — not a reason, no sidecar yet.
    return { reason: null, rejection_reason: null };
  }
}

function writeRefundMeta(tx: StoreTx, id: string, meta: RefundMeta, now: number): void {
  tx.run(`UPDATE payments SET reference = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(meta), now, id]);
}

function getRefundRow(db: StoreTx, id: string): Row {
  return getPaymentRow(db, id, 'refund');
}

/** Refundable balance = original payment's amount minus every EXECUTED
 * (`status='succeeded'`) refund against it — real computation, re-run
 * fresh every time (never cached), per the brief. */
function computeRefundableCents(tx: StoreTx, paymentId: string): { amountCents: number; refundedCents: number } {
  const payment = getPaymentRow(tx, paymentId, 'payment');
  const row = tx.get(
    `SELECT COALESCE(SUM(amount_cents), 0) AS refunded FROM payments
     WHERE kind = 'refund' AND status = 'succeeded' AND parent_payment_id = ?`,
    [paymentId],
  );
  const refunded = (row?.['refunded'] as number | null) ?? 0;
  return { amountCents: payment['amount_cents'] as number, refundedCents: refunded };
}

interface RefundView {
  id: string;
  payment_id: string | null;
  contact_id: string | null;
  invoice_id: string | null;
  order_id: string | null;
  status: string;
  amount_cents: number;
  processed_at: number | null;
  reason: string | null;
  rejection_reason: string | null;
  currency: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): RefundView {
  const meta = readRefundMeta(row);
  return {
    id: row['id'] as string,
    payment_id: (row['parent_payment_id'] as string | null) ?? null,
    contact_id: (row['contact_id'] as string | null) ?? null,
    invoice_id: (row['invoice_id'] as string | null) ?? null,
    order_id: (row['order_id'] as string | null) ?? null,
    status: row['status'] as string,
    amount_cents: row['amount_cents'] as number,
    processed_at: (row['processed_at'] as number | null) ?? null,
    reason: meta.reason,
    rejection_reason: meta.rejection_reason,
    currency: (row['currency'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const refundView = z.object({
  id: z.string(),
  payment_id: z.string().nullable(),
  contact_id: z.string().nullable(),
  invoice_id: z.string().nullable(),
  order_id: z.string().nullable(),
  status: z.string(),
  amount_cents: z.number(),
  processed_at: z.number().nullable(),
  reason: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  currency: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_refund_request -----------------------------------------------------

const createRefundRequestInput = z.strictObject({
  payment_id: z.string(),
  amount_cents: z.number().int().min(1).optional(),
  reason: z.string().optional(),
});

const createRefundRequest: ActionDef<z.infer<typeof createRefundRequestInput>, RefundView> = {
  id: 'M33.A01',
  slug: 'refunds.create_refund_request',
  module: MODULE,
  name: 'Create refund request',
  description: 'Request a refund against a succeeded payment (defaults to a full refund of the remaining balance).',
  risk: 'write',
  entities: ['payments'],
  inputSchema: createRefundRequestInput,
  outputSchema: refundView,
  searchCard: {
    synonyms: ['request refund', 'new refund request'],
    examplePhrasings: ['Start a refund request for this payment'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const original = getPaymentRow(ctx.db, input.payment_id, 'payment');
    if (original['status'] !== 'succeeded') {
      throw new ActionError('CONFLICT', `Payment '${input.payment_id}' has not succeeded — nothing to refund.`);
    }
    const { amountCents, refundedCents } = computeRefundableCents(ctx.db, input.payment_id);
    const refundable = amountCents - refundedCents;
    const amount = input.amount_cents ?? refundable;
    if (amount > refundable) {
      throw new ActionError('VALIDATION', `Requested amount (${amount}) exceeds the refundable balance (${refundable}).`);
    }
    const id = nextId(ctx.db, 'payments', 'pay');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO payments (id, created_at, updated_at, archived, kind, contact_id, invoice_id, order_id,
        subscription_id, parent_payment_id, status, method, amount_cents, processed_at, reference, currency)
       VALUES (?, ?, ?, 0, 'refund', ?, ?, ?, NULL, ?, 'requested', ?, ?, NULL, ?, ?)`,
      [
        id,
        now,
        now,
        original['contact_id'],
        original['invoice_id'],
        original['order_id'],
        input.payment_id,
        original['method'],
        amount,
        JSON.stringify({ reason: input.reason ?? null, rejection_reason: null }),
        original['currency'],
      ],
    );
    return toView(getRefundRow(ctx.db, id));
  }),
};

// --- A02 get_refund_request -------------------------------------------------

const getRefundRequestInput = z.strictObject({ id: z.string() });

const getRefundRequest: ActionDef<z.infer<typeof getRefundRequestInput>, RefundView> = {
  id: 'M33.A02',
  slug: 'refunds.get_refund_request',
  module: MODULE,
  name: 'Get refund request',
  description: 'Fetch a refund (request or executed) by id.',
  risk: 'read',
  entities: ['payments'],
  inputSchema: getRefundRequestInput,
  outputSchema: refundView,
  searchCard: {
    synonyms: ['refund details', 'look up refund'],
    examplePhrasings: ['Show me this refund request'],
  },
  handler: async (input, ctx) => toView(getRefundRow(ctx.db, input.id)),
};

// --- A03 search_refund_requests -------------------------------------------------

const searchRefundRequestsInput = z.strictObject({
  contact_id: z.string().optional(),
  status: z.string().optional(),
  payment_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchRefundRequestsInput = z.infer<typeof searchRefundRequestsInput>;
const searchRefundRequestsOutput = listOutputSchema(refundView);
type SearchRefundRequestsOutput = ListOrSpill<RefundView>;

const searchRefundRequests: ActionDef<SearchRefundRequestsInput, SearchRefundRequestsOutput> = {
  id: 'M33.A03',
  slug: 'refunds.search_refund_requests',
  module: MODULE,
  name: 'Search refund requests',
  description: 'Search non-archived refund-kind rows by common filters.',
  risk: 'read',
  entities: ['payments'],
  inputSchema: searchRefundRequestsInput,
  outputSchema: searchRefundRequestsOutput,
  searchCard: {
    synonyms: ['find refunds', 'list refund requests'],
    examplePhrasings: ['Find all pending refund requests'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
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
    if (input.payment_id) {
      where.push('parent_payment_id = ?');
      params.push(input.payment_id);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM payments WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM payments WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 set_refund_reason -------------------------------------------------

const setRefundReasonInput = z.strictObject({ id: z.string(), reason: z.string().min(1) });

const setRefundReason: ActionDef<z.infer<typeof setRefundReasonInput>, RefundView> = {
  id: 'M33.A04',
  slug: 'refunds.set_refund_reason',
  module: MODULE,
  name: 'Set refund reason',
  description: 'Set the reason on a still-requested refund.',
  risk: 'write',
  entities: ['payments'],
  inputSchema: setRefundReasonInput,
  outputSchema: refundView,
  searchCard: {
    synonyms: ['update refund reason', 'explain refund'],
    examplePhrasings: ['Set the reason for this refund to "damaged in transit"'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getRefundRow(ctx.db, input.id);
    if (row['status'] !== 'requested') {
      throw new ActionError('CONFLICT', `Refund '${input.id}' is not in 'requested' status.`);
    }
    const meta = readRefundMeta(row);
    writeRefundMeta(ctx.db, input.id, { ...meta, reason: input.reason }, ctx.clock.now());
    return toView(getRefundRow(ctx.db, input.id));
  }),
};

// --- A05 set_partial_refund_amount -------------------------------------------------

const setPartialRefundAmountInput = z.strictObject({ id: z.string(), amount_cents: z.number().int().min(1) });

const setPartialRefundAmount: ActionDef<z.infer<typeof setPartialRefundAmountInput>, RefundView> = {
  id: 'M33.A05',
  slug: 'refunds.set_partial_refund_amount',
  module: MODULE,
  name: 'Set partial refund amount',
  description: 'Set the amount on a still-requested refund (must not exceed the refundable balance).',
  risk: 'write',
  entities: ['payments'],
  inputSchema: setPartialRefundAmountInput,
  outputSchema: refundView,
  searchCard: {
    synonyms: ['change refund amount', 'partial refund'],
    examplePhrasings: ['Only refund half of this payment'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getRefundRow(ctx.db, input.id);
    if (row['status'] !== 'requested') {
      throw new ActionError('CONFLICT', `Refund '${input.id}' is not in 'requested' status.`);
    }
    const originalId = row['parent_payment_id'] as string;
    const { amountCents, refundedCents } = computeRefundableCents(ctx.db, originalId);
    // Exclude THIS request's own currently-reserved amount from "already refunded" —
    // it is not yet `succeeded`, so computeRefundableCents already excludes it.
    const refundable = amountCents - refundedCents;
    if (input.amount_cents > refundable) {
      throw new ActionError('VALIDATION', `Amount (${input.amount_cents}) exceeds the refundable balance (${refundable}).`);
    }
    ctx.db.run(`UPDATE payments SET amount_cents = ?, updated_at = ? WHERE id = ?`, [
      input.amount_cents,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getRefundRow(ctx.db, input.id));
  }),
};

// --- A06 check_refundable_balance -------------------------------------------------

const checkRefundableBalanceInput = z.strictObject({ payment_id: z.string() });
const refundableBalanceOutput = z.object({
  payment_id: z.string(),
  amount_cents: z.number(),
  refunded_cents: z.number(),
  refundable_cents: z.number(),
});

const checkRefundableBalance: ActionDef<z.infer<typeof checkRefundableBalanceInput>, z.infer<typeof refundableBalanceOutput>> = {
  id: 'M33.A06',
  slug: 'refunds.check_refundable_balance',
  module: MODULE,
  name: 'Check refundable balance',
  description: "Compute a payment's remaining refundable balance (amount minus prior EXECUTED refunds). Pure read.",
  risk: 'read',
  entities: ['payments'],
  inputSchema: checkRefundableBalanceInput,
  outputSchema: refundableBalanceOutput,
  searchCard: {
    synonyms: ['how much can be refunded', 'remaining refund balance'],
    examplePhrasings: ['How much of this payment can still be refunded?'],
  },
  handler: async (input, ctx) => {
    const { amountCents, refundedCents } = computeRefundableCents(ctx.db, input.payment_id);
    return {
      payment_id: input.payment_id,
      amount_cents: amountCents,
      refunded_cents: refundedCents,
      refundable_cents: amountCents - refundedCents,
    };
  },
};

// --- A07 approve_refund_request -------------------------------------------------

const approveRefundRequestInput = z.strictObject({ id: z.string() });

const approveRefundRequest: ActionDef<z.infer<typeof approveRefundRequestInput>, RefundView> = {
  id: 'M33.A07',
  slug: 'refunds.approve_refund_request',
  module: MODULE,
  name: 'Approve refund request',
  description: 'Approve a requested refund.',
  risk: 'write',
  entities: ['payments'],
  inputSchema: approveRefundRequestInput,
  outputSchema: refundView,
  searchCard: {
    synonyms: ['approve refund', 'authorize refund'],
    examplePhrasings: ['Approve this refund request'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getRefundRow(ctx.db, input.id);
    if (row['status'] !== 'requested') {
      throw new ActionError('CONFLICT', `Refund '${input.id}' is not in 'requested' status.`);
    }
    ctx.db.run(`UPDATE payments SET status = 'approved', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getRefundRow(ctx.db, input.id));
  }),
};

// --- A08 reject_refund_request -------------------------------------------------

const rejectRefundRequestInput = z.strictObject({ id: z.string(), rejection_reason: z.string().optional() });

const rejectRefundRequest: ActionDef<z.infer<typeof rejectRefundRequestInput>, RefundView> = {
  id: 'M33.A08',
  slug: 'refunds.reject_refund_request',
  module: MODULE,
  name: 'Reject refund request',
  description: 'Reject a requested or approved refund.',
  risk: 'write',
  entities: ['payments'],
  inputSchema: rejectRefundRequestInput,
  outputSchema: refundView,
  searchCard: {
    synonyms: ['deny refund', 'reject refund request'],
    examplePhrasings: ['Reject this refund request, outside policy'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getRefundRow(ctx.db, input.id);
    if (!['requested', 'approved'].includes(row['status'] as string)) {
      throw new ActionError('CONFLICT', `Refund '${input.id}' cannot be rejected from status '${row['status'] as string}'.`);
    }
    const meta = readRefundMeta(row);
    const now = ctx.clock.now();
    writeRefundMeta(ctx.db, input.id, { ...meta, rejection_reason: input.rejection_reason ?? meta.rejection_reason }, now);
    ctx.db.run(`UPDATE payments SET status = 'rejected', updated_at = ? WHERE id = ?`, [now, input.id]);
    return toView(getRefundRow(ctx.db, input.id));
  }),
};

// --- A09 execute_simulated_refund -------------------------------------------------

const executeSimulatedRefundInput = z.strictObject({ id: z.string() });

const executeSimulatedRefund: ActionDef<z.infer<typeof executeSimulatedRefundInput>, RefundView> = {
  id: 'M33.A09',
  slug: 'refunds.execute_simulated_refund',
  module: MODULE,
  name: 'Execute simulated refund',
  description: 'Execute an approved refund, settling it against the original payment.',
  risk: 'external',
  entities: ['payments'],
  inputSchema: executeSimulatedRefundInput,
  outputSchema: refundView,
  searchCard: {
    synonyms: ['execute refund', 'process the refund', 'issue the refund'],
    examplePhrasings: ['Go ahead and process this refund'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getRefundRow(ctx.db, input.id);
    if (row['status'] !== 'approved') {
      throw new ActionError('CONFLICT', `Refund '${input.id}' is not in 'approved' status.`);
    }
    const originalId = row['parent_payment_id'] as string;
    const { amountCents, refundedCents } = computeRefundableCents(ctx.db, originalId);
    const refundable = amountCents - refundedCents;
    if ((row['amount_cents'] as number) > refundable) {
      throw new ActionError(
        'VALIDATION',
        `Refund amount (${row['amount_cents'] as number}) now exceeds the refundable balance (${refundable}) — another refund may have executed since approval.`,
      );
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE payments SET status = 'succeeded', processed_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      input.id,
    ]);
    const remaining = refundable - (row['amount_cents'] as number);
    if (remaining <= 0) {
      ctx.db.run(`UPDATE payments SET status = 'refunded', updated_at = ? WHERE id = ?`, [now, originalId]);
    }
    return toView(getRefundRow(ctx.db, input.id));
  }),
};

// --- A10 get_refund_execution_status -------------------------------------------------

const getRefundExecutionStatusInput = z.strictObject({ id: z.string() });
const executionStatusOutput = z.object({ id: z.string(), status: z.string(), processed_at: z.number().nullable(), amount_cents: z.number() });

const getRefundExecutionStatus: ActionDef<z.infer<typeof getRefundExecutionStatusInput>, z.infer<typeof executionStatusOutput>> = {
  id: 'M33.A10',
  slug: 'refunds.get_refund_execution_status',
  module: MODULE,
  name: 'Get refund execution status',
  description: "Fetch a refund's current status and processed_at timestamp.",
  risk: 'read',
  entities: ['payments'],
  inputSchema: getRefundExecutionStatusInput,
  outputSchema: executionStatusOutput,
  searchCard: {
    synonyms: ['refund status', 'has this refund processed'],
    examplePhrasings: ['Has this refund gone through yet?'],
  },
  handler: async (input, ctx) => {
    const row = getRefundRow(ctx.db, input.id);
    return {
      id: input.id,
      status: row['status'] as string,
      processed_at: (row['processed_at'] as number | null) ?? null,
      amount_cents: row['amount_cents'] as number,
    };
  },
};

export const m33Refunds: ActionDef[] = [
  createRefundRequest as ActionDef,
  getRefundRequest as ActionDef,
  searchRefundRequests as ActionDef,
  setRefundReason as ActionDef,
  setPartialRefundAmount as ActionDef,
  checkRefundableBalance as ActionDef,
  approveRefundRequest as ActionDef,
  rejectRefundRequest as ActionDef,
  executeSimulatedRefund as ActionDef,
  getRefundExecutionStatus as ActionDef,
];

/** Tier-A discrimination: `status` counts over 135 refund-kind rows.
 * Every SEEDED refund is `succeeded` (seed generator always executes
 * them immediately) — verified via live `npm run smoke` output:
 * 'succeeded' → 135, 'requested' → 1 (the single row this module's own
 * `create_refund_request` inserts earlier in the SAME pass). This is a
 * ROBUST invariant, not a coincidental small-number margin: every other
 * action in this module resolves its own `id`/`payment_id` via a scoped
 * hint's OFFSET-0 lookup (`testing.ts`'s per-`synthesizeInput`-call
 * offset map does not persist ACROSS actions), which always lands on the
 * SAME lowest-id (seeded, already-`succeeded`) row — none of them ever
 * mutate it away from `succeeded`, so the one `requested` row created by
 * `create_refund_request` is never touched by a later action in the run. */
export const m33DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'refunds.search_refund_requests',
    paramsA: { status: 'succeeded' },
    paramsB: { status: 'requested' },
    expectDifferentCounts: true,
  },
];

/** `payments` is a shared mega-table (`kind: 'payment'|'refund'`) — every
 * bare `id` field here means "a refund-kind row" and needs a `${slug}:id`
 * scoped hint (M29 Payments declares the `kind:'payment'` counterpart on
 * the same table). `payment_id` is a FLAT override (declared identically
 * in m29-payments.ts; redundant, harmless, order-independent). */
export const m33SynthHints: SynthHints = {
  'refunds.get_refund_request:id': { table: 'payments', kind: 'refund' },
  'refunds.set_refund_reason:id': { table: 'payments', kind: 'refund' },
  'refunds.set_partial_refund_amount:id': { table: 'payments', kind: 'refund' },
  'refunds.approve_refund_request:id': { table: 'payments', kind: 'refund' },
  'refunds.reject_refund_request:id': { table: 'payments', kind: 'refund' },
  'refunds.execute_simulated_refund:id': { table: 'payments', kind: 'refund' },
  'refunds.get_refund_execution_status:id': { table: 'payments', kind: 'refund' },
  payment_id: { table: 'payments', kind: 'payment' },
};
