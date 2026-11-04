/**
 * Day-to-day CRM activity: tasks, notes, conversations (+ their `messages`),
 * appointments, events.
 *
 * Conversations carry the "scenario-material guarantee": at least
 * `minUnreplied` conversations are `status = 'open'` with the last inbound
 * message not yet answered (`last_outbound_at IS NULL OR last_inbound_at >
 * last_outbound_at`).
 */

import type { SeedCtx } from './seed-context.js';
import { insert, nextId, pastTimestamp, pick, chance, weightedPick } from './seed-context.js';
import { TASK_TITLES, NOTE_SNIPPETS, EVENT_NAMES } from './seed-data.js';

const DAY_MS = 1000 * 60 * 60 * 24;

const TASK_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;

export function generateTasks(ctx: SeedCtx, contactIds: string[], ownerIds: string[], count: number): void {
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'task');
    const createdAt = pastTimestamp(ctx, 180, 0);
    const status = weightedPick(ctx, TASK_STATUSES, [0.25, 0.15, 0.45, 0.15]);
    const dueDate = ctx.now + (ctx.rng.int(60) - 20) * DAY_MS;
    insert(ctx, 'tasks', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      title: pick(ctx, TASK_TITLES),
      status,
      priority: pick(ctx, ['low', 'medium', 'high']),
      due_date: dueDate,
      owner_id: pick(ctx, ownerIds),
      contact_id: chance(ctx, 0.7) ? pick(ctx, contactIds) : null,
      related_type: chance(ctx, 0.4) ? pick(ctx, ['lead', 'opportunity', 'invoice']) : null,
      related_id: null,
      completed_at: status === 'completed' ? createdAt + ctx.rng.int(10 * DAY_MS) : null,
      description: chance(ctx, 0.5) ? pick(ctx, NOTE_SNIPPETS) : null,
    });
  }
}

export function generateNotes(ctx: SeedCtx, contactIds: string[], authorIds: string[], count: number): void {
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'note');
    const createdAt = pastTimestamp(ctx, 300, 0);
    insert(ctx, 'notes', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      contact_id: pick(ctx, contactIds),
      author_id: pick(ctx, authorIds),
      related_type: chance(ctx, 0.3) ? pick(ctx, ['opportunity', 'lead']) : null,
      related_id: null,
      pinned: chance(ctx, 0.1) ? 1 : 0,
      body: pick(ctx, NOTE_SNIPPETS),
    });
  }
}

export interface ConversationHandle {
  id: string;
  channel: string;
  contactId: string;
  anchorTime: number;
}

/** `minUnreplied` conversations are explicitly left with an unanswered inbound. */
export function generateConversations(
  ctx: SeedCtx,
  contactIds: string[],
  ownerIds: string[],
  total: number,
  minUnreplied: number,
): ConversationHandle[] {
  const out: ConversationHandle[] = [];

  function makeConversation(unreplied: boolean): ConversationHandle {
    const id = nextId(ctx, 'conv');
    const contactId = pick(ctx, contactIds);
    const channel = pick(ctx, ['sms', 'email', 'webchat']);
    const lastInboundAt = pastTimestamp(ctx, unreplied ? 13 : 180, 0);
    const replied = !unreplied && chance(ctx, 0.75);
    const lastOutboundAt = replied ? lastInboundAt + ctx.rng.int(2 * DAY_MS) : unreplied ? null : lastInboundAt - ctx.rng.int(2 * DAY_MS);
    const status = unreplied ? 'open' : weightedPick(ctx, ['open', 'closed', 'snoozed'], [0.35, 0.5, 0.15]);
    const createdAt = Math.min(lastInboundAt, lastOutboundAt ?? lastInboundAt);
    insert(ctx, 'conversations', {
      id,
      created_at: createdAt,
      updated_at: lastInboundAt,
      archived: 0,
      contact_id: contactId,
      channel,
      status,
      last_inbound_at: lastInboundAt,
      last_outbound_at: lastOutboundAt,
      unread: unreplied || chance(ctx, 0.1) ? 1 : 0,
      owner_id: pick(ctx, ownerIds),
      subject: channel === 'email' ? 'Re: your inquiry' : null,
    });
    return { id, channel, contactId, anchorTime: lastInboundAt };
  }

  for (let i = 0; i < minUnreplied; i++) out.push(makeConversation(true));
  for (let i = minUnreplied; i < total; i++) out.push(makeConversation(false));
  return out;
}

