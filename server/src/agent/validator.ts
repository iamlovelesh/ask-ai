/**
 * Plan validator (LLD §2.2 ref grammar, §5.1 budgets). Runs AFTER an LLM
 * emits a `PlanOutcome` (already Zod-parsed by `generateObject`/
 * `planOutcomeSchema`) and BEFORE the executor ever sees it. Every check
 * here is a defensive re-check of a model-authored structure — nothing in
 * this file throws on bad input; unknown/malformed plans always come back
 * as `{ok:false, errors}` so the pipeline can repair-prompt and retry
 * (LLD Review Focus 3: "unknown slug → repairable error, NEVER throws").
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Registry } from '../catalog/registry.js';
import { ENTITY_MODEL } from '../entities/model.js';
import { VirtualClock } from '../store/clock.js';
import { DATE_FIELD_RE, resolveRelativeDate } from './date-expr.js';
import {
  planOutcomeSchema,
  toWirePlan,
  type PlanOutcome,
  type Plan,
  type Step,
} from './plan-schema.js';

// --- public result types ----------------------------------------------------

export type ValidationErrorCode =
  | 'SCHEMA'
  | 'UNKNOWN_SLUG'
  | 'UNKNOWN_PARAM'
  | 'PARAM_SCHEMA'
  | 'ID_NOT_RESOLVED'
  | 'ID_NOT_PROVENANCED'
  | 'DATE_EPOCH_LITERAL'
  | 'PLAN_MINIMALITY'
  | 'FIELD_NOT_IN_SCHEMA'
  | 'REF_PATH_MISMATCH'
  | 'REF_GRAMMAR'
  | 'ITEM_OUTSIDE_FOREACH'
  | 'FOREACH_NOT_REF'
  | 'UNKNOWN_DEP'
  | 'UNKNOWN_HANDLE'
  | 'UNKNOWN_STEP_REF'
  | 'DUPLICATE_STEP_ID'
  | 'MISSING_DEPENDENCY'
  | 'CYCLE';

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  stepId?: string;
}

/** A cross-turn handle descriptor — the trimmed shape the validator needs
 * (full `RefHandle` from `agent/memory.ts` has more fields; only `ref` and
 * `entityType` matter here). */
export interface HandleRef {
  ref: string; // "r_t3_s1" — WITHOUT the leading "$"
  entityType: string;
}

export interface Valid {
  ok: true;
  outcome: PlanOutcome;
  /** Present only when `outcome.kind === 'plan'`. */
  plan?: Plan;
  planHash?: string;
  /** Topological step order (present only alongside `plan`). */
  stepOrder?: string[];
  /** Ref auto-fixes applied before this validation pass (Fix A,
   * task-refconverge) — present and possibly empty whenever
   * `outcome.kind === 'plan'`; absent otherwise. */
  autofixes?: RefAutofix[];
}

export interface Invalid {
  ok: false;
  errors: ValidationError[];
  /** The (possibly partially autofixed) plan these errors are against —
   * present whenever the outcome was `kind:'plan'`. Lets the repair prompt
   * echo progress already made instead of a stale pre-fix plan, so a fix
   * already applied here is never re-discovered (or undone) by a later
   * repair round. */
  plan?: Plan;
  autofixes?: RefAutofix[];
}

// --- budgets (LLD §5.1 — canonical; the spec defers to these) --------------

export const BUDGETS = {
  // maxLlmCallsPerTurn 6→8 and maxRepairs 2→4 (LLD §5.1 amendment per TRIAGE
  // rec #3, C3=26): the haiku repairer can't converge 3-entity plans within 2
  // attempts → hard `failed`. The per-turn call ceiling rises in lockstep so
  // the extra repair rounds (worst case: 2 search + 1 plan + 4 repair = 7,
  // leaving headroom for a joiner replan) actually have room to run.
  maxLlmCallsPerTurn: 8,
  maxRepairs: 4,
  maxReplans: 2,
  maxSearchRounds: 2,
  turnTimeoutMs: 120_000,
  confirmTargetThreshold: 50,
  // engine-wave E6 (RC5): a write APPLIED TO MORE THAN THIS MANY records
  // (forEach fan-out or a bulk array param) always confirms, even plain
  // risk:'write' actions well under the 50-row bulk threshold — a 5-ticket
  // close / N-lead reassign must not run silently.
  gateBulkWriteThreshold: 3,
  forEachHardCap: 500,
} as const;

// --- ref grammar (LLD §2.2 — "the ONLY forms; validator enforces") ---------
//
//   $s<N>[.path]        intra-plan step result
//   $r_t<T>_s<N>[.path] cross-turn handle from WorkingState
//   $item[.path]        current element — legal ONLY under forEach
//   path := field | field.path | items[*] (pluck over array)
//                       | items[K] (engine-wave E5: 0-based element index;
//                         resolves against the HYDRATED full list, so [0] is
//                         the true first element. K≥0 by grammar; out-of-range
//                         is a runtime failure, not a validation error.)

// Engine-wave E5: a path segment's bracket suffix may be `[*]` (pluck over an
// array) OR `[K]` (select element K, K a NON-NEGATIVE integer). `[-1]` and the
// like simply don't match the grammar → REF_GRAMMAR, by construction.
const PATH = '(?:\\.[A-Za-z_][A-Za-z0-9_]*(?:\\[\\*\\]|\\[\\d+\\])?)*';
const STEP_REF = new RegExp(`^\\$s(\\d+)(${PATH})$`);
const CROSS_TURN_REF = new RegExp(`^\\$(r_t\\d+_s\\d+)(${PATH})$`);
const ITEM_REF = new RegExp(`^\\$item(${PATH})$`);

export type ParsedRef =
  | { form: 'step'; stepId: string; path: string }
  | { form: 'crossTurn'; handleId: string; path: string }
  | { form: 'item'; path: string };

/** Parses a candidate ref string against the three legal grammar forms.
 * Returns `null` if `ref` is not a well-formed ref at all. */
export function parseRefGrammar(ref: string): ParsedRef | null {
  const step = STEP_REF.exec(ref);
  if (step) return { form: 'step', stepId: `s${step[1]}`, path: step[2] ?? '' };
  const crossTurn = CROSS_TURN_REF.exec(ref);
  if (crossTurn) return { form: 'crossTurn', handleId: crossTurn[1] ?? '', path: crossTurn[2] ?? '' };
  const item = ITEM_REF.exec(ref);
  if (item) return { form: 'item', path: item[1] ?? '' };
  return null;
}

/** Recursively collects every string in `value` whose ENTIRE value is a ref
 * (starts with `$`) — used for grammar-checking (REF_GRAMMAR /
 * ITEM_OUTSIDE_FOREACH / UNKNOWN_HANDLE / FOREACH_NOT_REF).
 *
 * Deliberately does NOT reach into a larger literal string that merely
 * CONTAINS a `$ref` substring (e.g. the conformance example's
 * `"title": "Follow up with $item.item.name"`) — that's template
 * interpolation the executor resolves at run time, not a ref grammar this
 * validator enforces. See `containsEmbeddedDollar` below for the (broader)
 * check used to decide whether a param is "ref-bearing" at all. */
export function collectRefStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.startsWith('$') ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectRefStrings);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectRefStrings);
  }
  return [];
}

/** Broader than `collectRefStrings`: true if `value` contains a `$`
 * ANYWHERE in any nested string (whole-value ref OR embedded template).
 * Used to decide whether a param is skipped from literal inputSchema
 * compile — a templated string is not a "literal" the way a plain string
 * is, even though its outer shape (a JSON string) looks identical. */
function containsEmbeddedDollar(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('$');
  if (Array.isArray(value)) return value.some(containsEmbeddedDollar);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsEmbeddedDollar);
  }
  return false;
}

function containsRef(value: unknown): boolean {
  return containsEmbeddedDollar(value);
}

// --- per-field schema compile (zod v4 ZodObject exposes `.shape`) ----------

interface ShapeLike {
  shape: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } }>;
}

function isObjectShape(schema: unknown): schema is ShapeLike {
  return (
    schema !== null &&
    typeof schema === 'object' &&
    'shape' in schema &&
    typeof (schema as { shape?: unknown }).shape === 'object'
  );
}

