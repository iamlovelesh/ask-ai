import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  readSidebarCollapsed,
  readSidebarWidth,
  writeSidebarCollapsed,
  writeSidebarWidth,
} from '../sidebar-prefs.js';

describe('clampSidebarWidth', () => {
  it('clamps below the minimum and above the maximum', () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('keeps an in-range value (rounded)', () => {
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('falls back to the default for a non-finite value', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('sidebar prefs persistence', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips a clamped width', () => {
    writeSidebarWidth(9999);
    expect(readSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('defaults the width when nothing is stored', () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('round-trips the collapsed flag', () => {
    expect(readSidebarCollapsed()).toBe(false);
    writeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);
    writeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('degrades to defaults when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(readSidebarCollapsed()).toBe(false);
    expect(() => writeSidebarWidth(300)).not.toThrow();
    expect(() => writeSidebarCollapsed(true)).not.toThrow();
  });
});
