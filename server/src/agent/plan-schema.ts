/**
 * Plan DSL (LLD §2.2) — THE canonical Zod schema for `PlanOutcome`. Field
 * names and shapes are copied verbatim from the LLD; `events/types.ts`
 * imports/re-exports the plain TS types from here (no local copies — see
 * that file's header).
 *
 * `Value` (a param value) is `JSON literal | RefString`. `RefString` is kept
 * as a plain `string` in this schema — not a refined/branded type — on
 * purpose: Zod schemas built from unions of string-shaped branded types are
 * exactly the kind of structural-output edge case LLD §10 Spike B worries
 * about ("if union shapes fail on Gemini/GPT structured outputs, flatten
 * refs to plain strings … already strings"). Keeping `RefString` as `string`
 * here means that flattening is already done — the ref GRAMMAR (`$sN[.path]`
 * | `$r_t<T>_s<N>[.path]` | `$item[.path]`) is parsed and enforced later, by
 * `agent/validator.ts`, against the already-parsed object.
 *
 * **Day-1 schema spike fix (docs/SPIKES.md §1):** the ORIGINAL `valueSchema`
 * below was a `z.lazy` recursive union (literal | array of itself | record
 * of itself) and `stepSchema.params` was `z.record(z.string(), valueSchema)`
 * — i.e. the recursive schema WAS reachable from the root `PlanOutcome`
 * schema that `generateObject` compiles to JSON Schema. That produces a
 * self-referencing JSON Schema (`$ref` cycle through the `record` branch),
 * which Anthropic/Google/OpenAI structured-output validators ALL reject
 * (see SPIKES.md §1 for the three provider-specific error messages — same
 * defect, three symptoms). Per LLD §10's contingency ("flatten refs to plain
 * strings"), `params` is now `z.looseObject({})` — a flat, non-recursive
 * JSON Schema (`{"type":"object","properties":{},"additionalProperties":{}}`,
 * no `$ref`, no `propertyNames` — see `stepSchema` below for why plain
 * `z.record(z.string(), z.unknown())` was tried and rejected too: Zod still
 * emits `propertyNames` for ANY `z.record`, which is the exact OpenAI
 * strict-mode rejection the spike also hit). `agent/validator.ts` never relied on the
 * `Value` zod type for per-action checking anyway (it treats every param as
 * `unknown` and does its own `safeParse` against the action's OWN compiled
 * `inputSchema` field-by-field, and ref-scans with `typeof value ===
 * 'string'` checks) — see `validator.ts`'s `collectRefStrings`/`containsRef`,
 * both typed `(value: unknown)`. So this change needed NO validator/executor
 * edits. `valueSchema`/`Value` are kept below (unused by `stepSchema` now)
 * purely as documentation of the param-value shape and for the standalone
 * unit test in `plan-schema.test.ts` — neither is part of the compiled
 * `planOutcomeSchema` JSON Schema anymore, so the recursion they describe
 * can never reach a provider's structured-output compiler again.
 */

import { z } from 'zod';

// --- Value (LLD §2.2: "Value = JSON literal | RefString") ------------------

/** A step param value: any JSON literal, or a ref string (`$s1`, `$r_t3_s1`,
 * `$item.foo`, …) — refs are NOT distinguished at the type level; the
 * grammar is validated at runtime by `agent/validator.ts`.
 *
 * NOT used by `stepSchema.params` (see header comment) — kept here as
 * documentation of the conceptual param-value shape and for its own unit
 * test; `params` itself is the flat, provider-safe `z.record(z.string(),
 * z.unknown())` below. */
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

export const valueSchema: z.ZodType<Value> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(valueSchema),
    z.record(z.string(), valueSchema),
  ]),
);

// --- Step (LLD §2.2) ---------------------------------------------------------

export const whenOpSchema = z.enum(['eq', 'gt', 'lt', 'nonempty', 'empty']);
export type WhenOp = z.infer<typeof whenOpSchema>;

