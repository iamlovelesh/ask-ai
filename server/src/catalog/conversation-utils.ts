/**
 * Shared `conversations` helpers for M11 Conversations, M12 SMS, and M13
 * Email (task 9 batch 2). SMS/Email messages live on the `messages` table
 * (`conversation_id` FK) and are grouped into `conversations` threads per
 * `(contact_id, channel)` — M12/M13's send/draft/schedule/receive handlers
 * resolve (or lazily create) the thread a message belongs to and keep its
 * `last_inbound_at`/`last_outbound_at`/`unread` bookkeeping columns correct,
 * which is exactly what M11's `search_conversations`/`list_unanswered_conversations`
 * read back.
 */

import type { StoreTx, Row } from '../store/db.js';
import { nextId } from './next-id.js';

export type MessageChannel = 'sms' | 'email';

/**
 * Find the most recent non-archived conversation for `(contactId, channel)`,
 * or create a fresh `status:'open'` one. One conversation thread per
 * contact+channel — matches the seed data's own generation shape
 * (`seed-engage.ts#generateConversations`).
 */
export function findOrCreateConversation(
  db: StoreTx,
  now: number,
  contactId: string,
  channel: MessageChannel,
): string {
  const existing = db.get(
    `SELECT id FROM conversations WHERE contact_id = ? AND channel = ? AND archived = 0
     ORDER BY created_at DESC LIMIT 1`,
    [contactId, channel],
  );
  if (existing) return existing['id'] as string;
  const id = nextId(db, 'conversations', 'conv');
  db.run(
    `INSERT INTO conversations (id, created_at, updated_at, archived, contact_id, channel, status,
      last_inbound_at, last_outbound_at, unread, owner_id, subject)
     VALUES (?, ?, ?, 0, ?, ?, 'open', NULL, NULL, 0, NULL, NULL)`,
    [id, now, now, contactId, channel],
  );
  return id;
}

/** Stamp a conversation's outbound bookkeeping after a message is sent. */
export function markConversationOutbound(db: StoreTx, conversationId: string, now: number): void {
  db.run(`UPDATE conversations SET last_outbound_at = ?, updated_at = ? WHERE id = ?`, [
    now,
    now,
    conversationId,
  ]);
}

/**
 * Stamp a conversation's inbound bookkeeping after a message is received —
 * marks it unread and reopens it if it had been closed (an inbound reply on
 * a closed thread is, by definition, new activity).
 */
export function markConversationInbound(db: StoreTx, conversationId: string, now: number): void {
  db.run(
    `UPDATE conversations SET last_inbound_at = ?, unread = 1, updated_at = ?,
       status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
     WHERE id = ?`,
    [now, now, conversationId],
  );
}

export function getConversationIdForMessage(db: StoreTx, messageRow: Row): string | null {
  return (messageRow['conversation_id'] as string | null) ?? null;
}