// --- id-fabrication guard (TRIAGE conditional-coupons-001) -----------------
//
// Entity ids in this CRM are minted as `<prefix>_<n>`, INCLUDING composites
// like `course_2_lsn_1`, `community_12_ch_1`, `funnel_7_step_2`, `struct_5_p1`.
// A naive `^[a-z]+_\d+$` match would FALSE-POSITIVE on every composite id, so
// instead of trying to positively match the id shape we flag only values that
// are clearly NAME-shaped: they contain whitespace, OR any uppercase letter,
// OR no digit at all. That catches "coupon 5", "Summer Sale", "premium plan",
// "Acme" while passing every real (simple or composite) lowercase id. A
// LITERAL name in an `*_id`/`id` param is almost always the planner typing in
// a value it should have RESOLVED via a search action first — repairable, not
// a crash. Refs (`$s1.items[*].id`, `$r_t3_s1`) are excluded before this runs.

/** True when a literal value is clearly a human NAME rather than an entity id
 * (whitespace, any uppercase, or no digit at all). Deliberately conservative:
 * every lowercase-with-digit id (`con_123`, `course_2_lsn_1`, `struct_5_p1`)
 * passes. */
function looksLikeName(value: string): boolean {
  if (/\s/.test(value)) return true; // "coupon 5", "premium plan"
  if (/[A-Z]/.test(value)) return true; // "Summer Sale", "SPRING20"
  if (!/\d/.test(value)) return true; // "acme", "widget" — no digit at all
  if (/^\d+$/.test(value)) return true; // "4" — a bare ordinal ("appointment 4"),
  // never a real entity id (ids always carry a lowercase prefix, e.g. 'apt_4').
  return false;
}

/** True when `key` is an entity-id param by name (`id` or `*_id`), but NOT
 * a plural id-LIST param (`*_ids`) — an array of ids is a different shape
 * handled via refs, not a single fabricated literal. */
function isIdParamName(key: string): boolean {
  return key === 'id' || (key.endsWith('_id') && key !== '_id');
}

// --- id-provenance guard (engine-wave E4, RC6a) ----------------------------
//
// Every entity id in this CRM is minted `<prefix>_<n>` (entities/model.ts's
// per-table `prefix`, the SAME spaces `catalog/next-id.ts` mints into),
// INCLUDING composites (`course_2_lsn_1`, `struct_5_p1`). The prefixes are
// enumerated PROGRAMMATICALLY from the entity model — never a hand list — so
// this stays correct as modules change. A literal that IS id-shaped (so the
// `looksLikeName` guard passes it) but was never seen — not in working
// memory, not in the user's turn text, not produced by a prior step (those
// arrive as $refs, not literals) — is a FABRICATED id (support F7:
// get_contact_details(con_1) invented for "liam volkov"). Repairable:
// "resolve it via a lookup step".

const ENTITY_ID_PREFIXES: ReadonlySet<string> = new Set(ENTITY_MODEL.map((t) => t.prefix));

/** True when `value` is shaped like a real entity id — `<prefix>_<n>…` whose
 * prefix is one the entity model actually mints. Composites (`course_2_lsn_1`)
 * match on their leading `<prefix>_<n>`. */
export function looksLikeEntityId(value: string): boolean {
  const m = /^([a-z]+)_\d/.exec(value);
  return m !== null && ENTITY_ID_PREFIXES.has(m[1] as string);
}

/** Provenance context for the E4 guard (optional — when omitted the guard is
 * skipped entirely, preserving every pre-E4 caller/test). `knownIds` = ids
 * already in working memory (entities/handles the planner legitimately saw);
 * `userText` = the raw turn text the user typed. */
export interface Provenance {
  knownIds?: ReadonlySet<string>;
  userText?: string;
}

/** A literal id is provenanced iff it appears verbatim in working memory or
 * the user's own words. (A prior step's output is referenced as a $ref, not
 * a literal, so it never reaches this check.) */
function isProvenanced(value: string, prov: Provenance | undefined): boolean {
  if (prov === undefined) return true; // no context → cannot judge → don't flag
  if (prov.knownIds?.has(value)) return true;
  if (prov.userText !== undefined && prov.userText.includes(value)) return true;
  return false;
}

/** Unwrap optional/nullable/default wrappers to the inner schema, then test
 * whether it is a PLAIN `z.string()` — the allow-list guard from the brief:
 * the id check applies ONLY when the field expects a free-form string (never
 * an enum, number, or other id-semantic schema). An enum like `discount_type`
 * is a `ZodEnum`, not a `ZodString`, so it is left untouched. */
function isPlainStringSchema(schema: unknown): boolean {
  let s = schema;
  // Bounded unwrap of optional/nullable/default wrappers.
  for (let i = 0; i < 5 && s != null; i += 1) {
    if (s instanceof z.ZodString) return true;
    if (
      (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) &&
      typeof (s as { unwrap?: () => unknown }).unwrap === 'function'
    ) {
      s = (s as { unwrap: () => unknown }).unwrap();
      continue;
    }
    break;
  }
  return false;
}

// --- ref-path vs output-schema validation (REF_PATH_MISMATCH) --------------
//
// For an intra-plan ref `$sN.<path>`, the producing step's action has a
// declared zod `outputSchema`. We STRUCTURALLY walk `<path>` over that
// schema, mirroring the EXECUTOR's `traverse`/`resolveWholeRef` semantics
// EXACTLY (`agent/executor.ts`): `$s1.id` on a list-shaped output ({items,
// total}) is invalid (`.id` is a per-row field, reached via `items[*].id`);
// `$s1.items[*].bad_field` where the item schema has no `bad_field` is
// invalid; everything non-introspectable (opaque records, `z.unknown()`,
// cross-turn/`$item` refs) is SKIPPED — never a false positive. A
// validator/executor semantic mismatch would be worse than no check, so the
// walker errs toward `skip` at every ambiguity.

interface PathTok {
  field: string;
  spread: boolean;
  /** Engine-wave E5: a non-negative element index (`items[0]`), mutually
   * exclusive with `spread`. */
  index?: number;
}

/** Same tokenizer the executor uses (`agent/executor.ts#parsePathTokens`) —
 * `.field` segments, each optionally suffixed `[*]` (array pluck) or `[K]`
 * (element index, engine-wave E5). */
function pathTokens(path: string): PathTok[] {
  const toks: PathTok[] = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)(\[\*\]|\[\d+\])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    const suffix = m[2];
    const tok: PathTok = { field: m[1] as string, spread: suffix === '[*]' };
    if (suffix !== undefined && suffix !== '[*]') tok.index = Number(suffix.slice(1, -1));
    toks.push(tok);
  }
  return toks;
}

/** Strip optional/nullable/default wrappers to the inner schema (bounded). */
function unwrapSchema(schema: unknown): unknown {
  let s = schema;
  for (let i = 0; i < 6 && s != null; i += 1) {
    if (
      (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) &&
      typeof (s as { unwrap?: () => unknown }).unwrap === 'function'
    ) {
      s = (s as { unwrap: () => unknown }).unwrap();
      continue;
    }
    break;
  }
  return s;
}

// --- ISO-date → epoch-ms param coercion (TRIAGE fix #6; engine-wave E3) -----
//
// Models compute epoch-ms from training-time intuition and get the YEAR wrong
// ("last week" → Oct 2024 instead of 2026). The planner is instructed to emit
// ISO-8601 strings for date params; here we coerce such a string to epoch-ms
// when the TARGET FIELD EXPECTS A NUMBER, so validation passes and the typed
// handler still receives the ms number it expects. Both the validator
// (literal compile below) and the executor (param resolution) call these —
// the one coercion rule lives in one place.
//
// E3 (user-flagged): the trigger is purely SCHEMA-SHAPED — a number-typed
// param receiving a strict ISO-8601 string — NOT a field-NAME regex. The
// old name allow-list (`_at`/`_date`/`valid_until`-style) let `valid_until`
// and any never-seen date field slip through uncoerced. A plain number
// ("5") or arbitrary label never matches `ISO_DATE_RE`, and a non-number
// schema is left untouched, so this stays safe without enumerating names.
//
// Fix 3 (humantest round-3 "2024 regression") extends this with a SECOND
// accepted string shape — `agent/date-expr.ts`'s relative `@now`/
// `@start_of_month`/`@now-7d`/… grammar, resolved against `nowMs` (the
// pinned `VirtualClock`'s "now", defaulted below so every pre-existing
// 2-arg caller/test keeps working unchanged) — so the model never has to
// compute a date itself; it writes either a literal ISO date or a relative
// expression and this file does the arithmetic.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function isNumberSchema(schema: unknown): boolean {
  return unwrapSchema(schema) instanceof z.ZodNumber;
}

