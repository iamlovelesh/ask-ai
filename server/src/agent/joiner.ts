/**
 * Joiner — checkpoint model (LLD §5.4). Runs at every write-bearing stratum
 * boundary: `checkStratum` is PURE, DETERMINISTIC code — zero LLM calls —
 * that checks the `expects` of every completed upstream read plus two
 * structural smells (forEach fanning out over an empty source; a
 * filter/anti_join step that zeroed out a non-empty input). All pass →
 * `{ok:true}` (the common case, free). A violation triggers exactly one
 * `joinerRepair` LLM call (original plan + the violated expectation +
 * step summaries) that returns `patch | proceed | clarify | abort`; the
 * caller (Task 13's pipeline) enforces the `≤BUDGETS.maxReplans` round cap
 * and bumps `planRev` on a `patch` decision — this module only ever hands
 * back the patched steps.
 */

import { z } from 'zod';
import { NoObjectGeneratedError } from 'ai';
import { llmCall, type LlmCallResult } from '../llm/client.js';
import type { LlmUsage } from '../events/types.js';
import { parseRefGrammar } from './validator.js';
import { wireStepSchema, toStep, FlatOutcomeShapeError, type Plan, type Step } from './plan-schema.js';

// --- checkStratum -------------------------------------------------------------

export interface JoinerViolation {
  stepId: string;
  /** What was expected, e.g. `'nonEmpty'`, `'minCount:5'`, `'maxCount:100'`,
   * `'forEachSourceNonEmpty'`, `'nonZeroOutputFromNonZeroInput'`. */
  expect: string;
  /** What actually happened, e.g. `'0 rows'`, `'7 rows'`. */
  actual: string;
  /** Human-readable, feeds the repair prompt and (if unrepaired) the
   * composer's honest partial report. */
  summary: string;
}

export type JoinerVerdict = { ok: true } | { ok: false; violation: JoinerViolation };

/** A completed step's recorded result, the only piece of a `StepRecord`
 * (`agent/executor.ts`) the joiner needs. */
export interface CompletedStep {
  result: unknown;
}

const FILTER_LIKE_ACTIONS = new Set(['core.filter', 'core.anti_join', 'core.exclude_by']);

/** Row/result count, same shape convention `agent/executor.ts`'s
 * `countRows` and `agent/composer.ts` use: `{total:number}` wins, else
 * `{items:[]}.length`, else a bare array's length, else 1 (a scalar/object
 * result counts as one row). */
function countOf(result: unknown): number {
  if (result === undefined || result === null) return 0;
  if (Array.isArray(result)) return result.length;
  if (typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o['total'] === 'number') return o['total'];
    if (Array.isArray(o['items'])) return o['items'].length;
  }
  return 1;
}

/** The step id a ref points at, when it's an intra-plan `$sN[.path]` ref —
 * `undefined` for a cross-turn handle, `$item`, or a malformed ref (none of
 * those are "completed upstream reads" this checkpoint can reason about). */
function refSourceStepId(ref: unknown): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const parsed = parseRefGrammar(ref);
  return parsed?.form === 'step' ? parsed.stepId : undefined;
}

/**
 * Checks the `expects` of every COMPLETED step, plus forEach-source
 * emptiness for the UPCOMING stratum's steps, plus zero-from-nonzero on any
 * completed filter/anti_join/exclude_by. Returns the FIRST violation found
 * (checked in that order) or `{ok:true}`. Never calls an LLM.
 */
