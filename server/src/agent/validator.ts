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
}

export interface Invalid {
  ok: false;
  errors: ValidationError[];
}

// --- budgets (LLD §5.1 — canonical; the spec defers to these) --------------

export const BUDGETS = {
  maxLlmCallsPerTurn: 6,
  maxRepairs: 2,
  maxReplans: 2,
  maxSearchRounds: 2,
  turnTimeoutMs: 120_000,
  confirmTargetThreshold: 50,
  forEachHardCap: 500,
} as const;

// --- ref grammar (LLD §2.2 — "the ONLY forms; validator enforces") ---------
//
//   $s<N>[.path]        intra-plan step result
//   $r_t<T>_s<N>[.path] cross-turn handle from WorkingState
//   $item[.path]        current element — legal ONLY under forEach
//   path := field | field.path | items[*] (pluck over array)

const PATH = '(?:\\.[A-Za-z_][A-Za-z0-9_]*(?:\\[\\*\\])?)*';
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
  return false;
}

/** True when `key` is an entity-id param by name (`id` or `*_id`), but NOT
 * a plural id-LIST param (`*_ids`) — an array of ids is a different shape
 * handled via refs, not a single fabricated literal. */
function isIdParamName(key: string): boolean {
  return key === 'id' || (key.endsWith('_id') && key !== '_id');
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
}

/** Same tokenizer the executor uses (`agent/executor.ts#parsePathTokens`) —
 * `.field` segments, each optionally suffixed `[*]` (array pluck). */
function pathTokens(path: string): PathTok[] {
  const toks: PathTok[] = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)(\[\*\])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    toks.push({ field: m[1] as string, spread: m[2] !== undefined });
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

type WalkResult =
  | { kind: 'ok' }
  | { kind: 'skip' }
  | { kind: 'mismatch'; field: string; availableKeys: string[]; note?: string };

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
      return { kind: 'mismatch', field: tok.field, availableKeys: [], note: 'array' };
    }
    return { kind: 'skip' };
  }
  // object-like
  if (!container.keys.has(tok.field)) {
    return { kind: 'mismatch', field: tok.field, availableKeys: [...container.keys] };
  }
  const child = container.field(tok.field);
  if (child === undefined) return { kind: 'skip' };

  if (tok.spread) {
    const elem = arrayElement(child);
    if (elem === null) return { kind: 'skip' }; // `[*]` on a non-introspectable/non-array → skip
    return walkPath(elem, tokens, idx + 1, true);
  }
  return walkPath(child, tokens, idx + 1, spread);
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
 */
export function validate(
  outcome: PlanOutcome,
  shortlist: Set<string>,
  handles: readonly HandleRef[],
  registry: Registry,
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

  const { plan } = parsedOutcome;
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
      message: `${context}: '${ref}' does not match the output of action '${producerSlug}' — '${res.field}' is not reachable on that result.${avail}${pluckHint}`,
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
        message: `${context}: '${ref}' is not a valid ref — only $sN[.path], $r_t<T>_s<N>[.path], or $item[.path] (under forEach) are legal.`,
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
        if (containsRef(value)) continue;
        if (!shape || !(key in shape)) {
          errors.push({
            code: 'UNKNOWN_PARAM',
            stepId: step.id,
            message: `Step '${step.id}': action '${step.action}' has no input field '${key}'.`,
          });
          continue;
        }
        const fieldResult = shape[key]?.safeParse(value);
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
    return { ok: false, errors };
  }

  return {
    ok: true,
    outcome: parsedOutcome,
    plan,
    planHash: computePlanHash(plan),
    stepOrder: topo.ok ? topo.order : [],
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