/** If `value` is an ISO-8601 date/datetime string, or a Fix-3 relative
 * `@…` expression, and `schema` expects a number, return its epoch-ms;
 * otherwise return `value` unchanged. `nowMs` defaults to the pinned
 * `VirtualClock`'s "now" — never wall-clock — so relative expressions
 * resolve deterministically. */
export function coerceDateParamValue(
  value: unknown,
  schema: unknown,
  nowMs: number = new VirtualClock().now(),
): unknown {
  if (typeof value !== 'string') return value;
  if (!isNumberSchema(schema)) return value;
  if (ISO_DATE_RE.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : ms;
  }
  const relative = resolveRelativeDate(value, nowMs);
  return relative !== null ? relative : value;
}

/** Immutably coerce every date-named, number-typed param whose literal value
 * is an ISO-8601 string OR a Fix-3 relative `@…` expression to epoch-ms.
 * Returns the SAME object reference when nothing changed. */
export function coerceDateParams(
  params: Record<string, unknown>,
  inputSchema: unknown,
  nowMs: number = new VirtualClock().now(),
): Record<string, unknown> {
  if (!isObjectShape(inputSchema)) return params;
  const shape = inputSchema.shape;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    // E3: coerce by SCHEMA shape (number param + ISO/relative-expr string
    // value), for ANY param name — `coerceDateParamValue` is a no-op
    // unless both hold.
    if (k in shape) {
      const coerced = coerceDateParamValue(v, shape[k], nowMs);
      out[k] = coerced;
      if (coerced !== v) changed = true;
    } else {
      out[k] = v;
    }
  }
  return changed ? out : params;
}

type ObjClass =
  | { kind: 'object'; keys: Set<string>; field: (k: string) => unknown | undefined }
  | { kind: 'array' }
  | { kind: 'opaque' };

/** Detect the list-OR-spill union (`list-output.ts#listOutputSchema`) and
 * present it as a single object facade whose keys are the ones the executor
 * guarantees downstream (`items`/`total`, plus `sample` for spilled reads —
 * the executor's `spillToRef` also re-exposes `items`). Returns the inline
 * branch's item-array schema for `items`/`sample` so `items[*].field` can be
 * checked against the real row schema. */
function listUnionFacade(schema: unknown): ObjClass | undefined {
  if (!(schema instanceof z.ZodUnion)) return undefined;
  const u = schema as unknown as { def?: { options?: readonly unknown[] }; options?: readonly unknown[] };
  const options = u.def?.options ?? u.options;
  if (!Array.isArray(options)) return undefined;
  let itemsArray: unknown;
  for (const opt of options) {
    const o = unwrapSchema(opt);
    if (o instanceof z.ZodObject) {
      const shape = (o as { shape: Record<string, unknown> }).shape;
      if (shape['items'] instanceof z.ZodArray) itemsArray = shape['items'];
    }
  }
  if (itemsArray === undefined) return undefined; // not a list-shaped union
  // `sample` is treated as always-present and item-typed even though it only
  // exists on the spill branch at run time: this is fails-SAFE — a plan that
  // reads `$sN.sample[*].field` is never wrongly rejected (the executor's
  // post-spill shape also exposes `items`), and the item-field check still
  // runs against the real row schema. We never want to false-positive on a
  // ref that MIGHT be valid depending on inline-vs-spill at run time.
  const keys = new Set(['items', 'total', 'sample']);
  return {
    kind: 'object',
    keys,
    field: (k) => (k === 'items' || k === 'sample' ? itemsArray : k === 'total' ? z.number() : undefined),
  };
}

/** Classify a schema as object-like / array / opaque for one path hop. */
function classify(schema: unknown): ObjClass {
  const s = unwrapSchema(schema);
  if (s instanceof z.ZodArray) return { kind: 'array' };
  if (s instanceof z.ZodObject) {
    const shape = (s as { shape: Record<string, unknown> }).shape;
    return { kind: 'object', keys: new Set(Object.keys(shape)), field: (k) => shape[k] };
  }
  const facade = listUnionFacade(s);
  if (facade) return facade;
  return { kind: 'opaque' }; // ZodRecord, unknown, scalars, other unions, …
}

/** Array-element schema, or null when `schema` is not an introspectable
 * array (caller then SKIPs — never flags). */
function arrayElement(schema: unknown): unknown | null {
  const s = unwrapSchema(schema);
  if (s instanceof z.ZodArray) {
    return (s as { element?: unknown }).element ?? (s as { def?: { element?: unknown } }).def?.element ?? null;
  }
  const facade = listUnionFacade(s);
  if (facade && facade.kind === 'object') {
    const items = facade.field('items');
    return items !== undefined ? arrayElement(items) : null;
  }
  return null;
}

/** True when a param field expects a SCALAR string/number (after unwrapping
 * optional/nullable/default) — the only case where binding an array-valued
 * `items[*]` pluck to it is a definite shape error. Arrays, unions, enums,
 * objects, and anything non-introspectable return false (defensive skip). */
function isScalarParamSchema(schema: unknown): boolean {
  const s = unwrapSchema(schema);
  return s instanceof z.ZodString || s instanceof z.ZodNumber;
}

/** True when a whole-value ref is array-valued by construction: its path
 * carries an `[*]` pluck/spread, which the executor's `traverse` always
 * resolves to an array (`cur.map(...)`). */
function isArrayValuedPluck(ref: string): boolean {
  return parseRefGrammar(ref) !== null && ref.includes('[*]');
}

type WalkResult =
  | { kind: 'ok' }
  | { kind: 'skip' }
  | { kind: 'mismatch'; field: string; availableKeys: string[]; note?: string; idx?: number };

/** Walk `tokens` over `schema`, mirroring the executor's `traverse`:
 * `spread` tracks whether we are mapping over an array's elements (set once a
 * token carries `[*]`). Any non-introspectable hop returns `skip`. */
function walkPath(schema: unknown, tokens: readonly PathTok[], idx: number, spread: boolean): WalkResult {
  if (idx >= tokens.length) return { kind: 'ok' };
  const tok = tokens[idx] as PathTok;

  // The value we read `tok.field` off of (executor: `field(cur, f)` when not
  // spread; `cur.map(e => field(e, f))` when spread — in both cases `schema`
  // here is the schema of the thing a field is read off: the container when
  // !spread, the element when spread).
  const container = classify(schema);
  if (container.kind === 'opaque') return { kind: 'skip' };
  if (container.kind === 'array') {
    // Reading a plain field off an array value → `undefined` at run time.
    // Only confident enough to flag when NOT already spreading (a prior
    // `[*]` was expected); otherwise skip.
    if (!spread) {
      return { kind: 'mismatch', field: tok.field, availableKeys: [], note: 'array', idx };
    }
    return { kind: 'skip' };
  }
  // object-like
  if (!container.keys.has(tok.field)) {
    return { kind: 'mismatch', field: tok.field, availableKeys: [...container.keys], idx };
  }
  const child = container.field(tok.field);
  if (child === undefined) return { kind: 'skip' };

  if (tok.index !== undefined) {
    // Engine-wave E5: `[K]` selects one element — walk the element schema,
    // collapsing any spread back to a scalar. Out-of-range K is a RUNTIME
    // failure (array length is unknown at validation time), never flagged
    // here. Non-introspectable element → skip, like `[*]`.
    const elem = arrayElement(child);
    if (elem === null) return { kind: 'skip' };
    return walkPath(elem, tokens, idx + 1, false);
  }
  if (tok.spread) {
    const elem = arrayElement(child);
    if (elem === null) return { kind: 'skip' }; // `[*]` on a non-introspectable/non-array → skip
    return walkPath(elem, tokens, idx + 1, true);
  }
  return walkPath(child, tokens, idx + 1, spread);
}

// --- deterministic ref auto-correction (Fix A, task-refconverge) -----------
//
// The haiku planner converges on correct `$sN.items[*].field` paths far
// less reliably than it emits a "close but wrong" one — REF_PATH_MISMATCH/
// REF_GRAMMAR were the dominant repair-exhaustion reasons on the quick-20
// benchmark (round-2 triage). Most of those misses are a single, UNAMBIGUOUS
// mechanical slip (missing `[*]`, a redundant envelope level, a snake/camel
// field-name mismatch, a stray `[0]` index) rather than a genuine planning
// mistake. Fixing those HERE — deterministically, schema-validated, before
// any LLM repair round — saves the whole plan↔repair round-trip (cost +
// latency) and never consumes `BUDGETS.maxRepairs` (it runs inside
// `validate()`, before the repair-counting call site in `pipeline.ts` ever
// sees the plan). Every rewrite is applied ONLY when exactly one
// schema-valid candidate exists against the producing step's `outputSchema`
// (mirroring `walkPath` above exactly) — any ambiguity, or a producer whose
// output isn't introspectable, passes the ref through UNCHANGED for the
// normal validate()/LLM-repair path to catch.

