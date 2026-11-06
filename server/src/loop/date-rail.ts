/**
 * Deterministic date rail for the tool loop (plan rev 3, Task 2).
 *
 * The model writes ISO-8601 strings or `@`-relative expressions
 * (`agent/date-expr.ts` grammar) for date-shaped params; THIS module — not
 * the model — turns them into epoch ms, and reports what it resolved so
 * the tool result can echo the absolute range back (research consensus:
 * echo lets the model confirm the range to the user instead of
 * re-deriving it).
 */

import { z } from 'zod';
import { DATE_FIELD_RE, resolveRelativeDate } from '../agent/date-expr.js';

const DAY_MS = 24 * 3600 * 1000;

function dayStartUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface CoercedParams {
  params: Record<string, unknown>;
  /** One line per coercion, e.g. `created_after: '@today' → 2026-11-04T00:00:00.000Z`. */
  resolved: string[];
}

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** 'friday' / 'next friday' / 'this friday' → day-start UTC of the NEXT
 * occurrence strictly after today (round-6 support N5: the model mapped
 * "due friday" to Sunday by itself — weekday words now resolve server-side). */
function resolveWeekday(expr: string, nowMs: number): number | null {
  const m = /^(?:next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.exec(expr.trim());
  if (!m) return null;
  const target = WEEKDAY_INDEX[(m[1] as string).toLowerCase()] as number;
  const todayStart = dayStartUtc(nowMs);
  const todayDow = new Date(todayStart).getUTCDay();
  const delta = ((target - todayDow + 7) % 7) || 7;
  return todayStart + delta * DAY_MS;
}

function coerceValue(key: string, value: string, nowMs: number, resolved: string[]): unknown {
  const weekday = resolveWeekday(value, nowMs);
  if (weekday !== null) {
    resolved.push(`${key}: '${value}' → ${new Date(weekday).toISOString()}`);
    return weekday;
  }
  const relative = resolveRelativeDate(value, nowMs);
  if (relative !== null) {
    resolved.push(`${key}: '${value}' → ${new Date(relative).toISOString()}`);
    return relative;
  }
  // Strict ISO-8601 only — Date.parse alone accepts junk like '2026' or
  // bare month names; require a full date prefix.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      resolved.push(`${key}: '${value}' → ${new Date(ms).toISOString()}`);
      return ms;
    }
  }
  return value;
}

function walk(value: unknown, keyOfParent: string | undefined, nowMs: number, resolved: string[]): unknown {
  if (Array.isArray(value)) {
    // String ELEMENTS of an array under a date-shaped key are dates too
    // (review I5): `reminder_at: ['2026-11-04T00:00:00Z', '@today']`.
    return value.map((v) =>
      typeof v === 'string' && keyOfParent !== undefined && DATE_FIELD_RE.test(keyOfParent)
        ? coerceValue(keyOfParent, v, nowMs, resolved)
        : walk(v, keyOfParent, nowMs, resolved),
    );
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && DATE_FIELD_RE.test(k)) {
        out[k] = coerceValue(k, v, nowMs, resolved);
      } else {
        out[k] = walk(v, k, nowMs, resolved);
      }
    }
    return out;
  }
  return value;
}

/** Returns a NEW params object with date-shaped string values resolved to
 * epoch ms; numbers and everything else pass through untouched. */
