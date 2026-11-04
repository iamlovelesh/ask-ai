/**
 * M22 Availability — the `config.availability` sub-object of the SAME
 * `structures(kind='calendar')` row M20 Calendars owns (per
 * `entities/model.ts#MODULE_MAP`). See `calendar-availability.ts`'s header
 * comment for the full data-home rationale and why `block_time_range`
 * stores blocks inline in that config rather than as separate `structures`
 * rows.
 *
 * `find_available_slots`/`check_scheduling_conflicts` are REAL computation
 * (brief requirement) — `calendar-availability.ts#computeAvailableSlots`/
 * `findSchedulingConflicts` do a genuine query against `appointments`
 * (`status='booked'`) plus the calendar's own stored blocks, not a canned
 * result.
 *
 * KIND-BLINDNESS NOTE: every action here takes `calendar_id`, not a bare
 * `id` — `calendar_id` is already in `testing.ts`'s built-in `DEFAULT_HINTS`
 * (`{table:'structures', kind:'calendar'}`), so this module needs NO
 * `synthHints` entries of its own (exported as `{}` anyway, per the
 * required-export convention).
 *
 * No list/search action exists in this module (M20's `list_calendars`
 * already covers that) — `discriminationChecks` is `[]`, matching the
 * established convention for modules with no Tier-A coverage yet.
 */

import { z } from 'zod';
import type { ActionDef } from './types.js';
import { ActionError } from './types.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import type { SynthHints } from './synth-hints.js';
import {
  getCalendarRow,
  readCalendarConfig,
  writeCalendarConfig,
  computeAvailableSlots,
  findSchedulingConflicts,
  assertValidDateString,
  nextBlockId,
  VALID_WEEKDAYS,
  type TimeRange,
  type DateOverride,
  type TimeBlock,
} from './calendar-availability.js';

const MODULE = 'availability';

const timeRangeSchema = z.object({ start: z.string(), end: z.string() });

function assertValidRange(range: TimeRange): void {
  if (!/^\d{2}:\d{2}$/.test(range.start) || !/^\d{2}:\d{2}$/.test(range.end)) {
    throw new ActionError('VALIDATION', `Invalid time range '${range.start}'-'${range.end}' — expected 'HH:MM'.`);
  }
  if (range.start >= range.end) {
    throw new ActionError('VALIDATION', `Time range start '${range.start}' must be before end '${range.end}'.`);
  }
}

// --- A01 set_weekly_working_hours -----------------------------------------------

const setWeeklyWorkingHoursInput = z.strictObject({
  calendar_id: z.string(),
  weekly_hours: z.record(z.string(), z.array(timeRangeSchema)),
});
const weeklyHoursOutput = z.object({
  calendar_id: z.string(),
  name: z.string(),
  weekly_hours: z.record(z.string(), z.array(timeRangeSchema)),
});
type WeeklyHoursOutput = z.infer<typeof weeklyHoursOutput>;

const setWeeklyWorkingHours: ActionDef<z.infer<typeof setWeeklyWorkingHoursInput>, WeeklyHoursOutput> = {
  id: 'M22.A01',
  slug: 'availability.set_weekly_working_hours',
  module: MODULE,
  name: 'Set weekly working hours',
  description: "Replace a calendar's weekly recurring working-hours schedule.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setWeeklyWorkingHoursInput,
  outputSchema: weeklyHoursOutput,
  searchCard: {
    synonyms: ['set working hours', 'set weekly availability'],
    examplePhrasings: ['Set this calendar to be available Monday-Friday 9 to 5'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    for (const [day, ranges] of Object.entries(input.weekly_hours)) {
      if (!VALID_WEEKDAYS.includes(day)) {
        throw new ActionError('VALIDATION', `'${day}' is not a valid weekday (expected one of ${VALID_WEEKDAYS.join(', ')}).`);
      }
      for (const range of ranges) assertValidRange(range);
    }
    const config = readCalendarConfig(row);
    writeCalendarConfig(
      ctx.db,
      input.calendar_id,
      { ...config, availability: { ...config.availability, weekly_hours: input.weekly_hours } },
      ctx.clock.now(),
    );
    return { calendar_id: input.calendar_id, name: row['name'] as string, weekly_hours: input.weekly_hours };
  }),
};

// --- A02 get_weekly_working_hours -----------------------------------------------

const getWeeklyWorkingHoursInput = z.strictObject({ calendar_id: z.string() });

