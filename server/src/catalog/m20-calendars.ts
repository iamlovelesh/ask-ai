/**
 * M20 Calendars — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'calendar'`. Top-level scheduling
 * settings (timezone, host, default appointment duration, booking buffer,
 * visibility) live in `config` via the SHARED `calendar-availability.ts`
 * reader/writer — M22 Availability writes/reads the SAME row's
 * `config.availability` sub-object (per `entities/model.ts#MODULE_MAP`:
 * "M22: structures(calendar).config.availability"). See
 * `calendar-availability.ts`'s header comment for why the config is shared
 * across two module files instead of duplicated.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10/M14/M18/M19): `entities[0]`
 * is `'structures'` — the bare `id` field needs an action-scoped synthHint.
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';
import {
  CALENDAR_KIND as KIND,
  getCalendarRow,
  readCalendarConfig,
  writeCalendarConfig,
  type CalendarConfig,
} from './calendar-availability.js';

const MODULE = 'calendars';

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'calendar'}-${id}`;
}

interface CalendarView {
  id: string;
  name: string;
  status: string;
  timezone: string;
  host_user_id: string | null;
  appointment_duration_minutes: number;
  booking_buffer_minutes: number;
  visibility: 'public' | 'private';
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): CalendarView {
  const config = readCalendarConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    timezone: config.timezone,
    host_user_id: config.host_user_id,
    appointment_duration_minutes: config.appointment_duration_minutes,
    booking_buffer_minutes: config.booking_buffer_minutes,
    visibility: config.visibility,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const calendarView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  timezone: z.string(),
  host_user_id: z.string().nullable(),
  appointment_duration_minutes: z.number(),
  booking_buffer_minutes: z.number(),
  visibility: z.enum(['public', 'private']),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_calendar -----------------------------------------------------

const createCalendarInput = z.strictObject({ name: z.string().min(1), timezone: z.string().optional() });

const createCalendar: ActionDef<z.infer<typeof createCalendarInput>, CalendarView> = {
  id: 'M20.A01',
  slug: 'calendars.create_calendar',
  module: MODULE,
  name: 'Create calendar',
  description: 'Create a new scheduling calendar.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createCalendarInput,
  outputSchema: calendarView,
  searchCard: {
    synonyms: ['add calendar', 'new calendar'],
    examplePhrasings: ['Create a calendar for sales demos'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: CalendarConfig = {
      timezone: input.timezone ?? 'UTC',
      host_user_id: null,
      appointment_duration_minutes: 30,
      booking_buffer_minutes: 0,
      visibility: 'public',
      availability: { weekly_hours: {}, date_overrides: [], blocks: [], minimum_notice_minutes: 0, maximum_horizon_days: 60 },
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getCalendarRow(ctx.db, id));
  }),
};

// --- A02 get_calendar_settings -----------------------------------------------

const getCalendarSettingsInput = z.strictObject({ id: z.string() });

const getCalendarSettings: ActionDef<z.infer<typeof getCalendarSettingsInput>, CalendarView> = {
  id: 'M20.A02',
  slug: 'calendars.get_calendar_settings',
  module: MODULE,
  name: 'Get calendar settings',
  description: 'Fetch a calendar and its top-level scheduling settings.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getCalendarSettingsInput,
  outputSchema: calendarView,
  searchCard: {
    synonyms: ['calendar details', 'calendar settings'],
    examplePhrasings: ['Show me this calendar'],
  },
  handler: async (input, ctx) => toView(getCalendarRow(ctx.db, input.id)),
};

// --- A03 list_calendars --------------------------------------------------------

const listCalendarsInput = z.strictObject({
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListCalendarsInput = z.infer<typeof listCalendarsInput>;
const listCalendarsOutput = listOutputSchema(calendarView);
type ListCalendarsOutput = ListOrSpill<CalendarView>;

const listCalendars: ActionDef<ListCalendarsInput, ListCalendarsOutput> = {
  id: 'M20.A03',
  slug: 'calendars.list_calendars',
  module: MODULE,
  name: 'List calendars',
  description: 'List non-archived calendars.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listCalendarsInput,
  outputSchema: listCalendarsOutput,
  searchCard: {
    synonyms: ['all calendars', 'show calendars'],
    examplePhrasings: ['List our scheduling calendars'],
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
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 update_calendar_details -----------------------------------------------

const updateCalendarDetailsInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({ name: z.string().min(1).optional() })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateCalendarDetails: ActionDef<z.infer<typeof updateCalendarDetailsInput>, CalendarView> = {
  id: 'M20.A04',
  slug: 'calendars.update_calendar_details',
  module: MODULE,
  name: 'Update calendar details',
  description: "Patch a calendar's editable top-level fields (currently: name).",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateCalendarDetailsInput,
  outputSchema: calendarView,
  searchCard: {
    synonyms: ['edit calendar', 'rename calendar'],
    examplePhrasings: ['Rename this calendar to Enterprise Demos'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getCalendarRow(ctx.db, input.id);
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE structures SET ${setSql}, updated_at = ? WHERE id = ?`, [...values, ctx.clock.now(), input.id]);
    return toView(getCalendarRow(ctx.db, input.id));
  }),
};

// --- A05 set_calendar_timezone -----------------------------------------------

const setCalendarTimezoneInput = z.strictObject({ id: z.string(), timezone: z.string().min(1) });

const setCalendarTimezone: ActionDef<z.infer<typeof setCalendarTimezoneInput>, CalendarView> = {
  id: 'M20.A05',
  slug: 'calendars.set_calendar_timezone',
  module: MODULE,
  name: 'Set calendar timezone',
  description: "Set a calendar's timezone label.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setCalendarTimezoneInput,
  outputSchema: calendarView,
  searchCard: {
    synonyms: ['change calendar timezone', 'set timezone'],
    examplePhrasings: ['Set this calendar to Pacific time'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.id);
    const config = readCalendarConfig(row);
    writeCalendarConfig(ctx.db, input.id, { ...config, timezone: input.timezone }, ctx.clock.now());
    return toView(getCalendarRow(ctx.db, input.id));
  }),
};

// --- A06 assign_calendar_host -----------------------------------------------

const assignCalendarHostInput = z.strictObject({ id: z.string(), host_user_id: z.string() });

const assignCalendarHost: ActionDef<z.infer<typeof assignCalendarHostInput>, CalendarView> = {
  id: 'M20.A06',
  slug: 'calendars.assign_calendar_host',
  module: MODULE,
  name: 'Assign calendar host',
  description: 'Set the hosting user for a calendar.',
  risk: 'write',
  entities: ['structures', 'users'],
  inputSchema: assignCalendarHostInput,
  outputSchema: calendarView,
  searchCard: {
    synonyms: ['set calendar host', 'reassign calendar'],
    examplePhrasings: ['Make Dana the host of this calendar'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.id);
    const user = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.host_user_id]);
    if (!user) throw new ActionError('NOT_FOUND', `User '${input.host_user_id}' does not exist.`);
    const config = readCalendarConfig(row);
    writeCalendarConfig(ctx.db, input.id, { ...config, host_user_id: input.host_user_id }, ctx.clock.now());
    return toView(getCalendarRow(ctx.db, input.id));
  }),
};

// --- A07 set_appointment_duration -----------------------------------------------

const setAppointmentDurationInput = z.strictObject({
  id: z.string(),
  duration_minutes: z.number().int().min(5).max(480),
});

const setAppointmentDuration: ActionDef<z.infer<typeof setAppointmentDurationInput>, CalendarView> = {
  id: 'M20.A07',
  slug: 'calendars.set_appointment_duration',
  module: MODULE,
  name: 'Set appointment duration',
  description: 'Set the default appointment duration (minutes) for a calendar.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setAppointmentDurationInput,
  outputSchema: calendarView,
  searchCard: {
    synonyms: ['set default meeting length', 'appointment duration'],
    examplePhrasings: ['Make this calendar book 15-minute slots by default'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.id);
    const config = readCalendarConfig(row);
    writeCalendarConfig(ctx.db, input.id, { ...config, appointment_duration_minutes: input.duration_minutes }, ctx.clock.now());
    return toView(getCalendarRow(ctx.db, input.id));
  }),
};

// --- A08 set_booking_buffer -----------------------------------------------

const setBookingBufferInput = z.strictObject({ id: z.string(), buffer_minutes: z.number().int().min(0).max(240) });

const setBookingBuffer: ActionDef<z.infer<typeof setBookingBufferInput>, CalendarView> = {
  id: 'M20.A08',
  slug: 'calendars.set_booking_buffer',
  module: MODULE,
  name: 'Set booking buffer',
  description: 'Set the buffer time (minutes) required between bookings on a calendar.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setBookingBufferInput,
  outputSchema: calendarView,
  searchCard: {
    synonyms: ['set gap between meetings', 'booking buffer'],
    examplePhrasings: ['Add a 10-minute buffer between bookings on this calendar'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.id);
    const config = readCalendarConfig(row);
    writeCalendarConfig(ctx.db, input.id, { ...config, booking_buffer_minutes: input.buffer_minutes }, ctx.clock.now());
    return toView(getCalendarRow(ctx.db, input.id));
  }),
};

// --- A09 set_calendar_visibility -----------------------------------------------

const setCalendarVisibilityInput = z.strictObject({ id: z.string(), visibility: z.enum(['public', 'private']) });

const setCalendarVisibility: ActionDef<z.infer<typeof setCalendarVisibilityInput>, CalendarView> = {
  id: 'M20.A09',
  slug: 'calendars.set_calendar_visibility',
  module: MODULE,
  name: 'Set calendar visibility',
  description: 'Set whether a calendar is publicly bookable or private.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setCalendarVisibilityInput,
  outputSchema: calendarView,
  searchCard: {
    synonyms: ['make calendar private', 'make calendar public'],
    examplePhrasings: ['Make this calendar private'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.id);
    const config = readCalendarConfig(row);
    writeCalendarConfig(ctx.db, input.id, { ...config, visibility: input.visibility }, ctx.clock.now());
    return toView(getCalendarRow(ctx.db, input.id));
  }),
};

// --- A10 archive_calendar -----------------------------------------------

const archiveCalendarInput = z.strictObject({ id: z.string() });
const archiveCalendarOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const archiveCalendar: ActionDef<z.infer<typeof archiveCalendarInput>, z.infer<typeof archiveCalendarOutput>> = {
  id: 'M20.A10',
  slug: 'calendars.archive_calendar',
  module: MODULE,
  name: 'Archive calendar',
  description: 'Soft-delete a calendar.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: archiveCalendarInput,
  outputSchema: archiveCalendarOutput,
  searchCard: {
    synonyms: ['delete calendar', 'remove calendar'],
    examplePhrasings: ['Archive this calendar'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET archived = 1, updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, archived: true as const };
  }),
};

export const m20Calendars: ActionDef[] = [
  createCalendar as ActionDef,
  getCalendarSettings as ActionDef,
  listCalendars as ActionDef,
  updateCalendarDetails as ActionDef,
  setCalendarTimezone as ActionDef,
  assignCalendarHost as ActionDef,
  setAppointmentDuration as ActionDef,
  setBookingBuffer as ActionDef,
  setCalendarVisibility as ActionDef,
  archiveCalendar as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live: 'active' → 7, 'inactive' → 3 — margin 4; this module's own
 * writes never touch the `status` column — only `archive_calendar` removes
 * a row from the `archived=0` view entirely, which shifts both sides by at
 * most 1, never flipping the inequality).
 */
export const m20DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'calendars.list_calendars',
    paramsA: { status: 'active' },
    paramsB: { status: 'inactive' },
    expectDifferentCounts: true,
  },
];

/**
 * Every action below has `entities[0] === 'structures'` with
 * `kind = 'calendar'` — the bare `id` field needs an action-scoped hint.
 */
export const m20SynthHints: SynthHints = {
  'calendars.get_calendar_settings:id': { table: 'structures', kind: KIND },
  'calendars.update_calendar_details:id': { table: 'structures', kind: KIND },
  'calendars.set_calendar_timezone:id': { table: 'structures', kind: KIND },
  'calendars.assign_calendar_host:id': { table: 'structures', kind: KIND },
  'calendars.set_appointment_duration:id': { table: 'structures', kind: KIND },
  'calendars.set_booking_buffer:id': { table: 'structures', kind: KIND },
  'calendars.set_calendar_visibility:id': { table: 'structures', kind: KIND },
  'calendars.archive_calendar:id': { table: 'structures', kind: KIND },
};
