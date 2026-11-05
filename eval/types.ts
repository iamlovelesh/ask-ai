/**
 * Scenario schema (Task 16, LLD §9.1). This is the ONE zod schema every
 * scenario YAML file under `eval/scenarios/` round-trips through — the
 * runner (`eval/runner.ts`) loads+validates with it, the assertion engine
 * (`eval/assert.ts`) consumes its `Turn['expect']` shape, and the coverage
 * linter (`eval/lint.ts`) walks `category`/`subtype`/action slugs out of
 * already-parsed `Scenario` values.
 *
 * Field names are verbatim from the LLD/brief:
 *   {id, category, subtype?, profile:'standard', seedOverrides?, turns:
 *     [{user, expect: {planActions?, paramChecks?, state?, response?,
 *       behavior?}}], injectFailures?}
 *
 * `countDelta` (LLD §9.1 v1.1) is preferred over absolute `equals` counts
 * for exactly the reason the LLD gives: an absolute count couples a
 * scenario to the seed data, and a generator tweak invalidates dozens of
 * scenarios at once. `equals`/`gte`/`lte` remain available for checks that
 * genuinely want an absolute bound (e.g. "at least 3 active sales reps
 * exist") rather than a before/after delta.
 */

import { z } from 'zod';

// --- category / subtype (LLD §9.1) ------------------------------------------

export const categorySchema = z.enum([
  'direct',
  'indirect',
  'multistep',
  'conditional',
  'followup',
  'ambiguous',
  'unsupported',
  'failure',
]);
export type ScenarioCategory = z.infer<typeof categorySchema>;

export const subtypeSchema = z.enum(['typo', 'abstention', 'distractor', 'no_repeat']);
export type ScenarioSubtype = z.infer<typeof subtypeSchema>;

// --- action error codes (mirrors server/src/catalog/types.ts's ActionErrorCode
// — duplicated here, not imported, so eval/types.ts has zero runtime
// dependency on server internals; `eval/runner.ts` DOES import server
// modules directly (the existing `eval/smoke.ts` convention), but the
// SCHEMA itself stays import-free so it can be unit-tested with nothing
// else loaded). ----------------------------------------------------------

export const actionErrorCodeSchema = z.enum([
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'TRANSIENT',
  'FORBIDDEN',
  'LIMIT_EXCEEDED',
]);
export type ActionErrorCodeLike = z.infer<typeof actionErrorCodeSchema>;

// --- per-turn expectations ---------------------------------------------------

/** Checked against the `plan.ready` event's `outcome.plan.steps[*].action`
 * list (LLD §9.1). `orderFree` defaults to `true` — set it to `false` when
 * the scenario specifically wants to assert RELATIVE ordering (mustInclude
 * entries must appear as a subsequence, in that relative order; they need
 * not be contiguous or exhaustive). */
export const planActionsExpectSchema = z.strictObject({
  mustInclude: z.array(z.string()).optional(),
  mustNotInclude: z.array(z.string()).optional(),
  orderFree: z.boolean().optional(),
});
export type PlanActionsExpect = z.infer<typeof planActionsExpectSchema>;

/** Checked against the matching step's `params[param]` — EITHER the
 * literal value in the validated plan (a `$ref` string compared as-is) OR
 * the FULLY RESOLVED runtime value recorded on that step's `step.started`
 * event (task-harness-fairness: refs like `"$s1.items[0].id"` that
 * legitimately resolve to a runtime id, e.g. `"struct_200"`, must not fail
 * a check written against that resolved value). Either match is
 * sufficient — scenario authors may write `paramChecks` against the
 * literal param OR the value they expect it to resolve to at runtime. */
export const paramCheckSchema = z
  .strictObject({
    action: z.string(),
    param: z.string(),
    equals: z.unknown().optional(),
    contains: z.unknown().optional(),
  })
  .refine((v) => v.equals !== undefined || v.contains !== undefined, {
    message: 'paramCheck needs an `equals` or `contains` value',
  });
export type ParamCheck = z.infer<typeof paramCheckSchema>;

/** `query` is a raw SQL `SELECT` run against the CRM db that returns one
 * row with one column (e.g. `SELECT COUNT(*) AS n FROM leads WHERE
 * owner_id = 'u_5'`). Exactly one of `equals`/`gte`/`lte`/`countDelta` is
 * expected per check (not enforced by the schema — multiple assertions on
 * the same query are legal, just evaluated independently). `countDelta` is
 * the PREFERRED form (LLD §9.1 v1.1): it compares the query's value taken
 * right before the turn to its value right after, rather than coupling the
 * scenario to an absolute seed-data count. */
export const stateCheckSchema = z.strictObject({
  query: z.string().min(1),
  equals: z.unknown().optional(),
  gte: z.number().optional(),
  lte: z.number().optional(),
  countDelta: z.number().optional(),
});
export type StateCheck = z.infer<typeof stateCheckSchema>;

/** Checked against the turn's `answer.final.text` (case-insensitive
 * substring match for both directions). */
export const responseExpectSchema = z.strictObject({
  mustMention: z.array(z.string()).optional(),
  mustNotClaim: z.array(z.string()).optional(),
});
export type ResponseExpect = z.infer<typeof responseExpectSchema>;

/** `turn.completed.status` (mirrors `server/src/events/types.ts`'s
 * `TurnStatus` — duplicated, not imported, same "schema stays
 * import-free" rationale as `actionErrorCodeSchema` above). */
export const turnStatusSchema = z.enum(['done', 'clarify', 'refused', 'failed', 'cancelled']);
export type TurnStatusExpect = z.infer<typeof turnStatusSchema>;

