/**
 * M47 Support Tickets — follows the M01 Contacts convention verbatim.
 *
 * Data home: typed `support_tickets` table (`entities/model.ts#MODULE_MAP`).
 *
 * STATUS MACHINE (real, CONFLICT-guarded): `open -> pending -> resolved ->
 * closed`, with `resolved`/`closed` both re-openable back to `open`
 * (a genuine support-desk reopen flow). `closed` can also re-resolve.
 * `closed` is the only state nothing else can leave FROM via this map
 * except back to `open` (reopening). The explicit transition table:
 *   - open:      -> pending, resolved
 *   - pending:   -> open, resolved
 *   - resolved:  -> closed, open
 *   - closed:    -> open
 * Any `(from, to)` pair not in this table (including `from === to`)
 * throws `CONFLICT` — the SAME symmetry lesson task-9-b4's fix round 2
 * applied to M27 Quotes' line-item status guard (reviewer-flagged: a
 * status machine needs to guard EVERY illegal transition, not just the
 * "obvious" ones).
 *
 * `get_ticket_sla_status` (A10) computes REAL elapsed-vs-threshold timing
 * from `created_at`/`first_response_at`/`priority` against the pinned
 * virtual clock. SLA thresholds (documented, in ms, not configurable in
 * this task):
 *   - urgent: first response within 1h,  resolution within 4h
 *   - high:   first response within 4h,  resolution within 24h
 *   - medium: first response within 8h,  resolution within 48h
 *   - low:    first response within 24h, resolution within 120h
 *
 * `support_tickets` is a plain typed table — no synthHints needed.
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { Row, StoreTx } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';
import { findOrCreateConversation, markConversationOutbound } from './conversation-utils.js';

const MODULE = 'support_tickets';
const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const HOUR_MS = 1000 * 60 * 60;
const SLA_THRESHOLDS_MS: Record<string, { response: number; resolution: number }> = {
  urgent: { response: 1 * HOUR_MS, resolution: 4 * HOUR_MS },
  high: { response: 4 * HOUR_MS, resolution: 24 * HOUR_MS },
  medium: { response: 8 * HOUR_MS, resolution: 48 * HOUR_MS },
  low: { response: 24 * HOUR_MS, resolution: 120 * HOUR_MS },
};

const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  open: ['pending', 'resolved'],
  pending: ['open', 'resolved'],
  resolved: ['closed', 'open'],
  closed: ['open'],
};

function getTicketRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM support_tickets WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Support ticket '${id}' does not exist.`);
  return row;
}

interface TicketView {
  id: string;
  name: string;
  contact_id: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  team_id: string | null;
  channel: string | null;
  first_response_at: number | null;
  resolved_at: number | null;
  description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): TicketView {
  return {
    id: row['id'] as string,
    name: row['subject'] as string,
    contact_id: row['contact_id'] as string,
    status: row['status'] as string,
    priority: row['priority'] as string,
    assignee_id: (row['assignee_id'] as string | null) ?? null,
    team_id: (row['team_id'] as string | null) ?? null,
    channel: (row['channel'] as string | null) ?? null,
    first_response_at: (row['first_response_at'] as number | null) ?? null,
    resolved_at: (row['resolved_at'] as number | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const ticketView = z.object({
  id: z.string(),
  name: z.string(),
  contact_id: z.string(),
  status: z.string(),
  priority: z.string(),
  assignee_id: z.string().nullable(),
  team_id: z.string().nullable(),
  channel: z.string().nullable(),
  first_response_at: z.number().nullable(),
  resolved_at: z.number().nullable(),
  description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_support_ticket -----------------------------------------------------

const createSupportTicketInput = z.strictObject({
  subject: z.string().min(1),
  contact_id: z.string(),
  description: z.string().optional(),
  priority: z.enum(PRIORITIES).optional(),
  channel: z.string().optional(),
});

const createSupportTicket: ActionDef<z.infer<typeof createSupportTicketInput>, TicketView> = {
  id: 'M47.A01',
  slug: 'support_tickets.create_support_ticket',
  module: MODULE,
  name: 'Create support ticket',
  description: 'Open a new support ticket for a contact.',
  risk: 'write',
  entities: ['support_tickets', 'contacts'],
  inputSchema: createSupportTicketInput,
  outputSchema: ticketView,
  searchCard: { synonyms: ['open ticket', 'new support ticket'], examplePhrasings: ['Open a support ticket for this customer'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    const id = nextId(ctx.db, 'support_tickets', 'ticket');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO support_tickets (id, created_at, updated_at, archived, subject, contact_id, status, priority,
        assignee_id, team_id, channel, first_response_at, resolved_at, description)
       VALUES (?, ?, ?, 0, ?, ?, 'open', ?, NULL, NULL, ?, NULL, NULL, ?)`,
      [id, now, now, input.subject, input.contact_id, input.priority ?? 'medium', input.channel ?? 'email', input.description ?? null],
    );
    return toView(getTicketRow(ctx.db, id));
  }),
};

// --- A02 get_ticket_details -----------------------------------------------------

const getTicketDetailsInput = z.strictObject({ id: z.string() });

const getTicketDetails: ActionDef<z.infer<typeof getTicketDetailsInput>, TicketView> = {
  id: 'M47.A02',
  slug: 'support_tickets.get_ticket_details',
  module: MODULE,
  name: 'Get ticket details',
  description: 'Fetch a single support ticket by id.',
  risk: 'read',
  entities: ['support_tickets'],
  inputSchema: getTicketDetailsInput,
  outputSchema: ticketView,
  searchCard: { synonyms: ['ticket details', 'look up ticket'], examplePhrasings: ['Show me this support ticket'] },
  handler: async (input, ctx) => toView(getTicketRow(ctx.db, input.id)),
};

// --- A03 search_tickets -----------------------------------------------------

const searchTicketsInput = z.strictObject({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignee_id: z.string().optional(),
  team_id: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchTicketsInput = z.infer<typeof searchTicketsInput>;
const searchTicketsOutput = listOutputSchema(ticketView);
type SearchTicketsOutput = ListOrSpill<TicketView>;

const searchTickets: ActionDef<SearchTicketsInput, SearchTicketsOutput> = {
  id: 'M47.A03',
  slug: 'support_tickets.search_tickets',
  module: MODULE,
  name: 'Search tickets',
  description: 'Search non-archived support tickets by status, priority, assignee, team, and subject.',
  risk: 'read',
  entities: ['support_tickets'],
  inputSchema: searchTicketsInput,
  outputSchema: searchTicketsOutput,
  searchCard: { synonyms: ['find tickets', 'list support tickets'], examplePhrasings: ['Show me all open urgent tickets'] },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.priority) {
      where.push('priority = ?');
      params.push(input.priority);
    }
    if (input.assignee_id) {
      where.push('assignee_id = ?');
      params.push(input.assignee_id);
    }
    if (input.team_id) {
      where.push('team_id = ?');
      params.push(input.team_id);
    }
    if (input.query) {
      where.push('subject LIKE ?');
      params.push(`%${input.query}%`);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM support_tickets WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM support_tickets WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 assign_ticket_owner -----------------------------------------------------

const assignTicketOwnerInput = z.strictObject({ id: z.string(), assignee_id: z.string() });

const assignTicketOwner: ActionDef<z.infer<typeof assignTicketOwnerInput>, TicketView> = {
  id: 'M47.A04',
  slug: 'support_tickets.assign_ticket_owner',
  module: MODULE,
  name: 'Assign ticket owner',
  description: 'Assign a ticket to a user (validates the user exists).',
  risk: 'write',
  entities: ['support_tickets', 'users'],
  inputSchema: assignTicketOwnerInput,
  outputSchema: ticketView,
  searchCard: { synonyms: ['assign ticket', 'set ticket owner'], examplePhrasings: ['Assign this ticket to Sam'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTicketRow(ctx.db, input.id);
    const user = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.assignee_id]);
    if (!user) throw new ActionError('NOT_FOUND', `User '${input.assignee_id}' does not exist.`);
    ctx.db.run(`UPDATE support_tickets SET assignee_id = ?, updated_at = ? WHERE id = ?`, [input.assignee_id, ctx.clock.now(), input.id]);
    return toView(getTicketRow(ctx.db, input.id));
  }),
};

// --- A05 set_ticket_priority -----------------------------------------------------

const setTicketPriorityInput = z.strictObject({ id: z.string(), priority: z.enum(PRIORITIES) });

const setTicketPriority: ActionDef<z.infer<typeof setTicketPriorityInput>, TicketView> = {
  id: 'M47.A05',
  slug: 'support_tickets.set_ticket_priority',
  module: MODULE,
  name: 'Set ticket priority',
  description: "Change a ticket's priority.",
  risk: 'write',
  entities: ['support_tickets'],
  inputSchema: setTicketPriorityInput,
  outputSchema: ticketView,
  searchCard: { synonyms: ['change priority', 'escalate ticket'], examplePhrasings: ['Escalate this ticket to urgent'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTicketRow(ctx.db, input.id);
    ctx.db.run(`UPDATE support_tickets SET priority = ?, updated_at = ? WHERE id = ?`, [input.priority, ctx.clock.now(), input.id]);
    return toView(getTicketRow(ctx.db, input.id));
  }),
};

// --- A06 update_ticket_status -----------------------------------------------------

const updateTicketStatusInput = z.strictObject({ id: z.string(), status: z.enum(STATUSES) });

const updateTicketStatus: ActionDef<z.infer<typeof updateTicketStatusInput>, TicketView> = {
  id: 'M47.A06',
  slug: 'support_tickets.update_ticket_status',
  module: MODULE,
  name: 'Update ticket status',
  description: "Transition a ticket's status along the real open->pending->resolved->closed machine (CONFLICT on an illegal transition).",
  risk: 'write',
  entities: ['support_tickets'],
  inputSchema: updateTicketStatusInput,
  outputSchema: ticketView,
  searchCard: { synonyms: ['change ticket status', 'resolve ticket'], examplePhrasings: ['Mark this ticket as resolved'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTicketRow(ctx.db, input.id);
    const from = row['status'] as string;
    const allowed = ALLOWED_TRANSITIONS[from] ?? [];
    if (!allowed.includes(input.status)) {
      throw new ActionError('CONFLICT', `Support ticket '${input.id}' cannot move from '${from}' to '${input.status}'.`);
    }
    const now = ctx.clock.now();
    const firstResponseAt = row['first_response_at'] as number | null;
    const nextFirstResponse = firstResponseAt ?? (from === 'open' ? now : firstResponseAt);
    const resolvedAt = input.status === 'resolved' ? now : input.status === 'open' ? null : (row['resolved_at'] as number | null);
    ctx.db.run(
      `UPDATE support_tickets SET status = ?, first_response_at = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
      [input.status, nextFirstResponse, resolvedAt, now, input.id],
    );
    return toView(getTicketRow(ctx.db, input.id));
  }),
};

// --- A07 add_internal_ticket_note -----------------------------------------------------

const addInternalTicketNoteInput = z.strictObject({ id: z.string(), body: z.string().min(1), author_id: z.string().optional() });
const noteOutput = z.object({ id: z.string(), name: z.string(), ticket_id: z.string(), note_id: z.string() });

const addInternalTicketNote: ActionDef<z.infer<typeof addInternalTicketNoteInput>, z.infer<typeof noteOutput>> = {
  id: 'M47.A07',
  slug: 'support_tickets.add_internal_ticket_note',
  module: MODULE,
  name: 'Add internal ticket note',
  description: 'Add an internal (not customer-visible) note to a ticket — creates a real `notes` row.',
  risk: 'write',
  entities: ['notes', 'support_tickets'],
  inputSchema: addInternalTicketNoteInput,
  outputSchema: noteOutput,
  searchCard: { synonyms: ['internal note', 'add note to ticket'], examplePhrasings: ['Add an internal note about this ticket'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const ticket = getTicketRow(ctx.db, input.id);
    if (input.author_id) {
      const user = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.author_id]);
      if (!user) throw new ActionError('NOT_FOUND', `User '${input.author_id}' does not exist.`);
    }
    const noteId = nextId(ctx.db, 'notes', 'note');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO notes (id, created_at, updated_at, archived, contact_id, author_id, related_type, related_id, pinned, body)
       VALUES (?, ?, ?, 0, ?, ?, 'ticket', ?, 0, ?)`,
      [noteId, now, now, ticket['contact_id'] as string, input.author_id ?? null, input.id, input.body],
    );
    return { id: noteId, name: `Internal note on ticket '${input.id}'`, ticket_id: input.id, note_id: noteId };
  }),
};

// --- A08 reply_to_ticket_requester -----------------------------------------------------

const replyToTicketRequesterInput = z.strictObject({ id: z.string(), body: z.string().min(1) });
const replyOutput = z.object({ id: z.string(), name: z.string(), message_id: z.string() });

const replyToTicketRequester: ActionDef<z.infer<typeof replyToTicketRequesterInput>, z.infer<typeof replyOutput>> = {
  id: 'M47.A08',
  slug: 'support_tickets.reply_to_ticket_requester',
  module: MODULE,
  name: 'Reply to ticket requester',
  description: 'Send a simulated email reply to the ticket requester (creates a real messages row; stamps first_response_at if unset).',
  risk: 'external',
  entities: ['support_tickets', 'messages', 'conversations'],
  inputSchema: replyToTicketRequesterInput,
  outputSchema: replyOutput,
  searchCard: { synonyms: ['reply to customer', 'email ticket requester'], examplePhrasings: ['Reply to this customer about their ticket'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const ticket = getTicketRow(ctx.db, input.id);
    const now = ctx.clock.now();
    const contactId = ticket['contact_id'] as string;
    const conversationId = findOrCreateConversation(ctx.db, now, contactId, 'email');
    const messageId = nextId(ctx.db, 'messages', 'msg');
    ctx.db.run(
      `INSERT INTO messages (id, created_at, updated_at, archived, conversation_id, contact_id, channel,
        direction, status, scheduled_at, sent_at, from_addr, to_addr, template_id, campaign_id, subject, body)
       VALUES (?, ?, ?, 0, ?, ?, 'email', 'outbound', 'sent', NULL, ?, 'support@ourcrm.io', NULL, NULL, NULL, ?, ?)`,
      [messageId, now, now, conversationId, contactId, now, `Re: ${ticket['subject'] as string}`, input.body],
    );
    markConversationOutbound(ctx.db, conversationId, now);
    const firstResponseAt = ticket['first_response_at'] as number | null;
    ctx.db.run(`UPDATE support_tickets SET first_response_at = ?, updated_at = ? WHERE id = ?`, [firstResponseAt ?? now, now, input.id]);
    return { id: input.id, name: `Reply to ticket '${input.id}'`, message_id: messageId };
  }),
};

// --- A09 link_ticket_to_contact -----------------------------------------------------

const linkTicketToContactInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const linkTicketToContact: ActionDef<z.infer<typeof linkTicketToContactInput>, TicketView> = {
  id: 'M47.A09',
  slug: 'support_tickets.link_ticket_to_contact',
  module: MODULE,
  name: 'Link ticket to contact',
  description: 'Re-link a ticket to a different contact (validates the contact exists).',
  risk: 'write',
  entities: ['support_tickets', 'contacts'],
  inputSchema: linkTicketToContactInput,
  outputSchema: ticketView,
  searchCard: { synonyms: ['relink ticket', 'change ticket contact'], examplePhrasings: ['Link this ticket to the right contact'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTicketRow(ctx.db, input.id);
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    ctx.db.run(`UPDATE support_tickets SET contact_id = ?, updated_at = ? WHERE id = ?`, [input.contact_id, ctx.clock.now(), input.id]);
    return toView(getTicketRow(ctx.db, input.id));
  }),
};

// --- A10 get_ticket_sla_status -----------------------------------------------------

const getTicketSlaStatusInput = z.strictObject({ id: z.string() });
const slaStatusOutput = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.string(),
  response_due_at: z.number(),
  resolution_due_at: z.number(),
  response_breached: z.boolean(),
  resolution_breached: z.boolean(),
});

const getTicketSlaStatus: ActionDef<z.infer<typeof getTicketSlaStatusInput>, z.infer<typeof slaStatusOutput>> = {
  id: 'M47.A10',
  slug: 'support_tickets.get_ticket_sla_status',
  module: MODULE,
  name: 'Get ticket SLA status',
  description: 'Compute real elapsed-vs-threshold SLA status for a ticket from created_at/first_response_at/priority.',
  risk: 'read',
  entities: ['support_tickets'],
  inputSchema: getTicketSlaStatusInput,
  outputSchema: slaStatusOutput,
  searchCard: { synonyms: ['sla status', 'is this ticket breaching sla'], examplePhrasings: ['Is this ticket within SLA?'] },
  handler: async (input, ctx) => {
    const row = getTicketRow(ctx.db, input.id);
    const priority = row['priority'] as string;
    const thresholds = SLA_THRESHOLDS_MS[priority] ?? SLA_THRESHOLDS_MS['medium'];
    const createdAt = row['created_at'] as number;
    const responseDueAt = createdAt + (thresholds?.response ?? 0);
    const resolutionDueAt = createdAt + (thresholds?.resolution ?? 0);
    const now = ctx.clock.now();
    const firstResponseAt = row['first_response_at'] as number | null;
    const resolvedAt = row['resolved_at'] as number | null;
    const responseBreached = firstResponseAt !== null ? firstResponseAt > responseDueAt : now > responseDueAt;
    const resolutionBreached = resolvedAt !== null ? resolvedAt > resolutionDueAt : now > resolutionDueAt;
    return {
      id: input.id,
      name: row['subject'] as string,
      priority,
      response_due_at: responseDueAt,
      resolution_due_at: resolutionDueAt,
      response_breached: responseBreached,
      resolution_breached: resolutionBreached,
    };
  },
};

export const m47SupportTickets: ActionDef[] = [
  createSupportTicket as ActionDef,
  getTicketDetails as ActionDef,
  searchTickets as ActionDef,
  assignTicketOwner as ActionDef,
  setTicketPriority as ActionDef,
  updateTicketStatus as ActionDef,
  addInternalTicketNote as ActionDef,
  replyToTicketRequester as ActionDef,
  linkTicketToContact as ActionDef,
  getTicketSlaStatus as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'closed' → 142, 'resolved' → 90 out of
 * 370 seeded tickets).
 */
export const m47DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'support_tickets.search_tickets',
    paramsA: { status: 'closed' },
    paramsB: { status: 'resolved' },
    expectDifferentCounts: true,
  },
];

/**
 * `support_tickets` is a plain typed table — most actions' bare `id`
 * resolves correctly via `entities[0]`. `add_internal_ticket_note` is the
 * one exception: its `entities` lists `notes` FIRST (the action's write
 * target), but the bare `id` field means the TICKET id — needs a scoped
 * hint overriding the `entities[0]` fallback (same `${slug}:id` pattern
 * M18/M35/M43/M44 use for their own analogous write-target-first orderings).
 */
export const m47SynthHints: SynthHints = {
  'support_tickets.add_internal_ticket_note:id': { table: 'support_tickets' },
};
