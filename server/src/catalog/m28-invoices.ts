/**
 * M28 Invoices — follows the M01 Contacts convention verbatim.
 *
 * Data home: the typed `invoices` table (plain, NOT kind-discriminated)
 * PLUS `line_items` (`parent_type='invoice'`, shared with M27/M32 — see
 * `line-items.ts`'s MONEY RULE: `total_cents` is ALWAYS fully recomputed
 * from live line items).
 *
 * EVAL-CRITICAL overdue semantics ("unpaid invoices overdue by more than
 * 15 days"): `search_invoices`/`list_overdue_invoices` both accept an
 * optional `min_days_overdue` and filter `status = 'issued' AND due_date <
 * (ctx.clock.now() - min_days_overdue * DAY_MS)` — the cutoff is derived
 * from the VIRTUAL clock, never wall-clock time. `min_days_overdue: 15`
 * is exactly "overdue by more than 15 days."
 *
 * EVAL-CRITICAL reminder dedup marker: `send_invoice_reminder` creates a
 * real `messages` row (`channel='email'`, matching M13's shape) whose
 * `subject` is prefixed `[invoice_reminder:{invoice_id}]` — a caller
 * implementing "skip customers who already got a reminder this week" runs
 * `email.search_email_messages` (M13) with `contact_id` + a `created_at`
 * lower bound of `now - 7*DAY_MS` and checks for that subject prefix (or
 * queries `messages` directly). This module doesn't do the dedup itself —
 * it makes the fact searchable, per brief.
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
import {
  listLineItems,
  getOwnedLineItemRow,
  insertLineItem,
  recomputeParentSubtotal,
  toLineItemView,
} from './line-items.js';
import { findOrCreateConversation, markConversationOutbound } from './conversation-utils.js';

const MODULE = 'invoices';
const DAY_MS = 1000 * 60 * 60 * 24;

function getInvoiceRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM invoices WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Invoice '${id}' does not exist.`);
  return row;
}

/** The ONLY writer of `invoices.total_cents` — full recompute from live
 * line items (money rule; invoices have no discount concept in this
 * catalog, so this is a plain pass-through of the subtotal). */
function recomputeInvoiceTotal(tx: StoreTx, id: string, now: number): void {
  const total = recomputeParentSubtotal(tx, 'invoice', id);
  tx.run(`UPDATE invoices SET total_cents = ?, updated_at = ? WHERE id = ?`, [total, now, id]);
}