export interface RefAutofix {
  stepId: string;
  context: string;
  before: string;
  after: string;
  rule: 'list-unwrap' | 'missing-pluck-star' | 'redundant-envelope' | 'field-fuzzy-match' | 'index-to-pluck';
}

function pathToString(tokens: readonly PathTok[]): string {
  return tokens
    .map((t) => `.${t.field}${t.spread ? '[*]' : t.index !== undefined ? `[${t.index}]` : ''}`)
    .join('');
}

interface PathCandidate {
  tokens: PathTok[];
  rule: RefAutofix['rule'];
}

/** Enumerates plausible structural rewrites of `tokens` — rules 1/2/3 from
 * the brief (list-unwrap / missing-pluck-star / redundant-envelope). This
 * only ENUMERATES; the caller schema-validates each candidate via
 * `walkPath` and only accepts a UNIQUE survivor. */
function structuralCandidates(tokens: readonly PathTok[]): PathCandidate[] {
  const out: PathCandidate[] = [];
  const n = tokens.length;

  // Rules 1/2 (insertion): a fresh `items[*]` hop is missing entirely —
  // insert it immediately before index `i`. Skipped when `tokens[i]` is
  // already an `items` hop (the toggle-spread loop below handles THAT case
  // without duplicating the hop).
  for (let i = 0; i <= n; i += 1) {
    if (tokens[i]?.field === 'items') continue;
    out.push({
      tokens: [...tokens.slice(0, i), { field: 'items', spread: true }, ...tokens.slice(i)],
      rule: i === 0 ? 'list-unwrap' : 'missing-pluck-star',
    });
  }

  // Rule 2 (toggle): an EXISTING `items` hop forgot its `[*]` — flip
  // `spread` on in place rather than inserting a second hop.
  for (let i = 0; i < n; i += 1) {
    const tok = tokens[i];
    if (tok !== undefined && tok.field === 'items' && !tok.spread) {
      out.push({
        tokens: tokens.map((t, j) => (j === i ? { ...t, spread: true } : t)),
        rule: 'missing-pluck-star',
      });
    }
  }

  // Rule 3 (collapse): two ADJACENT spread `items[*]` hops — a redundant
  // envelope level — collapse to one.
  for (let i = 0; i < n - 1; i += 1) {
    if (tokens[i]?.field === 'items' && tokens[i]?.spread && tokens[i + 1]?.field === 'items') {
      out.push({ tokens: [...tokens.slice(0, i), ...tokens.slice(i + 1)], rule: 'redundant-envelope' });
    }
  }

  return out;
}

/** Case/snake-camel normalization for Rule 4 (`firstName` ↔ `first_name`):
 * lowercase, strip underscores. */
function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/_/g, '');
}

/** Rule 4: the mismatched LEAF field isn't in the schema, but exactly ONE
 * schema field normalizes to the same spelling — rewrite to that field's
 * real spelling. `null` on zero or 2+ matches (brief: "never rewrite when
 * 2+ candidates"). */
function fuzzyFieldCandidate(
  tokens: readonly PathTok[],
  mismatchIdx: number,
  availableKeys: readonly string[],
): PathTok[] | null {
  const target = tokens[mismatchIdx];
  if (target === undefined) return null;
  const norm = normalizeFieldKey(target.field);
  const matches = availableKeys.filter((k) => k !== target.field && normalizeFieldKey(k) === norm);
  if (matches.length !== 1) return null;
  return tokens.map((t, j) => (j === mismatchIdx ? { ...t, field: matches[0] as string } : t));
}

/** Attempts ONE deterministic, schema-validated rewrite of `path` (the
 * portion AFTER `$sN`/`$item`) against `schema` (the producer's
 * `outputSchema`, or a forEach element schema for `$item` paths). `null`
 * when the original path already validates or is non-introspectable (never
 * guess), or when 0 or 2+ distinct candidates validate (ambiguous — defer
 * to the LLM repair path; brief rules 1-4). */
function tryAutofixRefPath(path: string, schema: unknown): { path: string; rule: RefAutofix['rule'] } | null {
  const tokens = pathTokens(path);
  if (tokens.length === 0) return null;
  const baseResult = walkPath(schema, tokens, 0, false);
  if (baseResult.kind !== 'mismatch') return null; // already ok, or opaque/skip — nothing to fix

  const candidates = new Map<string, RefAutofix['rule']>();
  for (const { tokens: candTokens, rule } of structuralCandidates(tokens)) {
    const pathStr = pathToString(candTokens);
    if (pathStr === path || candidates.has(pathStr)) continue;
    if (walkPath(schema, candTokens, 0, false).kind === 'ok') candidates.set(pathStr, rule);
  }
  if (baseResult.idx !== undefined && baseResult.availableKeys.length > 0) {
    const fuzzy = fuzzyFieldCandidate(tokens, baseResult.idx, baseResult.availableKeys);
    if (fuzzy) {
      const pathStr = pathToString(fuzzy);
      if (pathStr !== path && !candidates.has(pathStr) && walkPath(schema, fuzzy, 0, false).kind === 'ok') {
        candidates.set(pathStr, 'field-fuzzy-match');
      }
    }
  }

  if (candidates.size !== 1) return null; // none, or ambiguous
  for (const [onlyPath, onlyRule] of candidates) {
    return { path: onlyPath, rule: onlyRule };
  }
  return null; // unreachable (size === 1 guarantees one iteration) — keeps TS happy
}

// Rule 5: `$s1[0].field` / `$s1.0.field` (and the SAME shape on a
// cross-turn handle, `$r_t3_s1[0].field` / `$r_t3_s1.0.field`) — an INDEX
// selector, which is not legal ref grammar at all (STEP_REF/CROSS_TURN_REF's
// path only admits `.field[*]` hops), so it surfaces as REF_GRAMMAR, not
// REF_PATH_MISMATCH. Rewritten to `.items[*].field` ONLY when the binding
// context expects an array (brief: "if the param expects a scalar, leave
// for LLM repair — index intent is ambiguous"). Cross-turn coverage added
// per task-refconverge diagnostic iteration: a handle produced by a SPILLED
// (>50-row) search is the live-test scenario ("add a note to the first
// one") most likely to trigger this exact invented-index shape, since the
// planner has no "take element N" ref form to reach for instead.
const INDEX_GRAMMAR_RE = /^\$(s\d+|r_t\d+_s\d+)(?:\[\d+\]|\.\d+)((?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\*\])?)*)$/;

function tryAutofixIndexGrammar(
  ref: string,
  expectsArray: boolean,
  schemaForStep: (stepId: string) => unknown | undefined,
): { after: string; rule: RefAutofix['rule'] } | null {
  if (!expectsArray) return null;
  const m = INDEX_GRAMMAR_RE.exec(ref);
  if (!m) return null;
  const refId = m[1] as string; // "s1" or "r_t3_s1"
  const rest = m[2] ?? '';
  const candidatePath = `.items[*]${rest}`;
  if (refId.startsWith('s')) {
    // Intra-plan step ref — schema-validate against the producer's
    // outputSchema, exactly like every other rule.
    const schema = schemaForStep(refId);
    if (schema === undefined) return null; // unknown producer — never guess
    if (walkPath(schema, pathTokens(candidatePath), 0, false).kind !== 'ok') return null;
  }
  // Cross-turn handle ref (`r_t<T>_s<N>`): no introspectable schema exists
  // (`RefHandle` carries no zod type) — but its RESOLVED base shape is
  // ALWAYS exactly `{ids, items}` by construction (`executor.ts`'s
  // `resolveWholeRef` crossTurn branch), so `.items[*]<rest>` is
  // structurally safe for ANY handle; the walkPath schema check above is
  // simply skipped for this form (nothing to check it against), matching
  // the validator's existing documented policy of never structurally
  // checking cross-turn/`$item` paths.
  return { after: `$${refId}${candidatePath}`, rule: 'index-to-pluck' };
}