export function checkStratum(
  plan: Plan,
  completed: Readonly<Record<string, CompletedStep>>,
  upcoming: readonly Step[],
): JoinerVerdict {
  const stepById = new Map(plan.steps.map((s) => [s.id, s]));

  // 1. `expects` on every completed step that declared one.
  for (const [stepId, rec] of Object.entries(completed)) {
    const step = stepById.get(stepId);
    if (!step?.expects) continue;
    const count = countOf(rec.result);

    if (step.expects.nonEmpty === true && count === 0) {
      return {
        ok: false,
        violation: {
          stepId,
          expect: 'nonEmpty',
          actual: '0 rows',
          summary: `Step '${stepId}' (${step.action}) expected a non-empty result but returned 0 rows.`,
        },
      };
    }
    if (step.expects.minCount !== undefined && count < step.expects.minCount) {
      return {
        ok: false,
        violation: {
          stepId,
          expect: `minCount:${step.expects.minCount}`,
          actual: `${count} rows`,
          summary: `Step '${stepId}' (${step.action}) expected at least ${step.expects.minCount} rows but got ${count}.`,
        },
      };
    }
    if (step.expects.maxCount !== undefined && count > step.expects.maxCount) {
      return {
        ok: false,
        violation: {
          stepId,
          expect: `maxCount:${step.expects.maxCount}`,
          actual: `${count} rows`,
          summary: `Step '${stepId}' (${step.action}) expected at most ${step.expects.maxCount} rows but got ${count}.`,
        },
      };
    }
  }

  // 2. a filter/anti_join/exclude_by that zeroed out a non-empty input.
  for (const [stepId, rec] of Object.entries(completed)) {
    const step = stepById.get(stepId);
    if (!step || !FILTER_LIKE_ACTIONS.has(step.action)) continue;
    if (countOf(rec.result) !== 0) continue;

    const srcStepId = refSourceStepId(step.params['in']);
    if (srcStepId === undefined) continue;
    const srcRec = completed[srcStepId];
    if (!srcRec) continue;
    const inCount = countOf(srcRec.result);
    if (inCount > 0) {
      return {
        ok: false,
        violation: {
          stepId,
          expect: 'nonZeroOutputFromNonZeroInput',
          actual: '0 rows',
          summary: `Step '${stepId}' (${step.action}) filtered ${inCount} input row(s) down to 0 — likely an incorrect filter/exclusion.`,
        },
      };
    }
  }

  // 3. an upcoming forEach fanning out over an empty (already-completed) source.
  for (const step of upcoming) {
    if (step.forEach === undefined) continue;
    const srcStepId = refSourceStepId(step.forEach);
    if (srcStepId === undefined) continue; // cross-turn handle — not checkable here
    const srcRec = completed[srcStepId];
    if (!srcRec) continue;
    if (countOf(srcRec.result) === 0) {
      return {
        ok: false,
        violation: {
          stepId: step.id,
          expect: 'forEachSourceNonEmpty',
          actual: '0 rows',
          summary: `Step '${step.id}' (${step.action}) fans out over '${step.forEach}', which resolved to 0 items — nothing to do.`,
        },
      };
    }
  }

  return { ok: true };
}

// --- joinerRepair --------------------------------------------------------------

// --- wire schema (Task 6 round-3 fix — docs/SPIKES.md §1c) -----------------
//
// The ORIGINAL `joinerDecisionSchema` here was `z.discriminatedUnion(
// 'decision', [...4 variants])` — the identical root-`oneOf` defect found
// (and fixed, for `PlanOutcome`) in `agent/plan-schema.ts`/`agent/
// planner.ts`. `joinerRepair` is the THIRD (and last) place that ever hands
// a schema to `generateObject` for a real provider call — flagged but left
// unfixed in round 2 (docs/SPIKES.md §1b), fixed here using the exact same
// flat-root + sentinel pattern (and the same `wireStepSchema`/`toStep`
// adapter from `plan-schema.ts` for `patchedSteps`, rather than a
// duplicate definition).
const wireJoinerDecisionSchema = z.strictObject({
  decision: z.enum(['patch', 'proceed', 'clarify', 'abort']),
  patchedSteps: z.array(wireStepSchema),
  question: z.string().nullable(),
});
type WireJoinerDecision = z.infer<typeof wireJoinerDecisionSchema>;

/** Narrows a wire `WireJoinerDecision` to the existing `JoinerDecision`
 * shape every caller of `joinerRepair` already expects — pure, no I/O (see
 * `joinerRepair`'s use of `NoObjectGeneratedError` for how a thrown
 * `FlatOutcomeShapeError` here reaches `pipeline.ts`'s existing
 * escalate-then-fail handling). */
function toJoinerDecision(wire: WireJoinerDecision): JoinerDecision {
  switch (wire.decision) {
    case 'patch':
      if (wire.patchedSteps.length === 0) {
        throw new FlatOutcomeShapeError(
          "decision:'patch' requires a non-empty 'patchedSteps' — got the sentinel [].",
        );
      }
      return { decision: 'patch', patchedSteps: wire.patchedSteps.map(toStep) };
    case 'proceed':
      return { decision: 'proceed' };
    case 'clarify':
      if (wire.question === null) {
        throw new FlatOutcomeShapeError("decision:'clarify' requires a non-null 'question' field.");
      }
      return { decision: 'clarify', question: wire.question };
    case 'abort':
      return { decision: 'abort' };
  }
}

type JoinerDecision =
  | { decision: 'patch'; patchedSteps: Step[] }
  | { decision: 'proceed' }
  | { decision: 'clarify'; question: string }
  | { decision: 'abort' };

export interface JoinerRepairCtx {
  plan: Plan;
  violation: JoinerViolation;
  /** Human-readable summaries of the steps run so far this turn (e.g. each
   * `step.finished.summary`), for repair-prompt grounding. */
  summaries: string[];
  model: string;
  /** Needed for `llmCall`'s span/budget accounting — not part of the
   * prompt content itself. */
  turnId: string;
}

