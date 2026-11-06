/**
 * M24 Events — follows the M01 Contacts convention verbatim.
 *
 * Data home: the typed `events` table (the event container — plain, NOT
 * kind-discriminated, so the bare `id` field resolves correctly via
 * `entities[0]` with no synthHint needed) PLUS `participations` table,
 * `kind = 'event_registration'` (`parent_type='event'`, `parent_id` = the
 * event id — matches `entities/seed-content.ts#generateParticipations`'s
 * own seeded shape: `status` ∈ registered|attended|cancelled|no_show,
 * `waitlisted` ∈ 0|1).
 *
 * `register_attendee`: real capacity check against the event's
 * `capacity` vs. its CURRENT non-cancelled, non-waitlisted registration
 * count (a live `COUNT(*)` query, not the possibly-stale `events.
 * registered_count` column) — waitlists (`waitlisted=1`) when full.
 * `promote_waitlisted_attendee`: real FIFO — picks the earliest-`joined_at`
 * waitlisted, non-cancelled registration for the event.
 * `events.registered_count` is always RECOMPUTED (not incrementally
 * patched) after every participations mutation, via
 * `recomputeRegisteredCount` — avoids incremental-math drift bugs entirely.
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

const MODULE = 'events';
const REG_KIND = 'event_registration';
const STATUSES = ['draft', 'published', 'cancelled', 'completed'] as const;

interface EventView {
  id: string;
  name: string;
  status: string;
  start_at: number;
  end_at: number;
  location: string | null;
  host_user_id: string | null;
  capacity: number | null;
  registered_count: number;
  price_cents: number | null;
  description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): EventView {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    start_at: row['start_at'] as number,
    end_at: row['end_at'] as number,
    location: (row['location'] as string | null) ?? null,
    host_user_id: (row['host_user_id'] as string | null) ?? null,
    capacity: (row['capacity'] as number | null) ?? null,
    registered_count: (row['registered_count'] as number | null) ?? 0,
    price_cents: (row['price_cents'] as number | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getEventRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM events WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Event '${id}' does not exist.`);
  return row;
}

/** Recompute `events.registered_count` from the real `participations` rows
 * (counted, non-waitlisted, non-cancelled) — always a full recompute, never
 * an incremental +1/-1, so it can never drift out of sync. */
function recomputeRegisteredCount(db: StoreTx, eventId: string, now: number): void {
  db.run(
    `UPDATE events SET registered_count = (
       SELECT COUNT(*) FROM participations
       WHERE kind = ? AND parent_id = ? AND waitlisted = 0 AND status != 'cancelled'
     ), updated_at = ? WHERE id = ?`,
    [REG_KIND, eventId, now, eventId],
  );
}

function getActiveRegistration(db: StoreTx, eventId: string, contactId: string): Row | undefined {
  return db.get(
    `SELECT * FROM participations
     WHERE kind = ? AND parent_id = ? AND contact_id = ? AND status != 'cancelled'
     ORDER BY joined_at DESC LIMIT 1`,
    [REG_KIND, eventId, contactId],
  );
}

interface RegistrationView {
  id: string;
  name: string;
  event_id: string;
  contact_id: string;
  status: string;
  waitlisted: boolean;
  joined_at: number;
  completed_at: number | null;
}

function toRegistrationView(db: StoreTx, row: Row): RegistrationView {
  const contact = db.get(`SELECT name FROM contacts WHERE id = ?`, [row['contact_id']]);
  const contactName = (contact?.['name'] as string | undefined) ?? (row['contact_id'] as string);
  return {
    id: row['id'] as string,
    name: `Registration for ${contactName}`,
    event_id: row['parent_id'] as string,
    contact_id: row['contact_id'] as string,
    status: row['status'] as string,
    waitlisted: row['waitlisted'] === 1,
    joined_at: row['joined_at'] as number,
    completed_at: (row['completed_at'] as number | null) ?? null,
  };
}

