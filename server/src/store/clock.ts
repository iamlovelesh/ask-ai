const VIRTUAL_NOW = process.env.VIRTUAL_NOW || '2026-11-04T10:00:00Z';
const PINNED_TIME_MS = new Date(VIRTUAL_NOW).getTime();

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
    this.timeMs = timeMs ?? PINNED_TIME_MS;
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
