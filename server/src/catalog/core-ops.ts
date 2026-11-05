/**
 * Built-in data ops (LLD §2.2) — deterministic pseudo-actions, zero LLM,
 * risk='read'. The executor resolves every `Ref` param (`$s1.items`, …) to a
 * literal array BEFORE calling these handlers, so each handler here only
 * ever sees already-resolved arrays — never ref strings. `core.distribute`'s
 * output shape `{items: Array<{item, assignee}>}` is normative (LLD §2.2)
 * and MUST NOT be changed without a corresponding LLD update.
 */

import { z } from 'zod';
import type { ActionDef } from './types.js';

type Row = Record<string, unknown>;

const rowSchema = z.record(z.string(), z.unknown());
const rowsSchema = z.array(rowSchema);
const itemsOutput = z.object({ items: z.array(rowSchema) });

const compareOp = z.enum(['eq', 'neq', 'gt', 'lt', 'contains']);
type CompareOp = z.infer<typeof compareOp>;

// Strict ISO-8601 shape: date, optional time/zone. Deliberately narrow so a
// bare numeric-looking string ("5") or an arbitrary label ("acme") never
// parses as a date (TRIAGE C5 requires non-date strings untouched).
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** TRIAGE C5 / engine-wave E3 (date type-mismatch): an ordered comparison
 * where at least one operand is an ISO-8601 date string and the counterpart
 * is a number (epoch-ms) OR another ISO-8601 string. Coerce BOTH to epoch-ms
 * so `updated_at` (epoch-ms number) compares correctly against
 * `"2026-10-04T.."` in EITHER operand order, and so two ISO strings compare
 * chronologically (the "string-side" hole F4b hit — two ISO operands
 * previously returned `null`, silently excluding every row). Returns `null`
 * only when a NON-date operand is involved (a plain number/number pair is
 * compared directly by the caller before this is ever reached; a non-ISO
 * string stays untouched). */
function coerceDatePair(a: unknown, b: unknown): [number, number] | null {
  const asEpoch = (v: unknown): number | null => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string' || !ISO_8601_RE.test(v)) return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  };
  // Only engage when at least one side is an ISO-8601 string (otherwise a
  // plain number/number comparison the caller already handled, or an
  // incomparable pair → null).
  const aIso = typeof a === 'string' && ISO_8601_RE.test(a);
  const bIso = typeof b === 'string' && ISO_8601_RE.test(b);
  if (!aIso && !bIso) return null;
  const aMs = asEpoch(a);
  const bMs = asEpoch(b);
  return aMs === null || bMs === null ? null : [aMs, bMs];
}

function matches(row: Row, field: string, op: CompareOp, value: unknown): boolean {
  const actual = row[field];
  switch (op) {
    case 'eq':
      return actual === value;
    case 'neq':
      return actual !== value;
    case 'gt': {
      if (typeof actual === 'number' && typeof value === 'number') return actual > value;
      const pair = coerceDatePair(actual, value);
      return pair !== null && pair[0] > pair[1];
    }
    case 'lt': {
      if (typeof actual === 'number' && typeof value === 'number') return actual < value;
      const pair = coerceDatePair(actual, value);
      return pair !== null && pair[0] < pair[1];
    }
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(value);
      if (typeof actual === 'string' && typeof value === 'string') return actual.includes(value);
      return false;
    default:
      return false;
  }
}

// --- core.filter ------------------------------------------------------------

const filterInput = z.strictObject({
  in: rowsSchema,
  field: z.string(),
  op: compareOp,
  value: z.unknown(),
});
type FilterInput = z.infer<typeof filterInput>;
type ItemsOutput = z.infer<typeof itemsOutput>;

const coreFilter: ActionDef<FilterInput, ItemsOutput> = {
  id: 'core.filter',
  slug: 'core.filter',
  module: 'core',
  name: 'Filter items',
  description: 'Keep only the rows in `in` whose `field` satisfies `op value`.',
  risk: 'read',
  entities: [],
  inputSchema: filterInput,
  outputSchema: itemsOutput,
  searchCard: { synonyms: ['filter', 'keep where'], examplePhrasings: [] },
  handler: async (input) => ({
    items: input.in.filter((row) => matches(row, input.field, input.op, input.value)),
  }),
};

// --- core.exclude_by ---------------------------------------------------------

const excludeByInput = z.strictObject({
  in: rowsSchema,
  field: z.string(),
  op: compareOp,
  value: z.unknown(),
});
type ExcludeByInput = z.infer<typeof excludeByInput>;

const coreExcludeBy: ActionDef<ExcludeByInput, ItemsOutput> = {
  id: 'core.exclude_by',
  slug: 'core.exclude_by',
  module: 'core',
  name: 'Exclude items by field',
  description: 'Keep only the rows in `in` whose `field` does NOT satisfy `op value`.',
  risk: 'read',
  entities: [],
  inputSchema: excludeByInput,
  outputSchema: itemsOutput,
  searchCard: { synonyms: ['exclude', 'remove where'], examplePhrasings: [] },
  handler: async (input) => ({
    items: input.in.filter((row) => !matches(row, input.field, input.op, input.value)),
  }),
};

