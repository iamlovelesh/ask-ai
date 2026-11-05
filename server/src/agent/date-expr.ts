/**
 * Relative-date expression resolver (humantest round-3 Fix 3 — the
 * recurring "model computes a training-era epoch-ms literal and gets the
 * YEAR wrong" defect: coupon struct_398 valid_until=2024-11-05, two webinar
 * start times in Nov 2024, round 3). `agent/validator.ts` never lets the
 * planner compute date ARITHMETIC itself: a literal raw number in a
 * date-shaped param is rejected outright (see `DATE_FIELD_RE` below), and
 * only a strict ISO-8601 string (existing TRIAGE fix #6 / engine-wave E3
 * coercion) or one of the relative expressions resolved HERE — purely,
 * deterministically, against the pinned `VirtualClock` "now" the caller
 * supplies — is accepted in its place.
 *
 * Grammar: `@now`, `@today`, `@start_of_<week|month|quarter|year>`,
 * `@end_of_<week|month|quarter|year>`, or `@now<+|->8<N><unit>` where unit
 * is one of `m` (minutes) `h` (hours) `d` (days) `w` (weeks) — e.g.
 * `@now-7d`. Weeks are Monday-start (UTC), matching `store/clock.ts`'s
 * existing `VirtualClock#startOfWeek` convention.
 */

/** Field-name suffixes that mark a numeric param/output field as
 * date-shaped — shared by `agent/retrieval.ts`'s card-enrichment type label
 * and this file's validator-side literal-epoch guard, so both walk the
 * EXACT same classification and can never disagree about which fields are
 * "date params". */
export const DATE_FIELD_RE = /_(at|date|until|from|after|before)$/;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS, w: WEEK_MS };

const OFFSET_RE = /^@now([+-])(\d+)([mhdw])$/;
const PERIOD_RE = /^@(start|end)_of_(week|month|quarter|year)$/;

function startOfDayUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Monday-start week, matching `VirtualClock#startOfWeek`'s convention. */
function startOfWeekUtc(ms: number): number {
  const dayStart = startOfDayUtc(ms);
  const dow = new Date(dayStart).getUTCDay(); // 0=Sun..6=Sat
  const daysToSubtract = dow === 0 ? 6 : dow - 1;
  return dayStart - daysToSubtract * DAY_MS;
}

function startOfMonthUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function startOfQuarterUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
}

function startOfYearUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), 0, 1);
}

// end_of_X = the instant just before the NEXT period's start_of_X — e.g.
// end_of_month on any day in November is 23:59:59.999 Nov 30, not midnight
// Dec 1.
function endOfWeekUtc(ms: number): number {
  return startOfWeekUtc(ms) + WEEK_MS - 1;
}

function endOfMonthUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
}

function endOfQuarterUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + 3, 1) - 1;
}

function endOfYearUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear() + 1, 0, 1) - 1;
}

const PERIOD_START: Record<string, (ms: number) => number> = {
  week: startOfWeekUtc,
  month: startOfMonthUtc,
  quarter: startOfQuarterUtc,
  year: startOfYearUtc,
};

const PERIOD_END: Record<string, (ms: number) => number> = {
  week: endOfWeekUtc,
  month: endOfMonthUtc,
  quarter: endOfQuarterUtc,
  year: endOfYearUtc,
};

/**
 * Resolves a relative-date expression string to epoch-ms against the given
 * pinned `nowMs`, or `null` if `expr` doesn't match the grammar at all (the
 * caller then treats `expr` as a non-match and falls through to its own
 * literal/ISO handling). Pure, never throws.
 */
export function resolveRelativeDate(expr: string, nowMs: number): number | null {
  if (expr === '@now') return nowMs;
  if (expr === '@today') return startOfDayUtc(nowMs);

  const offset = OFFSET_RE.exec(expr);
  if (offset) {
    const sign = offset[1] === '-' ? -1 : 1;
    const n = Number(offset[2]);
    const unitMs = UNIT_MS[offset[3] as string];
    if (unitMs === undefined || !Number.isFinite(n)) return null;
    return nowMs + sign * n * unitMs;
  }

  const period = PERIOD_RE.exec(expr);
  if (period) {
    const table = period[1] === 'start' ? PERIOD_START : PERIOD_END;
    const fn = table[period[2] as string];
    return fn ? fn(nowMs) : null;
  }

  return null;
}