const eventView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  start_at: z.number(),
  end_at: z.number(),
  location: z.string().nullable(),
  host_user_id: z.string().nullable(),
  capacity: z.number().nullable(),
  registered_count: z.number(),
  price_cents: z.number().nullable(),
  description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

const registrationView = z.object({
  id: z.string(),
  name: z.string(),
  event_id: z.string(),
  contact_id: z.string(),
  status: z.string(),
  waitlisted: z.boolean(),
  joined_at: z.number(),
  completed_at: z.number().nullable(),
});

// --- A01 create_event -----------------------------------------------------

const createEventInput = z.strictObject({
  name: z.string().min(1),
  start_at: z.number().int().min(0),
  end_at: z.number().int().min(0),
  location: z.string().optional(),
  host_user_id: z.string().optional(),
  capacity: z.number().int().min(1).optional(),
  price_cents: z.number().int().min(0).optional(),
  description: z.string().optional(),
});

const createEvent: ActionDef<z.infer<typeof createEventInput>, EventView> = {
  id: 'M24.A01',
  slug: 'events.create_event',
  module: MODULE,
  name: 'Create event',
  description: 'Create a new event.',
  risk: 'write',
  entities: ['events'],
  inputSchema: createEventInput,
  outputSchema: eventView,
  searchCard: {
    synonyms: ['add event', 'new event'],
    examplePhrasings: ['Create a webinar event for next Tuesday'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.end_at <= input.start_at) {
      throw new ActionError('VALIDATION', 'An event must have `end_at` after `start_at`.');
    }
    if (input.host_user_id) {
      const host = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.host_user_id]);
      if (!host) throw new ActionError('NOT_FOUND', `User '${input.host_user_id}' does not exist.`);
    }
    const id = nextId(ctx.db, 'events', 'evt');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO events (id, created_at, updated_at, archived, name, status, start_at, end_at,
        location, host_user_id, capacity, registered_count, price_cents, description)
       VALUES (?, ?, ?, 0, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        now,
        now,
        input.name,
        input.start_at,
        input.end_at,
        input.location ?? null,
        input.host_user_id ?? null,
        input.capacity ?? null,
        input.price_cents ?? null,
        input.description ?? null,
      ],
    );
    return toView(getEventRow(ctx.db, id));
  }),
};

// --- A02 get_event_details -----------------------------------------------

const getEventDetailsInput = z.strictObject({ id: z.string() });

const getEventDetails: ActionDef<z.infer<typeof getEventDetailsInput>, EventView> = {
  id: 'M24.A02',
  slug: 'events.get_event_details',
  module: MODULE,
  name: 'Get event details',
  description: 'Fetch a single event by id.',
  risk: 'read',
  entities: ['events'],
  inputSchema: getEventDetailsInput,
  outputSchema: eventView,
  searchCard: {
    synonyms: ['event details', 'look up event'],
    examplePhrasings: ['Show me this event'],
  },
  handler: async (input, ctx) => toView(getEventRow(ctx.db, input.id)),
};

// --- A03 search_events -----------------------------------------------------

