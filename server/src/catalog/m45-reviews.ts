/**
 * M45 Reviews — follows the M01 Contacts convention verbatim.
 *
 * Data home: typed `reviews` table (`entities/model.ts#MODULE_MAP`).
 *
 * REQUEST vs. SUBMITTED REVIEW split (both live in the SAME `reviews`
 * table, discriminated purely by `status` — no DDL change needed):
 *   - A "review request" (create/send/cancel/list_review_requests) is a
 *     row with `status IN ('requested','sent','cancelled')` and `rating =
 *     null` (nothing to rate yet).
 *   - A "submitted review" (everything else) has `status IN
 *     ('pending','published','rejected')` and a real `rating` — matching
 *     `entities/seed-content.ts#generateReviews`'s own seeded shape (every
 *     seeded row already has a rating).
 *   `search_reviews`/`get_review_rating_summary` only ever consider rows
 *   with `rating IS NOT NULL`, keeping the two flavors cleanly disjoint.
 *
 * DRAFT vs. PUBLISHED RESPONSE sidecar: `reviews.response` (a real column)
 * is upgraded to a JSON `{draft: string|null, published: string|null}`
 * object — same "resilient sidecar, normalize legacy plain string" pattern
 * as task-9-b4's `refunds.reference`/`quotes.notes`. Seeded rows carry a
 * plain response string (or null) for ~30% of rows; `readResponseMeta`
 * treats a legacy plain string as an already-published response.
 *
 * `get_review_rating_summary` (A10) is a REAL `GROUP BY rating` aggregation
 * over published reviews (EVAL-CRITICAL per brief) — never fabricated.
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
import { findOrCreateConversation, markConversationOutbound } from './conversation-utils.js';

const MODULE = 'reviews';
const TARGET_TYPES = ['product', 'business_listing', 'course', 'company'] as const;

interface ResponseMeta {
  draft: string | null;
  published: string | null;
}

function readResponseMeta(row: Row): ResponseMeta {
  const raw = row['response'];
  if (typeof raw !== 'string' || raw.length === 0) return { draft: null, published: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return { draft: (obj['draft'] as string | null | undefined) ?? null, published: (obj['published'] as string | null | undefined) ?? null };
    }
    return { draft: null, published: raw };
  } catch {
    // legacy plain-string seed shape — treat as an already-published response.
    return { draft: null, published: raw };
  }
}

function writeResponseMeta(db: StoreTx, id: string, meta: ResponseMeta, now: number): void {
  db.run(`UPDATE reviews SET response = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(meta), now, id]);
}

function getReviewRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM reviews WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Review '${id}' does not exist.`);
  return row;
}

interface RequestView {
  id: string;
  name: string;
  target_type: string;
  target_id: string | null;
  contact_id: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function toRequestView(row: Row): RequestView {
  return {
    id: row['id'] as string,
    name: `Review request (${row['target_type'] as string})`,
    target_type: row['target_type'] as string,
    target_id: (row['target_id'] as string | null) ?? null,
    contact_id: row['contact_id'] as string,
    status: row['status'] as string,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const requestView = z.object({
  id: z.string(),
  name: z.string(),
  target_type: z.string(),
  target_id: z.string().nullable(),
  contact_id: z.string(),
  status: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

interface ReviewView {
  id: string;
  name: string;
  target_type: string;
  target_id: string | null;
  contact_id: string;
  rating: number;
  status: string;
  source: string;
  title: string | null;
  body: string | null;
  draft_response: string | null;
  response: string | null;
  created_at: number;
  updated_at: number;
}

function toReviewView(row: Row): ReviewView {
  const meta = readResponseMeta(row);
  return {
    id: row['id'] as string,
    name: `${row['rating'] as number}-star review (${row['target_type'] as string})`,
    target_type: row['target_type'] as string,
    target_id: (row['target_id'] as string | null) ?? null,
    contact_id: row['contact_id'] as string,
    rating: row['rating'] as number,
    status: row['status'] as string,
    source: row['source'] as string,
    title: (row['title'] as string | null) ?? null,
    body: (row['body'] as string | null) ?? null,
    draft_response: meta.draft,
    response: meta.published,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const reviewView = z.object({
  id: z.string(),
  name: z.string(),
  target_type: z.string(),
  target_id: z.string().nullable(),
  contact_id: z.string(),
  rating: z.number(),
  status: z.string(),
  source: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  draft_response: z.string().nullable(),
  response: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_review_request -----------------------------------------------------

const createReviewRequestInput = z.strictObject({
  contact_id: z.string(),
  target_type: z.enum(TARGET_TYPES),
  target_id: z.string().optional(),
});

const createReviewRequest: ActionDef<z.infer<typeof createReviewRequestInput>, RequestView> = {
  id: 'M45.A01',
  slug: 'reviews.create_review_request',
  module: MODULE,
  name: 'Create review request',
  description: 'Create a (not-yet-sent) request asking a contact to leave a review.',
  risk: 'write',
  entities: ['reviews', 'contacts'],
  inputSchema: createReviewRequestInput,
  outputSchema: requestView,
  searchCard: { synonyms: ['ask for review', 'new review request'], examplePhrasings: ['Ask this customer for a review'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    const id = nextId(ctx.db, 'reviews', 'rev');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO reviews (id, created_at, updated_at, archived, contact_id, target_type, target_id, rating,
        status, source, title, body, response)
       VALUES (?, ?, ?, 0, ?, ?, ?, NULL, 'requested', 'request', NULL, NULL, NULL)`,
      [id, now, now, input.contact_id, input.target_type, input.target_id ?? null],
    );
    return toRequestView(getReviewRow(ctx.db, id));
  }),
};

// --- A02 send_review_request -----------------------------------------------------

const sendReviewRequestInput = z.strictObject({ id: z.string() });
const sendOutput = z.object({ id: z.string(), name: z.string(), message_id: z.string(), status: z.literal('sent') });

const sendReviewRequest: ActionDef<z.infer<typeof sendReviewRequestInput>, z.infer<typeof sendOutput>> = {
  id: 'M45.A02',
  slug: 'reviews.send_review_request',
  module: MODULE,
  name: 'Send review request',
  description: 'Send a simulated review-request email (creates a real messages row).',
  risk: 'external',
  entities: ['reviews', 'messages', 'conversations'],
  inputSchema: sendReviewRequestInput,
  outputSchema: sendOutput,
  searchCard: { synonyms: ['send review ask', 'email review request'], examplePhrasings: ['Send the review request now'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getReviewRow(ctx.db, input.id);
    if (row['status'] !== 'requested') {
      throw new ActionError('CONFLICT', `Review request '${input.id}' is '${row['status'] as string}', not 'requested'.`);
    }
    const now = ctx.clock.now();
    const contactId = row['contact_id'] as string;
    const conversationId = findOrCreateConversation(ctx.db, now, contactId, 'email');
    const messageId = nextId(ctx.db, 'messages', 'msg');
    ctx.db.run(
      `INSERT INTO messages (id, created_at, updated_at, archived, conversation_id, contact_id, channel,
        direction, status, scheduled_at, sent_at, from_addr, to_addr, template_id, campaign_id, subject, body)
       VALUES (?, ?, ?, 0, ?, ?, 'email', 'outbound', 'sent', NULL, ?, 'reviews@ourcrm.io', NULL, NULL, NULL, ?, ?)`,
      [messageId, now, now, conversationId, contactId, now, `[review_request:${input.id}] We'd love your feedback`, 'Please share your experience with us.'],
    );
    markConversationOutbound(ctx.db, conversationId, now);
    ctx.db.run(`UPDATE reviews SET status = 'sent', updated_at = ? WHERE id = ?`, [now, input.id]);
    return { id: input.id, name: `Review request (${row['target_type'] as string})`, message_id: messageId, status: 'sent' as const };
  }),
};

// --- A03 cancel_unsent_review_request -----------------------------------------------------

const cancelUnsentReviewRequestInput = z.strictObject({ id: z.string() });

const cancelUnsentReviewRequest: ActionDef<z.infer<typeof cancelUnsentReviewRequestInput>, RequestView> = {
  id: 'M45.A03',
  slug: 'reviews.cancel_unsent_review_request',
  module: MODULE,
  name: 'Cancel unsent review request',
  description: 'Cancel a review request that has not been sent yet (CONFLICT if already sent).',
  risk: 'destructive',
  entities: ['reviews'],
  inputSchema: cancelUnsentReviewRequestInput,
  outputSchema: requestView,
  searchCard: { synonyms: ['cancel review request'], examplePhrasings: ["Cancel that review request — don't send it"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getReviewRow(ctx.db, input.id);
    if (row['status'] !== 'requested') {
      throw new ActionError('CONFLICT', `Review request '${input.id}' is '${row['status'] as string}' — can only cancel a 'requested' one.`);
    }
    ctx.db.run(`UPDATE reviews SET status = 'cancelled', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toRequestView(getReviewRow(ctx.db, input.id));
  }),
};

// --- A04 list_review_requests -----------------------------------------------------

const listReviewRequestsInput = z.strictObject({
  status: z.enum(['requested', 'sent', 'cancelled']).optional(),
  contact_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListReviewRequestsInput = z.infer<typeof listReviewRequestsInput>;
const listReviewRequestsOutput = listOutputSchema(requestView);
type ListReviewRequestsOutput = ListOrSpill<RequestView>;

const listReviewRequests: ActionDef<ListReviewRequestsInput, ListReviewRequestsOutput> = {
  id: 'M45.A04',
  slug: 'reviews.list_review_requests',
  module: MODULE,
  name: 'List review requests',
  description: 'List review requests (requested/sent/cancelled — never a submitted review).',
  risk: 'read',
  entities: ['reviews'],
  inputSchema: listReviewRequestsInput,
  outputSchema: listReviewRequestsOutput,
  searchCard: { synonyms: ['find review requests', 'pending review asks'], examplePhrasings: ['Show me unsent review requests'] },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', `status IN ('requested','sent','cancelled')`];
    const params: unknown[] = [];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.contact_id) {
      where.push('contact_id = ?');
      params.push(input.contact_id);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM reviews WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM reviews WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map(toRequestView), total);
  },
};

// --- A05 record_simulated_customer_review -----------------------------------------------------

const recordSimulatedCustomerReviewInput = z.strictObject({
  contact_id: z.string(),
  target_type: z.enum(TARGET_TYPES),
  target_id: z.string().optional(),
  rating: z.number().int().min(1).max(5),
  title: z.string().optional(),
  body: z.string().optional(),
});

const recordSimulatedCustomerReview: ActionDef<z.infer<typeof recordSimulatedCustomerReviewInput>, ReviewView> = {
  id: 'M45.A05',
  slug: 'reviews.record_simulated_customer_review',
  module: MODULE,
  name: 'Record simulated customer review',
  description: 'Record a new simulated customer review awaiting moderation.',
  risk: 'write',
  entities: ['reviews', 'contacts'],
  inputSchema: recordSimulatedCustomerReviewInput,
  outputSchema: reviewView,
  searchCard: { synonyms: ['simulate review', 'add customer review'], examplePhrasings: ['Record a 5-star review from this customer'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    const id = nextId(ctx.db, 'reviews', 'rev');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO reviews (id, created_at, updated_at, archived, contact_id, target_type, target_id, rating,
        status, source, title, body, response)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'pending', 'simulated', ?, ?, NULL)`,
      [id, now, now, input.contact_id, input.target_type, input.target_id ?? null, input.rating, input.title ?? null, input.body ?? null],
    );
    return toReviewView(getReviewRow(ctx.db, id));
  }),
};

// --- A06 search_reviews -----------------------------------------------------

const searchReviewsInput = z.strictObject({
  status: z.enum(['pending', 'published', 'rejected']).optional(),
  target_type: z.enum(TARGET_TYPES).optional(),
  target_id: z.string().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchReviewsInput = z.infer<typeof searchReviewsInput>;
const searchReviewsOutput = listOutputSchema(reviewView);
type SearchReviewsOutput = ListOrSpill<ReviewView>;

const searchReviews: ActionDef<SearchReviewsInput, SearchReviewsOutput> = {
  id: 'M45.A06',
  slug: 'reviews.search_reviews',
  module: MODULE,
  name: 'Search reviews',
  description: 'Search submitted reviews (always rating IS NOT NULL — never a request row) by status, target, and rating.',
  risk: 'read',
  entities: ['reviews'],
  inputSchema: searchReviewsInput,
  outputSchema: searchReviewsOutput,
  searchCard: { synonyms: ['find reviews', 'list reviews'], examplePhrasings: ['Show me our published 5-star reviews'] },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'rating IS NOT NULL'];
    const params: unknown[] = [];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.target_type) {
      where.push('target_type = ?');
      params.push(input.target_type);
    }
    if (input.target_id) {
      where.push('target_id = ?');
      params.push(input.target_id);
    }
    if (input.rating !== undefined) {
      where.push('rating = ?');
      params.push(input.rating);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM reviews WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM reviews WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map(toReviewView), total);
  },
};

// --- A07 get_review_details -----------------------------------------------------

const getReviewDetailsInput = z.strictObject({ id: z.string() });

const getReviewDetails: ActionDef<z.infer<typeof getReviewDetailsInput>, ReviewView> = {
  id: 'M45.A07',
  slug: 'reviews.get_review_details',
  module: MODULE,
  name: 'Get review details',
  description: 'Fetch a single submitted review by id.',
  risk: 'read',
  entities: ['reviews'],
  inputSchema: getReviewDetailsInput,
  outputSchema: reviewView,
  searchCard: { synonyms: ['review details', 'look up review'], examplePhrasings: ['Show me this review'] },
  handler: async (input, ctx) => {
    const row = getReviewRow(ctx.db, input.id);
    if (row['rating'] === null) throw new ActionError('NOT_FOUND', `Review '${input.id}' is a request, not a submitted review.`);
    return toReviewView(row);
  },
};

// --- A08 draft_review_response -----------------------------------------------------

const draftReviewResponseInput = z.strictObject({ id: z.string(), response: z.string().min(1) });

const draftReviewResponse: ActionDef<z.infer<typeof draftReviewResponseInput>, ReviewView> = {
  id: 'M45.A08',
  slug: 'reviews.draft_review_response',
  module: MODULE,
  name: 'Draft review response',
  description: 'Save a draft response to a review (not yet visible — call publish_review_response to make it live).',
  risk: 'write',
  entities: ['reviews'],
  inputSchema: draftReviewResponseInput,
  outputSchema: reviewView,
  searchCard: { synonyms: ['draft reply', 'write review response'], examplePhrasings: ['Draft a reply to this review'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getReviewRow(ctx.db, input.id);
    if (row['rating'] === null) throw new ActionError('NOT_FOUND', `Review '${input.id}' is a request, not a submitted review.`);
    const meta = readResponseMeta(row);
    writeResponseMeta(ctx.db, input.id, { ...meta, draft: input.response }, ctx.clock.now());
    return toReviewView(getReviewRow(ctx.db, input.id));
  }),
};

// --- A09 publish_review_response -----------------------------------------------------

const publishReviewResponseInput = z.strictObject({ id: z.string(), response: z.string().min(1).optional() });

const publishReviewResponse: ActionDef<z.infer<typeof publishReviewResponseInput>, ReviewView> = {
  id: 'M45.A09',
  slug: 'reviews.publish_review_response',
  module: MODULE,
  name: 'Publish review response',
  description: 'Publish a response to a review (uses the saved draft if `response` is omitted).',
  risk: 'write',
  entities: ['reviews'],
  inputSchema: publishReviewResponseInput,
  outputSchema: reviewView,
  searchCard: { synonyms: ['publish reply', 'respond to review'], examplePhrasings: ['Publish our reply to this review'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getReviewRow(ctx.db, input.id);
    if (row['rating'] === null) throw new ActionError('NOT_FOUND', `Review '${input.id}' is a request, not a submitted review.`);
    const meta = readResponseMeta(row);
    const text = input.response ?? meta.draft;
    if (!text) throw new ActionError('VALIDATION', `Review '${input.id}' has no draft response — pass \`response\` or draft one first.`);
    writeResponseMeta(ctx.db, input.id, { draft: null, published: text }, ctx.clock.now());
    return toReviewView(getReviewRow(ctx.db, input.id));
  }),
};

// --- A10 get_review_rating_summary -----------------------------------------------------

const getReviewRatingSummaryInput = z.strictObject({ target_type: z.enum(TARGET_TYPES).optional(), target_id: z.string().optional() });
const ratingSummaryOutput = z.object({
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  total: z.number(),
  average_rating: z.number(),
  by_rating: z.array(z.object({ rating: z.number(), count: z.number() })),
});

const getReviewRatingSummary: ActionDef<z.infer<typeof getReviewRatingSummaryInput>, z.infer<typeof ratingSummaryOutput>> = {
  id: 'M45.A10',
  slug: 'reviews.get_review_rating_summary',
  module: MODULE,
  name: 'Get review rating summary',
  description: 'Compute a real average/count-by-rating summary over published reviews, optionally scoped to one target.',
  risk: 'read',
  entities: ['reviews'],
  inputSchema: getReviewRatingSummaryInput,
  outputSchema: ratingSummaryOutput,
  searchCard: { synonyms: ['rating breakdown', 'average rating'], examplePhrasings: ["What's our average rating?"] },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', `status = 'published'`, 'rating IS NOT NULL'];
    const params: unknown[] = [];
    if (input.target_type) {
      where.push('target_type = ?');
      params.push(input.target_type);
    }
    if (input.target_id) {
      where.push('target_id = ?');
      params.push(input.target_id);
    }
    const whereSql = where.join(' AND ');
    const rows = ctx.db.all(`SELECT rating, COUNT(*) AS n FROM reviews WHERE ${whereSql} GROUP BY rating ORDER BY rating ASC`, params);
    const byRating = rows.map((r) => ({ rating: r['rating'] as number, count: r['n'] as number }));
    const total = byRating.reduce((acc, r) => acc + r.count, 0);
    const sum = byRating.reduce((acc, r) => acc + r.rating * r.count, 0);
    const average = total > 0 ? Math.round((sum / total) * 100) / 100 : 0;
    return { target_type: input.target_type ?? null, target_id: input.target_id ?? null, total, average_rating: average, by_rating: byRating };
  },
};

export const m45Reviews: ActionDef[] = [
  createReviewRequest as ActionDef,
  sendReviewRequest as ActionDef,
  cancelUnsentReviewRequest as ActionDef,
  listReviewRequests as ActionDef,
  recordSimulatedCustomerReview as ActionDef,
  searchReviews as ActionDef,
  getReviewDetails as ActionDef,
  draftReviewResponse as ActionDef,
  publishReviewResponse as ActionDef,
  getReviewRatingSummary as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'published' → 310, 'pending' → 39 out
 * of 370 seeded reviews, all rating IS NOT NULL).
 */
export const m45DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'reviews.search_reviews',
    paramsA: { status: 'published' },
    paramsB: { status: 'pending' },
    expectDifferentCounts: true,
  },
];

/** `reviews` is a plain typed table — no kind-discrimination, so no
 * synthHints are needed (every bare `id` resolves correctly via
 * `entities[0]`). */
export const m45SynthHints: SynthHints = {};
