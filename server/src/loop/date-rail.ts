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

export interface CoercedParams {
  params: Record<string, unknown>;
  /** One line per coercion, e.g. `created_after: '@today' → 2026-11-04T00:00:00.000Z`. */
  resolved: string[];
}

function coerceValue(key: string, value: string, nowMs: number, resolved: string[]): unknown {
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
  if (Array.isArray(value)) return value.map((v) => walk(v, keyOfParent, nowMs, resolved));
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
const DAY_MS = 24 * 3600 * 1000;

function dayStartUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

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
  const lines = [
    `now = ${now.toISOString()} (${WEEKDAYS[now.getUTCDay()]})`,
    `today = ${isoDate(todayStart)}, from ${new Date(todayStart).toISOString()} to ${new Date(todayEnd).toISOString()}`,
    `tomorrow = ${isoDate(todayStart + DAY_MS)}`,
    `this month = ${new Date(monthStart).toISOString()} to ${new Date(monthEnd).toISOString()}`,
    `7 days ago = ${isoDate(todayStart - 7 * DAY_MS)}`,
  ];
  return lines.join('\n');
}

/** Copy of an action's input schema whose date-shaped fields ALSO accept
 * strings (ISO/@-relative) — what the model sees as the tool's parameters.
 * Coerced params are always re-validated against the ORIGINAL schema
 * before dispatch (Task 5), so this widening never reaches a handler. */
export function widenDateFields<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<z.ZodRawShape> {
  const shape = schema.shape as z.ZodRawShape;
  const widened: z.ZodRawShape = {};
  for (const [key, field] of Object.entries(shape)) {
    widened[key] = DATE_FIELD_RE.test(key) ? z.union([field as z.ZodType, z.string()]) : (field as z.ZodType);
  }
  // Preserve a catchall — dropping it would silently strip unknown keys at
  // the SDK's strict validation layer before our own schema ever sees them.
  const catchall = (schema.def as { catchall?: z.ZodType }).catchall;
  const out = z.object(widened);
  return catchall ? (out.catchall(catchall) as z.ZodObject<z.ZodRawShape>) : out;
}