interface InvoiceView {
  id: string;
  number: string;
  contact_id: string;
  status: string;
  total_cents: number;
  amount_paid_cents: number | null;
  due_date: number | null;
  issued_at: number | null;
  paid_at: number | null;
  quote_id: string | null;
  owner_id: string | null;
  currency: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): InvoiceView {
  return {
    id: row['id'] as string,
    number: row['number'] as string,
    contact_id: row['contact_id'] as string,
    status: row['status'] as string,
    total_cents: row['total_cents'] as number,
    amount_paid_cents: (row['amount_paid_cents'] as number | null) ?? null,
    due_date: (row['due_date'] as number | null) ?? null,
    issued_at: (row['issued_at'] as number | null) ?? null,
    paid_at: (row['paid_at'] as number | null) ?? null,
    quote_id: (row['quote_id'] as string | null) ?? null,
    owner_id: (row['owner_id'] as string | null) ?? null,
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
const invoiceView = z.object({
  id: z.string(),
  number: z.string(),
  contact_id: z.string(),
  status: z.string(),
  total_cents: z.number(),
  amount_paid_cents: z.number().nullable(),
  due_date: z.number().nullable(),
  issued_at: z.number().nullable(),
  paid_at: z.number().nullable(),
  quote_id: z.string().nullable(),
  owner_id: z.string().nullable(),
  currency: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

function overdueWhere(now: number, minDaysOverdue: number): { sql: string; params: unknown[] } {
  const cutoff = now - minDaysOverdue * DAY_MS;
  return { sql: `status = 'issued' AND due_date < ?`, params: [cutoff] };
}

// --- A01 create_invoice -----------------------------------------------------

const createInvoiceInput = z.strictObject({
  contact_id: z.string(),
  owner_id: z.string().optional(),
  currency: z.string().optional(),
  quote_id: z.string().optional(),
});

const createInvoice: ActionDef<z.infer<typeof createInvoiceInput>, InvoiceView> = {
  id: 'M28.A01',
  slug: 'invoices.create_invoice',
  module: MODULE,
  name: 'Create invoice',
  description: 'Create a new draft invoice for a contact.',
  risk: 'write',
  entities: ['invoices'],
  inputSchema: createInvoiceInput,
  outputSchema: invoiceView,
  searchCard: {
    synonyms: ['add invoice', 'new invoice'],
    examplePhrasings: ['Create an invoice for this contact'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'invoices', 'inv');
    const now = ctx.clock.now();
    const number = nextDocNumber(ctx.db, 'invoices', 'INV');
    ctx.db.run(
      `INSERT INTO invoices (id, created_at, updated_at, archived, number, contact_id, status,
        total_cents, amount_paid_cents, due_date, issued_at, paid_at, quote_id, owner_id, currency)
       VALUES (?, ?, ?, 0, ?, ?, 'draft', 0, 0, NULL, NULL, NULL, ?, ?, ?)`,
      [id, now, now, number, input.contact_id, input.quote_id ?? null, input.owner_id ?? null, input.currency ?? 'USD'],
    );
    return toView(getInvoiceRow(ctx.db, id));
  }),
};

// --- A02 get_invoice_details -------------------------------------------------

const getInvoiceDetailsInput = z.strictObject({ id: z.string() });
const invoiceDetailsOutput = z.object({ invoice: invoiceView, line_items: z.array(lineItemView) });

const getInvoiceDetails: ActionDef<z.infer<typeof getInvoiceDetailsInput>, z.infer<typeof invoiceDetailsOutput>> = {
  id: 'M28.A02',
  slug: 'invoices.get_invoice_details',
  module: MODULE,
  name: 'Get invoice details',
  description: 'Fetch an invoice and its line items.',
  risk: 'read',
  entities: ['invoices', 'line_items'],
  inputSchema: getInvoiceDetailsInput,
  outputSchema: invoiceDetailsOutput,
  searchCard: {
    synonyms: ['invoice details', 'look up invoice'],
    examplePhrasings: ['Show me invoice INV-2042'],
  },
  handler: async (input, ctx) => ({
    invoice: toView(getInvoiceRow(ctx.db, input.id)),
    line_items: listLineItems(ctx.db, 'invoice', input.id),
  }),
};

// --- A03 search_invoices -----------------------------------------------------

const searchInvoicesInput = z.strictObject({
  contact_id: z.string().optional(),
  status: z.string().optional(),
  owner_id: z.string().optional(),
  min_days_overdue: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchInvoicesInput = z.infer<typeof searchInvoicesInput>;
const searchInvoicesOutput = listOutputSchema(invoiceView);
type SearchInvoicesOutput = ListOrSpill<InvoiceView>;

const searchInvoices: ActionDef<SearchInvoicesInput, SearchInvoicesOutput> = {
  id: 'M28.A03',
  slug: 'invoices.search_invoices',
  module: MODULE,
  name: 'Search invoices',
  description:
    "Search non-archived invoices. Pass min_days_overdue to find unpaid invoices overdue by more than N days (status='issued' AND due_date < now - N days).",
  risk: 'read',
  entities: ['invoices'],
  inputSchema: searchInvoicesInput,
  outputSchema: searchInvoicesOutput,
  searchCard: {
    synonyms: ['find invoices', 'list invoices'],
    examplePhrasings: ['Find invoices overdue by more than 15 days'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. min_days_overdue:15 finds unpaid invoices overdue by more than 15 days.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.contact_id) {
      where.push('contact_id = ?');
      params.push(input.contact_id);
    }
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
    }
    if (input.min_days_overdue !== undefined) {
      const { sql, params: p } = overdueWhere(ctx.clock.now(), input.min_days_overdue);
      where.push(sql);
      params.push(...p);
    } else if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM invoices WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM invoices WHERE ${whereSql} ORDER BY due_date ASC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'invoices', whereSql, params },
    });
  },
};

// --- A04 add_invoice_line_item -----------------------------------------------

const addInvoiceLineItemInput = z.strictObject({
  id: z.string(),
  product_id: z.string(),
  quantity: z.number().int().min(1),
  unit_price_cents: z.number().int().min(0).optional(),
  description: z.string().optional(),
});
const invoiceLineItemResult = z.object({ invoice: invoiceView, line_item: lineItemView });

const addInvoiceLineItem: ActionDef<z.infer<typeof addInvoiceLineItemInput>, z.infer<typeof invoiceLineItemResult>> = {
  id: 'M28.A04',
  slug: 'invoices.add_invoice_line_item',
  module: MODULE,
  name: 'Add invoice line item',
  description: 'Add a product line item to a draft invoice. total_cents is fully recomputed.',
  risk: 'write',
  entities: ['invoices', 'line_items', 'products'],
  inputSchema: addInvoiceLineItemInput,
  outputSchema: invoiceLineItemResult,
  searchCard: {
    synonyms: ['add line item', 'add product to invoice'],
    examplePhrasings: ['Add this product to the invoice'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const invoice = getInvoiceRow(ctx.db, input.id);
    if (invoice['status'] !== 'draft') {
      throw new ActionError('CONFLICT', `Invoice '${input.id}' is not in 'draft' status — line items are fixed once issued.`);
    }
    const product = ctx.db.get(`SELECT default_price_cents FROM products WHERE id = ?`, [input.product_id]);
    if (!product) throw new ActionError('NOT_FOUND', `Product '${input.product_id}' does not exist.`);
    const unitPrice = input.unit_price_cents ?? (product['default_price_cents'] as number | null) ?? 0;
    const now = ctx.clock.now();
    const lineItemId = insertLineItem(
      ctx.db,
      'invoice',
      input.id,
      { product_id: input.product_id, quantity: input.quantity, unit_price_cents: unitPrice, description: input.description },
      now,
    );
    recomputeInvoiceTotal(ctx.db, input.id, now);
    const lineRow = getOwnedLineItemRow(ctx.db, 'invoice', input.id, lineItemId, 'invoice');
    return { invoice: toView(getInvoiceRow(ctx.db, input.id)), line_item: toLineItemView(lineRow) };
  }),
};

// --- A05 update_draft_invoice -----------------------------------------------

const updateDraftInvoiceInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({ contact_id: z.string().optional(), owner_id: z.string().optional(), currency: z.string().optional() })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateDraftInvoice: ActionDef<z.infer<typeof updateDraftInvoiceInput>, InvoiceView> = {
  id: 'M28.A05',
  slug: 'invoices.update_draft_invoice',
  module: MODULE,
  name: 'Update draft invoice',
  description: 'Patch header fields on a draft invoice.',
  risk: 'write',
  entities: ['invoices'],
  inputSchema: updateDraftInvoiceInput,
  outputSchema: invoiceView,
  searchCard: {
    synonyms: ['edit draft invoice', 'update invoice'],
    examplePhrasings: ["Change this draft invoice's owner"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const invoice = getInvoiceRow(ctx.db, input.id);
    if (invoice['status'] !== 'draft') {
      throw new ActionError('CONFLICT', `Invoice '${input.id}' is not in 'draft' status.`);
    }
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE invoices SET ${setSql}, updated_at = ? WHERE id = ?`, [...values, ctx.clock.now(), input.id]);
    return toView(getInvoiceRow(ctx.db, input.id));
  }),
};

// --- A06 set_invoice_due_date -----------------------------------------------

const setInvoiceDueDateInput = z.strictObject({ id: z.string(), due_date: z.number().int().min(0) });

const setInvoiceDueDate: ActionDef<z.infer<typeof setInvoiceDueDateInput>, InvoiceView> = {
  id: 'M28.A06',
  slug: 'invoices.set_invoice_due_date',
  module: MODULE,
  name: 'Set invoice due date',
  description: 'Set an invoice due date.',
  risk: 'write',
  entities: ['invoices'],
  inputSchema: setInvoiceDueDateInput,
  outputSchema: invoiceView,
  searchCard: {
    synonyms: ['change due date', 'extend invoice due date'],
    examplePhrasings: ['Push this invoice due date back a week'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const invoice = getInvoiceRow(ctx.db, input.id);
    if (invoice['status'] === 'paid' || invoice['status'] === 'void') {
      throw new ActionError('CONFLICT', `Invoice '${input.id}' is already settled (${invoice['status'] as string}).`);
    }
    ctx.db.run(`UPDATE invoices SET due_date = ?, updated_at = ? WHERE id = ?`, [
      input.due_date,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getInvoiceRow(ctx.db, input.id));
  }),
};

// --- A07 issue_invoice -----------------------------------------------

const issueInvoiceInput = z.strictObject({ id: z.string(), due_date: z.number().int().min(0).optional() });

const issueInvoice: ActionDef<z.infer<typeof issueInvoiceInput>, InvoiceView> = {
  id: 'M28.A07',
  slug: 'invoices.issue_invoice',
  module: MODULE,
  name: 'Issue invoice',
  description: 'Transition a draft invoice to issued, setting issued_at and due_date (net-30 default).',
  risk: 'write',
  entities: ['invoices'],
  inputSchema: issueInvoiceInput,
  outputSchema: invoiceView,
  searchCard: {
    synonyms: ['issue invoice', 'send invoice to customer'],
    examplePhrasings: ['Issue this invoice to the customer'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const invoice = getInvoiceRow(ctx.db, input.id);
    if (invoice['status'] !== 'draft') {
      throw new ActionError('CONFLICT', `Invoice '${input.id}' is not in 'draft' status.`);
    }
    const now = ctx.clock.now();
    const dueDate = input.due_date ?? now + 30 * DAY_MS;
    ctx.db.run(`UPDATE invoices SET status = 'issued', issued_at = ?, due_date = ?, updated_at = ? WHERE id = ?`, [
      now,
      dueDate,
      now,
      input.id,
    ]);
    return toView(getInvoiceRow(ctx.db, input.id));
  }),
};

// --- A08 send_invoice_reminder -----------------------------------------------

const sendInvoiceReminderInput = z.strictObject({ id: z.string() });
const reminderOutput = z.object({ id: z.string(), number: z.string(), message_id: z.string(), subject: z.string() });

const sendInvoiceReminder: ActionDef<z.infer<typeof sendInvoiceReminderInput>, z.infer<typeof reminderOutput>> = {
  id: 'M28.A08',
  slug: 'invoices.send_invoice_reminder',
  module: MODULE,
  name: 'Send invoice reminder',
  description:
    'Send a simulated payment reminder email for an issued invoice. Creates a real messages row (channel=email) tagged [invoice_reminder:{id}] for dedup lookups.',
  risk: 'external',
  entities: ['invoices', 'messages', 'conversations'],
  inputSchema: sendInvoiceReminderInput,
  outputSchema: reminderOutput,
  searchCard: {
    synonyms: ['remind customer', 'send payment reminder'],
    examplePhrasings: ['Send a reminder for this unpaid invoice'],
  },
  jit: "To avoid double-reminding, search email.search_email_messages with contact_id + created_at >= now-7days and check for a subject containing '[invoice_reminder:{id}]'.",
  handler: withIdempotentWrite(async (input, ctx) => {
    const invoice = getInvoiceRow(ctx.db, input.id);
    if (invoice['status'] !== 'issued') {
      throw new ActionError('CONFLICT', `Invoice '${input.id}' is not in 'issued' status — nothing to remind about.`);
    }
    const now = ctx.clock.now();
    const contactId = invoice['contact_id'] as string;
    const conversationId = findOrCreateConversation(ctx.db, now, contactId, 'email');
    const messageId = nextId(ctx.db, 'messages', 'msg');
    const subject = `[invoice_reminder:${input.id}] Payment reminder for ${invoice['number'] as string}`;
    ctx.db.run(
      `INSERT INTO messages (id, created_at, updated_at, archived, conversation_id, contact_id, channel,
        direction, status, scheduled_at, sent_at, from_addr, to_addr, template_id, campaign_id, subject, body)
       VALUES (?, ?, ?, 0, ?, ?, 'email', 'outbound', 'sent', NULL, ?, 'billing@ourcrm.io', NULL, NULL, NULL, ?, ?)`,
      [
        messageId,
        now,
        now,
        conversationId,
        contactId,
        now,
        subject,
        `This is a reminder that invoice ${invoice['number'] as string} is due.`,
      ],
    );
    markConversationOutbound(ctx.db, conversationId, now);
    return { id: input.id, number: invoice['number'] as string, message_id: messageId, subject };
  }),
};

// --- A09 void_unpaid_invoice -----------------------------------------------

const voidUnpaidInvoiceInput = z.strictObject({ id: z.string() });

const voidUnpaidInvoice: ActionDef<z.infer<typeof voidUnpaidInvoiceInput>, InvoiceView> = {
  id: 'M28.A09',
  slug: 'invoices.void_unpaid_invoice',
  module: MODULE,
  name: 'Void unpaid invoice',
  description: 'Void an invoice that has not been paid.',
  risk: 'destructive',
  entities: ['invoices'],
  inputSchema: voidUnpaidInvoiceInput,
  outputSchema: invoiceView,
  searchCard: {
    synonyms: ['void invoice', 'cancel invoice'],
    examplePhrasings: ['Void this invoice, the customer cancelled'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const invoice = getInvoiceRow(ctx.db, input.id);
    if (invoice['status'] === 'paid') {
      throw new ActionError('CONFLICT', `Invoice '${input.id}' is already paid and cannot be voided.`);
    }
    ctx.db.run(`UPDATE invoices SET status = 'void', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getInvoiceRow(ctx.db, input.id));
  }),
};