const getWeeklyWorkingHours: ActionDef<z.infer<typeof getWeeklyWorkingHoursInput>, WeeklyHoursOutput> = {
  id: 'M22.A02',
  slug: 'availability.get_weekly_working_hours',
  module: MODULE,
  name: 'Get weekly working hours',
  description: "Fetch a calendar's weekly recurring working-hours schedule.",
  risk: 'read',
  entities: ['structures'],
  inputSchema: getWeeklyWorkingHoursInput,
  outputSchema: weeklyHoursOutput,
  searchCard: {
    synonyms: ['get working hours', 'calendar hours'],
    examplePhrasings: ["What are this calendar's working hours?"],
  },
  handler: async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    const config = readCalendarConfig(row);
    return { calendar_id: input.calendar_id, name: row['name'] as string, weekly_hours: config.availability.weekly_hours as Record<string, TimeRange[]> };
  },
};

// --- A03 add_date_specific_availability -----------------------------------------------

const addDateSpecificAvailabilityInput = z.strictObject({
  calendar_id: z.string(),
  date: z.string(),
  ranges: z.array(timeRangeSchema),
});
const dateOverrideOutput = z.object({
  calendar_id: z.string(),
  name: z.string(),
  date: z.string(),
  ranges: z.array(timeRangeSchema),
});

const addDateSpecificAvailability: ActionDef<
  z.infer<typeof addDateSpecificAvailabilityInput>,
  z.infer<typeof dateOverrideOutput>
> = {
  id: 'M22.A03',
  slug: 'availability.add_date_specific_availability',
  module: MODULE,
  name: 'Add date-specific availability',
  description: 'Override a calendar\'s availability for one specific date (replaces any existing override for that date).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addDateSpecificAvailabilityInput,
  outputSchema: dateOverrideOutput,
  searchCard: {
    synonyms: ['set holiday hours', 'override availability for a date'],
    examplePhrasings: ['Block out this calendar on December 25th'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    assertValidDateString(input.date);
    for (const range of input.ranges) assertValidRange(range);
    const config = readCalendarConfig(row);
    const dateOverrides = config.availability.date_overrides.filter((o) => o.date !== input.date);
    const override: DateOverride = { date: input.date, ranges: input.ranges };
    writeCalendarConfig(
      ctx.db,
      input.calendar_id,
      { ...config, availability: { ...config.availability, date_overrides: [...dateOverrides, override] } },
      ctx.clock.now(),
    );
    return { calendar_id: input.calendar_id, name: row['name'] as string, date: input.date, ranges: input.ranges };
  }),
};

// --- A04 remove_date_specific_availability -----------------------------------------------

const removeDateSpecificAvailabilityInput = z.strictObject({ calendar_id: z.string(), date: z.string() });
const removeDateSpecificAvailabilityOutput = z.object({ calendar_id: z.string(), name: z.string(), date: z.string(), removed: z.literal(true) });

const removeDateSpecificAvailability: ActionDef<
  z.infer<typeof removeDateSpecificAvailabilityInput>,
  z.infer<typeof removeDateSpecificAvailabilityOutput>
> = {
  id: 'M22.A04',
  slug: 'availability.remove_date_specific_availability',
  module: MODULE,
  name: 'Remove date-specific availability',
  description: 'Remove a date-specific availability override, reverting that date to the weekly default.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: removeDateSpecificAvailabilityInput,
  outputSchema: removeDateSpecificAvailabilityOutput,
  searchCard: {
    synonyms: ['clear date override', 'remove holiday hours'],
    examplePhrasings: ['Remove the December 25th override from this calendar'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    assertValidDateString(input.date);
    const config = readCalendarConfig(row);
    if (!config.availability.date_overrides.some((o) => o.date === input.date)) {
      throw new ActionError('NOT_FOUND', `Calendar '${input.calendar_id}' has no availability override for '${input.date}'.`);
    }
    const dateOverrides = config.availability.date_overrides.filter((o) => o.date !== input.date);
    writeCalendarConfig(
      ctx.db,
      input.calendar_id,
      { ...config, availability: { ...config.availability, date_overrides: dateOverrides } },
      ctx.clock.now(),
    );
    return { calendar_id: input.calendar_id, name: row['name'] as string, date: input.date, removed: true as const };
  }),
};

// --- A05 block_time_range -----------------------------------------------

const blockTimeRangeInput = z.strictObject({
  calendar_id: z.string(),
  start_at: z.number().int().min(0),
  end_at: z.number().int().min(0),
  reason: z.string().optional(),
});
const blockTimeRangeOutput = z.object({
  calendar_id: z.string(),
  name: z.string(),
  id: z.string(),
  start_at: z.number(),
  end_at: z.number(),
  reason: z.string().nullable(),
});
type BlockTimeRangeOutput = z.infer<typeof blockTimeRangeOutput>;