export function generateMessages(
  ctx: SeedCtx,
  conversations: ConversationHandle[],
  templateIds: string[],
  campaignIds: string[],
): void {
  for (const conv of conversations) {
    const count = 4 + ctx.rng.int(13);
    for (let j = 0; j < count; j++) {
      const id = nextId(ctx, 'msg');
      const direction = pick(ctx, ['inbound', 'outbound'] as const);
      const status =
        direction === 'inbound'
          ? 'received'
          : weightedPick(ctx, ['sent', 'delivered', 'failed', 'scheduled', 'draft'], [0.35, 0.4, 0.05, 0.1, 0.1]);
      const channel = pick(ctx, ['sms', 'email'] as const);
      const sentAt = status === 'draft' ? null : conv.anchorTime - ctx.rng.int(20 * DAY_MS);
      insert(ctx, 'messages', {
        id,
        created_at: sentAt ?? conv.anchorTime,
        updated_at: sentAt ?? conv.anchorTime,
        archived: 0,
        conversation_id: conv.id,
        contact_id: conv.contactId,
        channel,
        direction,
        status,
        scheduled_at: status === 'scheduled' ? (sentAt ?? conv.anchorTime) + 2 * DAY_MS : null,
        sent_at: sentAt,
        from_addr: channel === 'sms' ? '+15555550100' : 'team@ourcrm.io',
        to_addr: channel === 'sms' ? '+15555550199' : 'contact@example.com',
        template_id: chance(ctx, 0.3) && templateIds.length > 0 ? pick(ctx, templateIds) : null,
        campaign_id: chance(ctx, 0.2) && campaignIds.length > 0 ? pick(ctx, campaignIds) : null,
        subject: channel === 'email' ? 'Following up' : null,
        body: direction === 'inbound' ? 'Thanks, can you tell me more?' : 'Happy to help — here are the details.',
      });
    }
  }
}

const APPT_STATUSES = ['booked', 'cancelled', 'completed', 'no_show'] as const;

export function generateAppointments(
  ctx: SeedCtx,
  contactIds: string[],
  calendarIds: string[],
  bookingPageIds: string[],
  hostIds: string[],
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'appt');
    const startAt = ctx.now + (ctx.rng.int(90) - 45) * DAY_MS;
    const status = startAt < ctx.now ? weightedPick(ctx, APPT_STATUSES, [0.05, 0.1, 0.75, 0.1]) : 'booked';
    insert(ctx, 'appointments', {
      id,
      created_at: startAt - ctx.rng.int(10 * DAY_MS),
      updated_at: startAt,
      archived: 0,
      title: 'Discovery call',
      contact_id: pick(ctx, contactIds),
      calendar_id: pick(ctx, calendarIds),
      host_user_id: pick(ctx, hostIds),
      booking_page_id: chance(ctx, 0.6) && bookingPageIds.length > 0 ? pick(ctx, bookingPageIds) : null,
      status,
      start_at: startAt,
      end_at: startAt + 30 * 60 * 1000,
      location: pick(ctx, ['Zoom', 'Google Meet', 'Phone', 'In-person']),
      notes: null,
    });
  }
}

const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'completed'] as const;

export function generateEvents(ctx: SeedCtx, hostIds: string[], count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'evt');
    const startAt = ctx.now + (ctx.rng.int(120) - 60) * DAY_MS;
    const status = startAt < ctx.now ? weightedPick(ctx, EVENT_STATUSES, [0.02, 0.08, 0.1, 0.8]) : weightedPick(ctx, EVENT_STATUSES, [0.1, 0.8, 0.1, 0]);
    const capacity = 50 + ctx.rng.int(450);
    insert(ctx, 'events', {
      id,
      created_at: startAt - 20 * DAY_MS,
      updated_at: startAt,
      archived: 0,
      name: pick(ctx, EVENT_NAMES),
      status,
      start_at: startAt,
      end_at: startAt + 2 * 60 * 60 * 1000,
      location: pick(ctx, ['Virtual', 'San Francisco, CA', 'New York, NY', 'Austin, TX']),
      host_user_id: pick(ctx, hostIds),
      capacity,
      registered_count: Math.min(capacity, ctx.rng.int(capacity)),
      price_cents: chance(ctx, 0.4) ? 0 : 20_00 + ctx.rng.int(200_00),
      description: `${pick(ctx, EVENT_NAMES)} — seeded event.`,
    });
    ids.push(id);
  }
  return ids;
}
