/**
 * M27 Quotes — follows the M01 Contacts convention verbatim.
 *
 * Data home: the typed `quotes` table (plain, NOT kind-discriminated — the
 * bare `id` field resolves correctly via `entities[0]`) PLUS `line_items`
 * (`parent_type='quote'`, shared with M28 Invoices/M32 Orders — see
 * `line-items.ts`'s header for the MONEY RULE: `total_cents` is ALWAYS
 * fully recomputed from live line items, never incrementally patched).
 *
 * DESIGN NOTE — discount persistence: `apply_quote_discount` must survive
 * a LATER line-item mutation recomputing the total (money rule), so the
 * discount descriptor itself must be persisted somewhere, re-applied on
 * every recompute. `quotes` has no dedicated JSON config column — `notes`
 * (the only free-text column) doubles as a small JSON sidecar:
 * `{ note: string | null, discount: {type,value} | null }`.
 * `readQuoteNotes` is resilient to BOTH shapes: a legacy/seed plain string
 * (treated as `{note: <string>, discount: null}`) and the JSON object this
 * module writes going forward — same "legacy shape vs. new shape,
 * normalize on read" pattern as `product-prices.ts`'s `prices` column
 * upgrade. `create_quote`'s own `notes` input is a plain human note (no
 * discount yet); `apply_quote_discount` is the only action that sets the
 * `discount` key, and does so via the SAME sidecar so a human note set at
 * creation is preserved alongside it.
 *
 * FIX ROUND 2 (reviewer IMPORTANT, task-9-b4): `add_quote_line_item`/
 * `update_quote_line_item` now CONFLICT unless `status='draft'` (matching
 * M28 Invoices' `add_invoice_line_item`/`update_draft_invoice` pattern) —
 * previously an already-SENT or ACCEPTED quote could be silently mutated,
 * letting `total_cents` drift away from the total the customer actually
 * agreed to/was invoiced from `convert_accepted_quote_to_invoice`.
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
  patchLineItemQuantityOrPrice,
  recomputeParentSubtotal,
  toLineItemView,
  type LineItemView,
} from './line-items.js';

const MODULE = 'quotes';
const DAY_MS = 1000 * 60 * 60 * 24;

interface QuoteDiscount {
  type: 'percent' | 'fixed';
  value: number;
}
interface QuoteNotes {
  note: string | null;
  discount: QuoteDiscount | null;
}

function readQuoteNotes(row: Row): QuoteNotes {
  const raw = row['notes'];
  if (typeof raw !== 'string' || raw.length === 0) return { note: null, discount: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if ('discount' in obj || 'note' in obj) {
        const d = obj['discount'];
        const discount =
          d && typeof d === 'object' && typeof (d as Record<string, unknown>)['value'] === 'number'
            ? (d as unknown as QuoteDiscount)
            : null;
        return { note: typeof obj['note'] === 'string' ? obj['note'] : null, discount };
      }
    }
    // Valid JSON but not our sidecar shape — treat the raw string as a plain note.
    return { note: raw, discount: null };
  } catch {
    return { note: raw, discount: null };
  }
}

function writeQuoteNotes(tx: StoreTx, id: string, notes: QuoteNotes, now: number): void {
  tx.run(`UPDATE quotes SET notes = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(notes), now, id]);
}

function applyDiscount(subtotalCents: number, discount: QuoteDiscount | null): number {
  if (!discount) return subtotalCents;
  const raw =
    discount.type === 'percent'
      ? subtotalCents * (1 - discount.value / 100)
      : subtotalCents - discount.value;
  return Math.max(0, Math.round(raw));
}

/** The ONLY writer of `quotes.total_cents` — always a full recompute from
 * live `line_items` + the persisted discount descriptor (money rule). */
function recomputeQuoteTotal(tx: StoreTx, id: string, now: number): void {
  const row = tx.get(`SELECT notes FROM quotes WHERE id = ?`, [id]);
  const { discount } = row ? readQuoteNotes(row) : { discount: null };
  const subtotal = recomputeParentSubtotal(tx, 'quote', id);
  const total = applyDiscount(subtotal, discount);
  tx.run(`UPDATE quotes SET total_cents = ?, updated_at = ? WHERE id = ?`, [total, now, id]);
}