const searchEventsInput = z.strictObject({
  query: z.string().optional(),
  status: z.enum(STATUSES).optional(),
  host_user_id: z.string().optional(),
  start_after: z.number().int().min(0).optional(),
  start_before: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchEventsInput = z.infer<typeof searchEventsInput>;
const searchEventsOutput = listOutputSchema(eventView);
type SearchEventsOutput = ListOrSpill<EventView>;

const searchEvents: ActionDef<SearchEventsInput, SearchEventsOutput> = {
  id: 'M24.A03',
  slug: 'events.search_events',
  module: MODULE,
  name: 'Search events',
  description: 'Search non-archived events by name, status, host, and start-time range.',
  risk: 'read',
  entities: ['events'],
  inputSchema: searchEventsInput,
  outputSchema: searchEventsOutput,
  searchCard: {
    synonyms: ['find events', 'list events'],
    examplePhrasings: ['Show published events happening next month'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('name LIKE ?');
      params.push(`%${input.query}%`);
    }
    if (input.status) {
      where.push('status = ? COLLATE NOCASE');
      params.push(input.status);
    }
    if (input.host_user_id) {
      where.push('host_user_id = ?');
      params.push(input.host_user_id);
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
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM events WHERE ${whereSql} ORDER BY start_at DESC LIMIT ?`, [
      ...params,
      limit,
    ]);
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'events', whereSql, params },
    });
  },
};

// --- A04 update_event_details -----------------------------------------------

const updateEventDetailsInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({
      name: z.string().min(1).optional(),
      start_at: z.number().int().min(0).optional(),
      end_at: z.number().int().min(0).optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateEventDetails: ActionDef<z.infer<typeof updateEventDetailsInput>, EventView> = {
  id: 'M24.A04',
  slug: 'events.update_event_details',
  module: MODULE,
  name: 'Update event details',
  description: "Patch an event's editable fields.",
  risk: 'write',
  entities: ['events'],
  inputSchema: updateEventDetailsInput,
  outputSchema: eventView,
  searchCard: {
    synonyms: ['edit event', 'update event'],
    examplePhrasings: ["Change this event's location"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getEventRow(ctx.db, input.id);
    const nextStartAt = input.patch.start_at ?? (row['start_at'] as number);
    const nextEndAt = input.patch.end_at ?? (row['end_at'] as number);
    if (nextEndAt <= nextStartAt) {
      throw new ActionError('VALIDATION', 'An event must have `end_at` after `start_at`.');
    }
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE events SET ${setSql}, updated_at = ? WHERE id = ?`, [...values, ctx.clock.now(), input.id]);
    return toView(getEventRow(ctx.db, input.id));
  }),
};

// --- A05 set_event_capacity -----------------------------------------------

const setEventCapacityInput = z.strictObject({ id: z.string(), capacity: z.number().int().min(1) });

const setEventCapacity: ActionDef<z.infer<typeof setEventCapacityInput>, EventView> = {
  id: 'M24.A05',
  slug: 'events.set_event_capacity',
  module: MODULE,
  name: 'Set event capacity',
  description: 'Set the maximum attendee capacity for an event (refuses to go below the current confirmed count).',
  risk: 'write',
  entities: ['events', 'participations'],
  inputSchema: setEventCapacityInput,
  outputSchema: eventView,
  searchCard: {
    synonyms: ['change event capacity', 'set max attendees'],
    examplePhrasings: ['Increase this event to 200 seats'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getEventRow(ctx.db, input.id);
    const countRow = ctx.db.get(
      `SELECT COUNT(*) AS n FROM participations
       WHERE kind = ? AND parent_id = ? AND waitlisted = 0 AND status != 'cancelled'`,
      [REG_KIND, input.id],
    );
    const confirmed = (countRow?.['n'] as number) ?? 0;
    if (input.capacity < confirmed) {
      throw new ActionError(
        'CONFLICT',
        `Cannot set capacity to ${input.capacity} — event '${input.id}' already has ${confirmed} confirmed attendees.`,
      );
    }
    ctx.db.run(`UPDATE events SET capacity = ?, updated_at = ? WHERE id = ?`, [input.capacity, ctx.clock.now(), input.id]);
    return toView(getEventRow(ctx.db, input.id));
  }),
};

// --- A06 register_attendee -----------------------------------------------

const registerAttendeeInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const registerAttendee: ActionDef<z.infer<typeof registerAttendeeInput>, RegistrationView> = {
  id: 'M24.A06',
  slug: 'events.register_attendee',
  module: MODULE,
  name: 'Register attendee',
  description: 'Register a contact for an event; waitlists automatically when the event is at capacity.',
  risk: 'write',
  entities: ['events', 'participations'],
  inputSchema: registerAttendeeInput,
  outputSchema: registrationView,
  searchCard: {
    synonyms: ['register for event', 'sign up for event'],
    examplePhrasings: ['Register this contact for the webinar'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const event = getEventRow(ctx.db, input.id);
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    if (getActiveRegistration(ctx.db, input.id, input.contact_id)) {
      throw new ActionError('CONFLICT', `Contact '${input.contact_id}' is already registered for event '${input.id}'.`);
    }
    const capacity = event['capacity'] as number | null;
    const confirmedRow = ctx.db.get(
      `SELECT COUNT(*) AS n FROM participations
       WHERE kind = ? AND parent_id = ? AND waitlisted = 0 AND status != 'cancelled'`,
      [REG_KIND, input.id],
    );
    const confirmed = (confirmedRow?.['n'] as number) ?? 0;
    const waitlisted = capacity !== null && confirmed >= capacity;
    const id = nextId(ctx.db, 'participations', 'part');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO participations (id, created_at, updated_at, archived, kind, contact_id, parent_type,
        parent_id, status, waitlisted, role, joined_at, progress, completed_at)
       VALUES (?, ?, ?, 0, ?, ?, 'event', ?, 'registered', ?, NULL, ?, NULL, NULL)`,
      [id, now, now, REG_KIND, input.contact_id, input.id, waitlisted ? 1 : 0, now],
    );
    recomputeRegisteredCount(ctx.db, input.id, now);
    return toRegistrationView(ctx.db, ctx.db.get(`SELECT * FROM participations WHERE id = ?`, [id]) as Row);
  }),
};

// --- A07 cancel_attendee_registration -----------------------------------------------

const cancelAttendeeRegistrationInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const cancelAttendeeRegistration: ActionDef<z.infer<typeof cancelAttendeeRegistrationInput>, RegistrationView> = {
  id: 'M24.A07',
  slug: 'events.cancel_attendee_registration',
  module: MODULE,
  name: 'Cancel attendee registration',
  description: "Cancel a contact's registration for an event.",
  risk: 'destructive',
  entities: ['events', 'participations'],
  inputSchema: cancelAttendeeRegistrationInput,
  outputSchema: registrationView,
  searchCard: {
    synonyms: ['cancel registration', 'unregister from event'],
    examplePhrasings: ["Cancel this contact's registration for the event"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getEventRow(ctx.db, input.id);
    const reg = getActiveRegistration(ctx.db, input.id, input.contact_id);
    if (!reg) {
      throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' has no active registration for event '${input.id}'.`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE participations SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now, reg['id']]);
    recomputeRegisteredCount(ctx.db, input.id, now);
    return toRegistrationView(ctx.db, ctx.db.get(`SELECT * FROM participations WHERE id = ?`, [reg['id']]) as Row);
  }),
};

