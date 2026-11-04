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
import { llmCall, type LlmCallResult } from '../llm/client.js';
import type { LlmUsage } from '../events/types.js';
import { parseRefGrammar } from './validator.js';
import { stepSchema, type Plan, type Step } from './plan-schema.js';

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

const joinerDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('patch'), patchedSteps: z.array(stepSchema) }),
  z.strictObject({ decision: z.literal('proceed') }),
  z.strictObject({ decision: z.literal('clarify'), question: z.string() }),
  z.strictObject({ decision: z.literal('abort') }),
]);
type JoinerDecision = z.infer<typeof joinerDecisionSchema>;

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
Decide exactly one of:
  {"decision":"patch","patchedSteps":[...]}   // replace the FULL remaining
                                               // step array with a corrected
                                               // one (same Step JSON shape)
  {"decision":"proceed"}                      // the violation is actually
                                               // fine — continue as planned
  {"decision":"clarify","question":"..."}     // ask the user ONE focused
                                               // question before continuing
  {"decision":"abort"}                        // the request cannot be
                                               // salvaged; report honestly
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
  const result: LlmCallResult<JoinerDecision> = await llmCall<JoinerDecision>({
    stage: 'repair',
    model: ctx.model,
    schema: joinerDecisionSchema,
    system: JOINER_SYSTEM_PROMPT,
    prompt: buildJoinerPrompt(ctx),
    turnId: ctx.turnId,
  });

  const decision = result.value as JoinerDecision;
  const out: JoinerRepairResult = {
    decision: decision.decision,
    usage: result.usage,
    spanId: result.spanId,
  };
  if (decision.decision === 'patch') out.patchedSteps = decision.patchedSteps;
  if (decision.decision === 'clarify') out.question = decision.question;
  return out;
}
