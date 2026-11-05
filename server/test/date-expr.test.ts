import { describe, it, expect } from 'vitest';
import { resolveRelativeDate, DATE_FIELD_RE } from '../src/agent/date-expr';

// A fixed, deliberately mid-week/mid-month/mid-quarter "now" so every period
// boundary below is a genuine computation, not a coincidental no-op:
// 2026-11-18T15:00:00Z is a Wednesday, in November (Q4), in 2026.
const NOW_MS = Date.UTC(2026, 10, 18, 15, 0, 0);

describe('date-expr — resolveRelativeDate (Fix 3)', () => {
  it('@now resolves to the pinned now, unchanged', () => {
    expect(resolveRelativeDate('@now', NOW_MS)).toBe(NOW_MS);
  });

  it('@today resolves to midnight UTC of the pinned now', () => {
    expect(resolveRelativeDate('@today', NOW_MS)).toBe(Date.UTC(2026, 10, 18));
  });

  it('@start_of_week / @end_of_week are Monday-start (UTC)', () => {
    expect(resolveRelativeDate('@start_of_week', NOW_MS)).toBe(Date.UTC(2026, 10, 16)); // Monday Nov 16
    expect(resolveRelativeDate('@end_of_week', NOW_MS)).toBe(Date.UTC(2026, 10, 23) - 1); // just before next Monday
  });

  it('@start_of_month / @end_of_month', () => {
    expect(resolveRelativeDate('@start_of_month', NOW_MS)).toBe(Date.UTC(2026, 10, 1));
    expect(resolveRelativeDate('@end_of_month', NOW_MS)).toBe(Date.UTC(2026, 11, 1) - 1);
  });

  it('@start_of_quarter / @end_of_quarter (Nov is in Q4: Oct-Dec)', () => {
    expect(resolveRelativeDate('@start_of_quarter', NOW_MS)).toBe(Date.UTC(2026, 9, 1));
    expect(resolveRelativeDate('@end_of_quarter', NOW_MS)).toBe(Date.UTC(2027, 0, 1) - 1);
  });

  it('@start_of_year / @end_of_year', () => {
    expect(resolveRelativeDate('@start_of_year', NOW_MS)).toBe(Date.UTC(2026, 0, 1));
    expect(resolveRelativeDate('@end_of_year', NOW_MS)).toBe(Date.UTC(2027, 0, 1) - 1);
  });

  it('@now±<N><unit> offsets for every unit (m/h/d/w)', () => {
    expect(resolveRelativeDate('@now-7d', NOW_MS)).toBe(NOW_MS - 7 * 24 * 60 * 60 * 1000);
    expect(resolveRelativeDate('@now+3h', NOW_MS)).toBe(NOW_MS + 3 * 60 * 60 * 1000);
    expect(resolveRelativeDate('@now-30m', NOW_MS)).toBe(NOW_MS - 30 * 60 * 1000);
    expect(resolveRelativeDate('@now+2w', NOW_MS)).toBe(NOW_MS + 2 * 7 * 24 * 60 * 60 * 1000);
  });

  it('a quarter boundary resolves correctly for EVERY quarter, not just Q4', () => {
    // Q1 (Jan-Mar), from a February "now".
    const feb = Date.UTC(2026, 1, 10);
    expect(resolveRelativeDate('@start_of_quarter', feb)).toBe(Date.UTC(2026, 0, 1));
    expect(resolveRelativeDate('@end_of_quarter', feb)).toBe(Date.UTC(2026, 3, 1) - 1);
    // Q3 (Jul-Sep), from an August "now".
    const aug = Date.UTC(2026, 7, 10);
    expect(resolveRelativeDate('@start_of_quarter', aug)).toBe(Date.UTC(2026, 6, 1));
    expect(resolveRelativeDate('@end_of_quarter', aug)).toBe(Date.UTC(2026, 9, 1) - 1);
  });

  it('returns null for anything that is not a recognized expression — never throws', () => {
    expect(resolveRelativeDate('2026-11-30', NOW_MS)).toBeNull(); // a real ISO date, not an @expr
    expect(resolveRelativeDate('@bogus', NOW_MS)).toBeNull();
    expect(resolveRelativeDate('@now-7x', NOW_MS)).toBeNull(); // unknown unit
    expect(resolveRelativeDate('@start_of_decade', NOW_MS)).toBeNull(); // unknown period
    expect(resolveRelativeDate('', NOW_MS)).toBeNull();
    expect(() => resolveRelativeDate('$s1.created_at', NOW_MS)).not.toThrow();
    expect(resolveRelativeDate('$s1.created_at', NOW_MS)).toBeNull(); // a ref, not an @expr
  });

  it('DATE_FIELD_RE matches the catalog timestamp-suffix convention', () => {
    for (const name of ['created_at', 'valid_until', 'issued_after', 'due_date', 'starts_from', 'ends_before']) {
      expect(DATE_FIELD_RE.test(name)).toBe(true);
    }
    for (const name of ['name', 'total_cents', 'status', 'quantity']) {
      expect(DATE_FIELD_RE.test(name)).toBe(false);
    }
  });
});