/**
 * `confirmation`/`clarify`: exact presence/absence expectations. `status`
 * (I2, Task 16 review): the EXACT `turn.completed.status` expected —
 * needed because `confirmation:false`+`clarify:false` alone cannot
 * distinguish a genuine `'refused'` outcome (e.g. `unsupported`) from a
 * turn that silently `'failed'` outright; both have no confirmation and
 * aren't `'clarify'`, so without `status` an `unsupported` scenario is
 * vacuously satisfied by an outright pipeline failure. `mustNotAsk` (LLD
 * §9.1 v1.1 `no_repeat` subtype): terms that must NOT appear in a
 * `clarify` turn's question — the scenario is asserting the planner did
 * not re-ask for information already present in working state.
 */
export const behaviorExpectSchema = z.strictObject({
  confirmation: z.boolean().optional(),
  clarify: z.boolean().optional(),
  status: turnStatusSchema.optional(),
  mustNotAsk: z.array(z.string()).optional(),
});
export type BehaviorExpect = z.infer<typeof behaviorExpectSchema>;

const turnExpectObjectSchema = z.strictObject({
  planActions: planActionsExpectSchema.optional(),
  paramChecks: z.array(paramCheckSchema).optional(),
  state: z.array(stateCheckSchema).optional(),
  response: responseExpectSchema.optional(),
  behavior: behaviorExpectSchema.optional(),
});
/** Inferred from the UNREFINED object schema on purpose — `.refine()`
 * (below) only adds a runtime check, it never changes the inferred
 * shape, but defining `TurnExpect` from the refined schema directly would
 * make `hasRealAssertion`'s own parameter type depend on a `const`
 * (`turnExpectSchema`) declared AFTER it, which is a value/declaration-
 * order problem `z.infer` on a type ALIAS doesn't have when pointed at
 * the base schema instead. */
export type TurnExpect = z.infer<typeof turnExpectObjectSchema>;

/** I3 (Task 16 review): `true` iff `expect` declares at least one REAL,
 * non-vacuous assertion — not merely a present-but-empty sub-object (e.g.
 * `behavior: {}` has a key but asserts nothing). Shared between the
 * schema `.refine()` below and `eval/lint.ts`'s "every turn has >=1
 * assertion" coverage check, so the two can never drift apart. */
export function hasRealAssertion(expect: TurnExpect): boolean {
  const pa = expect.planActions;
  if (pa && ((pa.mustInclude?.length ?? 0) > 0 || (pa.mustNotInclude?.length ?? 0) > 0)) return true;
  if ((expect.paramChecks?.length ?? 0) > 0) return true;
  if ((expect.state?.length ?? 0) > 0) return true;
  const r = expect.response;
  if (r && ((r.mustMention?.length ?? 0) > 0 || (r.mustNotClaim?.length ?? 0) > 0)) return true;
  const b = expect.behavior;
  if (b && (b.confirmation !== undefined || b.clarify !== undefined || b.status !== undefined || (b.mustNotAsk?.length ?? 0) > 0)) return true;
  return false;
}

export const turnExpectSchema = turnExpectObjectSchema.refine(hasRealAssertion, {
  message:
    'turn.expect must declare at least one real assertion (planActions/paramChecks/state/response/behavior) — an empty (or all-empty-sub-object) expect vacuously passes every turn (I3, Task 16 review)',
});

export const turnSchema = z.strictObject({
  user: z.string().min(1),
  expect: turnExpectSchema,
});
export type ScenarioTurn = z.infer<typeof turnSchema>;

// --- injectFailures (LLD §9.1 / Task 16's test-only admin hook) ------------

export const injectFailureSchema = z.strictObject({
  action: z.string().min(1),
  code: actionErrorCodeSchema,
  times: z.number().int().positive(),
});
export type InjectFailure = z.infer<typeof injectFailureSchema>;

// --- Scenario (top level) ---------------------------------------------------

export const scenarioSchema = z.strictObject({
  id: z.string().min(1),
  category: categorySchema,
  subtype: subtypeSchema.optional(),
  profile: z.literal('standard'),
  seedOverrides: z.record(z.string(), z.unknown()).optional(),
  turns: z.array(turnSchema).min(1),
  injectFailures: z.array(injectFailureSchema).optional(),
});
export type Scenario = z.infer<typeof scenarioSchema>;

/** Throws with a readable message (file path + zod issues) on failure —
 * every caller (`runner.ts`, `lint.ts`, tests) wants the SAME error
 * reporting shape rather than re-deriving it from a raw `ZodError`. */
export function parseScenario(raw: unknown, sourcePath?: string): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const where = sourcePath ? ` (${sourcePath})` : '';
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`invalid scenario${where}:\n${issues}`);
  }
  return parsed.data;
}

/** Every action slug a scenario's `turns[*].expect` touches — used by
 * `eval/lint.ts` for the "every module ≥2 scenarios" coverage gate. Pulled
 * from `planActions.mustInclude`/`paramChecks[*].action` only (the only
 * fields that name a concrete action slug); `mustNotInclude` is excluded
 * on purpose — a scenario asserting an action is ABSENT doesn't count as
 * coverage of that action. */
export function actionSlugsTouchedBy(scenario: Scenario): string[] {
  const slugs = new Set<string>();
  for (const turn of scenario.turns) {
    for (const slug of turn.expect.planActions?.mustInclude ?? []) slugs.add(slug);
    for (const check of turn.expect.paramChecks ?? []) slugs.add(check.action);
  }
  for (const fail of scenario.injectFailures ?? []) slugs.add(fail.action);
  return [...slugs];
}