export interface JoinerRepairResult {
  decision: 'patch' | 'proceed' | 'clarify' | 'abort';
  /** Present only when `decision === 'patch'` — the caller bumps `planRev`
   * and splices these in; this module never mutates `planRev` itself. */
  patchedSteps?: Step[];
  /** Present only when `decision === 'clarify'`. */
  question?: string;
  usage: LlmUsage;
  spanId: string;
}

const JOINER_SYSTEM_PROMPT = `You are the joiner repair step for a CRM automation agent. A plan's
execution has hit a checkpoint violation: a step's declared expectation
about its result did not hold (e.g. a read that was expected to be
non-empty came back empty, or a filter zeroed out a non-empty input).
Respond with exactly one JSON object with ALL THREE of these fields
present — "decision" plus both "patchedSteps"/"question" — fully filling
in ONLY the ONE field that matches "decision": "patchedSteps" is the
empty array [] and "question" is null when they are not the active field:

  {"decision":"patch", "patchedSteps": [...Step], "question": null}
                                               // replace the FULL remaining
                                               // step array with a
                                               // corrected one
  {"decision":"proceed", "patchedSteps": [], "question": null}
                                               // the violation is actually
                                               // fine — continue as planned
  {"decision":"clarify", "patchedSteps": [], "question": "..."}
                                               // ask the user ONE focused
                                               // question before continuing
  {"decision":"abort", "patchedSteps": [], "question": null}
                                               // the request cannot be
                                               // salvaged; report honestly

Each Step in "patchedSteps" has this exact shape — ALL SIX fields always
present ("id"/"action"/"params"/"dependsOn"/"forEach"/"when"/"expects"),
using sentinel/null values for whichever of "forEach"/"when"/"expects"
don't apply (never omit a field):
  {
    "id": "s1",
    "action": "module.slug",
    "params": "{\\"key\\":\\"value\\"}",     // a JSON-ENCODED STRING (not
                                          // an object); "{}" if no params
    "dependsOn": ["s0"],
    "forEach": "$s2.items",               // "" if this step does not fan out
    "when": {"ref": "$s1.items", "op": "nonempty", "value": null},
                                          // "ref":"" if no guard condition
    "expects": {"nonEmpty": null, "maxCount": null, "minCount": null}
                                          // null for whichever of the 3 you
                                          // are not asserting
  }
Respond with the JSON object only. No prose, no markdown fences.`;

function buildJoinerPrompt(ctx: JoinerRepairCtx): string {
  return [
    'Original plan:',
    JSON.stringify(ctx.plan),
    '',
    'Violated expectation:',
    `Step '${ctx.violation.stepId}' expected ${ctx.violation.expect} but got ${ctx.violation.actual}.`,
    ctx.violation.summary,
    '',
    'Step summaries so far this turn:',
    ctx.summaries.length > 0 ? ctx.summaries.join('\n') : '(none yet)',
  ].join('\n');
}

/** One `llmCall` deciding how to respond to a `checkStratum` violation. */
export async function joinerRepair(ctx: JoinerRepairCtx): Promise<JoinerRepairResult> {
  const result: LlmCallResult<WireJoinerDecision> = await llmCall<WireJoinerDecision>({
    stage: 'repair',
    model: ctx.model,
    schema: wireJoinerDecisionSchema,
    system: JOINER_SYSTEM_PROMPT,
    prompt: buildJoinerPrompt(ctx),
    turnId: ctx.turnId,
  });

  let decision: JoinerDecision;
  try {
    decision = toJoinerDecision(result.value as WireJoinerDecision);
  } catch (err) {
    if (err instanceof FlatOutcomeShapeError) {
      // Same adapter-layer re-throw `planner.ts`'s `narrowFlatOutcome` uses
      // for the identical situation — reusing `pipeline.ts`'s EXISTING
      // `NoObjectGeneratedError.isInstance(err)` handling with zero new
      // pipeline logic.
      throw new NoObjectGeneratedError({
        message: err.message,
        cause: err,
        text: JSON.stringify(result.value),
        response: { id: result.spanId, timestamp: new Date(), modelId: ctx.model },
        usage: {
          inputTokens: result.usage.tokensIn,
          outputTokens: result.usage.tokensOut,
          totalTokens: result.usage.tokensIn + result.usage.tokensOut,
        },
        finishReason: 'other',
      });
    }
    throw err;
  }

  const out: JoinerRepairResult = {
    decision: decision.decision,
    usage: result.usage,
    spanId: result.spanId,
  };
  if (decision.decision === 'patch') out.patchedSteps = decision.patchedSteps;
  if (decision.decision === 'clarify') out.question = decision.question;
  return out;
}