export const whenSchema = z.strictObject({
  ref: z.string(),
  op: whenOpSchema,
  value: z.unknown().optional(),
});
export type When = z.infer<typeof whenSchema>;

export const expectsSchema = z.strictObject({
  nonEmpty: z.boolean().optional(),
  maxCount: z.number().optional(),
  minCount: z.number().optional(),
});
export type Expects = z.infer<typeof expectsSchema>;

export const stepSchema = z.strictObject({
  id: z.string(), // "s1"
  action: z.string(), // slug from shortlist (or prior search round)
  // Flat/provider-safe (see file header): NOT `z.record(z.string(),
  // valueSchema)` — that recursive shape is what broke structured output
  // on all 3 target providers via a `$ref` cycle. Also deliberately NOT
  // `z.record(z.string(), z.unknown())` — Zod still compiles ANY `z.record`
  // (even with a plain `z.string()` key schema) to a JSON Schema
  // `propertyNames` keyword (`{"type":"object","propertyNames":{...},
  // "additionalProperties":{}}`), which is the SECOND, independent defect
  // the spike found on OpenAI's strict structured-output mode
  // ("'propertyNames' is not permitted"). `z.looseObject({})` compiles to
  // a plain `{"type":"object","properties":{},"additionalProperties":{}}`
  // — no `$ref`, no `propertyNames` — while still inferring as an open
  // `{[key: string]: unknown}` record, which is all `agent/validator.ts`
  // needs: it validates each param's actual shape against the action's own
  // `inputSchema` at runtime, so the planner-side schema only needs a
  // plain, unconstrained object here.
  params: z.looseObject({}),
  dependsOn: z.array(z.string()),
  /** Fan-out over a list; inside this step, `$item` is bound. */
  forEach: z.string().optional(),
  when: whenSchema.optional(),
  expects: expectsSchema.optional(),
});
export type Step = z.infer<typeof stepSchema>;

// --- Plan (LLD §2.2) ---------------------------------------------------------

export const planSchema = z.strictObject({
  goal: z.string(),
  steps: z.array(stepSchema),
});
export type Plan = z.infer<typeof planSchema>;

// --- PlanOutcome (LLD §2.2) ---------------------------------------------------

export const planOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan'), plan: planSchema }),
  // retrieval escape hatch: pipeline runs search → re-plan; max 2 rounds,
  // counted in maxLlmCallsPerTurn.
  z.strictObject({ kind: z.literal('search'), queries: z.array(z.string()) }),
  // exactly one focused question; MUST NOT ask for info present in working
  // state (enforced by prompt instructions + eval, not by this schema).
  z.strictObject({ kind: z.literal('clarify'), question: z.string() }),
  z.strictObject({ kind: z.literal('unsupported'), reason: z.string() }),
  z.strictObject({ kind: z.literal('respond'), text: z.string() }),
]);
export type PlanOutcome = z.infer<typeof planOutcomeSchema>;