const blockTimeRange: ActionDef<z.infer<typeof blockTimeRangeInput>, BlockTimeRangeOutput> = {
  id: 'M22.A05',
  slug: 'availability.block_time_range',
  module: MODULE,
  name: 'Block time range',
  description: 'Block a specific time range on a calendar so it is excluded from available slots.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: blockTimeRangeInput,
  outputSchema: blockTimeRangeOutput,
  searchCard: {
    synonyms: ['block out time', 'add time block'],
    examplePhrasings: ["Block out this host's calendar tomorrow afternoon"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    if (input.end_at <= input.start_at) {
      throw new ActionError('VALIDATION', 'A time block must have `end_at` after `start_at`.');
    }
    const config = readCalendarConfig(row);
    const blockId = nextBlockId(config.availability.blocks);
    const block: TimeBlock = { id: blockId, start_at: input.start_at, end_at: input.end_at, reason: input.reason ?? null };
    writeCalendarConfig(
      ctx.db,
      input.calendar_id,
      { ...config, availability: { ...config.availability, blocks: [...config.availability.blocks, block] } },
      ctx.clock.now(),
    );
    return { calendar_id: input.calendar_id, name: row['name'] as string, ...block };
  }),
};

// --- A06 remove_time_block -----------------------------------------------

const removeTimeBlockInput = z.strictObject({ calendar_id: z.string(), block_id: z.string() });
const removeTimeBlockOutput = z.object({ calendar_id: z.string(), name: z.string(), block_id: z.string(), removed: z.literal(true) });

const removeTimeBlock: ActionDef<z.infer<typeof removeTimeBlockInput>, z.infer<typeof removeTimeBlockOutput>> = {
  id: 'M22.A06',
  slug: 'availability.remove_time_block',
  module: MODULE,
  name: 'Remove time block',
  description: 'Remove a previously-blocked time range from a calendar.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: removeTimeBlockInput,
  outputSchema: removeTimeBlockOutput,
  searchCard: {
    synonyms: ['unblock time', 'remove time block'],
    examplePhrasings: ['Remove that block from this calendar'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    const config = readCalendarConfig(row);
    if (!config.availability.blocks.some((b) => b.id === input.block_id)) {
      throw new ActionError('NOT_FOUND', `Calendar '${input.calendar_id}' has no time block '${input.block_id}'.`);
    }
    const blocks = config.availability.blocks.filter((b) => b.id !== input.block_id);
    writeCalendarConfig(
      ctx.db,
      input.calendar_id,
      { ...config, availability: { ...config.availability, blocks } },
      ctx.clock.now(),
    );
    return { calendar_id: input.calendar_id, name: row['name'] as string, block_id: input.block_id, removed: true as const };
  }),
};

// --- A07 set_minimum_booking_notice -----------------------------------------------

const setMinimumBookingNoticeInput = z.strictObject({ calendar_id: z.string(), minutes: z.number().int().min(0) });
const minimumNoticeOutput = z.object({ calendar_id: z.string(), name: z.string(), minimum_notice_minutes: z.number() });

const setMinimumBookingNotice: ActionDef<z.infer<typeof setMinimumBookingNoticeInput>, z.infer<typeof minimumNoticeOutput>> = {
  id: 'M22.A07',
  slug: 'availability.set_minimum_booking_notice',
  module: MODULE,
  name: 'Set minimum booking notice',
  description: 'Set the minimum lead time (minutes) required before a new booking.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setMinimumBookingNoticeInput,
  outputSchema: minimumNoticeOutput,
  searchCard: {
    synonyms: ['set booking notice', 'minimum lead time'],
    examplePhrasings: ['Require at least 2 hours notice before booking this calendar'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    const config = readCalendarConfig(row);
    writeCalendarConfig(
      ctx.db,
      input.calendar_id,
      { ...config, availability: { ...config.availability, minimum_notice_minutes: input.minutes } },
      ctx.clock.now(),
    );
    return { calendar_id: input.calendar_id, name: row['name'] as string, minimum_notice_minutes: input.minutes };
  }),
};

// --- A08 set_maximum_booking_horizon -----------------------------------------------

const setMaximumBookingHorizonInput = z.strictObject({ calendar_id: z.string(), days: z.number().int().min(1) });
const maximumHorizonOutput = z.object({ calendar_id: z.string(), name: z.string(), maximum_horizon_days: z.number() });

const setMaximumBookingHorizon: ActionDef<z.infer<typeof setMaximumBookingHorizonInput>, z.infer<typeof maximumHorizonOutput>> = {
  id: 'M22.A08',
  slug: 'availability.set_maximum_booking_horizon',
  module: MODULE,
  name: 'Set maximum booking horizon',
  description: 'Set how many days into the future a calendar can be booked.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setMaximumBookingHorizonInput,
  outputSchema: maximumHorizonOutput,
  searchCard: {
    synonyms: ['set booking horizon', 'how far out can people book'],
    examplePhrasings: ['Only allow booking this calendar up to 30 days out'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    const config = readCalendarConfig(row);
    writeCalendarConfig(
      ctx.db,
      input.calendar_id,
      { ...config, availability: { ...config.availability, maximum_horizon_days: input.days } },
      ctx.clock.now(),
    );
    return { calendar_id: input.calendar_id, name: row['name'] as string, maximum_horizon_days: input.days };
  }),
};

