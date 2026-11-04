/**
 * M12 SMS — follows the M01 Contacts convention verbatim, using the shared
 * `messages`-table CRUD in `catalog/message-channel.ts` (factored out
 * because M13 Email is almost byte-identical, differing only in channel,
 * default addresses, and its preview action).
 *
 * Data home: `messages` table, `channel = 'sms'`.
 *
 * KIND-BLINDNESS NOTE: `messages` is a real typed table (not `structures`),
 * but it's STILL shared by two modules (M12/M13) via a `channel`
 * discriminator column (not `kind`) — `synth-hints.ts`'s `SynthHint.column`
 * (this task's addition) names that column explicitly. Every action here
 * whose `id` field means "this SMS message's id" declares an action-scoped
 * `${slug}:id` hint with `column:'channel'` — WITHOUT it, a flat/no hint
 * would resolve `id` against ANY message row (including email ones), which
 * is exactly the cross-module contamination this convention exists to
 * catch; see `getChannelMessageRow`'s own `AND channel = ?` filter for the
 * defense-in-depth half of the same guard.
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

const MODULE = 'sms';
const CHANNEL = 'sms' as const;

// --- A01 draft_sms --------------------------------------------------------

const draftSmsInput = z.strictObject({ contact_id: z.string(), body: z.string().min(1) });

const draftSms: ActionDef<z.infer<typeof draftSmsInput>, MessageView> = {
  id: 'M12.A01',
  slug: 'sms.draft_sms',
  module: MODULE,
  name: 'Draft SMS',
  description: 'Create a draft outbound SMS, opening or reusing the contact\'s SMS thread.',
  risk: 'write',
  entities: ['messages', 'conversations'],
  inputSchema: draftSmsInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['draft text message', 'new SMS draft'],
    examplePhrasings: ['Draft a text to this contact saying we\'ll call tomorrow'],
  },
  jit: 'Drafts are not sent — use send_sms (with this id) to actually deliver it.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) =>
    toMessageView(insertDraftMessage(ctx.db, ctx.clock.now(), CHANNEL, input.contact_id, null, input.body)),
  ),
};

// --- A02 preview_sms_segmentation -------------------------------------------

const previewSmsSegmentationInput = z.strictObject({ body: z.string().min(1) });
const previewSmsSegmentationOutput = z.object({
  length: z.number(),
  encoding: z.enum(['GSM-7', 'UCS-2']),
  segments: z.number(),
});
type PreviewSmsSegmentationOutput = z.infer<typeof previewSmsSegmentationOutput>;

const previewSmsSegmentation: ActionDef<
  z.infer<typeof previewSmsSegmentationInput>,
  PreviewSmsSegmentationOutput
> = {
  id: 'M12.A02',
  slug: 'sms.preview_sms_segmentation',
  module: MODULE,
  name: 'Preview SMS segmentation',
  description: 'Compute character count, encoding, and carrier segment count for SMS body text.',
  risk: 'read',
  entities: [],
  inputSchema: previewSmsSegmentationInput,
  outputSchema: previewSmsSegmentationOutput,
  searchCard: {
    synonyms: ['check sms length', 'how many segments'],
    examplePhrasings: ['Will this text message split into multiple segments?'],
  },
  handler: async (input) => {
    const isAscii = /^[\x00-\x7F]*$/.test(input.body);
    const singleLimit = isAscii ? 160 : 70;
    const multiLimit = isAscii ? 153 : 67;
    const length = input.body.length;
    const segments = length <= singleLimit ? 1 : Math.ceil(length / multiLimit);
    return { length, encoding: isAscii ? ('GSM-7' as const) : ('UCS-2' as const), segments };
  },
};

// --- A03 send_sms -----------------------------------------------------------

const sendSmsInput = z.strictObject({
  id: z.string().optional(),
  contact_id: z.string().optional(),
  body: z.string().optional(),
});

const sendSms: ActionDef<z.infer<typeof sendSmsInput>, MessageView> = {
  id: 'M12.A03',
  slug: 'sms.send_sms',
  module: MODULE,
  name: 'Send SMS',
  description:
    'Send an SMS now — pass `id` to send an existing draft, or `contact_id`+`body` to send fresh (simulated external send).',
  risk: 'external',
  entities: ['messages', 'conversations'],
  inputSchema: sendSmsInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['text this contact', 'send text message'],
    examplePhrasings: ['Send this contact a text saying we\'re on our way'],
  },
  handler: withIdempotentWrite(async (input, ctx) =>
    toMessageView(sendMessage(ctx.db, ctx.clock.now(), CHANNEL, input)),
  ),
};

// --- A04 schedule_sms ---------------------------------------------------------

const scheduleSmsInput = z.strictObject({
  id: z.string().optional(),
  contact_id: z.string().optional(),
  body: z.string().optional(),
  scheduled_at: z.number(),
});

const scheduleSms: ActionDef<z.infer<typeof scheduleSmsInput>, MessageView> = {
  id: 'M12.A04',
  slug: 'sms.schedule_sms',
  module: MODULE,
  name: 'Schedule SMS',
  description:
    'Schedule an SMS for later — pass `id` to schedule an existing draft, or `contact_id`+`body` for a fresh scheduled message.',
  risk: 'write',
  entities: ['messages', 'conversations'],
  inputSchema: scheduleSmsInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['schedule text message', 'send sms later'],
    examplePhrasings: ['Schedule this text to go out tomorrow at 9am'],
  },
  handler: withIdempotentWrite(async (input, ctx) =>
    toMessageView(scheduleMessage(ctx.db, ctx.clock.now(), CHANNEL, input)),
  ),
};

// --- A05 cancel_scheduled_sms -------------------------------------------------

const cancelScheduledSmsInput = z.strictObject({ id: z.string() });

const cancelScheduledSms: ActionDef<z.infer<typeof cancelScheduledSmsInput>, MessageView> = {
  id: 'M12.A05',
  slug: 'sms.cancel_scheduled_sms',
  module: MODULE,
  name: 'Cancel scheduled SMS',
  description: 'Cancel a scheduled SMS, reverting it to draft.',
  risk: 'write',
  entities: ['messages'],
  inputSchema: cancelScheduledSmsInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['cancel scheduled text', 'unschedule sms'],
    examplePhrasings: ['Cancel that scheduled text message'],
  },
  handler: withIdempotentWrite(async (input, ctx) =>
    toMessageView(cancelScheduledMessage(ctx.db, ctx.clock.now(), CHANNEL, input.id)),
  ),
};

// --- A06 get_sms_details -------------------------------------------------------

const getSmsDetailsInput = z.strictObject({ id: z.string() });

const getSmsDetails: ActionDef<z.infer<typeof getSmsDetailsInput>, MessageView> = {
  id: 'M12.A06',
  slug: 'sms.get_sms_details',
  module: MODULE,
  name: 'Get SMS details',
  description: 'Fetch a single SMS message by id.',
  risk: 'read',
  entities: ['messages'],
  inputSchema: getSmsDetailsInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['sms details', 'look up text message'],
    examplePhrasings: ['Show me that text message'],
  },
  handler: async (input, ctx) => toMessageView(getChannelMessageRow(ctx.db, input.id, CHANNEL)),
};

// --- A07 search_sms_messages ---------------------------------------------------

const searchSmsMessagesInput = z.strictObject({
  contact_id: z.string().optional(),
  status: z.string().optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchSmsMessagesInput = z.infer<typeof searchSmsMessagesInput>;

const searchSmsMessages: ActionDef<SearchSmsMessagesInput, MessageListOutput> = {
  id: 'M12.A07',
  slug: 'sms.search_sms_messages',
  module: MODULE,
  name: 'Search SMS messages',
  description: 'Search SMS messages by contact/status/date range.',
  risk: 'read',
  entities: ['messages'],
  inputSchema: searchSmsMessagesInput,
  outputSchema: messageListOutput,
  searchCard: {
    synonyms: ['find text messages', 'list sms'],
    examplePhrasings: ['Show me all text messages sent to this contact'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => searchChannelMessages(ctx.db, CHANNEL, input),
};

// --- A08 get_sms_delivery_status -----------------------------------------------

const getSmsDeliveryStatusInput = z.strictObject({ id: z.string() });
const deliveryStatusOutput = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  sent_at: z.number().nullable(),
});
type DeliveryStatusOutput = z.infer<typeof deliveryStatusOutput>;

const getSmsDeliveryStatus: ActionDef<z.infer<typeof getSmsDeliveryStatusInput>, DeliveryStatusOutput> = {
  id: 'M12.A08',
  slug: 'sms.get_sms_delivery_status',
  module: MODULE,
  name: 'Get SMS delivery status',
  description: 'Fetch the delivery status of a sent/scheduled SMS.',
  risk: 'read',
  entities: ['messages'],
  inputSchema: getSmsDeliveryStatusInput,
  outputSchema: deliveryStatusOutput,
  searchCard: {
    synonyms: ['sms delivery status', 'did the text go through'],
    examplePhrasings: ['Did that text message get delivered?'],
  },
  handler: async (input, ctx) => {
    const row = getChannelMessageRow(ctx.db, input.id, CHANNEL);
    const view = toMessageView(row);
    const status = deliveryStatusOf(row);
    return { id: view.id, name: view.name, ...status };
  },
};

// --- A09 receive_simulated_inbound_sms -----------------------------------------

const receiveSimulatedInboundSmsInput = z.strictObject({
  contact_id: z.string(),
  body: z.string().min(1),
});

const receiveSimulatedInboundSms: ActionDef<
  z.infer<typeof receiveSimulatedInboundSmsInput>,
  MessageView
> = {
  id: 'M12.A09',
  slug: 'sms.receive_simulated_inbound_sms',
  module: MODULE,
  name: 'Receive simulated inbound SMS',
  description: "Simulate an inbound SMS from a contact, updating the thread's unread/last-inbound state.",
  risk: 'write',
  entities: ['messages', 'conversations'],
  inputSchema: receiveSimulatedInboundSmsInput,
  outputSchema: messageView,
  searchCard: {
    synonyms: ['simulate incoming text', 'fake inbound sms'],
    examplePhrasings: ['Simulate this contact texting us back'],
  },
  handler: withIdempotentWrite(async (input, ctx) =>
    toMessageView(
      receiveSimulatedInbound(ctx.db, ctx.clock.now(), CHANNEL, input.contact_id, null, input.body),
    ),
  ),
};

// --- A10 record_sms_opt_out -----------------------------------------------------

const recordSmsOptOutInput = z.strictObject({ contact_id: z.string() });
const recordSmsOptOutOutput = z.object({ id: z.string(), name: z.string(), sms_opt_out: z.literal(true) });
type RecordSmsOptOutOutput = z.infer<typeof recordSmsOptOutOutput>;

const recordSmsOptOut: ActionDef<z.infer<typeof recordSmsOptOutInput>, RecordSmsOptOutOutput> = {
  id: 'M12.A10',
  slug: 'sms.record_sms_opt_out',
  module: MODULE,
  name: 'Record SMS opt-out',
  description: 'Record that a contact has opted out of SMS messaging.',
  risk: 'write',
  entities: ['contacts'],
  inputSchema: recordSmsOptOutInput,
  outputSchema: recordSmsOptOutOutput,
  searchCard: {
    synonyms: ['sms opt out', 'stop texting this contact'],
    examplePhrasings: ['This contact replied STOP, record their sms opt-out'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = recordChannelOptOut(ctx.db, ctx.clock.now(), input.contact_id, 'sms_opt_out');
    return { id: input.contact_id, name: row['name'] as string, sms_opt_out: true as const };
  }),
};

export const m12Sms: ActionDef[] = [
  draftSms as ActionDef,
  previewSmsSegmentation as ActionDef,
  sendSms as ActionDef,
  scheduleSms as ActionDef,
  cancelScheduledSms as ActionDef,
  getSmsDetails as ActionDef,
  searchSmsMessages as ActionDef,
  getSmsDeliveryStatus as ActionDef,
  receiveSimulatedInboundSms as ActionDef,
  recordSmsOptOut as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template,
 * scoped to `channel='sms'` (verified: 'sent' → 1314, 'scheduled' → 401).
 * This module's own smoke writes touch at most a handful of individual sms
 * rows (one per write action) — nowhere near enough to threaten a
 * thousand-row margin.
 */
export const m12DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'sms.search_sms_messages',
    paramsA: { status: 'sent' },
    paramsB: { status: 'scheduled' },
    expectDifferentCounts: true,
  },
];

/**
 * `messages` is shared with M13 Email via the `channel` column (not
 * `kind`) — every action whose `id` field means "this SMS message" needs
 * an action-scoped hint naming `column:'channel'` (see synth-hints.ts /
 * message-channel.ts header comments for why a flat/no hint is unsafe
 * here).
 */
export const m12SynthHints: SynthHints = {
  'sms.send_sms:id': { table: 'messages', kind: 'sms', column: 'channel' },
  'sms.schedule_sms:id': { table: 'messages', kind: 'sms', column: 'channel' },
  'sms.cancel_scheduled_sms:id': { table: 'messages', kind: 'sms', column: 'channel' },
  'sms.get_sms_details:id': { table: 'messages', kind: 'sms', column: 'channel' },
  'sms.get_sms_delivery_status:id': { table: 'messages', kind: 'sms', column: 'channel' },
};