// --- Wire schema (Task 6 round-3 fix — docs/SPIKES.md §1c) -----------------
//
// `planOutcomeSchema` above is `z.discriminatedUnion('kind', [...5 variants])`,
// compiling to a top-level `oneOf` — round 1's defect. Round 2 fixed that
// (flat root object) and ALSO found `.nullable()` on an object/array compiles
// to `anyOf` (no public zod escape hatch), fixing `plan`/`queries` via
// sentinel defaults instead. Both fixes are correct and still in place below
// — but round 3's live diagnostic (one call per still-failing provider,
// against the round-2 schema, BEFORE any further change — see docs/SPIKES.md
// §1c) found the round-2 schema STILL 400s, for a THIRD, independent defect:
//
//   Anthropic: "output_config.format.schema: Empty schema ({}) that accepts
//     any JSON value is not supported. Please specify a concrete type."
//   OpenAI: "...In context=('properties','plan','properties','steps','items',
//     'properties','params','additionalProperties'), schema must have a
//     'type' key."
//
// Both point at the exact same place: `stepSchema.params`'s
// `z.looseObject({})` compiles to `"additionalProperties":{}` — an EMPTY,
// type-less nested schema (round 1 already ruled out `z.record()` here for
// an unrelated reason, `propertyNames`, but never caught THIS one — the
// `{}` "additionalProperties" value is identical between `z.looseObject({})`
// and `z.record(z.string(), z.unknown())`). A local JSON-schema dump of the
// round-2 schema additionally found `whenSchema.value` (`z.unknown()`) has
// the IDENTICAL `{}` empty-schema shape, unexercised by either provider
// error only because validation apparently stops at the first offending
// field it reaches — and that `stepSchema`'s `forEach`/`when`/`expects`
// (and `whenSchema.value`, `expectsSchema`'s 3 fields) are genuinely
// OPTIONAL (omitted from `required`), the long-flagged-but-never-confirmed
// hypothesis from round 2. Rather than fix one and risk a FOURTH masked
// defect, this round fixes every remaining non-conforming construct at
// once, uniformly:
//
// 1. `params`: NOT an object schema at all anymore — `z.string()`, a
//    JSON-ENCODED blob of the real `Record<string, unknown>` (LLD §10 Spike
//    B's own original option 1, floated back in docs/SPIKES.md §1 and
//    finally needed). A plain string has a trivially concrete `type`, so
//    this can never hit the "empty schema" rejection again regardless of
//    how deeply nested or heterogeneous real param values get.
// 2. `when`/`expects`/`forEach`: ALWAYS present (never `.optional()`) with
//    SENTINEL semantics — `forEach: z.string()` (`''` = absent); `when` is
//    always an object, `ref: z.string()` (`''` = absent, `op`/`value` then
//    ignored); `expects` is always an object with `nonEmpty`/`maxCount`/
//    `minCount` each `.nullable()` (primitive nullable collapses to a
//    `type`-ARRAY, e.g. `{"type":["number","null"]}` — NOT `anyOf`, unlike
//    round 2's object/array nullable finding; `null` per-field = that field
//    unset, matching the original `Expects`'s per-field-optional shape
//    exactly). `when.op` stays the real 5-value enum, never nullable —
//    `z.enum([...]).nullable()` was checked locally and (unlike plain
//    primitives) DOES compile to `anyOf` (enum adds a second `enum`
//    keyword zod can't fold into a bare `type` array), so `op`'s "unused"
//    state is signaled by `ref===''` instead, not by nulling `op` itself.
// 3. `when.value`: `z.union([z.string(), z.number(), z.boolean(), z.null()])`
//    — a union of bare primitives (no enum, no object/array) collapses
//    cleanly to `{"type":["string","number","boolean","null"]}`, no `anyOf`
//    — confirmed locally. This is the one place a JSON Schema union of
//    primitives is safe: round 1/2's unions all failed because they also
//    contained an enum, object, or array branch forcing `anyOf`.
//
// `toStep`/`toPlan`/`toPlanOutcome` below adapt this wire shape back to the
// EXISTING `Step`/`Plan`/`PlanOutcome` types — `agent/validator.ts`,
// `agent/executor.ts`, `agent/joiner.ts`, and `events/types.ts` see EXACTLY
// what they saw before this fix; only the two call sites that ever hand a
// schema to `generateObject` (`planner.ts`'s `plan()`, `pipeline.ts`'s
// repair call) go through the wire schema + adapter.

/** The wire (generateObject-facing) shape of `When` — see this section's
 * header for why `ref`/`op`/`value` are all required with sentinel/
 * collapsible-nullable semantics instead of `whenSchema`'s `.optional()`
 * fields. `''` for `ref` means "no when clause" (then `op`/`value` are
 * ignored by `toStep`). */