// --- A10 list_overdue_invoices -----------------------------------------------

const listOverdueInvoicesInput = z.strictObject({
  min_days_overdue: z.number().int().min(0).optional(),
  owner_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListOverdueInvoicesInput = z.infer<typeof listOverdueInvoicesInput>;
const listOverdueInvoicesOutput = listOutputSchema(invoiceView);
type ListOverdueInvoicesOutput = ListOrSpill<InvoiceView>;

const listOverdueInvoices: ActionDef<ListOverdueInvoicesInput, ListOverdueInvoicesOutput> = {
  id: 'M28.A10',
  slug: 'invoices.list_overdue_invoices',
  module: MODULE,
  name: 'List overdue invoices',
  description:
    "List unpaid invoices overdue by more than min_days_overdue days (status='issued' AND due_date < now - min_days_overdue days; default 0 = any overdue).",
  risk: 'read',
  entities: ['invoices'],
  inputSchema: listOverdueInvoicesInput,
  outputSchema: listOverdueInvoicesOutput,
  searchCard: {
    synonyms: ['overdue invoices', 'unpaid invoices past due', 'customers who still owe us money'],
    examplePhrasings: [
      'Which invoices are overdue by more than 15 days?',
      "Which customers haven't paid us yet?",
    ],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const now = ctx.clock.now();
    const { sql, params: overdueParams } = overdueWhere(now, input.min_days_overdue ?? 0);
    const where: string[] = ['archived = 0', sql];
    const params: unknown[] = [...overdueParams];
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM invoices WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM invoices WHERE ${whereSql} ORDER BY due_date ASC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'invoices', whereSql, params },
    });
  },
};

