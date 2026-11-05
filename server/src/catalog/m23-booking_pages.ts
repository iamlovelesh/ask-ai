/**
 * M23 Booking Pages — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'booking_page'`. `config` is
 * `{ calendar_id: string|null, headline: string|null, description: string|
 * null, intake_fields: Array<{key,label,type,required}>, confirmation_message:
 * string|null, redirect_url: string|null }`.
 *
 * `link_calendar_to_booking_page` validates the target calendar is a real
 * `structures(kind='calendar')` row (real `NOT_FOUND` if not).
 * `publish_booking_page` enforces the real business rule that a booking
 * page needs a linked calendar before it can go live — `VALIDATION` if
 * `config.calendar_id` is unset (seeded booking pages have none, so this is
 * the expected path against a freshly-synthesized row until
 * `link_calendar_to_booking_page` has run).
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10/M14/M18/M19/M20): `entities[0]`
 * is `'structures'` — the bare `id` field needs an action-scoped synthHint.
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
import { parseJsonObject } from './json.js';

const MODULE = 'booking_pages';
const KIND = 'booking_page';

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'booking-page'}-${id}`;
}

interface IntakeField {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

interface BookingPageConfig {
  calendar_id: string | null;
  headline: string | null;
  description: string | null;
  intake_fields: IntakeField[];
  confirmation_message: string | null;
  redirect_url: string | null;
}

function readConfig(row: Row): BookingPageConfig {
  const config = parseJsonObject(row['config']);
  return {
    calendar_id: (config['calendar_id'] as string | null | undefined) ?? null,
    headline: (config['headline'] as string | null | undefined) ?? null,
    description: (config['description'] as string | null | undefined) ?? null,
    intake_fields: Array.isArray(config['intake_fields']) ? (config['intake_fields'] as IntakeField[]) : [],
    confirmation_message: (config['confirmation_message'] as string | null | undefined) ?? null,
    redirect_url: (config['redirect_url'] as string | null | undefined) ?? null,
  };
}

function writeConfig(db: StoreTx, id: string, config: BookingPageConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

interface BookingPageView {
  id: string;
  name: string;
  status: string;
  calendar_id: string | null;
  headline: string | null;
  description: string | null;
  intake_fields: IntakeField[];
  confirmation_message: string | null;
  redirect_url: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): BookingPageView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    calendar_id: config.calendar_id,
    headline: config.headline,
    description: config.description,
    intake_fields: config.intake_fields,
    confirmation_message: config.confirmation_message,
    redirect_url: config.redirect_url,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getBookingPageRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Booking page '${id}' does not exist.`);
  return row;
}

const intakeFieldSchema = z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean() });

const bookingPageView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  calendar_id: z.string().nullable(),
  headline: z.string().nullable(),
  description: z.string().nullable(),
  intake_fields: z.array(intakeFieldSchema),
  confirmation_message: z.string().nullable(),
  redirect_url: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_booking_page -----------------------------------------------------

const createBookingPageInput = z.strictObject({ name: z.string().min(1) });

const createBookingPage: ActionDef<z.infer<typeof createBookingPageInput>, BookingPageView> = {
  id: 'M23.A01',
  slug: 'booking_pages.create_booking_page',
  module: MODULE,
  name: 'Create booking page',
  description: 'Create a new booking page (link a calendar via link_calendar_to_booking_page before publishing).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createBookingPageInput,
  outputSchema: bookingPageView,
  searchCard: {
    synonyms: ['add booking page', 'new booking page'],
    examplePhrasings: ['Create a booking page for demo calls'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: BookingPageConfig = {
      calendar_id: null,
      headline: null,
      description: null,
      intake_fields: [],
      confirmation_message: null,
      redirect_url: null,
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getBookingPageRow(ctx.db, id));
  }),
};

// --- A02 get_booking_page -----------------------------------------------

const getBookingPageInput = z.strictObject({ id: z.string() });

const getBookingPage: ActionDef<z.infer<typeof getBookingPageInput>, BookingPageView> = {
  id: 'M23.A02',
  slug: 'booking_pages.get_booking_page',
  module: MODULE,
  name: 'Get booking page',
  description: 'Fetch a single booking page by id.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getBookingPageInput,
  outputSchema: bookingPageView,
  searchCard: {
    synonyms: ['booking page details', 'look up booking page'],
    examplePhrasings: ['Show me this booking page'],
  },
  handler: async (input, ctx) => toView(getBookingPageRow(ctx.db, input.id)),
};

// --- A03 list_booking_pages -----------------------------------------------------

const listBookingPagesInput = z.strictObject({
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListBookingPagesInput = z.infer<typeof listBookingPagesInput>;
const listBookingPagesOutput = listOutputSchema(bookingPageView);
type ListBookingPagesOutput = ListOrSpill<BookingPageView>;

const listBookingPages: ActionDef<ListBookingPagesInput, ListBookingPagesOutput> = {
  id: 'M23.A03',
  slug: 'booking_pages.list_booking_pages',
  module: MODULE,
  name: 'List booking pages',
  description: 'List non-archived booking pages.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listBookingPagesInput,
  outputSchema: listBookingPagesOutput,
  searchCard: {
    synonyms: ['all booking pages', 'show booking pages'],
    examplePhrasings: ['List our booking pages'],
  },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM structures WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'structures', whereSql, params },
    });
  },
};

// --- A04 update_booking_page_content -----------------------------------------------

const updateBookingPageContentInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({ headline: z.string().optional(), description: z.string().optional() })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateBookingPageContent: ActionDef<z.infer<typeof updateBookingPageContentInput>, BookingPageView> = {
  id: 'M23.A04',
  slug: 'booking_pages.update_booking_page_content',
  module: MODULE,
  name: 'Update booking page content',
  description: "Patch a booking page's headline/description.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateBookingPageContentInput,
  outputSchema: bookingPageView,
  searchCard: {
    synonyms: ['edit booking page', 'update booking page copy'],
    examplePhrasings: ["Change this booking page's headline"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getBookingPageRow(ctx.db, input.id);
    const config = readConfig(row);
    const next: BookingPageConfig = {
      ...config,
      headline: input.patch.headline ?? config.headline,
      description: input.patch.description ?? config.description,
    };
    writeConfig(ctx.db, input.id, next, ctx.clock.now());
    return toView(getBookingPageRow(ctx.db, input.id));
  }),
};

// --- A05 link_calendar_to_booking_page -----------------------------------------------

const linkCalendarToBookingPageInput = z.strictObject({ id: z.string(), calendar_id: z.string() });

const linkCalendarToBookingPage: ActionDef<z.infer<typeof linkCalendarToBookingPageInput>, BookingPageView> = {
  id: 'M23.A05',
  slug: 'booking_pages.link_calendar_to_booking_page',
  module: MODULE,
  name: 'Link calendar to booking page',
  description: 'Link a booking page to the calendar it books against (validates the calendar exists).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: linkCalendarToBookingPageInput,
  outputSchema: bookingPageView,
  searchCard: {
    synonyms: ['connect calendar', 'link calendar'],
    examplePhrasings: ['Link this booking page to the sales demo calendar'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getBookingPageRow(ctx.db, input.id);
    const calendar = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'calendar'`, [input.calendar_id]);
    if (!calendar) throw new ActionError('NOT_FOUND', `Calendar '${input.calendar_id}' does not exist.`);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, calendar_id: input.calendar_id }, ctx.clock.now());
    return toView(getBookingPageRow(ctx.db, input.id));
  }),
};

// --- A06 set_booking_intake_fields -----------------------------------------------

const setBookingIntakeFieldsInput = z.strictObject({ id: z.string(), fields: z.array(intakeFieldSchema) });

const setBookingIntakeFields: ActionDef<z.infer<typeof setBookingIntakeFieldsInput>, BookingPageView> = {
  id: 'M23.A06',
  slug: 'booking_pages.set_booking_intake_fields',
  module: MODULE,
  name: 'Set booking intake fields',
  description: 'Replace the list of intake fields a booker must fill in.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setBookingIntakeFieldsInput,
  outputSchema: bookingPageView,
  searchCard: {
    synonyms: ['set intake form', 'booking intake fields'],
    examplePhrasings: ['Ask for a phone number when someone books this page'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getBookingPageRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, intake_fields: input.fields }, ctx.clock.now());
    return toView(getBookingPageRow(ctx.db, input.id));
  }),
};

// --- A07 set_booking_confirmation_message -----------------------------------------------

const setBookingConfirmationMessageInput = z.strictObject({ id: z.string(), message: z.string().min(1) });

const setBookingConfirmationMessage: ActionDef<z.infer<typeof setBookingConfirmationMessageInput>, BookingPageView> = {
  id: 'M23.A07',
  slug: 'booking_pages.set_booking_confirmation_message',
  module: MODULE,
  name: 'Set booking confirmation message',
  description: 'Set the message shown after a successful booking.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setBookingConfirmationMessageInput,
  outputSchema: bookingPageView,
  searchCard: {
    synonyms: ['set confirmation message', 'thank you message'],
    examplePhrasings: ["Change this booking page's confirmation message"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getBookingPageRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, confirmation_message: input.message }, ctx.clock.now());
    return toView(getBookingPageRow(ctx.db, input.id));
  }),
};

// --- A08 set_booking_redirect_url -----------------------------------------------

const setBookingRedirectUrlInput = z.strictObject({ id: z.string(), url: z.string().url() });

const setBookingRedirectUrl: ActionDef<z.infer<typeof setBookingRedirectUrlInput>, BookingPageView> = {
  id: 'M23.A08',
  slug: 'booking_pages.set_booking_redirect_url',
  module: MODULE,
  name: 'Set booking redirect URL',
  description: 'Set the URL a booker is redirected to after a successful booking.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setBookingRedirectUrlInput,
  outputSchema: bookingPageView,
  searchCard: {
    synonyms: ['set redirect url', 'post-booking redirect'],
    examplePhrasings: ['Redirect bookers to our thank-you page'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getBookingPageRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, redirect_url: input.url }, ctx.clock.now());
    return toView(getBookingPageRow(ctx.db, input.id));
  }),
};

// --- A09 publish_booking_page -----------------------------------------------

const publishBookingPageInput = z.strictObject({ id: z.string() });
const publishBookingPageOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('published') });

const publishBookingPage: ActionDef<z.infer<typeof publishBookingPageInput>, z.infer<typeof publishBookingPageOutput>> = {
  id: 'M23.A09',
  slug: 'booking_pages.publish_booking_page',
  module: MODULE,
  name: 'Publish booking page',
  description: 'Publish a booking page (requires a linked calendar).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: publishBookingPageInput,
  outputSchema: publishBookingPageOutput,
  searchCard: {
    synonyms: ['go live with booking page', 'publish booking page'],
    examplePhrasings: ['Publish this booking page'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getBookingPageRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.calendar_id) {
      throw new ActionError('VALIDATION', `Booking page '${input.id}' needs a linked calendar before it can be published.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'published', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, status: 'published' as const };
  }),
};

// --- A10 unpublish_booking_page -----------------------------------------------

const unpublishBookingPageInput = z.strictObject({ id: z.string() });
const unpublishBookingPageOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('draft') });

const unpublishBookingPage: ActionDef<z.infer<typeof unpublishBookingPageInput>, z.infer<typeof unpublishBookingPageOutput>> = {
  id: 'M23.A10',
  slug: 'booking_pages.unpublish_booking_page',
  module: MODULE,
  name: 'Unpublish booking page',
  description: 'Take a booking page offline (back to draft).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: unpublishBookingPageInput,
  outputSchema: unpublishBookingPageOutput,
  searchCard: {
    synonyms: ['take booking page offline', 'unpublish'],
    examplePhrasings: ['Unpublish this booking page'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getBookingPageRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET status = 'draft', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, status: 'draft' as const };
  }),
};

export const m23BookingPages: ActionDef[] = [
  createBookingPage as ActionDef,
  getBookingPage as ActionDef,
  listBookingPages as ActionDef,
  updateBookingPageContent as ActionDef,
  linkCalendarToBookingPage as ActionDef,
  setBookingIntakeFields as ActionDef,
  setBookingConfirmationMessage as ActionDef,
  setBookingRedirectUrl as ActionDef,
  publishBookingPage as ActionDef,
  unpublishBookingPage as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live: 'published' → 7, 'draft' → 3 — margin 4; this module's own
 * writes can shift it by at most 1 either way — `publish_booking_page`
 * mostly short-circuits via VALIDATION against a freshly-synthesized,
 * never-linked row — never flipping the inequality).
 */
