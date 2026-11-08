/**
 * Pure helpers for the desktop sidebar's user preferences: its width (set by
 * dragging the right-edge handle) and collapsed state (the « / » toggle).
 * Both persist across refreshes via localStorage, guarded so a non-browser or
 * storage-denied environment degrades to the defaults instead of throwing.
 *
 * The DOM/pointer wiring lives in App.vue; this module owns only the clamp +
 * (de)serialization so it is unit-testable without a browser.
 */

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 260;

const WIDTH_KEY = 'ask-ai:sidebarWidth';
const COLLAPSED_KEY = 'ask-ai:sidebarCollapsed';

/** Clamps a candidate width to the allowed range, falling back to the default
 * for a non-finite value (e.g. a corrupted stored value or NaN from a drag). */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
    return clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function writeSidebarWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    /* storage unavailable — width just won't persist this session */
  }
}

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}
