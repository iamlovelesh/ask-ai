/**
 * Regression tests for `catalog/calendar-availability.ts` — the shared
 * M20 Calendars / M22 Availability engine.
 *
 * Reviewer finding (task-9-b3 fix round 1): `availability.block_time_range`
 * derived a new block's id from `config.availability.blocks.length + 1`
 * (count-based) instead of the MAX numeric suffix among EXISTING blocks
 * (`next-id.ts`'s own principle). Count-based ids collide the moment a
 * block in the middle of the array is removed: add A (`blk_1`) + B
 * (`blk_2`) → remove A (length drops to 1) → add C → `length + 1` = `blk_2`,
 * literally colliding with the still-live B. `remove_time_block('blk_2')`
 * then deletes BOTH B and C (the filter matches both by id), and a
 * conflict check against B's original time range silently stops firing
 * once "B" is actually C's row underneath. Fixed via
 * `calendar-availability.ts#nextBlockId` (MAX-based). The first `describe`
 * block below reproduces the reviewer's EXACT sequence and proves the fix.
 *
 * The second `describe` block is the reviewer's requested
 * belt-and-suspenders case: a populated calendar (real weekly hours for
 * two different weekdays + one booked appointment + one block) exercised
 * through `availability.find_available_slots` over a MULTI-DAY range,
 * asserting both the appointment and the block are excluded AND that the
 * `[range_start_at, range_end_at)` boundaries are respected on both ends.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { registry } from '../src/catalog/registry';
import { getCalendarRow, readCalendarConfig } from '../src/catalog/calendar-availability';
import type { ActionContext } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type Crm, type StoreTx } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';

const PROFILE = 'test-calendar-availability';

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

function ctx(db: StoreTx, key = `k-${Math.random()}`, nowMs?: number): ActionContext {
  return { db, clock: new VirtualClock(nowMs), idempotencyKey: key, format: 'concise' };
}

function def(slug: string) {
  const d = registry.get(slug);
  if (!d) throw new Error(`action '${slug}' not registered`);
  return d;
}

function insertContact(db: StoreTx, id: string): void {
  db.run(`INSERT INTO contacts (id, created_at, updated_at, archived, name) VALUES (?, 1, 1, 0, ?)`, [
    id,
    id,
  ]);
}

function insertUser(db: StoreTx, id: string): void {
  db.run(`INSERT INTO users (id, created_at, updated_at, archived, name) VALUES (?, 1, 1, 0, ?)`, [id, id]);
}

async function createCalendar(db: StoreTx): Promise<string> {
  const out = (await def('calendars.create_calendar').handler({ name: 'Test Calendar' }, ctx(db))) as {
    id: string;
  };
  return out.id;
}

let crm: Crm;

beforeEach(() => {
  cleanup();
  crm = openCrm(PROFILE);
});

afterAll(() => {
  closeRegistered(PROFILE);
  cleanup();
});

describe('availability.block_time_range — next block id (reviewer repro)', () => {
  it('add A, add B, remove A, add C: C does NOT collide with B, and removing B removes ONLY B', async () => {
    const calendarId = await crm.tx((db) => createCalendar(db));

    const blockA = (await crm.tx((db) =>
      def('availability.block_time_range').handler(
        { calendar_id: calendarId, start_at: 1_000, end_at: 2_000, reason: 'A' },
        ctx(db),
      ),
    )) as { id: string };
    expect(blockA.id).toBe('blk_1');

    const blockB = (await crm.tx((db) =>
      def('availability.block_time_range').handler(
        { calendar_id: calendarId, start_at: 3_000, end_at: 4_000, reason: 'B' },
        ctx(db),
      ),
    )) as { id: string };
    expect(blockB.id).toBe('blk_2');

    await crm.tx((db) =>
      def('availability.remove_time_block').handler({ calendar_id: calendarId, block_id: blockA.id }, ctx(db)),
    );
    // Sanity: A really is gone, B is still there, before C is even added.
    const afterRemoveA = crm.tx((db) => readCalendarConfig(getCalendarRow(db, calendarId)));
    expect(afterRemoveA.availability.blocks.map((b) => b.id)).toEqual(['blk_2']);

    const blockC = (await crm.tx((db) =>
      def('availability.block_time_range').handler(
        { calendar_id: calendarId, start_at: 5_000, end_at: 6_000, reason: 'C' },
        ctx(db),
      ),
    )) as { id: string };

    // THE regression: a count-based id (`blocks.length + 1` = 1 + 1 = 2)
    // would reuse B's id here. The fix must pick blk_3 (MAX existing
    // suffix, which is B's `2`, plus 1) instead.
    expect(blockC.id).not.toBe(blockB.id);
    expect(blockC.id).toBe('blk_3');

    const afterAddC = crm.tx((db) => readCalendarConfig(getCalendarRow(db, calendarId)));
    expect(afterAddC.availability.blocks.map((b) => b.id).sort()).toEqual(['blk_2', 'blk_3']);

    // Removing B by its id must remove ONLY B — C (a different id) must survive.
    await crm.tx((db) =>
      def('availability.remove_time_block').handler({ calendar_id: calendarId, block_id: blockB.id }, ctx(db)),
    );
    const afterRemoveB = crm.tx((db) => readCalendarConfig(getCalendarRow(db, calendarId)));
    expect(afterRemoveB.availability.blocks.map((b) => b.id)).toEqual(['blk_3']);
    expect(afterRemoveB.availability.blocks[0]?.reason).toBe('C');
  });

  it('never generates an id colliding with any CURRENTLY LIVE block, across repeated middle-removal churn', async () => {
    // `nextBlockId` is MAX-based over the blocks live RIGHT NOW (same
    // "no persistent counter, derive from current rows" model as
    // `next-id.ts#nextId` over a real table) — it does NOT promise every
    // id ever generated across a calendar's full history is globally
    // unique (exactly like a real table: deleting the max-numbered row
    // frees that number for reuse). What it MUST guarantee is the
    // reviewer's actual concern: a freshly-generated id never collides
    // with a block that is still alive at the moment it's generated. This
    // test churns the array (always removing the EARLIEST surviving
    // block, never the one just added) and asserts that invariant holds
    // at every step.
    const calendarId = await crm.tx((db) => createCalendar(db));
    const live: string[] = [];

    async function addBlock(i: number): Promise<string> {
      const block = (await crm.tx((db) =>
        def('availability.block_time_range').handler(
          { calendar_id: calendarId, start_at: i * 10_000, end_at: i * 10_000 + 1_000 },
          ctx(db),
        ),
      )) as { id: string };
      expect(live).not.toContain(block.id);
      live.push(block.id);
      return block.id;
    }

    async function removeBlock(id: string): Promise<void> {
      await crm.tx((db) =>
        def('availability.remove_time_block').handler({ calendar_id: calendarId, block_id: id }, ctx(db)),
      );
      live.splice(live.indexOf(id), 1);
    }

    const a = await addBlock(0); // blk_1
    const b = await addBlock(1); // blk_2
    const c = await addBlock(2); // blk_3
    await removeBlock(b); // live: [a, c]
    const d = await addBlock(3); // must not collide with a or c
    await removeBlock(a); // live: [c, d]
    const e = await addBlock(4); // must not collide with c or d

    // Every id generated while [a,c] / [c,d] were live was distinct from
    // them at generation time (asserted inline above via `addBlock`).
    // Final sanity: the currently-live set (c, d, e) really has no
    // duplicates and really is exactly what we think it is.
    expect(new Set([c, d, e]).size).toBe(3);
    const config = crm.tx((db) => readCalendarConfig(getCalendarRow(db, calendarId)));
    expect(config.availability.blocks.map((blk) => blk.id).sort()).toEqual([c, d, e].sort());
  });
});

describe('availability.find_available_slots — populated calendar, multi-day range (belt-and-suspenders)', () => {
  // Monday 2024-01-01 / Tuesday 2024-01-02 (UTC) — both confirmed weekdays.
  const MONDAY_9AM = Date.UTC(2024, 0, 1, 9, 0, 0);
  const TUESDAY_9AM = Date.UTC(2024, 0, 2, 9, 0, 0);
  // The handler's `minimum_notice_minutes`/`maximum_horizon_days` bounds are
  // relative to `ctx.clock.now()` — pin "now" to the day BEFORE our Monday
  // fixture (not the suite-wide default pinned `VIRTUAL_NOW`, which is
  // 2026-11-04 and would put every 2024 slot "in the past" and filter it
  // out via the minimum-notice check, independent of this test's actual
  // scenario). This makes the fixture internally consistent: "today" is
  // 2023-12-31, and we're checking availability for the upcoming Mon/Tue.
  const TEST_NOW = Date.UTC(2023, 11, 31);

  it('excludes the booked appointment slot and the blocked slot; respects both range boundaries', async () => {
    const calendarId = await crm.tx((db) => createCalendar(db));
    await crm.tx((db) => insertContact(db, 'con_test_1'));
    await crm.tx((db) => insertUser(db, 'user_test_1'));

    // Real weekly hours for BOTH Monday and Tuesday, 09:00-13:00 — proves
    // the engine iterates across days, not just a single day.
    await crm.tx((db) =>
      def('availability.set_weekly_working_hours').handler(
        {
          calendar_id: calendarId,
          weekly_hours: {
            monday: [{ start: '09:00', end: '13:00' }],
            tuesday: [{ start: '09:00', end: '13:00' }],
          },
        },
        ctx(db, undefined, TEST_NOW),
      ),
    );

    // One real booked appointment on Monday 10:00-10:30.
    const mondayApptStart = Date.UTC(2024, 0, 1, 10, 0, 0);
    const mondayApptEnd = Date.UTC(2024, 0, 1, 10, 30, 0);
    await crm.tx((db) =>
      def('appointments.create_appointment').handler(
        {
          contact_id: 'con_test_1',
          calendar_id: calendarId,
          host_user_id: 'user_test_1',
          start_at: mondayApptStart,
          end_at: mondayApptEnd,
        },
        ctx(db, undefined, TEST_NOW),
      ),
    );

    // One block on Monday 11:30-12:00.
    const mondayBlockStart = Date.UTC(2024, 0, 1, 11, 30, 0);
    const mondayBlockEnd = Date.UTC(2024, 0, 1, 12, 0, 0);
    await crm.tx((db) =>
      def('availability.block_time_range').handler(
        { calendar_id: calendarId, start_at: mondayBlockStart, end_at: mondayBlockEnd, reason: 'maintenance' },
        ctx(db, undefined, TEST_NOW),
      ),
    );

    // Multi-day range: Monday 09:30 → Tuesday 12:00 (left boundary trims
    // Monday's 09:00 slot; right boundary trims Tuesday's 12:00 slot,
    // which would otherwise end at 12:30, past the range end).
    const rangeStartAt = Date.UTC(2024, 0, 1, 9, 30, 0);
    const rangeEndAt = Date.UTC(2024, 0, 2, 12, 0, 0);

    const result = (await crm.tx((db) =>
      def('availability.find_available_slots').handler(
        { calendar_id: calendarId, range_start_at: rangeStartAt, range_end_at: rangeEndAt, duration_minutes: 30 },
        ctx(db, undefined, TEST_NOW),
      ),
    )) as { items: Array<{ start_at: number; end_at: number }>; total: number };

    expect('items' in result).toBe(true);
    const starts = result.items.map((s) => s.start_at).sort((a, b) => a - b);

    // Not present: Monday 09:00 (before range_start_at — left boundary),
    // Monday 10:00 (booked appointment), Monday 11:30 (block), Tuesday
    // 12:00 (would end at 12:30, after range_end_at — right boundary).
    const mondayNine = Date.UTC(2024, 0, 1, 9, 0, 0);
    const mondayTen = mondayApptStart;
    const mondayElevenThirty = mondayBlockStart;
    const tuesdayNoon = Date.UTC(2024, 0, 2, 12, 0, 0);
    for (const excluded of [mondayNine, mondayTen, mondayElevenThirty, tuesdayNoon]) {
      expect(starts).not.toContain(excluded);
    }

    // Present: Monday 09:30 (first slot inside the left boundary), Monday
    // 10:30/11:00 (free, between the appointment and the block), Tuesday
    // 09:00 and Tuesday 11:30 (Tuesday has no busy items at all, and
    // 11:30-12:00 fits fully inside the range).
    const mondayNineThirty = Date.UTC(2024, 0, 1, 9, 30, 0);
    const mondayTenThirty = Date.UTC(2024, 0, 1, 10, 30, 0);
    const mondayEleven = Date.UTC(2024, 0, 1, 11, 0, 0);
    const tuesdayNine = TUESDAY_9AM;
    const tuesdayElevenThirty = Date.UTC(2024, 0, 2, 11, 30, 0);
    for (const present of [mondayNineThirty, mondayTenThirty, mondayEleven, tuesdayNine, tuesdayElevenThirty]) {
      expect(starts).toContain(present);
    }

    // Exact expected set: Monday {09:30,10:30,11:00,12:00,12:30} (5) +
    // Tuesday {09:00..11:30 in 30-min steps} (6, 12:00 trimmed) = 11.
    expect(result.total).toBe(11);
    expect(starts).toHaveLength(11);

    // `check_scheduling_conflicts` independently agrees on both busy spans.
    const apptConflict = (await crm.tx((db) =>
      def('availability.check_scheduling_conflicts').handler(
        { calendar_id: calendarId, start_at: mondayApptStart, end_at: mondayApptEnd },
        ctx(db, undefined, TEST_NOW),
      ),
    )) as { conflict: boolean; conflicting_appointment_ids: string[] };
    expect(apptConflict.conflict).toBe(true);
    expect(apptConflict.conflicting_appointment_ids).toHaveLength(1);

    const blockConflict = (await crm.tx((db) =>
      def('availability.check_scheduling_conflicts').handler(
        { calendar_id: calendarId, start_at: mondayBlockStart, end_at: mondayBlockEnd },
        ctx(db, undefined, TEST_NOW),
      ),
    )) as { conflict: boolean; conflicting_block_ids: string[] };
    expect(blockConflict.conflict).toBe(true);
    expect(blockConflict.conflicting_block_ids).toHaveLength(1);

    // A genuinely free span (Monday 09:30-10:00) has no conflicts at all.
    const freeConflict = (await crm.tx((db) =>
      def('availability.check_scheduling_conflicts').handler(
        {
          calendar_id: calendarId,
          start_at: MONDAY_9AM + 30 * 60 * 1000,
          end_at: MONDAY_9AM + 60 * 60 * 1000,
        },
        ctx(db, undefined, TEST_NOW),
      ),
    )) as { conflict: boolean };
    expect(freeConflict.conflict).toBe(false);
  });
});