/** Rewrites a `$sN.path` ref against the producing step's output schema.
 * `schemaForStep` resolves a step id to its action's `outputSchema`
 * (`undefined` when the producer/slug can't be resolved — never guess). */
function tryAutofixStepRef(
  ref: string,
  schemaForStep: (stepId: string) => unknown | undefined,
): { after: string; rule: RefAutofix['rule'] } | null {
  const parsed = parseRefGrammar(ref);
  if (!parsed || parsed.form !== 'step' || parsed.path === '') return null;
  const schema = schemaForStep(parsed.stepId);
  if (schema === undefined) return null;
  const fix = tryAutofixRefPath(parsed.path, schema);
  if (!fix) return null;
  return { after: `$${parsed.stepId}${fix.path}`, rule: fix.rule };
}

/** Same rewrite, for a `$item.path` ref inside a forEach step, checked
 * against the forEach's iterated ELEMENT schema (brief: "apply the same
 * rewrites inside forEach $item paths against the iterated element
 * schema"). */
function tryAutofixItemRef(ref: string, elementSchema: unknown): { after: string; rule: RefAutofix['rule'] } | null {
  const parsed = parseRefGrammar(ref);
  if (!parsed || parsed.form !== 'item' || parsed.path === '') return null;
  const fix = tryAutofixRefPath(parsed.path, elementSchema);
  if (!fix) return null;
  return { after: `$item${fix.path}`, rule: fix.rule };
}

/** Best-effort schema AT a path — NOT a validity verdict, only used to find
 * the schema a forEach step's `$item` should be checked against. `undefined`
 * on anything non-introspectable, which simply disables `$item` autofix for
 * that step (never a false fix). */
function schemaAtPath(schema: unknown, tokens: readonly PathTok[]): unknown | undefined {
  let cur = schema;
  for (const tok of tokens) {
    const cls = classify(cur);
    if (cls.kind !== 'object' || !cls.keys.has(tok.field)) return undefined;
    const child = cls.field(tok.field);
    if (child === undefined) return undefined;
    if (tok.spread || tok.index !== undefined) {
      const elem = arrayElement(child);
      if (elem === null) return undefined;
      cur = elem;
    } else {
      cur = child;
    }
  }
  return cur;
}

/** Resolves the ELEMENT schema a forEach step's `$item` iterates over, from
 * the forEach ref's target path over its producing step's output schema.
 * `undefined` for anything not resolvable (cross-turn handles, unknown
 * producer, non-introspectable schema) — `$item` autofix is simply skipped. */
function resolveForEachElementSchema(
  forEachRef: string,
  schemaForStep: (stepId: string) => unknown | undefined,
): unknown | undefined {
  const parsed = parseRefGrammar(forEachRef);
  if (!parsed || parsed.form !== 'step') return undefined;
  const schema = schemaForStep(parsed.stepId);
  if (schema === undefined) return undefined;
  const valueSchema = schemaAtPath(schema, pathTokens(parsed.path));
  if (valueSchema === undefined) return undefined;
  return arrayElement(valueSchema) ?? undefined;
}

// --- core-op field validation (engine-wave E2, RC3) -----------------------
//
// A core data op names row FIELDS it reads off the list it consumes
// (core.filter/exclude_by/pluck `field` off `in`; core.anti_join `key` off
// `in` / `excludeKey` off `exclude`; core.join `key` off `in` / `withKey`
// off `with`). A field the producing step's item schema doesn't actually
// expose (amount_cents vs total_cents, start_time vs start_at, …) yields a
// silent all-null/empty result at run time — the exact silent-null class
// RC3 names. This is intrinsic to the six fixed built-in core ops (not any
// module), so the param→list-param map below is a closed, generic contract,
// not a per-module special-case. `as` (core.join) names a NEW output field,
// never checked.

const CORE_OP_FIELD_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'core.filter': { field: 'in' },
  'core.exclude_by': { field: 'in' },
  'core.pluck': { field: 'in' },
  'core.sort': { field: 'in' },
  // `right` is validated only when it's a literal field name (a numeric
  // literal is skipped by the validator's `typeof fieldVal !== 'string'`
  // guard); `as` names a NEW output field and is never checked.
  'core.compute': { left: 'in', right: 'in' },
  'core.anti_join': { key: 'in', excludeKey: 'exclude' },
  'core.join': { key: 'in', withKey: 'with' },
  'core.distribute': {},
};

/** The ELEMENT (row) schema a list-shaped ref resolves to, for the core-op
 * field check. Only intra-plan `$sN.<path>` refs against an introspectable
 * producer are resolvable; everything else (cross-turn, `$item`, a literal
 * array, an opaque/non-list producer) returns `undefined` → the caller
 * SKIPs, never a false positive (same defensive policy as `walkPath`). */
function listRefItemSchema(
  listRef: unknown,
  schemaForStep: (stepId: string) => unknown | undefined,
): unknown | undefined {
  if (typeof listRef !== 'string') return undefined;
  const parsed = parseRefGrammar(listRef);
  if (!parsed || parsed.form !== 'step') return undefined;
  const producer = schemaForStep(parsed.stepId);
  if (producer === undefined) return undefined;
  const at = schemaAtPath(producer, pathTokens(parsed.path));
  if (at === undefined) return undefined;
  // `at` may already be the element (a spread/index path) or the array.
  const elem = arrayElement(at);
  return elem ?? at;
}

/** Recursively rewrites every WHOLE-value ref string in `value` via `fn`
 * (same "entire value is a ref" scope as `collectRefStrings` — an embedded
 * template substring is the executor's job, not this one's). */
function deepRewriteRefs(value: unknown, fn: (ref: string) => string): unknown {
  if (typeof value === 'string') return value.startsWith('$') ? fn(value) : value;
  if (Array.isArray(value)) return value.map((v) => deepRewriteRefs(v, fn));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepRewriteRefs(v, fn);
    return out;
  }
  return value;
}

/**
 * Fix A (task-refconverge): deterministic, schema-validated ref
 * auto-correction — runs BEFORE any LLM repair round, inside `validate()`.
 * For every ref string in a step's params/when.ref/forEach, attempts the
 * canonical rewrites and applies the result ONLY when exactly one
 * schema-valid candidate exists; everything else (including every genuine
 * planning mistake) passes through UNCHANGED for the normal
 * validate()/repair path to catch. Returns a NEW `Plan` (steps/params are
 * never mutated in place — immutable per repo convention) plus the list of
 * fixes applied, for the caller to trace/count.
 */
export function autoFixRefs(plan: Plan, registry: Registry): { plan: Plan; autofixes: RefAutofix[] } {
  const slugByStepId = new Map(plan.steps.map((s) => [s.id, s.action] as const));
  const autofixes: RefAutofix[] = [];

  function schemaForStep(stepId: string): unknown | undefined {
    const slug = slugByStepId.get(stepId);
    if (slug === undefined) return undefined;
    return registry.get(slug)?.outputSchema;
  }

  const fixedSteps = plan.steps.map((step) => {
    const elementSchema =
      step.forEach !== undefined && step.forEach !== ''
        ? resolveForEachElementSchema(step.forEach, schemaForStep)
        : undefined;

    function fixRef(ref: string, context: string, expectsArray: boolean): string {
      const parsed = parseRefGrammar(ref);
      if (parsed?.form === 'item') {
        if (elementSchema === undefined) return ref;
        const fix = tryAutofixItemRef(ref, elementSchema);
        if (!fix) return ref;
        autofixes.push({ stepId: step.id, context, before: ref, after: fix.after, rule: fix.rule });
        return fix.after;
      }
      const indexFix = tryAutofixIndexGrammar(ref, expectsArray, schemaForStep);
      if (indexFix) {
        autofixes.push({ stepId: step.id, context, before: ref, after: indexFix.after, rule: indexFix.rule });
        return indexFix.after;
      }
      const fix = tryAutofixStepRef(ref, schemaForStep);
      if (!fix) return ref;
      autofixes.push({ stepId: step.id, context, before: ref, after: fix.after, rule: fix.rule });
      return fix.after;
    }

    const action = registry.get(step.action);
    const shape = action && isObjectShape(action.inputSchema) ? action.inputSchema.shape : undefined;

    const fixedParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step.params)) {
      const expectsArray = !(shape && key in shape && isScalarParamSchema(shape[key]));
      fixedParams[key] = deepRewriteRefs(value, (ref) => fixRef(ref, `Step '${step.id}' params.${key}`, expectsArray));
    }

    let fixedWhen = step.when;
    if (step.when && step.when.ref) {
      const newRef = fixRef(step.when.ref, `Step '${step.id}' when.ref`, false);
      if (newRef !== step.when.ref) fixedWhen = { ...step.when, ref: newRef };
    }

    let fixedForEach = step.forEach;
    if (step.forEach) {
      const newForEach = fixRef(step.forEach, `Step '${step.id}' forEach`, false);
      if (newForEach !== step.forEach) fixedForEach = newForEach;
    }

    return { ...step, params: fixedParams, when: fixedWhen, forEach: fixedForEach };
  });

  return { plan: { ...plan, steps: fixedSteps }, autofixes };
}

