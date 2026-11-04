/**
 * Shared `messages`-table logic for M12 SMS and M13 Email (task 9 batch 2).
 * Both modules back onto the SAME physical `messages` table
 * (`entities/model.ts`), discriminated by `channel: 'sms' | 'email'` — every
 * CRUD shape (draft/send/schedule/cancel/get/search/delivery-status/receive)
 * is identical between the two modules; only default addresses, the
 * subject/segmentation preview, and the human-facing error noun differ.
 * Factored here so M13 doesn't duplicate M12's ~10 handler bodies verbatim
 * (coding-style: many small files, no duplication).
 *
 * NOTE on `synthesizeInput` kind-blindness: `messages` is a real typed table
 * (not one of the `structures`/`records`/`participations` mega-tables), but
 * it's STILL shared by two catalog modules with a discriminator column
 * (`channel`, not `kind`). `catalog/synth-hints.ts`'s `SynthHint.kind` only
 * ever generates `WHERE kind = ?` — it has no notion of an arbitrary
 * discriminator column — so a bare `{table:'messages', kind:'sms'}` hint
 * would literally fail the `SELECT ... WHERE kind = ?` query against a table
 * with no `kind` column. `synth-hints.ts`/`testing.ts` gained an optional
 * `column` field this task (defaults to `'kind'`, fully backward-compatible
 * with every M02-M10 hint) specifically so M12/M13 can declare
 * `{table:'messages', kind:'sms', column:'channel'}` — see `m12-sms.ts`'s
 * `synthHints` for the worked example.
 */