// --- core.anti_join -----------------------------------------------------------

const antiJoinInput = z.strictObject({
  in: rowsSchema,
  key: z.string(),
  exclude: rowsSchema,
  excludeKey: z.string(),
});
type AntiJoinInput = z.infer<typeof antiJoinInput>;

const coreAntiJoin: ActionDef<AntiJoinInput, ItemsOutput> = {
  id: 'core.anti_join',
  slug: 'core.anti_join',
  module: 'core',
  name: 'Anti-join (set difference)',
  description: 'Keep only rows in `in` whose `key` value is absent from `exclude`[`excludeKey`].',
  risk: 'read',
  entities: [],
  inputSchema: antiJoinInput,
  outputSchema: itemsOutput,
  searchCard: { synonyms: ['exclude matching', 'set difference', 'not in'], examplePhrasings: [] },
  handler: async (input) => {
    const excluded = new Set(input.exclude.map((row) => row[input.excludeKey]));
    return { items: input.in.filter((row) => !excluded.has(row[input.key])) };
  },
};

// --- core.join ----------------------------------------------------------------

const joinInput = z.strictObject({
  in: rowsSchema,
  key: z.string(),
  with: rowsSchema,
  withKey: z.string(),
  as: z.string(),
});
type JoinInput = z.infer<typeof joinInput>;

const coreJoin: ActionDef<JoinInput, ItemsOutput> = {
  id: 'core.join',
  slug: 'core.join',
  module: 'core',
  name: 'Join (enrich)',
  description:
    'Enrich each row in `in` with the first matching row from `with` (matched on `key`/`withKey`), nested under `as`. Unmatched rows get `as: null`.',
  risk: 'read',
  entities: [],
  inputSchema: joinInput,
  outputSchema: itemsOutput,
  searchCard: { synonyms: ['join', 'enrich', 'merge in'], examplePhrasings: [] },
  handler: async (input) => {
    const byKey = new Map<unknown, Row>();
    for (const row of input.with) {
      const k = row[input.withKey];
      if (!byKey.has(k)) byKey.set(k, row);
    }
    return {
      items: input.in.map((row) => ({ ...row, [input.as]: byKey.get(row[input.key]) ?? null })),
    };
  },
};

// --- core.pluck -----------------------------------------------------------------

const pluckInput = z.strictObject({
  in: rowsSchema,
  field: z.string(),
});
type PluckInput = z.infer<typeof pluckInput>;
const pluckOutput = z.object({ items: z.array(z.unknown()) });
type PluckOutput = z.infer<typeof pluckOutput>;

const corePluck: ActionDef<PluckInput, PluckOutput> = {
  id: 'core.pluck',
  slug: 'core.pluck',
  module: 'core',
  name: 'Pluck field',
  description: 'Extract `field` from every row in `in`, returned as a flat array.',
  risk: 'read',
  entities: [],
  inputSchema: pluckInput,
  outputSchema: pluckOutput,
  searchCard: { synonyms: ['pluck', 'extract field', 'map to field'], examplePhrasings: [] },
  handler: async (input) => ({ items: input.in.map((row) => row[input.field]) }),
};

// --- core.distribute --------------------------------------------------------------

// `items`/`across` are typed `unknown[]` (not `rowsSchema`) because `across`
// commonly resolves from a plucked ref (e.g. `$s6.items[*].id` — an array of
// plain id strings, not row objects); `items` may likewise be any JSON array.
const distributeInput = z.strictObject({
  items: z.array(z.unknown()),
  across: z.array(z.unknown()),
  strategy: z.literal('round_robin'),
});
type DistributeInput = z.infer<typeof distributeInput>;
const distributeOutput = z.object({
  items: z.array(z.object({ item: z.unknown(), assignee: z.unknown() })),
});
type DistributeOutput = z.infer<typeof distributeOutput>;

const coreDistribute: ActionDef<DistributeInput, DistributeOutput> = {
  id: 'core.distribute',
  slug: 'core.distribute',
  module: 'core',
  name: 'Distribute items round-robin',
  description:
    'Assign every entry in `items` to an entry in `across`, cycling round-robin. Output shape `{items:[{item,assignee}]}` is normative.',
  risk: 'read',
  entities: [],
  inputSchema: distributeInput,
  outputSchema: distributeOutput,
  searchCard: { synonyms: ['round robin', 'distribute', 'assign evenly'], examplePhrasings: [] },
  handler: async (input) => {
    if (input.across.length === 0) {
      return { items: [] };
    }
    return {
      items: input.items.map((item, i) => ({
        item,
        assignee: input.across[i % input.across.length],
      })),
    };
  },
};

/** All built-in data ops, registered as pseudo-ActionDefs alongside the catalog. */
export const coreOps: ActionDef[] = [
  coreFilter as ActionDef,
  coreExcludeBy as ActionDef,
  coreAntiJoin as ActionDef,
  coreJoin as ActionDef,
  corePluck as ActionDef,
  coreDistribute as ActionDef,
];