export const m23DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'booking_pages.list_booking_pages',
    paramsA: { status: 'published' },
    paramsB: { status: 'draft' },
    expectDifferentCounts: true,
  },
];

/**
 * Every action below has `entities[0] === 'structures'` with
 * `kind = 'booking_page'` — the bare `id` field needs an action-scoped hint.
 * `calendar_id` is already a `testing.ts` built-in default
 * (`{table:'structures', kind:'calendar'}`), so `link_calendar_to_booking_page`
 * needs no extra hint for that field.
 */
export const m23SynthHints: SynthHints = {
  'booking_pages.get_booking_page:id': { table: 'structures', kind: KIND },
  'booking_pages.update_booking_page_content:id': { table: 'structures', kind: KIND },
  'booking_pages.link_calendar_to_booking_page:id': { table: 'structures', kind: KIND },
  'booking_pages.set_booking_intake_fields:id': { table: 'structures', kind: KIND },
  'booking_pages.set_booking_confirmation_message:id': { table: 'structures', kind: KIND },
  'booking_pages.set_booking_redirect_url:id': { table: 'structures', kind: KIND },
  'booking_pages.publish_booking_page:id': { table: 'structures', kind: KIND },
  'booking_pages.unpublish_booking_page:id': { table: 'structures', kind: KIND },
};
