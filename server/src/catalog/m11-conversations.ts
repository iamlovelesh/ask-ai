/**
 * M11 Conversations — follows the M01 Contacts convention verbatim.
 *
 * Data home: `conversations` table (a real typed table, NOT a shared
 * `structures`/`records`/`participations` mega-table) — `entities[0]` is
 * always `'conversations'` so the bare `id` field resolves kind-blind-free
 * via `testing.ts`'s plain `entities[0]` fallback; no `synthHints` needed.
 *
 * `conversations` has no `name` column — the display name (output
 * discipline rule) is the related contact's name (left-joined), falling
 * back to the conversation's own `subject`, then a generic placeholder.
 *
 * M12 SMS / M13 Email own the `messages` rows underneath a conversation
 * (`conversation_id` FK) and keep `last_inbound_at`/`last_outbound_at`/
 * `unread` current via `catalog/conversation-utils.ts` — this module only
 * READS those bookkeeping columns (`search_conversations`'s
 * `has_inbound_reply` filter, `list_unanswered_conversations`) plus a few
 * direct conversation-level writes (owner/read-state/open-closed) that
 * don't touch `messages` at all.
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

const MODULE = 'conversations';

const CHANNELS = ['sms', 'email', 'webchat'] as const;
const STATUSES = ['open', 'closed', 'snoozed'] as const;

interface ConversationView {
  id: string;
  name: string;
  contact_id: string | null;
  channel: string;
  status: string;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  unread: boolean;
  owner_id: string | null;
  subject: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

/** Row from a query that joined `contacts ct ON ct.id = c.contact_id`. */
function toView(row: Row): ConversationView {
  const subject = (row['subject'] as string | null) ?? null;
  const contactName = (row['contact_name'] as string | null) ?? null;
  return {
    id: row['id'] as string,
    name: subject ?? contactName ?? `Conversation ${row['id'] as string}`,
    contact_id: (row['contact_id'] as string | null) ?? null,
    channel: row['channel'] as string,
    status: row['status'] as string,
    last_inbound_at: (row['last_inbound_at'] as number | null) ?? null,
    last_outbound_at: (row['last_outbound_at'] as number | null) ?? null,
    unread: row['unread'] === 1,
    owner_id: (row['owner_id'] as string | null) ?? null,
    subject,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const JOIN_SELECT = `SELECT c.*, ct.name AS contact_name FROM conversations c
  LEFT JOIN contacts ct ON ct.id = c.contact_id`;

function getConversationRow(db: StoreTx, id: string): Row {
  const row = db.get(`${JOIN_SELECT} WHERE c.id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Conversation '${id}' does not exist.`);
  return row;
}

const conversationView = z.object({
  id: z.string(),
  name: z.string(),
  contact_id: z.string().nullable(),
  channel: z.string(),
  status: z.string(),
  last_inbound_at: z.number().nullable(),
  last_outbound_at: z.number().nullable(),
  unread: z.boolean(),
  owner_id: z.string().nullable(),
  subject: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 get_conversation ----------------------------------------------------

const getConversationInput = z.strictObject({ id: z.string() });

const getConversation: ActionDef<z.infer<typeof getConversationInput>, ConversationView> = {
  id: 'M11.A01',
  slug: 'conversations.get_conversation',
  module: MODULE,
  name: 'Get conversation',
  description: 'Fetch a single conversation thread by id.',
  risk: 'read',
  entities: ['conversations'],
  inputSchema: getConversationInput,
  outputSchema: conversationView,
  searchCard: {
    synonyms: ['conversation details', 'look up thread'],
    examplePhrasings: ['Show me this conversation', 'What is conv_42 about?'],
  },
  handler: async (input, ctx) => toView(getConversationRow(ctx.db, input.id)),
};

// --- A02 search_conversations -------------------------------------------------

const searchConversationsInput = z.strictObject({
  contact_ids: z.array(z.string()).optional(),
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(STATUSES).optional(),
  has_inbound_reply: z.boolean().optional(),
  unread: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchConversationsInput = z.infer<typeof searchConversationsInput>;
const searchConversationsOutput = listOutputSchema(conversationView);
type SearchConversationsOutput = ListOrSpill<ConversationView>;

const searchConversations: ActionDef<SearchConversationsInput, SearchConversationsOutput> = {
  id: 'M11.A02',
  slug: 'conversations.search_conversations',
  module: MODULE,
  name: 'Search conversations',
  description: 'Search non-archived conversation threads by contact/channel/status/reply-state.',
  risk: 'read',
  entities: ['conversations', 'messages'],
  inputSchema: searchConversationsInput,
  outputSchema: searchConversationsOutput,
  searchCard: {
    synonyms: ['find conversations', 'list threads'],
    examplePhrasings: ['Find open email conversations', 'Show unread conversations with Dana'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Narrow with channel/status/contact_ids before relying on the sample.',
  handler: async (input, ctx) => {
    const where: string[] = ['c.archived = 0'];
    const params: unknown[] = [];
    if (input.contact_ids && input.contact_ids.length > 0) {
      where.push(`c.contact_id IN (${input.contact_ids.map(() => '?').join(',')})`);
      params.push(...input.contact_ids);
    }
    if (input.channel) {
      where.push('c.channel = ?');
      params.push(input.channel);
    }
    if (input.status) {
      where.push('c.status = ?');
      params.push(input.status);
    }
    if (input.unread !== undefined) {
      where.push('c.unread = ?');
      params.push(input.unread ? 1 : 0);
    }
    if (input.has_inbound_reply !== undefined) {
      const existsSql =
        'EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = \'inbound\' AND m.archived = 0)';
      where.push(input.has_inbound_reply ? existsSql : `NOT ${existsSql}`);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(
      `SELECT COUNT(*) AS n FROM conversations c WHERE ${whereSql}`,
      params,
    );
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `${JOIN_SELECT} WHERE ${whereSql} ORDER BY c.created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A03 assign_conversation_owner --------------------------------------------

const assignConversationOwnerInput = z.strictObject({ id: z.string(), owner_id: z.string() });

const assignConversationOwner: ActionDef<z.infer<typeof assignConversationOwnerInput>, ConversationView> = {
  id: 'M11.A03',
  slug: 'conversations.assign_conversation_owner',
  module: MODULE,
  name: 'Assign conversation owner',
  description: 'Set the owning user for a conversation thread.',
  risk: 'write',
  entities: ['conversations'],
  inputSchema: assignConversationOwnerInput,
  outputSchema: conversationView,
  searchCard: {
    synonyms: ['assign thread', 'reassign conversation'],
    examplePhrasings: ['Assign this conversation to Dana'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    getConversationRow(ctx.db, input.id);
    ctx.db.run(`UPDATE conversations SET owner_id = ?, updated_at = ? WHERE id = ?`, [
      input.owner_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getConversationRow(ctx.db, input.id));
  }),
};

// --- A04 mark_conversation_read ------------------------------------------------

const markConversationReadInput = z.strictObject({ id: z.string() });

const markConversationRead: ActionDef<z.infer<typeof markConversationReadInput>, ConversationView> = {
  id: 'M11.A04',
  slug: 'conversations.mark_conversation_read',
  module: MODULE,
  name: 'Mark conversation read',
  description: 'Clear the unread flag on a conversation.',
  risk: 'write',
  entities: ['conversations'],
  inputSchema: markConversationReadInput,
  outputSchema: conversationView,
  searchCard: {
    synonyms: ['mark as read', 'clear unread'],
    examplePhrasings: ['Mark this conversation as read'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getConversationRow(ctx.db, input.id);
    // Unconditional UPDATE (even if already unread=0) — an idempotent-in-
    // effect write still needs its own state-delta signal (task-8 fix round
    // 1 lesson: smoke's delta check is on the `updated_at` STAMP, not
    // whether the business value actually flipped).
    ctx.db.run(`UPDATE conversations SET unread = 0, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getConversationRow(ctx.db, input.id));
  }),
};

// --- A05 mark_conversation_unread ----------------------------------------------

const markConversationUnreadInput = z.strictObject({ id: z.string() });

const markConversationUnread: ActionDef<z.infer<typeof markConversationUnreadInput>, ConversationView> = {
  id: 'M11.A05',
  slug: 'conversations.mark_conversation_unread',
  module: MODULE,
  name: 'Mark conversation unread',
  description: 'Set the unread flag on a conversation.',
  risk: 'write',
  entities: ['conversations'],
  inputSchema: markConversationUnreadInput,
  outputSchema: conversationView,
  searchCard: {
    synonyms: ['mark as unread', 'flag unread'],
    examplePhrasings: ['Mark this conversation as unread so I remember to follow up'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getConversationRow(ctx.db, input.id);
    ctx.db.run(`UPDATE conversations SET unread = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getConversationRow(ctx.db, input.id));
  }),
};

// --- A06 close_conversation ------------------------------------------------------

const closeConversationInput = z.strictObject({ id: z.string() });

const closeConversation: ActionDef<z.infer<typeof closeConversationInput>, ConversationView> = {
  id: 'M11.A06',
  slug: 'conversations.close_conversation',
  module: MODULE,
  name: 'Close conversation',
  description: 'Close a conversation thread (reversible via reopen).',
  risk: 'write',
  entities: ['conversations'],
  inputSchema: closeConversationInput,
  outputSchema: conversationView,
  searchCard: {
    synonyms: ['close thread', 'resolve conversation'],
    examplePhrasings: ['Close this conversation'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getConversationRow(ctx.db, input.id);
    ctx.db.run(`UPDATE conversations SET status = 'closed', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getConversationRow(ctx.db, input.id));
  }),
};

// --- A07 reopen_conversation ------------------------------------------------------

const reopenConversationInput = z.strictObject({ id: z.string() });

const reopenConversation: ActionDef<z.infer<typeof reopenConversationInput>, ConversationView> = {
  id: 'M11.A07',
  slug: 'conversations.reopen_conversation',
  module: MODULE,
  name: 'Reopen conversation',
  description: 'Reopen a closed or snoozed conversation thread.',
  risk: 'write',
  entities: ['conversations'],
  inputSchema: reopenConversationInput,
  outputSchema: conversationView,
  searchCard: {
    synonyms: ['reopen thread', 'resume conversation'],
    examplePhrasings: ['Reopen this conversation'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getConversationRow(ctx.db, input.id);
    ctx.db.run(`UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getConversationRow(ctx.db, input.id));
  }),
};

// --- A08 add_internal_comment ------------------------------------------------------

const addInternalCommentInput = z.strictObject({ id: z.string(), body: z.string().min(1) });
const addInternalCommentOutput = z.object({
  id: z.string(),
  name: z.string(),
  conversation_id: z.string(),
  body: z.string(),
});
type AddInternalCommentOutput = z.infer<typeof addInternalCommentOutput>;

const addInternalComment: ActionDef<z.infer<typeof addInternalCommentInput>, AddInternalCommentOutput> = {
  id: 'M11.A08',
  slug: 'conversations.add_internal_comment',
  module: MODULE,
  name: 'Add internal comment',
  description:
    'Add a staff-only internal note on a conversation (not visible to the contact) — stored as a note.',
  risk: 'write',
  // NOTE: `conversations` must stay entities[0] — the action's own `id`
  // field means "this conversation's id", and `testing.ts`'s bare-`id`
  // resolution picks `entities[0]` with no further hint. Listing `notes`
  // first would resolve `id` against a NOTE id instead (silently wrong
  // table), which is exactly the smoke-blind-spot this convention exists
  // to catch — caught during this module's own smoke run (see
  // task-9-b2-report "judgment calls" / fix notes).
  entities: ['conversations', 'notes'],
  inputSchema: addInternalCommentInput,
  outputSchema: addInternalCommentOutput,
  searchCard: {
    synonyms: ['internal note', 'add private comment'],
    examplePhrasings: ['Add an internal note to this conversation for the team'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const conversation = getConversationRow(ctx.db, input.id);
    const now = ctx.clock.now();
    const id = nextId(ctx.db, 'notes', 'note');
    ctx.db.run(
      `INSERT INTO notes (id, created_at, updated_at, archived, contact_id, author_id,
        related_type, related_id, pinned, body)
       VALUES (?, ?, ?, 0, ?, NULL, 'conversation', ?, 0, ?)`,
      [id, now, now, conversation['contact_id'] ?? null, input.id, input.body],
    );
    return { id, name: input.body.slice(0, 60), conversation_id: input.id, body: input.body };
  }),
};

// --- A09 summarize_conversation_history ------------------------------------------------

const summarizeConversationHistoryInput = z.strictObject({ id: z.string() });
const summarizeConversationHistoryOutput = z.object({
  id: z.string(),
  name: z.string(),
  message_count: z.number(),
  inbound_count: z.number(),
  outbound_count: z.number(),
  last_message_preview: z.string().nullable(),
  summary: z.string(),
});
type SummarizeConversationHistoryOutput = z.infer<typeof summarizeConversationHistoryOutput>;

const summarizeConversationHistory: ActionDef<
  z.infer<typeof summarizeConversationHistoryInput>,
  SummarizeConversationHistoryOutput
> = {
  id: 'M11.A09',
  slug: 'conversations.summarize_conversation_history',
  module: MODULE,
  name: 'Summarize conversation history',
  description: 'Deterministic rollup of message counts and the most recent message in a thread.',
  risk: 'read',
  entities: ['conversations', 'messages'],
  inputSchema: summarizeConversationHistoryInput,
  outputSchema: summarizeConversationHistoryOutput,
  searchCard: {
    synonyms: ['summarize thread', 'conversation recap'],
    examplePhrasings: ['Summarize this conversation for me'],
  },
  handler: async (input, ctx) => {
    const row = getConversationRow(ctx.db, input.id);
    const counts = ctx.db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
              SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound
       FROM messages WHERE conversation_id = ? AND archived = 0`,
      [input.id],
    );
    const total = (counts?.['total'] as number) ?? 0;
    const inbound = (counts?.['inbound'] as number) ?? 0;
    const outbound = (counts?.['outbound'] as number) ?? 0;
    const lastMsg = ctx.db.get(
      `SELECT subject, body FROM messages WHERE conversation_id = ? AND archived = 0
       ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1`,
      [input.id],
    );
    const lastPreview = lastMsg
      ? String((lastMsg['subject'] as string | null) ?? (lastMsg['body'] as string | null) ?? '').slice(0, 80)
      : null;
    const view = toView(row);
    return {
      id: view.id,
      name: view.name,
      message_count: total,
      inbound_count: inbound,
      outbound_count: outbound,
      last_message_preview: lastPreview || null,
      summary: `${total} message${total === 1 ? '' : 's'} (${inbound} inbound, ${outbound} outbound)${
        lastPreview ? ` — last: "${lastPreview}"` : ''
      }.`,
    };
  },
};

// --- A10 list_unanswered_conversations ------------------------------------------------

const listUnansweredConversationsInput = z.strictObject({
  limit: z.number().int().min(1).max(50).optional(),
});
type ListUnansweredConversationsInput = z.infer<typeof listUnansweredConversationsInput>;
const listUnansweredConversationsOutput = listOutputSchema(conversationView);
type ListUnansweredConversationsOutput = ListOrSpill<ConversationView>;

const listUnansweredConversations: ActionDef<
  ListUnansweredConversationsInput,
  ListUnansweredConversationsOutput
> = {
  id: 'M11.A10',
  slug: 'conversations.list_unanswered_conversations',
  module: MODULE,
  name: 'List unanswered conversations',
  description:
    "List conversations whose last message is inbound (no outbound reply sent after it yet).",
  risk: 'read',
  entities: ['conversations'],
  inputSchema: listUnansweredConversationsInput,
  outputSchema: listUnansweredConversationsOutput,
  searchCard: {
    synonyms: ['unreplied conversations', 'needs a reply'],
    examplePhrasings: ['Which conversations are waiting on a reply from us?'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const whereSql = `c.archived = 0 AND c.last_inbound_at IS NOT NULL
      AND (c.last_outbound_at IS NULL OR c.last_inbound_at > c.last_outbound_at)`;
    const limit = input.limit ?? 50;
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM conversations c WHERE ${whereSql}`);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `${JOIN_SELECT} WHERE ${whereSql} ORDER BY c.last_inbound_at DESC LIMIT ?`,
      [limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

export const m11Conversations: ActionDef[] = [
  getConversation as ActionDef,
  searchConversations as ActionDef,
  assignConversationOwner as ActionDef,
  markConversationRead as ActionDef,
  markConversationUnread as ActionDef,
  closeConversation as ActionDef,
  reopenConversation as ActionDef,
  addInternalComment as ActionDef,
  summarizeConversationHistory as ActionDef,
  listUnansweredConversations as ActionDef,
];

/**
 * Tier-A discrimination: `channel` counts against the standard template
 * (pristine: 'email' → 503, 'sms' → 513). Never mutated by any M11 action
 * (none of the 10 actions above change `channel`). M12/M13's own smoke
 * passes (same `--modules m11-m17` / full-suite run) add a handful of new
 * conversations via `findOrCreateConversation` for their synthesized
 * contacts — empirically verified live value (full-range/full-suite run):
 * 'email' → 504, 'sms' → 513, margin 9 — nowhere near enough to threaten
 * the ~10-row pristine margin.
 */
export const m11DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'conversations.search_conversations',
    paramsA: { channel: 'email' },
    paramsB: { channel: 'sms' },
    expectDifferentCounts: true,
  },
];

/**
 * `conversations` is a plain (non-kind-discriminated) table — `entities[0]`
 * resolves the bare `id` field correctly with no hint needed, same as M01.
 */
export const m11SynthHints: SynthHints = {};
