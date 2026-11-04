/**
 * Shared calendar config + real availability-computation engine, used by
 * BOTH M20 Calendars (top-level calendar settings: timezone, host, duration,
 * buffer, visibility) and M22 Availability (the `availability` sub-object:
 * weekly working hours, date-specific overrides, blocked ranges, booking
 * notice/horizon) — per `entities/model.ts#MODULE_MAP`, M22's data home IS
 * M20's own `structures(kind='calendar').config.availability`, so the two
 * modules share ONE physical row. Factoring the read/write/compute logic
 * here (instead of duplicating it in both `m20-calendars.ts` and
 * `m22-availability.ts`) keeps the two modules from drifting on the config
 * shape — the same reasoning as task-9 batch-2's `conversation-utils.ts`
 * (M11↔M12↔M13 shared-table wiring).
 *
 * DESIGN DECISION (brief says "your call, document"): time blocks
 * (`block_time_range`/`remove_time_block`) are stored INSIDE the calendar's
 * own `config.availability.blocks` array, not as separate `structures` rows.
 * A block is config for ONE calendar, not an independently addressable
 * catalog entity — keeping it inline avoids inventing an 21st
 * `STRUCTURE_KINDS` entry for something that's really just more calendar
 * config, and matches the MODULE_MAP comment's framing
 * ("structures(calendar).config.availability").
 *
 * Weekday/date arithmetic is UTC-only (no timezone-library dependency) —
 * `calendars.timezone` is stored as a label but slot computation treats all
 * times as UTC epoch ms, consistent with every other epoch-ms column in
 * `entities/model.ts`. Documented simplification, not a bug.
 */

import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { parseJsonObject } from './json.js';

export const CALENDAR_KIND = 'calendar';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const VALID_WEEKDAYS: readonly string[] = WEEKDAYS;

export interface TimeRange {
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}

export interface DateOverride {
  date: string; // 'YYYY-MM-DD'
  ranges: TimeRange[]; // empty = fully unavailable that date
}

export interface TimeBlock {
  id: string;
  start_at: number;
  end_at: number;
  reason: string | null;
}

export interface AvailabilityConfig {
  weekly_hours: Partial<Record<Weekday, TimeRange[]>>;
  date_overrides: DateOverride[];
  blocks: TimeBlock[];
  minimum_notice_minutes: number;
  maximum_horizon_days: number;
}

export interface CalendarConfig {
  timezone: string;
  host_user_id: string | null;
  appointment_duration_minutes: number;
  booking_buffer_minutes: number;
  visibility: 'public' | 'private';
  availability: AvailabilityConfig;
}

/** Mon-Fri 09:00-17:00 — used only when a calendar has NEVER had its weekly
 * hours set (freshly seeded `config` has no `availability` key at all).
 * Once `availability.set_weekly_working_hours` writes ANY value (including
 * `{}`), that stored value is used as-is with no fallback — same pattern as
 * m05-pipelines.ts's `DEFAULT_STAGES` fallback. */
export const DEFAULT_WEEKLY_HOURS: Partial<Record<Weekday, TimeRange[]>> = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
};

function readAvailability(config: Record<string, unknown>): AvailabilityConfig {
  const raw = config['availability'];
  const availability = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    weekly_hours:
      availability['weekly_hours'] && typeof availability['weekly_hours'] === 'object'
        ? (availability['weekly_hours'] as Partial<Record<Weekday, TimeRange[]>>)
        : { ...DEFAULT_WEEKLY_HOURS },
    date_overrides: Array.isArray(availability['date_overrides'])
      ? (availability['date_overrides'] as DateOverride[])
      : [],
    blocks: Array.isArray(availability['blocks']) ? (availability['blocks'] as TimeBlock[]) : [],
    minimum_notice_minutes:
      typeof availability['minimum_notice_minutes'] === 'number' ? (availability['minimum_notice_minutes'] as number) : 0,
    maximum_horizon_days:
      typeof availability['maximum_horizon_days'] === 'number' ? (availability['maximum_horizon_days'] as number) : 60,
  };
}

export function readCalendarConfig(row: Row): CalendarConfig {
  const config = parseJsonObject(row['config']);
  return {
    timezone: typeof config['timezone'] === 'string' ? (config['timezone'] as string) : 'UTC',
    host_user_id: (config['host_user_id'] as string | null | undefined) ?? null,
    appointment_duration_minutes:
      typeof config['appointment_duration_minutes'] === 'number' ? (config['appointment_duration_minutes'] as number) : 30,
    booking_buffer_minutes:
      typeof config['booking_buffer_minutes'] === 'number' ? (config['booking_buffer_minutes'] as number) : 0,
    visibility: config['visibility'] === 'private' ? 'private' : 'public',
    availability: readAvailability(config),
  };
}

export function writeCalendarConfig(db: StoreTx, id: string, config: CalendarConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

export function getCalendarRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, CALENDAR_KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Calendar '${id}' does not exist.`);
  return row;
}

/**
 * Next `blk_{n}` id for a calendar's own `config.availability.blocks` array
 * — derived from the MAX numeric suffix among the blocks CURRENTLY on the
 * calendar (same principle as `next-id.ts#nextId`'s `MAX(...)+1` over a real
 * table), NOT `blocks.length + 1`. `length`-based ids collide the moment a
 * block is removed from the middle: add A (`blk_1`) + B (`blk_2`), remove A
 * (length drops to 1), add C → `length + 1` = `blk_2`, colliding with the
 * still-live B. `remove_time_block('blk_2')` would then delete BOTH B and C
 * (the filter matches both by id), and any conflict check against B's time
 * range would silently stop firing once "B" is actually C's row. Reviewer
 * finding, task-9-b3 fix round 1 — regression test in
 * `server/test/calendar-availability.test.ts`.
 */