// --- A09 find_available_slots -----------------------------------------------

const findAvailableSlotsInput = z.strictObject({
  calendar_id: z.string(),
  range_start_at: z.number().int().min(0),
  range_end_at: z.number().int().min(0),
  duration_minutes: z.number().int().min(5).max(480).optional(),
});
const slotSchema = z.object({ start_at: z.number(), end_at: z.number() });
const findAvailableSlotsOutput = listOutputSchema(slotSchema);
type FindAvailableSlotsOutput = ListOrSpill<z.infer<typeof slotSchema>>;

const findAvailableSlots: ActionDef<z.infer<typeof findAvailableSlotsInput>, FindAvailableSlotsOutput> = {
  id: 'M22.A09',
  slug: 'availability.find_available_slots',
  module: MODULE,
  name: 'Find available slots',
  description:
    'Compute real open booking slots for a calendar in a time range: weekly hours minus blocks minus booked appointments.',
  risk: 'read',
  entities: ['structures', 'appointments'],
  inputSchema: findAvailableSlotsInput,
  outputSchema: findAvailableSlotsOutput,
  searchCard: {
    synonyms: ['open slots', 'available times'],
    examplePhrasings: ['When is this calendar free next week?'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Narrow the range if you need a specific day.',
  handler: async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    if (input.range_end_at < input.range_start_at) {
      throw new ActionError('VALIDATION', '`range_end_at` must not be before `range_start_at`.');
    }
    const config = readCalendarConfig(row);
    const duration = input.duration_minutes ?? config.appointment_duration_minutes;
    const slots = computeAvailableSlots(
      ctx.db,
      input.calendar_id,
      config.availability,
      input.range_start_at,
      input.range_end_at,
      duration,
      ctx.clock.now(),
    );
    return toListOrSpill(slots.slice(0, 50), slots.length);
  },
};

// --- A10 check_scheduling_conflicts -----------------------------------------------

const checkSchedulingConflictsInput = z.strictObject({
  calendar_id: z.string(),
  start_at: z.number().int().min(0),
  end_at: z.number().int().min(0),
});
const checkSchedulingConflictsOutput = z.object({
  calendar_id: z.string(),
  name: z.string(),
  conflict: z.boolean(),
  conflicting_appointment_ids: z.array(z.string()),
  conflicting_block_ids: z.array(z.string()),
});
type CheckSchedulingConflictsOutput = z.infer<typeof checkSchedulingConflictsOutput>;

const checkSchedulingConflicts: ActionDef<
  z.infer<typeof checkSchedulingConflictsInput>,
  CheckSchedulingConflictsOutput
> = {
  id: 'M22.A10',
  slug: 'availability.check_scheduling_conflicts',
  module: MODULE,
  name: 'Check scheduling conflicts',
  description: 'Real overlap check for a time range against booked appointments and blocks on a calendar.',
  risk: 'read',
  entities: ['structures', 'appointments'],
  inputSchema: checkSchedulingConflictsInput,
  outputSchema: checkSchedulingConflictsOutput,
  searchCard: {
    synonyms: ['check for conflicts', 'is this time free'],
    examplePhrasings: ['Is this calendar free from 2 to 3pm on Thursday?'],
  },
  handler: async (input, ctx) => {
    const row = getCalendarRow(ctx.db, input.calendar_id);
    if (input.end_at < input.start_at) {
      throw new ActionError('VALIDATION', '`end_at` must not be before `start_at`.');
    }
    const config = readCalendarConfig(row);
    const result = findSchedulingConflicts(ctx.db, input.calendar_id, config.availability, input.start_at, input.end_at);
    return { calendar_id: input.calendar_id, name: row['name'] as string, ...result };
  },
};

export const m22Availability: ActionDef[] = [
  setWeeklyWorkingHours as ActionDef,
  getWeeklyWorkingHours as ActionDef,
  addDateSpecificAvailability as ActionDef,
  removeDateSpecificAvailability as ActionDef,
  blockTimeRange as ActionDef,
  removeTimeBlock as ActionDef,
  setMinimumBookingNotice as ActionDef,
  setMaximumBookingHorizon as ActionDef,
  findAvailableSlots as ActionDef,
  checkSchedulingConflicts as ActionDef,
];

/** No list/search action in this module — M20's `list_calendars` already
 * covers Tier-A coverage for the shared `structures(kind='calendar')` row. */
export const m22DiscriminationChecks: DiscriminationCheck[] = [];

/** `calendar_id` is already a `testing.ts` built-in default hint
 * (`{table:'structures', kind:'calendar'}`) — no module-declared hints needed. */
export const m22SynthHints: SynthHints = {};
