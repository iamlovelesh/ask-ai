/**
 * Shared JSON column helpers (task 9+). M01 inlined these; factored out here
 * so M02-M50 don't each re-declare the same 20 lines (coding-style: many
 * small files, no duplication). Behavior is identical to M01's inline
 * versions — safe parse with an empty-shape fallback, never throws.
 */

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