export function coerceDateParams(params: Record<string, unknown>, nowMs: number): CoercedParams {
  const resolved: string[] = [];
  const out = walk(params, undefined, nowMs, resolved) as Record<string, unknown>;
  return { params: out, resolved };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One line per anchor, injected into every loop user prompt so the model
 * never does calendar arithmetic itself. */
export function buildDateAnchors(nowMs: number): string {
  const now = new Date(nowMs);
  const todayStart = dayStartUtc(nowMs);
  const todayEnd = todayStart + DAY_MS - 1;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1;
  const weekdayLines: string[] = [];
  for (let offset = 1; offset <= 7; offset += 1) {
    const dayMs = todayStart + offset * DAY_MS;
    const name = WEEKDAYS[new Date(dayMs).getUTCDay()] as string;
    weekdayLines.push(`next ${name.toLowerCase()} = ${isoDate(dayMs)}`);
  }
  const lines = [
    `now = ${now.toISOString()} (${WEEKDAYS[now.getUTCDay()]})`,
    `today = ${isoDate(todayStart)}, from ${new Date(todayStart).toISOString()} to ${new Date(todayEnd).toISOString()}`,
    `tomorrow = ${isoDate(todayStart + DAY_MS)}`,
    `this month = ${new Date(monthStart).toISOString()} to ${new Date(monthEnd).toISOString()}`,
    `7 days ago = ${isoDate(todayStart - 7 * DAY_MS)}`,
    ...weekdayLines,
  ];
  return lines.join('\n');
}

/** Copy of an action's input schema whose date-shaped fields ALSO accept
 * strings (ISO/@-relative) — what the model sees as the tool's parameters.
 * Coerced params are always re-validated against the ORIGINAL schema
 * before dispatch (Task 5), so this widening never reaches a handler. */
/** Widens one field: date-shaped keys accept strings; objects/arrays/
 * optionals are recursed so NESTED date fields widen too (review I5 — a
 * nested ISO string must not be rejected by the SDK's strict validation
 * before our coercion ever runs). */
function widenField(key: string, field: z.ZodType): z.ZodType {
  // Strict mode makes every param REQUIRED on the wire; without a legal
  // null, a model facing an optional enum like priority must INVENT a value
  // (round-5 F32: priority:"low", team_id:"team_1" poisoned searches).
  // Optional fields therefore widen to nullable; execute scrubs nulls.
  // Date fields are STRINGS ONLY at the model boundary (live evidence
  // 2026-11-06: the model wrote start_after=1730688000000, an epoch for
  // 2024, sailing past the string-coercion rail; same policy as the
  // plan-DSL validator's literal-epoch rejection). Coercion turns the
  // strings into epoch ms before the ORIGINAL schema validates.
  if (DATE_FIELD_RE.test(key)) {
    const stringOnly = z.union([z.string(), z.array(z.string())]);
    return field instanceof z.ZodOptional || field instanceof z.ZodNullable ? stringOnly.optional() : stringOnly;
  }
  if (field instanceof z.ZodOptional) return widenField(key, (field.def as { innerType: z.ZodType }).innerType).nullable().optional();
  if (field instanceof z.ZodNullable) return widenField(key, (field.def as { innerType: z.ZodType }).innerType).nullable();
  if (field instanceof z.ZodDefault) return field; // default wrapper: leave as-is (rare in params)
  if (field instanceof z.ZodObject) return widenDateFields(field as z.ZodObject<z.ZodRawShape>);
  if (field instanceof z.ZodArray) {
    const element = (field.def as { element: z.ZodType }).element;
    if (element instanceof z.ZodObject) return z.array(widenDateFields(element as z.ZodObject<z.ZodRawShape>));
    return field;
  }
  return field;
}

/** Model-facing widening: date fields string-only, optionals nullable,
 * nested objects/arrays recursed. (Alias kept as `widenDateFields` for the
 * original date-only name.) */
export function widenForModel<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<z.ZodRawShape> {
  return widenDateFields(schema);
}

export function widenDateFields<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<z.ZodRawShape> {
  const shape = schema.shape as z.ZodRawShape;
  const widened: z.ZodRawShape = {};
  for (const [key, field] of Object.entries(shape)) {
    widened[key] = widenField(key, field as z.ZodType);
  }
  // Preserve a catchall — dropping it would silently strip unknown keys at
  // the SDK's strict validation layer before our own schema ever sees them.
  const catchall = (schema.def as { catchall?: z.ZodType }).catchall;
  const out = z.object(widened);
  return catchall ? (out.catchall(catchall) as z.ZodObject<z.ZodRawShape>) : out;
}