interface QuoteView {
  id: string;
  number: string;
  contact_id: string;
  company_id: string | null;
  status: string;
  total_cents: number;
  owner_id: string | null;
  valid_until: number | null;
  currency: string | null;
  note: string | null;
  discount: QuoteDiscount | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): QuoteView {
  const { note, discount } = readQuoteNotes(row);
  return {
    id: row['id'] as string,
    number: row['number'] as string,
    contact_id: row['contact_id'] as string,
    company_id: (row['company_id'] as string | null) ?? null,
    status: row['status'] as string,
    total_cents: row['total_cents'] as number,
    owner_id: (row['owner_id'] as string | null) ?? null,
    valid_until: (row['valid_until'] as number | null) ?? null,
    currency: (row['currency'] as string | null) ?? null,
    note,
    discount,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getQuoteRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM quotes WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Quote '${id}' does not exist.`);
  return row;
}

const discountSchema = z.object({ type: z.enum(['percent', 'fixed']), value: z.number() });
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
const quoteView = z.object({
  id: z.string(),
  number: z.string(),
  contact_id: z.string(),
  company_id: z.string().nullable(),
  status: z.string(),
  total_cents: z.number(),
  owner_id: z.string().nullable(),
  valid_until: z.number().nullable(),
  currency: z.string().nullable(),
  note: z.string().nullable(),
  discount: discountSchema.nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_quote -----------------------------------------------------

const createQuoteInput = z.strictObject({
  contact_id: z.string(),
  company_id: z.string().optional(),
  owner_id: z.string().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
});

const createQuote: ActionDef<z.infer<typeof createQuoteInput>, QuoteView> = {
  id: 'M27.A01',
  slug: 'quotes.create_quote',
  module: MODULE,
  name: 'Create quote',
  description: 'Create a new draft quote for a contact.',
  risk: 'write',
  entities: ['quotes'],
  inputSchema: createQuoteInput,
  outputSchema: quoteView,
  searchCard: {
    synonyms: ['add quote', 'new quote'],
    examplePhrasings: ['Create a quote for this contact'],
  },
  jit: 'A fresh quote starts with total_cents=0 — add line items with add_quote_line_item.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'quotes', 'quote');
    const now = ctx.clock.now();
    const number = nextDocNumber(ctx.db, 'quotes', 'Q');
    ctx.db.run(
      `INSERT INTO quotes (id, created_at, updated_at, archived, number, contact_id, company_id,
        status, total_cents, owner_id, valid_until, currency, notes)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', 0, ?, ?, ?, ?)`,
      [
        id,
        now,
        now,
        number,
        input.contact_id,
        input.company_id ?? null,
        input.owner_id ?? null,
        now + 30 * DAY_MS,
        input.currency ?? 'USD',
        JSON.stringify({ note: input.notes ?? null, discount: null }),
      ],
    );
    return toView(getQuoteRow(ctx.db, id));
  }),
};

// --- A02 get_quote_details -------------------------------------------------

const getQuoteDetailsInput = z.strictObject({ id: z.string() });
const quoteDetailsOutput = z.object({ quote: quoteView, line_items: z.array(lineItemView) });
type QuoteDetailsOutput = z.infer<typeof quoteDetailsOutput>;

const getQuoteDetails: ActionDef<z.infer<typeof getQuoteDetailsInput>, QuoteDetailsOutput> = {
  id: 'M27.A02',
  slug: 'quotes.get_quote_details',
  module: MODULE,
  name: 'Get quote details',
  description: 'Fetch a quote and its line items.',
  risk: 'read',
  entities: ['quotes', 'line_items'],
  inputSchema: getQuoteDetailsInput,
  outputSchema: quoteDetailsOutput,
  searchCard: {
    synonyms: ['quote details', 'look up quote'],
    examplePhrasings: ['Show me quote Q-1042'],
  },
  handler: async (input, ctx) => ({
    quote: toView(getQuoteRow(ctx.db, input.id)),
    line_items: listLineItems(ctx.db, 'quote', input.id),
  }),
};

// --- A03 search_quotes -----------------------------------------------------

const searchQuotesInput = z.strictObject({
  contact_id: z.string().optional(),
  company_id: z.string().optional(),
  owner_id: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchQuotesInput = z.infer<typeof searchQuotesInput>;
const searchQuotesOutput = listOutputSchema(quoteView);
type SearchQuotesOutput = ListOrSpill<QuoteView>;

const searchQuotes: ActionDef<SearchQuotesInput, SearchQuotesOutput> = {
  id: 'M27.A03',
  slug: 'quotes.search_quotes',
  module: MODULE,
  name: 'Search quotes',
  description: 'Search non-archived quotes by common filters.',
  risk: 'read',
  entities: ['quotes'],
  inputSchema: searchQuotesInput,
  outputSchema: searchQuotesOutput,
  searchCard: {
    synonyms: ['find quotes', 'list quotes'],
    examplePhrasings: ['Find all accepted quotes'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Use get_quote_details for a quote\'s line items.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.contact_id) {
      where.push('contact_id = ?');
      params.push(input.contact_id);
    }
    if (input.company_id) {
      where.push('company_id = ?');
      params.push(input.company_id);
    }
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
    }
    if (input.status) {
      where.push('status = ? COLLATE NOCASE');
      params.push(input.status);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM quotes WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM quotes WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'quotes', whereSql, params },
    });
  },
};

