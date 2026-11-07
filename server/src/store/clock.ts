// When `VIRTUAL_NOW` is set, the agent clock is PINNED to it — deterministic
// demos, evals (eval/runner-process.ts sets its own pin), and the test suite
// (pinned via vitest.config.ts) all rely on this. When it is unset, the clock
// tracks REAL wall-clock time (captured per `VirtualClock` construction) so the
// running server reports the actual current date instead of a stale anchor.
const PINNED_ISO = process.env.VIRTUAL_NOW;
const PINNED_TIME_MS = PINNED_ISO ? new Date(PINNED_ISO).getTime() : null;

/** Real wall-clock time, in ms. The ONLY sanctioned caller of `Date.now()`
 * besides this module's VirtualClock. Use for genuine real-time bookkeeping
 * (session created_at/updated_at for the sidebar) — never for anything the
 * agent reasons about, which must stay on the pinned VirtualClock. */
export function wallClockNow(): number {
  return Date.now();
}

export class VirtualClock {
  private timeMs: number;

  constructor(timeMs?: number) {
    this.timeMs = timeMs ?? PINNED_TIME_MS ?? Date.now();
  }

  now(): number {
    return this.timeMs;
  }

  iso(): string {
    return new Date(this.timeMs).toISOString();
  }

  startOfWeek(offsetWeeks?: number): number {
    const offset = offsetWeeks ?? 0;
    const currentDate = new Date(this.timeMs);

    // Get the current day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
    const dayOfWeek = currentDate.getUTCDay();

    // Calculate days to subtract to get to Monday (1)
    // If Monday (1), subtract 0 days
    // If Tuesday (2), subtract 1 day
    // If Wednesday (3), subtract 2 days
    // ... If Sunday (0), subtract 6 days
    const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    // Create a new date at the start of the current week
    const weekStart = new Date(currentDate);
    weekStart.setUTCDate(weekStart.getUTCDate() - daysToSubtract);
    weekStart.setUTCHours(0, 0, 0, 0);

    // Apply offset in weeks
    weekStart.setUTCDate(weekStart.getUTCDate() + offset * 7);

    return weekStart.getTime();
  }

  daysAgo(n: number): number {
    return this.timeMs - n * 24 * 60 * 60 * 1000;
  }
}
