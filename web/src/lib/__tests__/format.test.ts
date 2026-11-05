import { describe, expect, it } from 'vitest';
import { formatCost, formatMs, formatTokens } from '../format.js';

describe('formatMs', () => {
  it('returns null for zero, negative, or non-finite durations (field omitted, never "0ms")', () => {
    expect(formatMs(0)).toBeNull();
    expect(formatMs(-5)).toBeNull();
    expect(formatMs(NaN)).toBeNull();
    expect(formatMs(Infinity)).toBeNull();
  });

  it('renders a real sub-millisecond duration as "<1ms", never a misleading "0ms"', () => {
    expect(formatMs(0.5)).toBe('<1ms');
    expect(formatMs(0.8965)).toBe('<1ms');
    expect(formatMs(0.001)).toBe('<1ms');
  });

  it('rounds whole-millisecond durations', () => {
    expect(formatMs(1)).toBe('1ms');
    expect(formatMs(49.6)).toBe('50ms');
    expect(formatMs(999)).toBe('999ms');
  });

  it('switches to seconds at/over 1000ms', () => {
    expect(formatMs(1000)).toBe('1.0s');
    expect(formatMs(2345)).toBe('2.3s');
  });
});

describe('formatTokens', () => {
  it('omits zero/unknown', () => {
    expect(formatTokens(0)).toBeNull();
    expect(formatTokens(NaN)).toBeNull();
  });

  it('formats small and large counts', () => {
    expect(formatTokens(512)).toBe('512 tok');
    expect(formatTokens(1500)).toBe('1.5k tok');
  });
});

describe('formatCost', () => {
  it('omits zero/unknown', () => {
    expect(formatCost(0)).toBeNull();
    expect(formatCost(NaN)).toBeNull();
  });

  it('formats a cost to four decimal places', () => {
    expect(formatCost(0.0004756)).toBe('$0.0005');
    expect(formatCost(0.022158)).toBe('$0.0222');
  });
});