// --- A08 add_attendee_to_waitlist -----------------------------------------------

const addAttendeeToWaitlistInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const addAttendeeToWaitlist: ActionDef<z.infer<typeof addAttendeeToWaitlistInput>, RegistrationView> = {
  id: 'M24.A08',
  slug: 'events.add_attendee_to_waitlist',
  module: MODULE,
  name: 'Add attendee to waitlist',
  description: "Add a contact directly to an event's waitlist, bypassing the capacity check.",
  risk: 'write',
  entities: ['events', 'participations'],
  inputSchema: addAttendeeToWaitlistInput,
  outputSchema: registrationView,
  searchCard: {
    synonyms: ['waitlist attendee', 'add to waitlist'],
    examplePhrasings: ['Put this contact on the waitlist for the event'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getEventRow(ctx.db, input.id);
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    if (getActiveRegistration(ctx.db, input.id, input.contact_id)) {
      throw new ActionError('CONFLICT', `Contact '${input.contact_id}' already has a registration for event '${input.id}'.`);
    }
    const id = nextId(ctx.db, 'participations', 'part');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO participations (id, created_at, updated_at, archived, kind, contact_id, parent_type,
        parent_id, status, waitlisted, role, joined_at, progress, completed_at)
       VALUES (?, ?, ?, 0, ?, ?, 'event', ?, 'registered', 1, NULL, ?, NULL, NULL)`,
      [id, now, now, REG_KIND, input.contact_id, input.id, now],
    );
    recomputeRegisteredCount(ctx.db, input.id, now);
    return toRegistrationView(ctx.db, ctx.db.get(`SELECT * FROM participations WHERE id = ?`, [id]) as Row);
  }),
};

// --- A09 promote_waitlisted_attendee -----------------------------------------------

const promoteWaitlistedAttendeeInput = z.strictObject({ id: z.string() });

const promoteWaitlistedAttendee: ActionDef<z.infer<typeof promoteWaitlistedAttendeeInput>, RegistrationView> = {
  id: 'M24.A09',
  slug: 'events.promote_waitlisted_attendee',
  module: MODULE,
  name: 'Promote waitlisted attendee',
  description: 'Promote the longest-waiting waitlisted attendee for an event off the waitlist (FIFO).',
  risk: 'write',
  entities: ['events', 'participations'],
  inputSchema: promoteWaitlistedAttendeeInput,
  outputSchema: registrationView,
  searchCard: {
    synonyms: ['promote from waitlist', 'move up the waitlist'],
    examplePhrasings: ['Promote the next person off the waitlist for this event'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getEventRow(ctx.db, input.id);
    const next = ctx.db.get(
      `SELECT * FROM participations
       WHERE kind = ? AND parent_id = ? AND waitlisted = 1 AND status != 'cancelled'
       ORDER BY joined_at ASC LIMIT 1`,
      [REG_KIND, input.id],
    );
    if (!next) throw new ActionError('NOT_FOUND', `Event '${input.id}' has no one on the waitlist.`);
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE participations SET waitlisted = 0, updated_at = ? WHERE id = ?`, [now, next['id']]);
    recomputeRegisteredCount(ctx.db, input.id, now);
    return toRegistrationView(ctx.db, ctx.db.get(`SELECT * FROM participations WHERE id = ?`, [next['id']]) as Row);
  }),
};