export const wireWhenSchema = z.strictObject({
  ref: z.string(),
  op: whenOpSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
export type WireWhen = z.infer<typeof wireWhenSchema>;

/** The wire shape of `Expects` — all 3 fields required+nullable (not
 * `.optional()`); `null` means that field is unset, exactly matching the
 * original per-field-optional `Expects` semantics once `toStep` strips the
 * nulls back out. */
export const wireExpectsSchema = z.strictObject({
  nonEmpty: z.boolean().nullable(),
  maxCount: z.number().nullable(),
  minCount: z.number().nullable(),
});
export type WireExpects = z.infer<typeof wireExpectsSchema>;

/** The wire shape of `Step` — `params` is a JSON-ENCODED STRING (parsed
 * back to `Record<string, unknown>` by `toStep`), and `forEach`/`when`/
 * `expects` are always present (sentinel/nullable, never `.optional()`) —
 * see this section's header for the full rationale. */
export const wireStepSchema = z.strictObject({
  id: z.string(),
  action: z.string(),
  params: z.string(),
  dependsOn: z.array(z.string()),
  forEach: z.string(),
  when: wireWhenSchema,
  expects: wireExpectsSchema,
});
export type WireStep = z.infer<typeof wireStepSchema>;

/** The wire shape of `Plan`. */
export const wirePlanSchema = z.strictObject({
  goal: z.string(),
  steps: z.array(wireStepSchema),
});
export type WirePlan = z.infer<typeof wirePlanSchema>;

/** The wire (generateObject-facing) shape of `PlanOutcome` — a single flat
 * root object, every field always present. `plan`/`queries` use sentinel
 * defaults (`{goal:"",steps:[]}` / `[]`) rather than `.nullable()` (round 2:
 * nullable object/array compiles to `anyOf`, which this file avoids
 * everywhere); `question`/`reason`/`text` stay `.nullable()` (safe for
 * plain strings — collapses to a `type` array, no `anyOf`).
 *
 * `reasoning` (in-band reasoning, task-quickwins Fix 1) is a REQUIRED plain
 * `z.string()` — a trivially concrete `type`, so it's as provider-safe as
 * every other scalar field this file already relies on — and is listed
 * FIRST in property order, below, so `generateObject`'s JSON Schema
 * `required`/`properties` ordering (which every target provider honors when
 * deciding emission order) has the model write its reasoning out BEFORE
 * committing to "kind"/"plan"/etc. It is intentionally NOT part of
 * `PlanOutcome`/`Plan`/`Step` — `toPlanOutcome` below reads every OTHER
 * field off `flat` but never copies `reasoning` across, so it never reaches
 * the validator/executor/joiner/events, and `toWireStep`/`toWirePlan` (the
 * repair-prompt echo serializers) have no `reasoning` field to re-emit
 * either — a repair round asks for fresh reasoning on the NEW response, not
 * a resend of the old one, keeping repair prompts lean. */
export const flatPlanOutcomeSchema = z.strictObject({
  reasoning: z
    .string()
    .describe('2-4 sentences working out which actions, what order, which refs — brief.'),
  kind: z.enum(['plan', 'search', 'clarify', 'unsupported', 'respond']),
  plan: wirePlanSchema,
  queries: z.array(z.string()),
  question: z.string().nullable(),
  reason: z.string().nullable(),
  text: z.string().nullable(),
});
export type FlatPlanOutcome = z.infer<typeof flatPlanOutcomeSchema>;

/** Thrown by `toPlanOutcome`/`toStep` when a structurally-valid wire value
 * (already passed its zod parse) has an internally-inconsistent or
 * unparseable combination of fields — a kind-specific field left at its
 * sentinel/null default, or a `params` string that isn't valid JSON. A
 * cross-field/content constraint the wire schema itself cannot express
 * (zod object schemas don't encode "this field matters only when that
 * discriminant has this value," and can't validate a string's CONTENTS as
 * JSON, without reintroducing a union/recursive schema — exactly what this
 * file is avoiding). Call sites (`planner.ts`'s `plan()`, `pipeline.ts`'s
 * repair call, `joiner.ts`'s `joinerRepair`) catch this and re-throw it as
 * the AI SDK's `NoObjectGeneratedError` — see `planner.ts`'s
 * `narrowFlatOutcome` — so `pipeline.ts`'s EXISTING
 * `NoObjectGeneratedError.isInstance(err)` handling (escalate-and-retry,
 * then a repairable `'failed'` turn; LLD: "never a crash") covers this case
 * with no new pipeline logic. */
export class FlatOutcomeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlatOutcomeShapeError';
  }
}