// --- topological sort / cycle detection -------------------------------------

function topoSort(steps: readonly Step[]): { ok: true; order: string[] } | { ok: false; cycleStepIds: string[] } {
  const ids = steps.map((s) => s.id);
  const idSet = new Set(ids);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!idSet.has(dep)) continue; // unknown dep — reported separately
      dependents.get(dep)?.push(step.id);
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    }
  }
  const queue: string[] = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    seen.add(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== ids.length) {
    const cycleStepIds = ids.filter((id) => !seen.has(id));
    return { ok: false, cycleStepIds };
  }
  return { ok: true, order };
}

/** All step ids transitively reachable from `stepId` via `dependsOn` edges
 * (direct + indirect). Safe against cycles (bounded by a visited set — a
 * cyclic graph is ALSO reported via `CYCLE` separately, so precise
 * behavior here doesn't matter for the overall `ok` verdict, only that it
 * terminates). Ignores `dependsOn` entries that aren't real step ids
 * (those are already reported via `UNKNOWN_DEP`). */
function transitiveDeps(stepId: string, dependsOnById: ReadonlyMap<string, readonly string[]>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [...(dependsOnById.get(stepId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const dep of dependsOnById.get(id) ?? []) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return visited;
}

// --- plan hash (sha256 of sorted-keys JSON) ---------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [k, v] of entries) sorted[k] = sortKeysDeep(v);
    return sorted;
  }
  return value;
}

/** sha256 of the plan serialized with keys sorted at every level — stable
 * regardless of the key order the LLM/JSON.stringify happened to emit. */
export function computePlanHash(plan: Plan): string {
  const stable = JSON.stringify(sortKeysDeep(plan));
  return createHash('sha256').update(stable).digest('hex');
}

// --- the validator -----------------------------------------------------------

/**
 * Validates a `PlanOutcome`.
 *
 * `shortlist` (the retrieval candidate set offered to the planner this
 * round) is accepted but deliberately NOT used to reject slugs: known-slug
 * checking is against the FULL catalog (`registry`), not the shortlist — a
 * model may legitimately recall an action from an earlier `search` round or
 * from `core.*` (always available, never retrieved). The param exists so
 * callers/tests have a documented place to pass it, and so a future
 * "slug outside shortlist" WARNING (not an error) has somewhere to read it
 * from without a signature change.
 *
 * `nowMs` (Fix 3) is the pinned `VirtualClock`'s "now", used ONLY to
 * resolve a relative `@…` date expression in a literal param to epoch-ms
 * for the per-field `safeParse` check below — it defaults to a fresh
 * `VirtualClock().now()` so every pre-existing 4/5-arg caller/test keeps
 * working unchanged.
 */
