/**
 * M13 Email — mirrors M12 SMS exactly (same shared `messages`-table CRUD in
 * `catalog/message-channel.ts`), differing only in `channel`, default
 * addresses, subject handling, and the preview action's computation.
 *
 * Data home: `messages` table, `channel = 'email'`.
 *
 * KIND-BLINDNESS NOTE: same as M12 — `messages` is shared with M12 SMS via
 * the `channel` column; every action whose `id` field means "this email
 * message" declares an action-scoped `${slug}:id` hint with
 * `column:'channel'`.
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import type { DiscriminationCheck } from './discrimination.js';
import type { SynthHints } from './synth-hints.js';
import { withIdempotentWrite } from './idempotency.js';
import {
  messageView,
  messageListOutput,
  toMessageView,
  getChannelMessageRow,
  insertDraftMessage,
  sendMessage,
  scheduleMessage,
  cancelScheduledMessage,
  searchChannelMessages,
  receiveSimulatedInbound,
  recordChannelOptOut,
  deliveryStatusOf,
  type MessageView,
  type MessageListOutput,
} from './message-channel.js';

const MODULE = 'email';
const CHANNEL = 'email' as const;

// --- A01 draft_email --------------------------------------------------------

const draftEmailInput = z.strictObject({
  contact_id: z.string(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const draftEmail: ActionDef<z.infer<typeof draftEmailInput>, MessageView> = {
  id: 'M13.A01',
  slug: 'email.draft_email',
  module: MODULE,
  name: 'Draft email',
  description: 'Create a draft outbound email, opening or reusing the contact\'s email thread.',
  risk: 'write',
  entities: ['messages', 'conversations'],
  inputSchema: draftEmailInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['draft email', 'new email draft'],
    examplePhrasings: ['Draft an email to this contact following up on our call'],
  },
  jit: 'Drafts are not sent — use send_email (with this id) to actually deliver it.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) =>
    toMessageView(
      insertDraftMessage(ctx.db, ctx.clock.now(), CHANNEL, input.contact_id, input.subject, input.body),
    ),
  ),
};

// --- A02 preview_email -------------------------------------------------------

const previewEmailInput = z.strictObject({ subject: z.string().min(1), body: z.string().min(1) });
const previewEmailOutput = z.object({
  subject: z.string(),
  word_count: z.number(),
  approx_read_time_seconds: z.number(),
});
type PreviewEmailOutput = z.infer<typeof previewEmailOutput>;

const previewEmail: ActionDef<z.infer<typeof previewEmailInput>, PreviewEmailOutput> = {
  id: 'M13.A02',
  slug: 'email.preview_email',
  module: MODULE,
  name: 'Preview email',
  description: 'Compute word count and an approximate read time for an email subject/body.',
  risk: 'read',
  entities: [],
  inputSchema: previewEmailInput,
  outputSchema: previewEmailOutput,
  searchCard: {
    synonyms: ['preview email content', 'check email length'],
    examplePhrasings: ['How long will this email take to read?'],
  },
  handler: async (input) => {
    const words = input.body.trim().split(/\s+/).filter((w) => w.length > 0);
    const wordCount = words.length;
    const readTimeSeconds = Math.max(1, Math.round((wordCount / 200) * 60));
    return { subject: input.subject, word_count: wordCount, approx_read_time_seconds: readTimeSeconds };
  },
};

// --- A03 send_email -----------------------------------------------------------

const sendEmailInput = z.strictObject({
  id: z.string().optional(),
  contact_id: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
});

const sendEmail: ActionDef<z.infer<typeof sendEmailInput>, MessageView> = {
  id: 'M13.A03',
  slug: 'email.send_email',
  module: MODULE,
  name: 'Send email',
  description:
    'Send an email now — pass `id` to send an existing draft, or `contact_id`+`body` to send fresh (simulated external send).',
  risk: 'external',
  entities: ['messages', 'conversations'],
  inputSchema: sendEmailInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['email this contact', 'send email'],
    examplePhrasings: ['Send this contact the pricing details by email'],
  },
  handler: withIdempotentWrite(async (input, ctx) =>
    toMessageView(sendMessage(ctx.db, ctx.clock.now(), CHANNEL, input)),
  ),
};

// --- A04 schedule_email ---------------------------------------------------------

const scheduleEmailInput = z.strictObject({
  id: z.string().optional(),
  contact_id: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  scheduled_at: z.number(),
});

const scheduleEmail: ActionDef<z.infer<typeof scheduleEmailInput>, MessageView> = {
  id: 'M13.A04',
  slug: 'email.schedule_email',
  module: MODULE,
  name: 'Schedule email',
  description:
    'Schedule an email for later — pass `id` to schedule an existing draft, or `contact_id`+`body` for a fresh scheduled email.',
  risk: 'write',
  entities: ['messages', 'conversations'],
  inputSchema: scheduleEmailInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['schedule email', 'send email later'],
    examplePhrasings: ['Schedule this email to go out Monday morning'],
  },
  handler: withIdempotentWrite(async (input, ctx) =>
    toMessageView(scheduleMessage(ctx.db, ctx.clock.now(), CHANNEL, input)),
  ),
};

// --- A05 cancel_scheduled_email -------------------------------------------------

const cancelScheduledEmailInput = z.strictObject({ id: z.string() });

const cancelScheduledEmail: ActionDef<z.infer<typeof cancelScheduledEmailInput>, MessageView> = {
  id: 'M13.A05',
  slug: 'email.cancel_scheduled_email',
  module: MODULE,
  name: 'Cancel scheduled email',
  description: 'Cancel a scheduled email, reverting it to draft.',
  risk: 'write',
  entities: ['messages'],
  inputSchema: cancelScheduledEmailInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['cancel scheduled email', 'unschedule email'],
    examplePhrasings: ['Cancel that scheduled email'],
  },
  handler: withIdempotentWrite(async (input, ctx) =>
    toMessageView(cancelScheduledMessage(ctx.db, ctx.clock.now(), CHANNEL, input.id)),
  ),
};

// --- A06 get_email_details -------------------------------------------------------

const getEmailDetailsInput = z.strictObject({ id: z.string() });

const getEmailDetails: ActionDef<z.infer<typeof getEmailDetailsInput>, MessageView> = {
  id: 'M13.A06',
  slug: 'email.get_email_details',
  module: MODULE,
  name: 'Get email details',
  description: 'Fetch a single email message by id.',
  risk: 'read',
  entities: ['messages'],
  inputSchema: getEmailDetailsInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['email details', 'look up email'],
    examplePhrasings: ['Show me that email'],
  },
  handler: async (input, ctx) => toMessageView(getChannelMessageRow(ctx.db, input.id, CHANNEL)),
};

// --- A07 search_email_messages ---------------------------------------------------

const searchEmailMessagesInput = z.strictObject({
  contact_id: z.string().optional(),
  status: z.string().optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchEmailMessagesInput = z.infer<typeof searchEmailMessagesInput>;

const searchEmailMessages: ActionDef<SearchEmailMessagesInput, MessageListOutput> = {
  id: 'M13.A07',
  slug: 'email.search_email_messages',
  module: MODULE,
  name: 'Search email messages',
  description: 'Search email messages by contact/status/date range.',
  risk: 'read',
  entities: ['messages'],
  inputSchema: searchEmailMessagesInput,
  outputSchema: messageListOutput,
  searchCard: {
    synonyms: ['find emails', 'list sent emails'],
    examplePhrasings: ['Show me all emails sent to this contact'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => searchChannelMessages(ctx.db, CHANNEL, input),
};

// --- A08 get_email_delivery_status -----------------------------------------------

const getEmailDeliveryStatusInput = z.strictObject({ id: z.string() });
const deliveryStatusOutput = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  sent_at: z.number().nullable(),
});
type DeliveryStatusOutput = z.infer<typeof deliveryStatusOutput>;

const getEmailDeliveryStatus: ActionDef<
  z.infer<typeof getEmailDeliveryStatusInput>,
  DeliveryStatusOutput
> = {
  id: 'M13.A08',
  slug: 'email.get_email_delivery_status',
  module: MODULE,
  name: 'Get email delivery status',
  description: 'Fetch the delivery status of a sent/scheduled email.',
  risk: 'read',
  entities: ['messages'],
  inputSchema: getEmailDeliveryStatusInput,
  outputSchema: deliveryStatusOutput,
  searchCard: {
    synonyms: ['email delivery status', 'did the email go through'],
    examplePhrasings: ['Did that email get delivered?'],
  },
  handler: async (input, ctx) => {
    const row = getChannelMessageRow(ctx.db, input.id, CHANNEL);
    const view = toMessageView(row);
    const status = deliveryStatusOf(row);
    return { id: view.id, name: view.name, ...status };
  },
};

// --- A09 receive_simulated_inbound_email -----------------------------------------

const receiveSimulatedInboundEmailInput = z.strictObject({
  contact_id: z.string(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const receiveSimulatedInboundEmail: ActionDef<
  z.infer<typeof receiveSimulatedInboundEmailInput>,
  MessageView
> = {
  id: 'M13.A09',
  slug: 'email.receive_simulated_inbound_email',
  module: MODULE,
  name: 'Receive simulated inbound email',
  description: "Simulate an inbound email from a contact, updating the thread's unread/last-inbound state.",
  risk: 'write',
  entities: ['messages', 'conversations'],
  inputSchema: receiveSimulatedInboundEmailInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['simulate incoming email', 'fake inbound email'],
    examplePhrasings: ['Simulate this contact replying to our email'],
  },
  handler: withIdempotentWrite(async (input, ctx) =>
    toMessageView(
      receiveSimulatedInbound(ctx.db, ctx.clock.now(), CHANNEL, input.contact_id, input.subject, input.body),
    ),
  ),
};

// --- A10 record_email_unsubscribe -----------------------------------------------------

const recordEmailUnsubscribeInput = z.strictObject({ contact_id: z.string() });
const recordEmailUnsubscribeOutput = z.object({
  id: z.string(),
  name: z.string(),
  email_unsubscribed: z.literal(true),
});
type RecordEmailUnsubscribeOutput = z.infer<typeof recordEmailUnsubscribeOutput>;

const recordEmailUnsubscribe: ActionDef<
  z.infer<typeof recordEmailUnsubscribeInput>,
  RecordEmailUnsubscribeOutput
> = {
  id: 'M13.A10',
  slug: 'email.record_email_unsubscribe',
  module: MODULE,
  name: 'Record email unsubscribe',
  description: 'Record that a contact has unsubscribed from email.',
  risk: 'write',
  entities: ['contacts'],
  inputSchema: recordEmailUnsubscribeInput,
  outputSchema: recordEmailUnsubscribeOutput,
  searchCard: {
    synonyms: ['email unsubscribe', 'stop emailing this contact'],
    examplePhrasings: ['This contact unsubscribed, record it'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = recordChannelOptOut(ctx.db, ctx.clock.now(), input.contact_id, 'email_unsubscribed');
    return { id: input.contact_id, name: row['name'] as string, email_unsubscribed: true as const };
  }),
};

export const m13Email: ActionDef[] = [
  draftEmail as ActionDef,
  previewEmail as ActionDef,
  sendEmail as ActionDef,
  scheduleEmail as ActionDef,
  cancelScheduledEmail as ActionDef,
  getEmailDetails as ActionDef,
  searchEmailMessages as ActionDef,
  getEmailDeliveryStatus as ActionDef,
  receiveSimulatedInboundEmail as ActionDef,
  recordEmailUnsubscribe as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template,
 * scoped to `channel='email'` (verified: 'sent' → 1331, 'scheduled' → 370).
 */
export const m13DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'email.search_email_messages',
    paramsA: { status: 'sent' },
    paramsB: { status: 'scheduled' },
    expectDifferentCounts: true,
  },
];

/**
 * `messages` is shared with M12 SMS via the `channel` column — every
 * action whose `id` field means "this email message" needs an
 * action-scoped hint naming `column:'channel'`.
 */
export const m13SynthHints: SynthHints = {
  'email.send_email:id': { table: 'messages', kind: 'email', column: 'channel' },
  'email.schedule_email:id': { table: 'messages', kind: 'email', column: 'channel' },
  'email.cancel_scheduled_email:id': { table: 'messages', kind: 'email', column: 'channel' },
  'email.get_email_details:id': { table: 'messages', kind: 'email', column: 'channel' },
  'email.get_email_delivery_status:id': { table: 'messages', kind: 'email', column: 'channel' },
};