export function nextBlockId(blocks: readonly TimeBlock[]): string {
  let maxN = 0;
  for (const block of blocks) {
    const match = /^blk_(\d+)$/.exec(block.id);
    const n = match?.[1] ? Number(match[1]) : NaN;
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }
  return `blk_${maxN + 1}`;
}

function hhmmToMs(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match || !match[1] || !match[2]) {
    throw new ActionError('VALIDATION', `Invalid time '${hhmm}' — expected 'HH:MM'.`);
  }
  return (Number(match[1]) * 60 + Number(match[2])) * 60 * 1000;
}

export function assertValidDateString(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ActionError('VALIDATION', `Invalid date '${date}' — expected 'YYYY-MM-DD'.`);
  }
}

function dateStrOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function startOfDayUtc(epochMs: number): number {
  return Math.floor(epochMs / DAY_MS) * DAY_MS;
}

function weekdayOf(epochMs: number): Weekday {
  return WEEKDAYS[new Date(epochMs).getUTCDay()] as Weekday;
}

export interface Slot {
  start_at: number;
  end_at: number;
}

/**
 * REAL slot computation: walk every day in `[rangeStartAt, rangeEndAt)`,
 * expand that day's working-hour ranges (date override if one exists for
 * that date, else the weekly default) into `durationMinutes`-wide slots,
 * then drop any slot that overlaps a stored block OR a `status='booked'`
 * appointment on this calendar, or that violates the minimum-notice /
 * maximum-horizon bounds. No persisted slot cache — this walks the real
 * config + a real `appointments` query every call.
 */
export function computeAvailableSlots(
  db: StoreTx,
  calendarId: string,
  config: AvailabilityConfig,
  rangeStartAt: number,
  rangeEndAt: number,
  durationMinutes: number,
  now: number,
): Slot[] {
  const stepMs = durationMinutes * 60 * 1000;
  const notBeforeAt = now + config.minimum_notice_minutes * 60 * 1000;
  const notAfterAt = now + config.maximum_horizon_days * DAY_MS;

  const booked = db.all(
    `SELECT start_at, end_at FROM appointments
     WHERE calendar_id = ? AND status = 'booked' AND archived = 0
       AND start_at < ? AND end_at > ?`,
    [calendarId, rangeEndAt, rangeStartAt],
  );
  const busy: Slot[] = [
    ...booked.map((r) => ({ start_at: r['start_at'] as number, end_at: r['end_at'] as number })),
    ...config.blocks.map((b) => ({ start_at: b.start_at, end_at: b.end_at })),
  ];
  const overlapsBusy = (s: Slot): boolean => busy.some((b) => s.start_at < b.end_at && s.end_at > b.start_at);

  const slots: Slot[] = [];
  for (let dayStart = startOfDayUtc(rangeStartAt); dayStart < rangeEndAt; dayStart += DAY_MS) {
    const dateStr = dateStrOf(dayStart);
    const override = config.date_overrides.find((o) => o.date === dateStr);
    const ranges = override ? override.ranges : config.weekly_hours[weekdayOf(dayStart)] ?? [];
    for (const range of ranges) {
      const rangeStartMs = dayStart + hhmmToMs(range.start);
      const rangeEndMs = dayStart + hhmmToMs(range.end);
      for (let slotStart = rangeStartMs; slotStart + stepMs <= rangeEndMs; slotStart += stepMs) {
        const slotEnd = slotStart + stepMs;
        if (slotStart < rangeStartAt || slotEnd > rangeEndAt) continue;
        if (slotStart < notBeforeAt || slotStart > notAfterAt) continue;
        const candidate = { start_at: slotStart, end_at: slotEnd };
        if (!overlapsBusy(candidate)) slots.push(candidate);
      }
    }
  }
  return slots;
}

export interface ConflictResult {
  conflict: boolean;
  conflicting_appointment_ids: string[];
  conflicting_block_ids: string[];
}

/** REAL overlap query against `appointments` (status='booked') + the
 * calendar's own stored blocks — used by `availability.check_scheduling_conflicts`. */
export function findSchedulingConflicts(
  db: StoreTx,
  calendarId: string,
  config: AvailabilityConfig,
  startAt: number,
  endAt: number,
): ConflictResult {
  const rows = db.all(
    `SELECT id FROM appointments
     WHERE calendar_id = ? AND status = 'booked' AND archived = 0
       AND start_at < ? AND end_at > ?`,
    [calendarId, endAt, startAt],
  );
  const conflictingAppointmentIds = rows.map((r) => r['id'] as string);
  const conflictingBlockIds = config.blocks
    .filter((b) => startAt < b.end_at && endAt > b.start_at)
    .map((b) => b.id);
  return {
    conflict: conflictingAppointmentIds.length > 0 || conflictingBlockIds.length > 0,
    conflicting_appointment_ids: conflictingAppointmentIds,
    conflicting_block_ids: conflictingBlockIds,
  };
}