export function validate(
  outcome: PlanOutcome,
  shortlist: Set<string>,
  handles: readonly HandleRef[],
  registry: Registry,
  provenance?: Provenance,
  nowMs: number = new VirtualClock().now(),
): Valid | Invalid {
  void shortlist; // see doc comment above

  // Layer 0: structural re-check against the canonical schema. Catches
  // malformed `when`/`expects` shapes and anything else `plan-schema.ts`
  // already encodes, for callers that didn't construct `outcome` via
  // `generateObject` (e.g. hand-built in tests, or a repaired JSON blob).
  const structural = planOutcomeSchema.safeParse(outcome);
  if (!structural.success) {
    return {
      ok: false,
      errors: structural.error.issues.map((issue) => ({
        code: 'SCHEMA' as const,
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    };
  }
  const parsedOutcome = structural.data;

  if (parsedOutcome.kind !== 'plan') {
    // search / clarify / unsupported / respond — no further semantic checks.
    return { ok: true, outcome: parsedOutcome };
  }

  // Fix A (task-refconverge): deterministic ref auto-correction runs BEFORE
  // any other check — every check below (and the plan the executor/joiner
  // ultimately runs) sees the ALREADY-FIXED plan, never the raw one.
  const { plan: fixedPlan, autofixes } = autoFixRefs(parsedOutcome.plan, registry);
  const plan = fixedPlan;
  const errors: ValidationError[] = [];

  // 0. duplicate step ids. The executor keys results/idempotency by
  //    stepId (LLD §5.3 `idempotencyKey = turnId:planRev:stepId:itemIndex`)
  //    — a silent `Set`-dedup here would let two different steps collide
  //    on the same key downstream. Reported but non-fatal to the rest of
  //    this pass (everything below still runs; `errors.length > 0` already
  //    guarantees `ok:false`).
  const idCounts = new Map<string, number>();
  for (const s of plan.steps) idCounts.set(s.id, (idCounts.get(s.id) ?? 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({
        code: 'DUPLICATE_STEP_ID',
        stepId: id,
        message: `Step id '${id}' is used by ${count} different steps — step ids must be unique within a plan.`,
      });
    }
  }

  const stepIds = new Set(plan.steps.map((s) => s.id));
  const handleIds = new Set(handles.map((h) => h.ref));
  const dependsOnById = new Map<string, readonly string[]>(plan.steps.map((s) => [s.id, s.dependsOn]));
  const slugByStepId = new Map<string, string>(plan.steps.map((s) => [s.id, s.action]));

  /** Producer `outputSchema` by step id — for the core-op field check (E2)
   * and other schema walks. `undefined` when the slug/producer is unknown. */
  function schemaForStepId(stepId: string): unknown | undefined {
    const slug = slugByStepId.get(stepId);
    if (slug === undefined) return undefined;
    return registry.get(slug)?.outputSchema;
  }

  /** Structural `$sN.<path>` vs producing-action-outputSchema check
   * (REF_PATH_MISMATCH). Only intra-plan step refs with a non-empty path;
   * everything else (bare `$sN`, cross-turn, `$item`, unknown producer,
   * non-introspectable output) is a silent no-op — see `walkPath`. */
  function checkRefPath(ref: string, step: Step, context: string): void {
    const parsed = parseRefGrammar(ref);
    if (!parsed || parsed.form !== 'step' || parsed.path === '') return;
    const producerSlug = slugByStepId.get(parsed.stepId);
    if (producerSlug === undefined) return; // dangling step ref — reported elsewhere
    const producer = registry.get(producerSlug);
    if (!producer) return; // unknown slug — reported elsewhere
    const res = walkPath(producer.outputSchema, pathTokens(parsed.path), 0, false);
    if (res.kind !== 'mismatch') return;
    const avail =
      res.availableKeys.length > 0
        ? ` Valid top-level fields on step '${parsed.stepId}'s result: ${res.availableKeys.join(', ')}.`
        : '';
    const pluckHint =
      res.note === 'array' || res.availableKeys.includes('items')
        ? ` '${parsed.stepId}' returns a list — reference a per-row field with '$${parsed.stepId}.items[*].${res.field}', not '${ref}'.`
        : '';
    errors.push({
      code: 'REF_PATH_MISMATCH',
      stepId: step.id,
      message: `${context}: '${ref}' does not match the output of action '${producerSlug}' — '${res.field}' is not reachable on that result.${avail}${pluckHint} Corrected-ref example: "$${parsed.stepId}.items[*].id" reads the id of every row; "$${parsed.stepId}.total" reads the count.`,
    });
  }

  /** Grammar + handle + dependency-closure checks for a single ref string,
   * shared by params and `when.ref`. `reachable` = every step id this
   * `step` can see via `dependsOn` (direct or transitive) — see
   * `transitiveDeps`. */
  function checkRef(ref: string, step: Step, context: string, reachable: ReadonlySet<string>): void {
    const parsed = parseRefGrammar(ref);
    if (!parsed) {
      errors.push({
        code: 'REF_GRAMMAR',
        stepId: step.id,
        message: `${context}: '${ref}' is not a valid ref — only $sN[.path], $r_t<T>_s<N>[.path], or $item[.path] (under forEach) are legal. Corrected-ref example: "$s1.items[*].id" (per-row id from step s1) or "$r_t2_s1" (a prior-turn handle shown in the working state).`,
      });
      return;
    }
    if (parsed.form === 'item' && step.forEach === undefined) {
      errors.push({
        code: 'ITEM_OUTSIDE_FOREACH',
        stepId: step.id,
        message: `${context}: '$item' used in step '${step.id}', which has no forEach — $item is only legal inside a forEach step.`,
      });
    }
    if (parsed.form === 'crossTurn' && !handleIds.has(parsed.handleId)) {
      errors.push({
        code: 'UNKNOWN_HANDLE',
        stepId: step.id,
        message: `${context}: '${ref}' references unknown cross-turn handle '${parsed.handleId}' (not in WorkingState).`,
      });
    }
    if (parsed.form === 'step') {
      if (!stepIds.has(parsed.stepId)) {
        // CRITICAL fix: a dangling intra-plan ref (no step with this id
        // exists AT ALL) previously passed silently — `checkRef` only
        // branched on item/crossTurn forms, never checking a 'step' form
        // ref against the plan's own step ids.
        errors.push({
          code: 'UNKNOWN_STEP_REF',
          stepId: step.id,
          message: `${context}: '${ref}' references step '${parsed.stepId}', which does not exist in this plan.`,
        });
      } else if (!reachable.has(parsed.stepId)) {
        // The step exists, but this step never declared a (transitive)
        // dependency on it. Strata are scheduled from `dependsOn` alone,
        // never by ref-scanning params — so without this, the executor
        // could schedule this step before/alongside its ref target and
        // hit an unresolved-ref failure AT RUN TIME instead of here,
        // before execution ever starts.
        errors.push({
          code: 'MISSING_DEPENDENCY',
          stepId: step.id,
          message: `${context}: '${ref}' references step '${parsed.stepId}', but step '${step.id}' does not depend on '${parsed.stepId}' (directly or transitively) — add '${parsed.stepId}' to step '${step.id}'s dependsOn.`,
        });
      }
    }
  }

  for (const step of plan.steps) {
    const reachable = transitiveDeps(step.id, dependsOnById);

    // 1. unknown slug (catalog, not shortlist) — never throws, always a
    //    repairable error.
    const action = registry.get(step.action);
    if (!action) {
      errors.push({
        code: 'UNKNOWN_SLUG',
        stepId: step.id,
        message: `Step '${step.id}' references unknown action slug '${step.action}'.`,
      });
    } else {
      // 2. params compile against the action's inputSchema WHERE literal;
      //    ref-bearing params are skipped (resolved at execution time).
      const shape = isObjectShape(action.inputSchema) ? action.inputSchema.shape : undefined;
      for (const [key, value] of Object.entries(step.params)) {
        // Array-pluck bound to a scalar param: `items[*]` resolves to an
        // ARRAY, but a plain-string/number field expects ONE value — this
        // passes grammar/path checks yet fails downstream ("Unknown named
        // parameter '0'"). Flag it. Defensive-skip when the target schema is
        // opaque/array/union/enum (not an introspectable scalar).
        if (
          typeof value === 'string' &&
          isArrayValuedPluck(value) &&
          shape &&
          key in shape &&
          isScalarParamSchema(shape[key])
        ) {
          errors.push({
            code: 'REF_PATH_MISMATCH',
            stepId: step.id,
            message: `Step '${step.id}': param '${key}' for '${step.action}' takes a single value, but '${value}' is an 'items[*]' pluck that resolves to a LIST. Narrow the list to one item first (filter to a single match) or reference a scalar field — do not bind an array to a scalar id/param. Corrected-ref example: resolve to ONE record (e.g. core.filter down to a single match in step s2) and reference its scalar id as "$s2.id", not an "items[*]" pluck.`,
          });
          continue;
        }
        if (containsRef(value)) continue;
        if (!shape || !(key in shape)) {
          errors.push({
            code: 'UNKNOWN_PARAM',
            stepId: step.id,
            message: `Step '${step.id}': action '${step.action}' has no input field '${key}'.`,
          });
          continue;
        }
        // Fix 3 (humantest round-3 "2024 regression"): a LITERAL raw number
        // in a date-shaped param (same field-name + ZodNumber classification
        // `agent/retrieval.ts`'s card renderer uses to label it
        // "date(ISO|@expr)") is ALWAYS rejected — the model must never
        // compute an epoch-ms literal itself (it gets the year wrong from
        // its training-era clock; coupon struct_398 valid_until=2024-11-05,
        // two Nov-2024 webinar start times). A $ref is excluded above
        // (`containsRef`), so only a genuine model-authored literal reaches
        // here.
        if (typeof value === 'number' && DATE_FIELD_RE.test(key) && isNumberSchema(shape[key])) {
          errors.push({
            code: 'DATE_EPOCH_LITERAL',
            stepId: step.id,
            message: `Step '${step.id}': param '${key}' for '${step.action}' is the literal epoch-ms number ${value}. Write dates as ISO-8601 ('2026-11-30') or a relative expression ('@end_of_month'); never epoch numbers.`,
          });
          continue;
        }
        // A number-typed param accepts an ISO-8601 string, or a relative
        // `@…` expression (Fix 3), coerced to epoch-ms at execution time
        // (E3) — validate the coerced form so a well-formed date string on
        // ANY number field isn't rejected.
        const valueToCheck = coerceDateParamValue(value, shape[key], nowMs);
        const fieldResult = shape[key]?.safeParse(valueToCheck);
        if (fieldResult && !fieldResult.success) {
          errors.push({
            code: 'PARAM_SCHEMA',
            stepId: step.id,
            message: `Step '${step.id}': param '${key}' for '${step.action}' failed validation (${fieldResult.error?.message ?? 'invalid'}).`,
          });
          continue;
        }
        // id-fabrication guard: a literal string in an `id`/`*_id` field (on
        // a plain-string, non-enum schema) that is NOT shaped like an entity
        // id (`<prefix>_<n>`) is almost certainly a NAME the planner should
        // have resolved via a search action — repairable, not a crash.
        if (
          typeof value === 'string' &&
          isIdParamName(key) &&
          isPlainStringSchema(shape[key]) &&
          looksLikeName(value)
        ) {
          errors.push({
            code: 'ID_NOT_RESOLVED',
            stepId: step.id,
            message: `Step '${step.id}': param '${key}' for '${step.action}' is the literal '${value}', which looks like a name, not an entity id (ids are lowercase with a numeric segment, e.g. 'con_123' or 'course_2_lsn_1'). Resolve it via a search action first (e.g. a '*.search_*' action) and reference its result with a $ref, never a typed-in id.`,
          });
        } else if (
          // id-provenance guard (E4 + P4): ANY literal in an `id`/`*_id`
          // param (on a plain-string schema) that the planner never actually
          // saw — not in working memory, not in the user's words — is
          // fabricated. P4 drops the old `looksLikeEntityId` precondition:
          // that only flagged literals shaped `<known-prefix>_<n>`, so a
          // WRONG-shape fake ("cam_8"/"campaign_16" invented for "campaign 8",
          // marketing NEW-1) slipped past BOTH the name guard (it has a
          // digit, no caps) and this one (unknown prefix) and rode a bogus id
          // straight through the confirmation gate to a runtime NOT_FOUND.
          // Non-name literals are the only ones reaching this branch (names
          // were caught above); any that the planner can't account for must
          // come from a lookup $ref instead. A prior step's output always
          // arrives as a $ref, never a literal, so it never reaches here.
          typeof value === 'string' &&
          isIdParamName(key) &&
          isPlainStringSchema(shape[key]) &&
          !isProvenanced(value, provenance)
        ) {
          errors.push({
            code: 'ID_NOT_PROVENANCED',
            stepId: step.id,
            message: `Step '${step.id}': param '${key}' for '${step.action}' is the literal id '${value}', but that id was never produced by a lookup or seen in the request/working state — it appears to be guessed. An id must come from a lookup step: add a '*.search_*'/'*.list_*' action that finds the record, then reference its result with a $ref (e.g. "$s1.items[0].id"). Never type in an id you did not retrieve.`,
          });
        }
      }
    }

    // 3. ref grammar + dependency-closure over params, plus structural
    //    ref-path vs producing-action-outputSchema (REF_PATH_MISMATCH).
    for (const ref of collectRefStrings(step.params)) {
      checkRef(ref, step, `Step '${step.id}' params`, reachable);
      checkRefPath(ref, step, `Step '${step.id}' params`);
    }
    // `when`: grammar/handle/dependency enforcement is scoped to
    // `when.ref` ONLY. `when.value` is an opaque literal comparison value
    // (e.g. `{ref:'$s1.total', op:'gt', value:'$100'}` — "$100" is a
    // perfectly plausible dollar-amount literal in this CRM, not a
    // malformed ref) — sweeping the whole `when` object previously made
    // that a spurious REF_GRAMMAR failure.
    if (step.when) {
      checkRef(step.when.ref, step, `Step '${step.id}' when.ref`, reachable);
      checkRefPath(step.when.ref, step, `Step '${step.id}' when.ref`);
    }

    // 4. forEach target must itself be a ref (and not $item — you cannot
    //    fan out over the current item of a fan-out you're declaring),
    //    subject to the same handle/dependency-closure rules as any other
    //    step ref.
    if (step.forEach !== undefined) {
      checkRefPath(step.forEach, step, `Step '${step.id}' forEach`);
      const parsedForEach = parseRefGrammar(step.forEach);
      if (!parsedForEach || parsedForEach.form === 'item') {
        errors.push({
          code: 'FOREACH_NOT_REF',
          stepId: step.id,
          message: `Step '${step.id}': forEach target '${step.forEach}' must be a $sN or $r_t<T>_s<N> ref.`,
        });
      } else if (parsedForEach.form === 'crossTurn' && !handleIds.has(parsedForEach.handleId)) {
        errors.push({
          code: 'UNKNOWN_HANDLE',
          stepId: step.id,
          message: `Step '${step.id}': forEach '${step.forEach}' references unknown cross-turn handle '${parsedForEach.handleId}'.`,
        });
      } else if (parsedForEach.form === 'step') {
        if (!stepIds.has(parsedForEach.stepId)) {
          errors.push({
            code: 'UNKNOWN_STEP_REF',
            stepId: step.id,
            message: `Step '${step.id}': forEach '${step.forEach}' references step '${parsedForEach.stepId}', which does not exist in this plan.`,
          });
        } else if (!reachable.has(parsedForEach.stepId)) {
          errors.push({
            code: 'MISSING_DEPENDENCY',
            stepId: step.id,
            message: `Step '${step.id}': forEach '${step.forEach}' references step '${parsedForEach.stepId}', but does not depend on it (directly or transitively) — add '${parsedForEach.stepId}' to dependsOn.`,
          });
        }
      }
    }

    // 4a. plan-minimality self-assignment backstop (E6c, RC5): a write whose
    //     ENTIRE input is refs into ONE fetched record (its own id + its own
    //     fields) writes that record's current values back onto itself — it
    //     can't change the state the user asked about (e.g. "who owns
    //     lead_2025" → assign_lead_owner(id:$s1.id, owner_id:$s1.owner_id)).
    //     Conservative by design: fires ONLY when the step is a write, has
    //     ≥2 params, and EVERY param value is a whole-value ref into the SAME
    //     single producing base — a legitimate write mixes in a literal or a
    //     second source, so it never trips this.
    if (action && action.risk !== 'read' && !step.action.startsWith('core.')) {
      const entries = Object.entries(step.params);
      const refBases = entries.map(([, v]) => {
        if (typeof v !== 'string') return null;
        const p = parseRefGrammar(v);
        if (!p) return null;
        return p.form === 'step' ? `s:${p.stepId}` : p.form === 'crossTurn' ? `h:${p.handleId}` : null;
      });
      const allRefs = entries.length >= 2 && refBases.every((b) => b !== null);
      const singleBase = allRefs && new Set(refBases).size === 1;
      if (singleBase) {
        errors.push({
          code: 'PLAN_MINIMALITY',
          stepId: step.id,
          message: `Step '${step.id}': write '${step.action}' takes all of its inputs (${entries.map(([k]) => k).join(', ')}) from the same fetched record — it would write that record's own current values back onto itself, changing nothing. If the user only ASKED about this record (e.g. who owns it), answer from the read and drop this write step entirely; if a real change was intended, supply the new value as a literal or from a different source.`,
        });
      }
    }

    // 4b. core-op field validation (E2): a `field`/`key`/`excludeKey`/
    //     `withKey` literal must exist on the item schema of the list it
    //     reads — else FIELD_NOT_IN_SCHEMA listing the ACTUAL fields.
    const fieldParams = CORE_OP_FIELD_PARAMS[step.action];
    if (fieldParams) {
      for (const [fieldParam, listParam] of Object.entries(fieldParams)) {
        const fieldVal = (step.params as Record<string, unknown>)[fieldParam];
        if (typeof fieldVal !== 'string' || fieldVal.includes('$')) continue; // only literal field names
        const itemSchema = listRefItemSchema((step.params as Record<string, unknown>)[listParam], schemaForStepId);
        if (itemSchema === undefined) continue; // non-introspectable → skip
        const cls = classify(itemSchema);
        if (cls.kind !== 'object') continue; // opaque row shape → skip
        if (!cls.keys.has(fieldVal)) {
          const avail = [...cls.keys].join(', ');
          errors.push({
            code: 'FIELD_NOT_IN_SCHEMA',
            stepId: step.id,
            message: `Step '${step.id}': '${step.action}' param '${fieldParam}' is '${fieldVal}', which is not a field on the rows from '${listParam}'. Available fields: ${avail}. Use one of those exact field names.`,
          });
        }
      }
    }

    // 5. dependsOn references exist.
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        errors.push({
          code: 'UNKNOWN_DEP',
          stepId: step.id,
          message: `Step '${step.id}' depends on unknown step '${dep}'.`,
        });
      }
    }
  }

  // 6. acyclic.
  const topo = topoSort(plan.steps);
  if (!topo.ok) {
    errors.push({
      code: 'CYCLE',
      message: `Cycle detected among steps: ${topo.cycleStepIds.join(', ')}.`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors, plan, autofixes };
  }

  return {
    ok: true,
    outcome: { ...parsedOutcome, plan },
    plan,
    planHash: computePlanHash(plan),
    stepOrder: topo.ok ? topo.order : [],
    autofixes,
  };
}

/** Builds a targeted repair prompt: the previous plan JSON + a bullet list
 * of exactly what's wrong, nothing else (LLD §5.1 `maxRepairs`).
 *
 * The echoed "Previous plan" MUST be in the WIRE shape (`toWirePlan` —
 * string-encoded `params`, every `forEach`/`when`/`expects` field present
 * with its sentinel/null default when unused), NOT the narrowed `Plan`
 * shape this function receives as its `plan` argument — the repair call
 * site (`pipeline.ts`) demands a wire-shaped `FlatPlanOutcome` response
 * (`agent/plan-schema.ts`'s `flatPlanOutcomeSchema`), so echoing the
 * ALREADY-NARROWED shape back (object `params`, omitted fields) mismatches
 * what's being asked for and risks the model echoing the familiar-but-wrong
 * shape, burning a repair round on a shape mismatch instead of the actual
 * fix (code-review finding, docs/SPIKES.md §1c). */
export function repairPrompt(plan: Plan, errors: readonly ValidationError[]): string {
  const errorLines = errors
    .map((e) => `- ${e.stepId ? `[step ${e.stepId}] ` : ''}${e.code}: ${e.message}`)
    .join('\n');
  return [
    'The previous plan failed validation. Fix ONLY the problems listed below and',
    'resend the COMPLETE corrected plan as the same PlanOutcome JSON shape',
    '(normally `{"kind":"plan","plan":{...}}` with the FULL `plan.steps` array —',
    'not a diff — and the SAME wire shape shown below: `params` as a',
    'JSON-encoded STRING, and `forEach`/`when`/`expects` always present).',
    'These are VALIDATION errors in YOUR plan — fix the plan and resend it.',
    'Do NOT downgrade to `clarify`: clarify is valid ONLY when information is',
    'genuinely missing from the request/conversation, never as a way to avoid',
    'correcting a plan whose inputs are all present. If (and only if) the',
    'request truly cannot be satisfied by any plan, you may return a different',
    '`kind` (search/clarify/unsupported/respond) with an honest reason.',
    '',
    'Previous plan:',
    JSON.stringify(toWirePlan(plan)),
    '',
    'Validation errors to fix:',
    errorLines,
  ].join('\n');
}