// --- A04 add_quote_line_item -----------------------------------------------

const addQuoteLineItemInput = z.strictObject({
  id: z.string(),
  product_id: z.string(),
  quantity: z.number().int().min(1),
  unit_price_cents: z.number().int().min(0).optional(),
  description: z.string().optional(),
});
const quoteLineItemResult = z.object({ quote: quoteView, line_item: lineItemView });
type QuoteLineItemResult = z.infer<typeof quoteLineItemResult>;

const addQuoteLineItem: ActionDef<z.infer<typeof addQuoteLineItemInput>, QuoteLineItemResult> = {
  id: 'M27.A04',
  slug: 'quotes.add_quote_line_item',
  module: MODULE,
  name: 'Add quote line item',
  description: 'Add a product line item to a quote. total_cents is fully recomputed.',
  risk: 'write',
  entities: ['quotes', 'line_items', 'products'],
  inputSchema: addQuoteLineItemInput,
  outputSchema: quoteLineItemResult,
  searchCard: {
    synonyms: ['add line item', 'add product to quote'],
    examplePhrasings: ['Add 2 of this product to the quote'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const quote = getQuoteRow(ctx.db, input.id);
    if (quote['status'] !== 'draft') {
      throw new ActionError('CONFLICT', `Quote '${input.id}' is not in 'draft' status — line items are fixed once sent.`);
    }
    const product = ctx.db.get(`SELECT default_price_cents FROM products WHERE id = ?`, [input.product_id]);
    if (!product) throw new ActionError('NOT_FOUND', `Product '${input.product_id}' does not exist.`);
    const unitPrice = input.unit_price_cents ?? (product['default_price_cents'] as number | null) ?? 0;
    const now = ctx.clock.now();
    const lineItemId = insertLineItem(
      ctx.db,
      'quote',
      input.id,
      { product_id: input.product_id, quantity: input.quantity, unit_price_cents: unitPrice, description: input.description },
      now,
    );
    recomputeQuoteTotal(ctx.db, input.id, now);
    const lineRow = getOwnedLineItemRow(ctx.db, 'quote', input.id, lineItemId, 'quote');
    return { quote: toView(getQuoteRow(ctx.db, input.id)), line_item: toLineItemView(lineRow) };
  }),
};

// --- A05 update_quote_line_item -----------------------------------------------