export const m28Invoices: ActionDef[] = [
  createInvoice as ActionDef,
  getInvoiceDetails as ActionDef,
  searchInvoices as ActionDef,
  addInvoiceLineItem as ActionDef,
  updateDraftInvoice as ActionDef,
  setInvoiceDueDate as ActionDef,
  issueInvoice as ActionDef,
  sendInvoiceReminder as ActionDef,
  voidUnpaidInvoice as ActionDef,
  listOverdueInvoices as ActionDef,
];

/** Tier-A discrimination: `status` counts over 750 invoices (incl. 65
 * forced-overdue) — verified via live `npm run smoke` output: 'issued' →
 * 322, 'paid' → 314. */
export const m28DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'invoices.search_invoices',
    paramsA: { status: 'issued' },
    paramsB: { status: 'paid' },
    expectDifferentCounts: true,
  },
];

/** `invoices` is a plain (non-kind-discriminated) table — `id` resolves
 * via `entities[0]`. `line_item_id` is backed by the shared `line_items`
 * table, discriminated by `parent_type` — M28 has no action taking a bare
 * `line_item_id` for lookup only (add_invoice_line_item creates one; no
 * update/remove-by-id action exists in this module's 10-action list), so
 * no scoped hint is needed here. */
export const m28SynthHints: SynthHints = {};