/** Narrows a wire `WireStep` to the existing `Step` type every downstream
 * consumer (validator/executor/joiner/events) already expects — pure, no
 * I/O. `params` is JSON-parsed back to a real object (throwing
 * `FlatOutcomeShapeError` on invalid JSON — a model mistake, not a crash);
 * `forEach`/`when`/`expects` sentinels are stripped back to `undefined`,
 * matching `stepSchema`'s original `.optional()` shape exactly. */
function parseWireParams(wire: WireStep): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire.params);
  } catch (err) {
    throw new FlatOutcomeShapeError(`Step '${wire.id}': 'params' is not valid JSON (${String(err)}).`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FlatOutcomeShapeError(`Step '${wire.id}': 'params' must JSON-decode to an object, got ${wire.params}`);
  }
  return parsed as Record<string, unknown>;
}

function toExpects(wire: WireExpects): Expects | undefined {
  if (wire.nonEmpty === null && wire.maxCount === null && wire.minCount === null) return undefined;
  return {
    ...(wire.nonEmpty !== null ? { nonEmpty: wire.nonEmpty } : {}),
    ...(wire.maxCount !== null ? { maxCount: wire.maxCount } : {}),
    ...(wire.minCount !== null ? { minCount: wire.minCount } : {}),
  };
}

export function toStep(wire: WireStep): Step {
  const params = parseWireParams(wire);
  const expects = toExpects(wire.expects);
  // `.trim()` before the absent-sentinel check (not just `!== ''`) — a
  // model emitting whitespace instead of a true empty string (e.g. `" "`)
  // for "no forEach"/"no when clause" should still be treated as absent,
  // not as a bogus ref the executor would fail to resolve at run time.
  return {
    id: wire.id,
    action: wire.action,
    params,
    dependsOn: wire.dependsOn,
    ...(wire.forEach.trim() !== '' ? { forEach: wire.forEach } : {}),
    ...(wire.when.ref.trim() !== ''
      ? { when: { ref: wire.when.ref, op: wire.when.op, value: wire.when.value } }
      : {}),
    ...(expects !== undefined ? { expects } : {}),
  };
}

/** Narrows a wire `WirePlan` to the existing `Plan` type. */
export function toPlan(wire: WirePlan): Plan {
  return { goal: wire.goal, steps: wire.steps.map(toStep) };
}

// --- toWirePlan — the INVERSE serializer (code-review fix, docs/SPIKES.md
// §1c review) --------------------------------------------------------------
//
// `agent/validator.ts`'s `repairPrompt` and `agent/joiner.ts`'s
// `buildJoinerPrompt` both echo the PREVIOUS plan back to the model as part
// of a repair prompt, while demanding the model's response conform to the
// WIRE shape (string `params`, all-fields-present `forEach`/`when`/
// `expects`) — echoing the already-narrowed `Plan`/`Step` shape (object
// `params`, omitted fields) via a plain `JSON.stringify(plan)` mismatches
// what the prompt demands and risks the model echoing the FAMILIAR (wrong)
// shape back, burning a repair round. `toWirePlan` is the exact inverse of
// `toPlan`/`toStep` above — re-serializes an already-narrowed `Plan` back
// to the wire shape so both repair-prompt echo sites show the model
// EXACTLY the shape it's being asked to reproduce.