// --- A10 check_in_attendee -----------------------------------------------

const checkInAttendeeInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const checkInAttendee: ActionDef<z.infer<typeof checkInAttendeeInput>, RegistrationView> = {
  id: 'M24.A10',
  slug: 'events.check_in_attendee',
  module: MODULE,
  name: 'Check in attendee',
  description: "Check in a contact at an event (validates their registration exists).",
  risk: 'write',
  entities: ['events', 'participations'],
  inputSchema: checkInAttendeeInput,
  outputSchema: registrationView,
  searchCard: {
    synonyms: ['check in', 'mark attended'],
    examplePhrasings: ['Check this contact in to the event'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getEventRow(ctx.db, input.id);
    const reg = getActiveRegistration(ctx.db, input.id, input.contact_id);
    if (!reg) {
      throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' has no active registration for event '${input.id}'.`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE participations SET status = 'attended', completed_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      reg['id'],
    ]);
    return toRegistrationView(ctx.db, ctx.db.get(`SELECT * FROM participations WHERE id = ?`, [reg['id']]) as Row);
  }),
};

export const m24Events: ActionDef[] = [
  createEvent as ActionDef,
  getEventDetails as ActionDef,
  searchEvents as ActionDef,
  updateEventDetails as ActionDef,
  setEventCapacity as ActionDef,
  registerAttendee as ActionDef,
  cancelAttendeeRegistration as ActionDef,
  addAttendeeToWaitlist as ActionDef,
  promoteWaitlistedAttendee as ActionDef,
  checkInAttendee as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live: 'published' → 22, 'draft' → 4 — margin 18, comfortably
 * survives this module's own smoke writes, none of which touch `status`).
 */
export const m24DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'events.search_events',
    paramsA: { status: 'published' },
    paramsB: { status: 'draft' },
    expectDifferentCounts: true,
  },
];

/**
 * `events` is a plain typed table (not kind-discriminated) — the bare `id`
 * field resolves correctly via `entities[0]` with no hint needed, and
 * `contact_id`/`host_user_id` are already covered by `testing.ts`'s
 * `DEFAULT_HINTS`. No module-declared hints required.
 */
export const m24SynthHints: SynthHints = {};
