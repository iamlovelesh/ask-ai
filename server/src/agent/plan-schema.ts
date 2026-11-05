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

// --- FlatPlanOutcome (Task 6 round-2 fix — docs/SPIKES.md §1b) -------------
//
// `planOutcomeSchema` above is `z.discriminatedUnion('kind', [...5 variants])`,
// which Zod compiles to a JSON Schema with a **top-level `oneOf`**. That's a
// SEPARATE, independent defect from the recursive-`Value` one fixed earlier
// in this file (docs/SPIKES.md §1/§1a) — it was masked in round 1 because the
// `$ref`-cycle error fired first for Anthropic/OpenAI. Once that cycle was
// fixed, re-spiking showed both providers reject a union **at the schema
// root** ("Schema type 'oneOf' is not supported" / "In context=(), 'oneOf'
// is not permitted" — Gemini has no such restriction). `planOutcomeSchema`
// itself is UNCHANGED and still the type every downstream consumer
// (validator/pipeline/executor/events) works with — it's also still used by
// `agent/validator.ts` for a pure in-process structural re-check of an
// ALREADY-PARSED JS object (never sent to a provider, so its `oneOf` is
// irrelevant there).
//
// `flatPlanOutcomeSchema` below is the schema actually handed to
// `generateObject` (by `planner.ts`'s `plan()` and `pipeline.ts`'s repair
// call site — the only two places that ever asked a real provider for a
// `PlanOutcome`): a single FLAT root object, every field always present
// (required). No `oneOf`/`anyOf` ANYWHERE in this schema, root or nested —
// not just at the root:
//
// Round-2 re-spike (docs/SPIKES.md §1b) found that fixing ONLY the root
// `oneOf` was NOT enough — Anthropic/OpenAI still rejected the result.
// `z.toJSONSchema` was checked locally against every nullable variant zod
// offers (`.nullable()`, `z.union([X, z.null()])`, `.or(z.null())`) and
// ALL of them compile a nullable OBJECT/ARRAY to `{"anyOf":[{the type},
// {"type":"null"}]}` — zod has no public way to emit the alternative,
// equally-valid `{"type":[X,"null"], ...}` form for complex types (it DOES
// use that `type`-array form automatically for nullable PRIMITIVES like
// `z.string().nullable()` → `{"type":["string","null"]}`, no `anyOf` — this
// asymmetry is exactly why `question`/`reason`/`text` below stay
// `.nullable()` but `plan`/`queries` do not). Since `anyOf` is the only
// remaining union-shaped keyword anywhere in the compiled schema after the
// root fix, and both failing providers' complaints have consistently been
// about union keywords (`oneOf` at root, `propertyNames`+ref-loop through
// a union branch in round 1), `plan`/`queries` use SENTINEL values instead
// of `null` when not the active kind — `plan: planSchema` (not nullable;
// sentinel `{goal:"", steps:[]}`) and `queries: z.array(z.string())` (not
// nullable; sentinel `[]`) — eliminating `anyOf` for them entirely. This
// candidate fix is NOT yet live-verified (docs/SPIKES.md §1b: the live
// budget for this round was exhausted reaching this hypothesis) — see that
// section for the exact status and the fallback hypothesis (nested
// `.optional()` fields deep in `stepSchema`) if this still isn't enough.
export const flatPlanOutcomeSchema = z.strictObject({
  kind: z.enum(['plan', 'search', 'clarify', 'unsupported', 'respond']),
  plan: planSchema,
  queries: z.array(z.string()),
  question: z.string().nullable(),
  reason: z.string().nullable(),
  text: z.string().nullable(),
});
export type FlatPlanOutcome = z.infer<typeof flatPlanOutcomeSchema>;

/** Thrown by `toPlanOutcome` when a structurally-valid `FlatPlanOutcome`
 * (already passed `flatPlanOutcomeSchema`'s zod parse) has an
 * internally-inconsistent combination of fields for its `kind` — either a
 * kind-specific field left at its SENTINEL value (`plan.steps.length===0`
 * for `kind:'plan'`; `queries.length===0` for `kind:'search'` — see
 * `flatPlanOutcomeSchema`'s header for why `plan`/`queries` use sentinels
 * instead of `null`) or still `null` (`question`/`reason`/`text`) — a
 * cross-field constraint `flatPlanOutcomeSchema` itself cannot express (zod
 * object schemas don't encode "this field is required only when that
 * discriminant has this value" without reintroducing a union, which is
 * exactly what this file is avoiding at the schema level). Call sites
 * (`planner.ts`'s `plan()`, `pipeline.ts`'s repair call) catch this and
 * re-throw it as the AI SDK's `NoObjectGeneratedError` — see `planner.ts`'s
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
      return { kind: 'plan', plan: flat.plan };
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