import { z } from 'zod';
import type { ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import { nextId } from './next-id.js';
import {
  findOrCreateConversation,
  markConversationOutbound,
  markConversationInbound,
  type MessageChannel,
} from './conversation-utils.js';

export type Channel = MessageChannel;

export function channelNoun(channel: Channel): string {
  return channel === 'sms' ? 'SMS message' : 'Email message';
}

export function defaultAddrs(channel: Channel): { from: string; to: string } {
  return channel === 'sms'
    ? { from: '+15555550100', to: '+15555550199' }
    : { from: 'team@ourcrm.io', to: 'contact@example.com' };
}

export interface MessageView {
  id: string;
  name: string;
  conversation_id: string | null;
  contact_id: string | null;
  channel: string;
  direction: string;
  status: string;
  scheduled_at: number | null;
  sent_at: number | null;
  from_addr: string | null;
  to_addr: string | null;
  template_id: string | null;
  campaign_id: string | null;
  subject: string | null;
  body: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

export function toMessageView(row: Row): MessageView {
  const subject = (row['subject'] as string | null) ?? null;
  const body = (row['body'] as string | null) ?? null;
  const name = subject ?? (body ? body.slice(0, 60) : `Message ${row['id'] as string}`);
  return {
    id: row['id'] as string,
    name,
    conversation_id: (row['conversation_id'] as string | null) ?? null,
    contact_id: (row['contact_id'] as string | null) ?? null,
    channel: row['channel'] as string,
    direction: row['direction'] as string,
    status: row['status'] as string,
    scheduled_at: (row['scheduled_at'] as number | null) ?? null,
    sent_at: (row['sent_at'] as number | null) ?? null,
    from_addr: (row['from_addr'] as string | null) ?? null,
    to_addr: (row['to_addr'] as string | null) ?? null,
    template_id: (row['template_id'] as string | null) ?? null,
    campaign_id: (row['campaign_id'] as string | null) ?? null,
    subject,
    body,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

export const messageView = z.object({
  id: z.string(),
  name: z.string(),
  conversation_id: z.string().nullable(),
  contact_id: z.string().nullable(),
  channel: z.string(),
  direction: z.string(),
  status: z.string(),
  scheduled_at: z.number().nullable(),
  sent_at: z.number().nullable(),
  from_addr: z.string().nullable(),
  to_addr: z.string().nullable(),
  template_id: z.string().nullable(),
  campaign_id: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const messageListOutput = listOutputSchema(messageView);
export type MessageListOutput = ListOrSpill<MessageView>;

/** Existence check SCOPED to a channel — never hands a wrong-channel row to a handler. */
export function getChannelMessageRow(db: StoreTx, id: string, channel: Channel): Row {
  const row = db.get(`SELECT * FROM messages WHERE id = ? AND channel = ?`, [id, channel]);
  if (!row) throw new ActionError('NOT_FOUND', `${channelNoun(channel)} '${id}' does not exist.`);
  return row;
}

function requireContactRow(db: StoreTx, contactId: string): Row {
  const row = db.get(`SELECT * FROM contacts WHERE id = ?`, [contactId]);
  if (!row) throw new ActionError('NOT_FOUND', `Contact '${contactId}' does not exist.`);
  return row;
}

/** M12.A01 / M13.A01 — create a draft outbound message, opening/reusing its thread. */
export function insertDraftMessage(
  db: StoreTx,
  now: number,
  channel: Channel,
  contactId: string,
  subject: string | null,
  body: string,
): Row {
  requireContactRow(db, contactId);
  const conversationId = findOrCreateConversation(db, now, contactId, channel);
  const id = nextId(db, 'messages', 'msg');
  const addrs = defaultAddrs(channel);
  db.run(
    `INSERT INTO messages (id, created_at, updated_at, archived, conversation_id, contact_id,
      channel, direction, status, scheduled_at, sent_at, from_addr, to_addr, template_id,
      campaign_id, subject, body)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'outbound', 'draft', NULL, NULL, ?, ?, NULL, NULL, ?, ?)`,
    [id, now, now, conversationId, contactId, channel, addrs.from, addrs.to, subject, body],
  );
  return getChannelMessageRow(db, id, channel);
}

/**
 * M12.A03 / M13.A03 — send. If `id` names an existing message (any prior
 * status — most naturally a `draft`), transition it to `sent` in place
 * (preserving its id/thread). Otherwise create-and-send a brand new message
 * from `contact_id`/`body` directly, skipping the draft step entirely.
 */
export function sendMessage(
  db: StoreTx,
  now: number,
  channel: Channel,
  input: {
    id?: string | undefined;
    contact_id?: string | undefined;
    subject?: string | undefined;
    body?: string | undefined;
  },
): Row {
  if (input.id) {
    const row = getChannelMessageRow(db, input.id, channel);
    db.run(`UPDATE messages SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      input.id,
    ]);
    const conversationId = (row['conversation_id'] as string | null) ?? null;
    if (conversationId) markConversationOutbound(db, conversationId, now);
    return getChannelMessageRow(db, input.id, channel);
  }
  if (!input.contact_id || !input.body) {
    throw new ActionError(
      'VALIDATION',
      'Sending a new message needs either an existing `id`, or `contact_id` + `body`.',
    );
  }
  requireContactRow(db, input.contact_id);
  const conversationId = findOrCreateConversation(db, now, input.contact_id, channel);
  const id = nextId(db, 'messages', 'msg');
  const addrs = defaultAddrs(channel);
  db.run(
    `INSERT INTO messages (id, created_at, updated_at, archived, conversation_id, contact_id,
      channel, direction, status, scheduled_at, sent_at, from_addr, to_addr, template_id,
      campaign_id, subject, body)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'outbound', 'sent', NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      now,
      now,
      conversationId,
      input.contact_id,
      channel,
      now,
      addrs.from,
      addrs.to,
      input.subject ?? null,
      input.body,
    ],
  );
  markConversationOutbound(db, conversationId, now);
  return getChannelMessageRow(db, id, channel);
}

/** M12.A04 / M13.A04 — schedule. Same id-or-fresh-params shape as `sendMessage`. */
export function scheduleMessage(
  db: StoreTx,
  now: number,
  channel: Channel,
  input: {
    id?: string | undefined;
    contact_id?: string | undefined;
    subject?: string | undefined;
    body?: string | undefined;
    scheduled_at: number;
  },
): Row {
  if (input.id) {
    getChannelMessageRow(db, input.id, channel); // existence check
    db.run(
      `UPDATE messages SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?`,
      [input.scheduled_at, now, input.id],
    );
    return getChannelMessageRow(db, input.id, channel);
  }
  if (!input.contact_id || !input.body) {
    throw new ActionError(
      'VALIDATION',
      'Scheduling a new message needs either an existing `id`, or `contact_id` + `body`.',
    );
  }
  requireContactRow(db, input.contact_id);
  const conversationId = findOrCreateConversation(db, now, input.contact_id, channel);
  const id = nextId(db, 'messages', 'msg');
  const addrs = defaultAddrs(channel);
  db.run(
    `INSERT INTO messages (id, created_at, updated_at, archived, conversation_id, contact_id,
      channel, direction, status, scheduled_at, sent_at, from_addr, to_addr, template_id,
      campaign_id, subject, body)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'outbound', 'scheduled', ?, NULL, ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      now,
      now,
      conversationId,
      input.contact_id,
      channel,
      input.scheduled_at,
      addrs.from,
      addrs.to,
      input.subject ?? null,
      input.body,
    ],
  );
  return getChannelMessageRow(db, id, channel);
}

/** M12.A05 / M13.A05 — only a `scheduled` message can be cancelled; reverts to `draft`. */
export function cancelScheduledMessage(db: StoreTx, now: number, channel: Channel, id: string): Row {
  const row = getChannelMessageRow(db, id, channel);
  if (row['status'] !== 'scheduled') {
    throw new ActionError(
      'CONFLICT',
      `${channelNoun(channel)} '${id}' is not scheduled (status: '${row['status'] as string}').`,
    );
  }
  db.run(`UPDATE messages SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ?`, [
    now,
    id,
  ]);
  return getChannelMessageRow(db, id, channel);
}

export interface ChannelSearchFilters {
  contact_id?: string | undefined;
  status?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  limit?: number | undefined;
}

export function searchChannelMessages(
  db: StoreTx,
  channel: Channel,
  filters: ChannelSearchFilters,
): MessageListOutput {
  const where: string[] = ['archived = 0', 'channel = ?'];
  const params: unknown[] = [channel];
  if (filters.contact_id) {
    where.push('contact_id = ?');
    params.push(filters.contact_id);
  }
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.from !== undefined) {
    where.push('created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    where.push('created_at <= ?');
    params.push(filters.to);
  }
  const limit = filters.limit ?? 50;
  const whereSql = where.join(' AND ');
  const countRow = db.get(`SELECT COUNT(*) AS n FROM messages WHERE ${whereSql}`, params);
  const total = (countRow?.['n'] as number) ?? 0;
  const rows = db.all(
    `SELECT * FROM messages WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit],
  );
  return toListOrSpill(rows.map(toMessageView), total);
}

/** M12.A09 / M13.A09 — simulated inbound: new message + conversation bookkeeping. */
export function receiveSimulatedInbound(
  db: StoreTx,
  now: number,
  channel: Channel,
  contactId: string,
  subject: string | null,
  body: string,
): Row {
  requireContactRow(db, contactId); // existence check
  const conversationId = findOrCreateConversation(db, now, contactId, channel);
  const id = nextId(db, 'messages', 'msg');
  const addrs = defaultAddrs(channel);
  db.run(
    `INSERT INTO messages (id, created_at, updated_at, archived, conversation_id, contact_id,
      channel, direction, status, scheduled_at, sent_at, from_addr, to_addr, template_id,
      campaign_id, subject, body)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'inbound', 'received', NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      now,
      now,
      conversationId,
      contactId,
      channel,
      now,
      addrs.to,
      addrs.from,
      subject,
      body,
    ],
  );
  markConversationInbound(db, conversationId, now);
  return getChannelMessageRow(db, id, channel);
}

/** M12.A10 / M13.A10 — opt-out/unsubscribe, recorded on the contact (M01 preferences pattern). */
export function recordChannelOptOut(
  db: StoreTx,
  now: number,
  contactId: string,
  key: 'sms_opt_out' | 'email_unsubscribed',
): Row {
  const row = db.get(`SELECT * FROM contacts WHERE id = ?`, [contactId]);
  if (!row) throw new ActionError('NOT_FOUND', `Contact '${contactId}' does not exist.`);
  const raw = row['custom_fields'];
  const customFields: Record<string, unknown> =
    typeof raw === 'string' && raw.length > 0
      ? (() => {
          try {
            const parsed = JSON.parse(raw) as unknown;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
          } catch {
            return {};
          }
        })()
      : {};
  db.run(`UPDATE contacts SET custom_fields = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify({ ...customFields, [key]: true }),
    now,
    contactId,
  ]);
  return db.get(`SELECT * FROM contacts WHERE id = ?`, [contactId]) as Row;
}

export function deliveryStatusOf(row: Row): { status: string; sent_at: number | null } {
  return { status: row['status'] as string, sent_at: (row['sent_at'] as number | null) ?? null };
}

// re-export for module files that want the ActionContext type alongside these helpers
export type { ActionContext };
