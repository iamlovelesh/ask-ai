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
 * `agent/validator.ts`, against the already-parsed object. This schema stays
 * generateObject-friendly across providers.
 */

import { z } from 'zod';

// --- Value (LLD §2.2: "Value = JSON literal | RefString") ------------------

/** A step param value: any JSON literal, or a ref string (`$s1`, `$r_t3_s1`,
 * `$item.foo`, …) — refs are NOT distinguished at the type level; the
 * grammar is validated at runtime by `agent/validator.ts`. */
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
  params: z.record(z.string(), valueSchema),
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
