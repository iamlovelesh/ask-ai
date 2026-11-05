import { describe, expect, it } from 'vitest';
import { relativeTime } from '../relative-time.js';

const NOW = new Date('2026-11-05T12:00:00Z').getTime();

describe('relativeTime', () => {
  it('renders "just now" for under a minute', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
  });

  it('renders minutes-ago under an hour', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });

  it('renders hours-ago under 24h', () => {
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
  });

  it('falls back to an absolute date at/after 24h', () => {
    const epoch = NOW - 25 * 3_600_000;
    expect(relativeTime(epoch, NOW)).toBe(
      new Date(epoch).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    );
  });

  it('falls back to an absolute date for a future timestamp (never a negative "ago")', () => {
    const epoch = NOW + 3_600_000;
    expect(relativeTime(epoch, NOW)).toBe(
      new Date(epoch).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    );
  });
});
