/**
 * M21 Appointments — follows the M01 Contacts convention verbatim.
 *
 * Data home: the typed `appointments` table (plain, NOT kind-discriminated
 * — `entities[0] = 'appointments'` resolves the bare `id` field correctly
 * via `testing.ts`'s generic `entities[0]` fallback, so NO action-scoped
 * synthHint is needed here, unlike the `structures`-backed modules in this
 * same batch).
 *
 * `search_appointments` is eval-critical per the brief ("exclude anyone
 * with a booked appointment" uses `status='booked'` + `contact_ids`) — every
 * documented filter param (`contact_ids`, `calendar_id`, `host_user_id`,
 * `status`, `start_after`, `start_before`) is wired into the WHERE clause for
 * real.
 *
 * SINGLE-ATTENDEE JUDGMENT CALL: `appointments` has exactly one
 * `contact_id` column (no multi-attendee list/JSON column in
 * `entities/model.ts` — this table models a classic 1:1 scheduling-tool
 * appointment, matching `entities/seed-engage.ts#generateAppointments`,
 * which seeds exactly one `contact_id` per row). `add_appointment_attendee`/
 * `remove_appointment_attendee`/`mark_attendee_no_show` therefore operate on
 * that ONE attendee slot rather than a real multi-attendee list: adding a
 * second, DIFFERENT contact while one is already set is a real `CONFLICT`
 * (not silently overwritten), removing validates the given contact IS the
 * current attendee, and no-show marks the appointment's own `status`
 * (there's no separate per-attendee status column to mark).
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

const MODULE = 'appointments';
const STATUSES = ['booked', 'cancelled', 'completed', 'no_show'] as const;

interface AppointmentView {
  id: string;
  title: string | null;
  contact_id: string | null;
  calendar_id: string | null;
  host_user_id: string | null;
  booking_page_id: string | null;
  status: string;
  start_at: number;
  end_at: number;
  location: string | null;
  notes: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): AppointmentView {
  return {
    id: row['id'] as string,
    title: (row['title'] as string | null) ?? null,
    contact_id: (row['contact_id'] as string | null) ?? null,
    calendar_id: (row['calendar_id'] as string | null) ?? null,
    host_user_id: (row['host_user_id'] as string | null) ?? null,
    booking_page_id: (row['booking_page_id'] as string | null) ?? null,
    status: row['status'] as string,
    start_at: row['start_at'] as number,
    end_at: row['end_at'] as number,
    location: (row['location'] as string | null) ?? null,
    notes: (row['notes'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getAppointmentRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM appointments WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Appointment '${id}' does not exist.`);
  return row;
}

const appointmentView = z.object({
  id: z.string(),
  title: z.string().nullable(),
  contact_id: z.string().nullable(),
  calendar_id: z.string().nullable(),
  host_user_id: z.string().nullable(),
  booking_page_id: z.string().nullable(),
  status: z.string(),
  start_at: z.number(),
  end_at: z.number(),
  location: z.string().nullable(),
  notes: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_appointment -----------------------------------------------------

const createAppointmentInput = z.strictObject({
  title: z.string().optional(),
  contact_id: z.string(),
  calendar_id: z.string(),
  host_user_id: z.string(),
  start_at: z.number().int().min(0),
  end_at: z.number().int().min(0),
  booking_page_id: z.string().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
});
type CreateAppointmentInput = z.infer<typeof createAppointmentInput>;

const createAppointment: ActionDef<CreateAppointmentInput, AppointmentView> = {
  id: 'M21.A01',
  slug: 'appointments.create_appointment',
  module: MODULE,
  name: 'Create appointment',
  description: 'Book a new appointment on a calendar.',
  risk: 'write',
  entities: ['appointments'],
  inputSchema: createAppointmentInput,
  outputSchema: appointmentView,
  searchCard: {
    synonyms: ['book appointment', 'schedule meeting'],
    examplePhrasings: ['Book a discovery call with this contact tomorrow at 2pm'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.end_at <= input.start_at) {
      throw new ActionError('VALIDATION', 'An appointment must have `end_at` after `start_at`.');
    }
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    const calendar = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'calendar'`, [input.calendar_id]);
    if (!calendar) throw new ActionError('NOT_FOUND', `Calendar '${input.calendar_id}' does not exist.`);
    const host = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.host_user_id]);
    if (!host) throw new ActionError('NOT_FOUND', `User '${input.host_user_id}' does not exist.`);
    const id = nextId(ctx.db, 'appointments', 'appt');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO appointments (id, created_at, updated_at, archived, title, contact_id, calendar_id,
        host_user_id, booking_page_id, status, start_at, end_at, location, notes)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?)`,
      [
        id,
        now,
        now,
        input.title ?? null,
        input.contact_id,
        input.calendar_id,
        input.host_user_id,
        input.booking_page_id ?? null,
        input.start_at,
        input.end_at,
        input.location ?? null,
        input.notes ?? null,
      ],
    );
    return toView(getAppointmentRow(ctx.db, id));
  }),
};

// --- A02 get_appointment_details -----------------------------------------------

const getAppointmentDetailsInput = z.strictObject({ id: z.string() });

const getAppointmentDetails: ActionDef<z.infer<typeof getAppointmentDetailsInput>, AppointmentView> = {
  id: 'M21.A02',
  slug: 'appointments.get_appointment_details',
  module: MODULE,
  name: 'Get appointment details',
  description: 'Fetch a single appointment by id.',
  risk: 'read',
  entities: ['appointments'],
  inputSchema: getAppointmentDetailsInput,
  outputSchema: appointmentView,
  searchCard: {
    synonyms: ['appointment details', 'look up appointment'],
    examplePhrasings: ['Show me this appointment'],
  },
  handler: async (input, ctx) => toView(getAppointmentRow(ctx.db, input.id)),
};

// --- A03 search_appointments -----------------------------------------------------

const searchAppointmentsInput = z.strictObject({
  contact_ids: z.array(z.string()).optional(),
  calendar_id: z.string().optional(),
  host_user_id: z.string().optional(),
  status: z.enum(STATUSES).optional(),
  start_after: z.number().int().min(0).optional(),
  start_before: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchAppointmentsInput = z.infer<typeof searchAppointmentsInput>;
const searchAppointmentsOutput = listOutputSchema(appointmentView);
type SearchAppointmentsOutput = ListOrSpill<AppointmentView>;

const searchAppointments: ActionDef<SearchAppointmentsInput, SearchAppointmentsOutput> = {
  id: 'M21.A03',
  slug: 'appointments.search_appointments',
  module: MODULE,
  name: 'Search appointments',
  description: 'Search appointments by contact(s), calendar, host, status, and start-time range.',
  risk: 'read',
  entities: ['appointments'],
  inputSchema: searchAppointmentsInput,
  outputSchema: searchAppointmentsOutput,
  searchCard: {
    synonyms: ['find appointments', 'list appointments'],
    examplePhrasings: ['Who has a booked appointment next week?', "Show Dana's completed appointments"],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Use status=\'booked\' + contact_ids to check who already has an appointment on the books.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.contact_ids && input.contact_ids.length > 0) {
      where.push(`contact_id IN (${input.contact_ids.map(() => '?').join(', ')})`);
      params.push(...input.contact_ids);
    }
    if (input.calendar_id) {
      where.push('calendar_id = ?');
      params.push(input.calendar_id);
    }
    if (input.host_user_id) {
      where.push('host_user_id = ?');
      params.push(input.host_user_id);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.start_after !== undefined) {
      where.push('start_at > ?');
      params.push(input.start_after);
    }
    if (input.start_before !== undefined) {
      where.push('start_at < ?');
      params.push(input.start_before);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM appointments WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM appointments WHERE ${whereSql} ORDER BY start_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'appointments', whereSql, params },
    });
  },
};

// --- A04 reschedule_appointment -----------------------------------------------------

const rescheduleAppointmentInput = z.strictObject({ id: z.string(), start_at: z.number().int().min(0), end_at: z.number().int().min(0) });

const rescheduleAppointment: ActionDef<z.infer<typeof rescheduleAppointmentInput>, AppointmentView> = {
  id: 'M21.A04',
  slug: 'appointments.reschedule_appointment',
  module: MODULE,
  name: 'Reschedule appointment',
  description: 'Move a booked appointment to a new start/end time.',
  risk: 'write',
  entities: ['appointments'],
  inputSchema: rescheduleAppointmentInput,
  outputSchema: appointmentView,
  searchCard: {
    synonyms: ['move appointment', 'change appointment time'],
    examplePhrasings: ['Move this appointment to 3pm tomorrow'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAppointmentRow(ctx.db, input.id);
    if (row['status'] !== 'booked') {
      throw new ActionError('CONFLICT', `Appointment '${input.id}' is '${row['status'] as string}', not 'booked' — cannot reschedule.`);
    }
    if (input.end_at <= input.start_at) {
      throw new ActionError('VALIDATION', 'An appointment must have `end_at` after `start_at`.');
    }
    ctx.db.run(`UPDATE appointments SET start_at = ?, end_at = ?, status = 'booked', updated_at = ? WHERE id = ?`, [
      input.start_at,
      input.end_at,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getAppointmentRow(ctx.db, input.id));
  }),
};

// --- A05 cancel_appointment -----------------------------------------------------

const cancelAppointmentInput = z.strictObject({ id: z.string() });
const cancelAppointmentOutput = z.object({ id: z.string(), title: z.string().nullable(), status: z.literal('cancelled') });

const cancelAppointment: ActionDef<z.infer<typeof cancelAppointmentInput>, z.infer<typeof cancelAppointmentOutput>> = {
  id: 'M21.A05',
  slug: 'appointments.cancel_appointment',
  module: MODULE,
  name: 'Cancel appointment',
  description: 'Cancel an appointment (soft status change, not a delete).',
  risk: 'destructive',
  entities: ['appointments'],
  inputSchema: cancelAppointmentInput,
  outputSchema: cancelAppointmentOutput,
  searchCard: {
    synonyms: ['delete appointment', 'cancel meeting'],
    examplePhrasings: ['Cancel this appointment'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAppointmentRow(ctx.db, input.id);
    ctx.db.run(`UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, title: (row['title'] as string | null) ?? null, status: 'cancelled' as const };
  }),
};

// --- A06 assign_appointment_host -----------------------------------------------

const assignAppointmentHostInput = z.strictObject({ id: z.string(), host_user_id: z.string() });

const assignAppointmentHost: ActionDef<z.infer<typeof assignAppointmentHostInput>, AppointmentView> = {
  id: 'M21.A06',
  slug: 'appointments.assign_appointment_host',
  module: MODULE,
  name: 'Assign appointment host',
  description: 'Reassign the hosting user for an appointment.',
  risk: 'write',
  entities: ['appointments', 'users'],
  inputSchema: assignAppointmentHostInput,
  outputSchema: appointmentView,
  searchCard: {
    synonyms: ['reassign appointment', 'change appointment host'],
    examplePhrasings: ['Reassign this appointment to Dana'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getAppointmentRow(ctx.db, input.id);
    const host = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.host_user_id]);
    if (!host) throw new ActionError('NOT_FOUND', `User '${input.host_user_id}' does not exist.`);
    ctx.db.run(`UPDATE appointments SET host_user_id = ?, updated_at = ? WHERE id = ?`, [
      input.host_user_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getAppointmentRow(ctx.db, input.id));
  }),
};

// --- A07 add_appointment_attendee -----------------------------------------------

const addAppointmentAttendeeInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const addAppointmentAttendee: ActionDef<z.infer<typeof addAppointmentAttendeeInput>, AppointmentView> = {
  id: 'M21.A07',
  slug: 'appointments.add_appointment_attendee',
  module: MODULE,
  name: 'Add appointment attendee',
  description: 'Set the attendee contact for an appointment (single-attendee model — see module header).',
  risk: 'write',
  entities: ['appointments'],
  inputSchema: addAppointmentAttendeeInput,
  outputSchema: appointmentView,
  searchCard: {
    synonyms: ['add attendee', 'invite contact to appointment'],
    examplePhrasings: ['Add this contact to the appointment'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAppointmentRow(ctx.db, input.id);
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    const current = row['contact_id'] as string | null;
    if (current !== null && current !== input.contact_id) {
      throw new ActionError(
        'CONFLICT',
        `Appointment '${input.id}' already has attendee '${current}' — remove them before adding a different attendee.`,
      );
    }
    ctx.db.run(`UPDATE appointments SET contact_id = ?, updated_at = ? WHERE id = ?`, [
      input.contact_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getAppointmentRow(ctx.db, input.id));
  }),
};

// --- A08 remove_appointment_attendee -----------------------------------------------

const removeAppointmentAttendeeInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const removeAppointmentAttendee: ActionDef<z.infer<typeof removeAppointmentAttendeeInput>, AppointmentView> = {
  id: 'M21.A08',
  slug: 'appointments.remove_appointment_attendee',
  module: MODULE,
  name: 'Remove appointment attendee',
  description: 'Clear the attendee contact from an appointment (single-attendee model — see module header).',
  risk: 'write',
  entities: ['appointments'],
  inputSchema: removeAppointmentAttendeeInput,
  outputSchema: appointmentView,
  searchCard: {
    synonyms: ['remove attendee', 'uninvite contact'],
    examplePhrasings: ['Remove this contact from the appointment'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAppointmentRow(ctx.db, input.id);
    if (row['contact_id'] !== input.contact_id) {
      throw new ActionError('VALIDATION', `Contact '${input.contact_id}' is not the attendee of appointment '${input.id}'.`);
    }
    ctx.db.run(`UPDATE appointments SET contact_id = NULL, updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getAppointmentRow(ctx.db, input.id));
  }),
};

// --- A09 mark_attendee_no_show -----------------------------------------------

const markAttendeeNoShowInput = z.strictObject({ id: z.string() });
const markAttendeeNoShowOutput = z.object({ id: z.string(), title: z.string().nullable(), status: z.literal('no_show') });

const markAttendeeNoShow: ActionDef<z.infer<typeof markAttendeeNoShowInput>, z.infer<typeof markAttendeeNoShowOutput>> = {
  id: 'M21.A09',
  slug: 'appointments.mark_attendee_no_show',
  module: MODULE,
  name: 'Mark attendee no-show',
  description: "Mark an appointment's attendee as a no-show.",
  risk: 'write',
  entities: ['appointments'],
  inputSchema: markAttendeeNoShowInput,
  outputSchema: markAttendeeNoShowOutput,
  searchCard: {
    synonyms: ['mark no-show', 'attendee did not show up', 'guest never showed up'],
    examplePhrasings: [
      "Mark this appointment's attendee as a no-show",
      'This guest never showed up for their scheduled meeting',
    ],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAppointmentRow(ctx.db, input.id);
    ctx.db.run(`UPDATE appointments SET status = 'no_show', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, title: (row['title'] as string | null) ?? null, status: 'no_show' as const };
  }),
};

// --- A10 mark_appointment_completed -----------------------------------------------

const markAppointmentCompletedInput = z.strictObject({ id: z.string() });
const markAppointmentCompletedOutput = z.object({ id: z.string(), title: z.string().nullable(), status: z.literal('completed') });

const markAppointmentCompleted: ActionDef<
  z.infer<typeof markAppointmentCompletedInput>,
  z.infer<typeof markAppointmentCompletedOutput>
> = {
  id: 'M21.A10',
  slug: 'appointments.mark_appointment_completed',
  module: MODULE,
  name: 'Mark appointment completed',
  description: 'Mark an appointment as completed.',
  risk: 'write',
  entities: ['appointments'],
  inputSchema: markAppointmentCompletedInput,
  outputSchema: markAppointmentCompletedOutput,
  searchCard: {
    synonyms: ['complete appointment', 'mark meeting done'],
    examplePhrasings: ['Mark this appointment as completed'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAppointmentRow(ctx.db, input.id);
    ctx.db.run(`UPDATE appointments SET status = 'completed', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, title: (row['title'] as string | null) ?? null, status: 'completed' as const };
  }),
};

export const m21Appointments: ActionDef[] = [
  createAppointment as ActionDef,
  getAppointmentDetails as ActionDef,
  searchAppointments as ActionDef,
  rescheduleAppointment as ActionDef,
  cancelAppointment as ActionDef,
  assignAppointmentHost as ActionDef,
  addAppointmentAttendee as ActionDef,
  removeAppointmentAttendee as ActionDef,
  markAttendeeNoShow as ActionDef,
  markAppointmentCompleted as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live: 'booked' → 388, 'completed' → 271 — margin 117,
 * comfortably survives this module's own smoke writes).
 */
export const m21DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'appointments.search_appointments',
    paramsA: { status: 'booked' },
    paramsB: { status: 'completed' },
    expectDifferentCounts: true,
  },
];

/**
 * `appointments` is a plain typed table (not kind-discriminated) — the bare
 * `id` field resolves correctly via `entities[0]` with no hint needed, and
 * every `*_id` field (`contact_id`, `calendar_id`, `host_user_id`) is
 * already covered by `testing.ts`'s `DEFAULT_HINTS`. No module-declared
 * hints required.
 */
export const m21SynthHints: SynthHints = {};
