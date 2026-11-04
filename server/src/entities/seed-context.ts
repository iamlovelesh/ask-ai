/**
 * Shared seeding context + low-level helpers for `seed.ts`'s generators.
 *
 * Everything here is deterministic: all "randomness" flows through the
 * supplied `Prng`, and all time flows through the supplied `VirtualClock`.
 * No wall-clock or non-seeded randomness APIs (enforced by the grep guard test).
 */

import type { StoreTx } from '../store/db.js';
import type { Prng } from '../util/prng.js';
import type { VirtualClock } from '../store/clock.js';
import { makeId } from '../util/ids.js';
import type { SeedSummary } from './seed-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeedCtx {
  db: StoreTx;
  rng: Prng;
  clock: VirtualClock;
  now: number;
  counts: SeedSummary;
  ids: Record<string, number>;
}

export function createCtx(db: StoreTx, rng: Prng, clock: VirtualClock, counts: SeedSummary): SeedCtx {
  return { db, rng, clock, now: clock.now(), counts, ids: {} };
}

/** Allocate the next `{prefix}_{n}` id for a table prefix, 1-based. */
export function nextId(ctx: SeedCtx, prefix: string): string {
  const n = (ctx.ids[prefix] ?? 0) + 1;
  ctx.ids[prefix] = n;
  return makeId(prefix, n);
}

/** Insert a row into `table`; row keys must exactly match column names. */
export function insert(ctx: SeedCtx, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map((c) => row[c] ?? null);
  ctx.db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, values);
  ctx.counts[table] = (ctx.counts[table] ?? 0) + 1;
}

/** A timestamp between `minDaysAgo` and `maxDaysAgo` days before `ctx.now`. */
export function pastTimestamp(ctx: SeedCtx, maxDaysAgo: number, minDaysAgo = 0): number {
  const minMs = minDaysAgo * DAY_MS;
  const maxMs = maxDaysAgo * DAY_MS;
  const span = Math.max(1, maxMs - minMs);
  return ctx.now - minMs - ctx.rng.int(span);
}

/** A timestamp uniformly spread across the full previous calendar week. */
export function withinLastWeek(ctx: SeedCtx): number {
  const start = ctx.clock.startOfWeek(-1);
  const end = ctx.clock.startOfWeek(0);
  return start + ctx.rng.int(end - start);
}

/** A timestamp `daysFromNow` to `daysFromNow + spanDays` in the future. */
export function futureTimestamp(ctx: SeedCtx, daysFromNow: number, spanDays: number): number {
  return ctx.now + daysFromNow * DAY_MS + ctx.rng.int(Math.max(1, spanDays * DAY_MS));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Weighted pick: `weights` must be same length as `arr`, need not sum to 1. */
export function weightedPick<T>(ctx: SeedCtx, arr: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = ctx.rng.int(Math.max(1, Math.round(total * 1000))) / 1000;
  for (let i = 0; i < arr.length; i++) {
    const w = weights[i] ?? 0;
    if (roll < w) return arr[i] as T;
    roll -= w;
  }
  return arr[arr.length - 1] as T;
}

export function chance(ctx: SeedCtx, p: number): boolean {
  return ctx.rng.chance(p);
}

export function pick<T>(ctx: SeedCtx, arr: readonly T[]): T {
  return ctx.rng.pick(arr as T[]);
}

export function maybe<T>(ctx: SeedCtx, p: number, arr: readonly T[]): T | null {
  if (arr.length === 0 || !chance(ctx, p)) return null;
  return pick(ctx, arr);
}
