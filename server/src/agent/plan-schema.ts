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