const updateQuoteLineItemInput = z.strictObject({
  id: z.string(),
  line_item_id: z.string(),
  patch: z
    .strictObject({ quantity: z.number().int().min(1).optional(), unit_price_cents: z.number().int().min(0).optional() })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateQuoteLineItem: ActionDef<z.infer<typeof updateQuoteLineItemInput>, QuoteLineItemResult> = {
  id: 'M27.A05',
  slug: 'quotes.update_quote_line_item',
  module: MODULE,
  name: 'Update quote line item',
  description: 'Patch a quote line item\'s quantity/price. total_cents is fully recomputed.',
  risk: 'write',
  entities: ['quotes', 'line_items'],
  inputSchema: updateQuoteLineItemInput,
  outputSchema: quoteLineItemResult,
  searchCard: {
    synonyms: ['edit line item', 'change quote line item'],
    examplePhrasings: ['Change the quantity on this quote line item'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const quote = getQuoteRow(ctx.db, input.id);
    if (quote['status'] !== 'draft') {
      throw new ActionError('CONFLICT', `Quote '${input.id}' is not in 'draft' status — line items are fixed once sent.`);
    }
    getOwnedLineItemRow(ctx.db, 'quote', input.id, input.line_item_id, 'quote');
    const now = ctx.clock.now();
    patchLineItemQuantityOrPrice(ctx.db, input.line_item_id, input.patch, now);
    recomputeQuoteTotal(ctx.db, input.id, now);
    const lineRow = getOwnedLineItemRow(ctx.db, 'quote', input.id, input.line_item_id, 'quote');
    return { quote: toView(getQuoteRow(ctx.db, input.id)), line_item: toLineItemView(lineRow) };
  }),
};

// --- A06 set_quote_expiry -----------------------------------------------

const setQuoteExpiryInput = z.strictObject({ id: z.string(), valid_until: z.number().int().min(0) });

const setQuoteExpiry: ActionDef<z.infer<typeof setQuoteExpiryInput>, QuoteView> = {
  id: 'M27.A06',
  slug: 'quotes.set_quote_expiry',
  module: MODULE,
  name: 'Set quote expiry',
  description: 'Set the date a quote stops being valid.',
  risk: 'write',
  entities: ['quotes'],
  inputSchema: setQuoteExpiryInput,
  outputSchema: quoteView,
  searchCard: {
    synonyms: ['set valid until', 'extend quote expiry'],
    examplePhrasings: ['Extend this quote by another 2 weeks'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getQuoteRow(ctx.db, input.id);
    ctx.db.run(`UPDATE quotes SET valid_until = ?, updated_at = ? WHERE id = ?`, [
      input.valid_until,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getQuoteRow(ctx.db, input.id));
  }),
};

// --- A07 apply_quote_discount -----------------------------------------------

const applyQuoteDiscountInput = z.strictObject({
  id: z.string(),
  discount_type: z.enum(['percent', 'fixed']),
  value: z.number().min(0),
});

const applyQuoteDiscount: ActionDef<z.infer<typeof applyQuoteDiscountInput>, QuoteView> = {
  id: 'M27.A07',
  slug: 'quotes.apply_quote_discount',
  module: MODULE,
  name: 'Apply quote discount',
  description:
    'Apply a percent/fixed discount to a quote. total_cents is recomputed now and on every future line-item change.',
  risk: 'write',
  entities: ['quotes', 'line_items'],
  inputSchema: applyQuoteDiscountInput,
  outputSchema: quoteView,
  searchCard: {
    synonyms: ['discount this quote', 'apply discount'],
    examplePhrasings: ['Apply a 10% discount to this quote'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    if (input.discount_type === 'percent' && input.value > 100) {
      throw new ActionError('VALIDATION', 'A percent discount must be between 0 and 100.');
    }
    const row = getQuoteRow(ctx.db, input.id);
    const { note } = readQuoteNotes(row);
    const now = ctx.clock.now();
    writeQuoteNotes(ctx.db, input.id, { note, discount: { type: input.discount_type, value: input.value } }, now);
    recomputeQuoteTotal(ctx.db, input.id, now);
    return toView(getQuoteRow(ctx.db, input.id));
  }),
};

// --- A08 send_quote_for_acceptance -----------------------------------------------

const sendQuoteForAcceptanceInput = z.strictObject({ id: z.string() });

const sendQuoteForAcceptance: ActionDef<z.infer<typeof sendQuoteForAcceptanceInput>, QuoteView> = {
  id: 'M27.A08',
  slug: 'quotes.send_quote_for_acceptance',
  module: MODULE,
  name: 'Send quote for acceptance',
  description: 'Transition a draft quote to sent.',
  risk: 'write',
  entities: ['quotes'],
  inputSchema: sendQuoteForAcceptanceInput,
  outputSchema: quoteView,
  searchCard: {
    synonyms: ['send quote', 'quote to sent'],
    examplePhrasings: ['Send this quote to the customer'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getQuoteRow(ctx.db, input.id);
    if (row['status'] !== 'draft') {
      throw new ActionError('CONFLICT', `Quote '${input.id}' is not in 'draft' status.`);
    }
    ctx.db.run(`UPDATE quotes SET status = 'sent', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getQuoteRow(ctx.db, input.id));
  }),
};

// --- A09 record_quote_acceptance -----------------------------------------------

const recordQuoteAcceptanceInput = z.strictObject({ id: z.string() });

const recordQuoteAcceptance: ActionDef<z.infer<typeof recordQuoteAcceptanceInput>, QuoteView> = {
  id: 'M27.A09',
  slug: 'quotes.record_quote_acceptance',
  module: MODULE,
  name: 'Record quote acceptance',
  description: 'Mark a sent quote as accepted by the customer.',
  risk: 'write',
  entities: ['quotes'],
  inputSchema: recordQuoteAcceptanceInput,
  outputSchema: quoteView,
  searchCard: {
    synonyms: ['accept quote', 'customer accepted quote'],
    examplePhrasings: ['The customer accepted this quote'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getQuoteRow(ctx.db, input.id);
    if (row['status'] !== 'sent') {
      throw new ActionError('CONFLICT', `Quote '${input.id}' is not in 'sent' status.`);
    }
    ctx.db.run(`UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getQuoteRow(ctx.db, input.id));
  }),
};

// --- A10 convert_accepted_quote_to_invoice -----------------------------------------------

const convertAcceptedQuoteToInvoiceInput = z.strictObject({ id: z.string() });
const convertResultOutput = z.object({
  quote_id: z.string(),
  invoice: z.object({
    id: z.string(),
    number: z.string(),
    status: z.string(),
    total_cents: z.number(),
  }),
});

const convertAcceptedQuoteToInvoice: ActionDef<
  z.infer<typeof convertAcceptedQuoteToInvoiceInput>,
  z.infer<typeof convertResultOutput>
> = {
  id: 'M27.A10',
  slug: 'quotes.convert_accepted_quote_to_invoice',
  module: MODULE,
  name: 'Convert accepted quote to invoice',
  description: 'Create a draft invoice from an accepted quote, copying its line items.',
  risk: 'write',
  entities: ['quotes', 'line_items', 'invoices'],
  inputSchema: convertAcceptedQuoteToInvoiceInput,
  outputSchema: convertResultOutput,
  searchCard: {
    synonyms: ['convert quote to invoice', 'invoice this quote'],
    examplePhrasings: ['Turn this accepted quote into an invoice'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const quote = getQuoteRow(ctx.db, input.id);
    if (quote['status'] !== 'accepted') {
      throw new ActionError('CONFLICT', `Quote '${input.id}' is not in 'accepted' status.`);
    }
    const now = ctx.clock.now();
    const invoiceId = nextId(ctx.db, 'invoices', 'inv');
    const number = nextDocNumber(ctx.db, 'invoices', 'INV');
    ctx.db.run(
      `INSERT INTO invoices (id, created_at, updated_at, archived, number, contact_id, status,
        total_cents, amount_paid_cents, due_date, issued_at, paid_at, quote_id, owner_id, currency)
       VALUES (?, ?, ?, 0, ?, ?, 'draft', 0, 0, NULL, NULL, NULL, ?, ?, ?)`,
      [invoiceId, now, now, number, quote['contact_id'], input.id, quote['owner_id'], quote['currency']],
    );
    const sourceItems = listLineItems(ctx.db, 'quote', input.id);
    for (const item of sourceItems) {
      insertLineItem(
        ctx.db,
        'invoice',
        invoiceId,
        {
          product_id: item.product_id ?? '',
          quantity: item.quantity,
          unit_price_cents: item.unit_price_cents,
          description: item.description,
        },
        now,
      );
    }
    const total = recomputeParentSubtotal(ctx.db, 'invoice', invoiceId);
    ctx.db.run(`UPDATE invoices SET total_cents = ?, updated_at = ? WHERE id = ?`, [total, now, invoiceId]);
    const invoiceRow = ctx.db.get(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]) as Row;
    return {
      quote_id: input.id,
      invoice: {
        id: invoiceRow['id'] as string,
        number: invoiceRow['number'] as string,
        status: invoiceRow['status'] as string,
        total_cents: invoiceRow['total_cents'] as number,
      },
    };
  }),
};

export const m27Quotes: ActionDef[] = [
  createQuote as ActionDef,
  getQuoteDetails as ActionDef,
  searchQuotes as ActionDef,
  addQuoteLineItem as ActionDef,
  updateQuoteLineItem as ActionDef,
  setQuoteExpiry as ActionDef,
  applyQuoteDiscount as ActionDef,
  sendQuoteForAcceptance as ActionDef,
  recordQuoteAcceptance as ActionDef,
  convertAcceptedQuoteToInvoice as ActionDef,
];

/** Tier-A discrimination: `status` counts over 450 quotes — verified via
 * live `npm run smoke` output: 'draft' → 89, 'accepted' → 88. Thin margin
 * for a uniform 5-way split — flagged per task-9-b1/b2/b3's small-margin
 * precedent (M08 tags, M16 workflows) for future re-verification if the
 * seed's quote count or status distribution ever changes. */
export const m27DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'quotes.search_quotes',
    paramsA: { status: 'draft' },
    paramsB: { status: 'accepted' },
    expectDifferentCounts: true,
  },
];

/** `quotes` is a plain (non-kind-discriminated) table — `id` resolves via
 * `entities[0]`. `line_item_id` is backed by the shared `line_items` table,
 * discriminated by `parent_type` (not `kind`) — scoped so it doesn't
 * collide with M28/M32's identically-named field on the same table. */
export const m27SynthHints: SynthHints = {
  'quotes.update_quote_line_item:line_item_id': { table: 'line_items', kind: 'quote', column: 'parent_type' },
};