function toWireWhen(when: When | undefined): WireWhen {
  if (when === undefined) return { ref: '', op: 'eq', value: null };
  const value = when.value;
  return {
    ref: when.ref,
    op: when.op,
    // `When.value` is `unknown | undefined` (an opaque literal comparison
    // value — see `whenSchema`'s header); the wire type narrows it to the
    // 4 JSON-scalar types `wireWhenSchema.value` actually accepts. Real
    // `When`s are always constructed from a wire `value` in the first
    // place (via `toStep`), so this is a safe round-trip, not a new
    // constraint.
    value: (value === undefined ? null : (value as string | number | boolean | null)),
  };
}

function toWireExpects(expects: Expects | undefined): WireExpects {
  return {
    nonEmpty: expects?.nonEmpty ?? null,
    maxCount: expects?.maxCount ?? null,
    minCount: expects?.minCount ?? null,
  };
}

/** The inverse of `toStep` — re-serializes an already-narrowed `Step` back
 * to the wire shape (`params` JSON-stringified; `forEach`/`when`/`expects`
 * filled out to their sentinel/null wire defaults when absent). */
export function toWireStep(step: Step): WireStep {
  return {
    id: step.id,
    action: step.action,
    params: JSON.stringify(step.params),
    dependsOn: step.dependsOn,
    forEach: step.forEach ?? '',
    when: toWireWhen(step.when),
    expects: toWireExpects(step.expects),
  };
}

/** The inverse of `toPlan` — re-serializes an already-narrowed `Plan` back
 * to the wire shape, for repair-prompt echo sites that need to show the
 * model its own previous plan in the EXACT shape it's being asked to
 * resend (`agent/validator.ts`'s `repairPrompt`, `agent/joiner.ts`'s
 * `buildJoinerPrompt`). `JSON.stringify(toWirePlan(plan))` round-trips
 * through `toPlan(JSON.parse(...))` back to (an equivalent) `plan` —
 * covered by `plan-schema.test.ts`'s round-trip test. */
export function toWirePlan(plan: Plan): WirePlan {
  return { goal: plan.goal, steps: plan.steps.map(toWireStep) };
}

/** Narrows a structurally-valid `FlatPlanOutcome` to the existing
 * discriminated `PlanOutcome` union that every downstream consumer
 * (validator/pipeline/executor/events) already expects — pure, no I/O, no
 * AI SDK dependency (see `FlatOutcomeShapeError`'s doc comment for how
 * callers turn a thrown error here into the pipeline's existing
 * repair/escalation path). */
export function toPlanOutcome(flat: FlatPlanOutcome): PlanOutcome {
  switch (flat.kind) {
    case 'plan':
      if (flat.plan.steps.length === 0) {
        throw new FlatOutcomeShapeError(
          "kind:'plan' requires a non-empty 'plan.steps' — got the sentinel empty plan.",
        );
      }
      return { kind: 'plan', plan: toPlan(flat.plan) };
    case 'search':
      if (flat.queries.length === 0) {
        throw new FlatOutcomeShapeError("kind:'search' requires a non-empty 'queries' — got the sentinel [].");
      }
      return { kind: 'search', queries: flat.queries };
    case 'clarify':
      if (flat.question === null) {
        throw new FlatOutcomeShapeError("kind:'clarify' requires a non-null 'question' field.");
      }
      return { kind: 'clarify', question: flat.question };
    case 'unsupported':
      if (flat.reason === null) {
        throw new FlatOutcomeShapeError("kind:'unsupported' requires a non-null 'reason' field.");
      }
      return { kind: 'unsupported', reason: flat.reason };
    case 'respond':
      if (flat.text === null) {
        throw new FlatOutcomeShapeError("kind:'respond' requires a non-null 'text' field.");
      }
      return { kind: 'respond', text: flat.text };
  }
}
