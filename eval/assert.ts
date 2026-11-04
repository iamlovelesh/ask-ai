/**
 * Assertion engine (Task 16, LLD §9.1/§9.2): evaluates one scenario turn's
 * `expect` block against the turn's event transcript (+ the CRM db, for
 * `state` checks). Pure/synchronous apart from the `SqlDb.get` calls
 * `state` checks make — no HTTP, no process spawning; `eval/runner.ts`
 * drives the real server and hands this module the resulting events.
 *
 * Event shapes are imported directly from `server/src/events/types.ts` —
 * the same cross-workspace-relative-import convention `eval/smoke.ts`
 * already uses (`tsx` resolves both packages' TS directly; there is no
 * build step between them).
 */

import type { Event, Plan, PlanOutcome } from '../server/src/events/types.js';
import { type SqlDb, scalarOf, numericScalarOf } from './db.js';
import type { ParamCheck, StateCheck, TurnExpect } from './types.js';

export interface AssertFailure {
  kind: 'planActions' | 'paramChecks' | 'state' | 'response' | 'behavior';
  detail: string;
}

export interface AssertResult {
  pass: boolean;
  failures: AssertFailure[];
}

// --- small event-transcript helpers -----------------------------------------

function findPlanReady(events: readonly Event[]): Extract<Event, { t: 'plan.ready' }> | undefined {
  return events.find((e): e is Extract<Event, { t: 'plan.ready' }> => e.t === 'plan.ready');
}

function findAnswerFinal(events: readonly Event[]): Extract<Event, { t: 'answer.final' }> | undefined {
  return events.find((e): e is Extract<Event, { t: 'answer.final' }> => e.t === 'answer.final');
}

function findTurnCompleted(events: readonly Event[]): Extract<Event, { t: 'turn.completed' }> | undefined {
  return events.find((e): e is Extract<Event, { t: 'turn.completed' }> => e.t === 'turn.completed');
}

function planFromOutcome(outcome: PlanOutcome | undefined): Plan | undefined {
  return outcome && outcome.kind === 'plan' ? outcome.plan : undefined;
}

/** `true` iff the turn's `plan.ready` outcome is a multi-step plan
 * (LLD §9.2 / `docs/TARGETS.md` §1's direct/complex bucketing — kept here
 * too since `assert.ts`'s behavior checks don't need it, but `report.ts`
 * and tests both want ONE canonical implementation). */
export function isComplexTurn(events: readonly Event[]): boolean {
  const plan = planFromOutcome(findPlanReady(events)?.outcome);
  return plan !== undefined && plan.steps.length > 1;
}

// --- planActions -------------------------------------------------------------

function checkPlanActions(
  events: readonly Event[],
  expect: NonNullable<TurnExpect['planActions']>,
): AssertFailure[] {
  const planReady = findPlanReady(events);
  if (!planReady) {
    const needsPlan = (expect.mustInclude?.length ?? 0) > 0;
    return needsPlan ? [{ kind: 'planActions', detail: 'no plan.ready event was emitted this turn' }] : [];
  }
  const plan = planFromOutcome(planReady.outcome);
  const actions = plan ? plan.steps.map((s) => s.action) : [];
  const failures: AssertFailure[] = [];

  const mustInclude = expect.mustInclude ?? [];
  const missing = mustInclude.filter((slug) => !actions.includes(slug));
  if (missing.length > 0) {
    failures.push({
      kind: 'planActions',
      detail: `plan is missing required action(s) [${missing.join(', ')}] — plan had [${actions.join(', ')}]`,
    });
  }

  const mustNotInclude = expect.mustNotInclude ?? [];
  const present = mustNotInclude.filter((slug) => actions.includes(slug));
  if (present.length > 0) {
    failures.push({
      kind: 'planActions',
      detail: `plan includes forbidden action(s) [${present.join(', ')}]`,
    });
  }

  // orderFree defaults to true; `false` requires mustInclude to appear as
  // an in-order SUBSEQUENCE of the actual steps (not necessarily
  // contiguous or exhaustive).
  if (expect.orderFree === false && missing.length === 0 && mustInclude.length > 1) {
    let cursor = 0;
    for (const slug of mustInclude) {
      const idx = actions.indexOf(slug, cursor);
      if (idx === -1) {
        failures.push({
          kind: 'planActions',
          detail: `plan actions [${actions.join(', ')}] do not contain [${mustInclude.join(', ')}] in order`,
        });
        break;
      }
      cursor = idx + 1;
    }
  }

  return failures;
}

// --- paramChecks -------------------------------------------------------------

function valueContains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return actual.toLowerCase().includes(String(expected).toLowerCase());
  if (Array.isArray(actual)) return actual.some((v) => deepEqual(v, expected));
  return JSON.stringify(actual ?? null).toLowerCase().includes(JSON.stringify(expected).toLowerCase());
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkOneParam(plan: Plan | undefined, check: ParamCheck): AssertFailure | undefined {
  const matchingSteps = (plan?.steps ?? []).filter((s) => s.action === check.action);
  if (matchingSteps.length === 0) {
    return { kind: 'paramChecks', detail: `no step for action '${check.action}' in the plan` };
  }

  // "resolved where literal" (LLD §9.1): a step param that is a $ref string
  // is compared AS-IS — this engine never attempts runtime ref resolution.
  // ANY matching step satisfying the condition is enough to pass (a
  // forEach/multi-step plan may dispatch the same action several times).
  const satisfied = matchingSteps.some((step) => {
    const actual = step.params[check.param];
    if (check.equals !== undefined) return deepEqual(actual, check.equals);
    if (check.contains !== undefined) return valueContains(actual, check.contains);
    return false;
  });

  if (satisfied) return undefined;

  const seen = matchingSteps.map((s) => JSON.stringify(s.params[check.param] ?? null)).join(' | ');
  const expected = check.equals !== undefined ? `equals ${JSON.stringify(check.equals)}` : `contains ${JSON.stringify(check.contains)}`;
  return {
    kind: 'paramChecks',
    detail: `'${check.action}'.params.${check.param} expected to ${expected}, saw [${seen}]`,
  };
}

function checkParamChecks(events: readonly Event[], checks: readonly ParamCheck[]): AssertFailure[] {
  const plan = planFromOutcome(findPlanReady(events)?.outcome);
  const failures: AssertFailure[] = [];
  for (const check of checks) {
    const failure = checkOneParam(plan, check);
    if (failure) failures.push(failure);
  }
  return failures;
}

// --- state --------------------------------------------------------------------

/** Pre-turn snapshot values for every `state` check that needs one
 * (`countDelta` only — `equals`/`gte`/`lte` are evaluated purely
 * post-turn). Index-aligned with `expect.state`; `undefined` for checks
 * that don't use `countDelta`. `eval/runner.ts` calls this BEFORE posting
 * the turn's message. */
export function snapshotStateChecks(db: SqlDb, checks: readonly StateCheck[] | undefined): (number | undefined)[] {
  if (!checks) return [];
  return checks.map((check) =>
    check.countDelta === undefined ? undefined : numericScalarOf(db.get(check.query), check.query),
  );
}

function checkOneState(db: SqlDb, check: StateCheck, before: number | undefined): AssertFailure | undefined {
  const row = db.get(check.query);

  if (check.countDelta !== undefined) {
    const after = numericScalarOf(row, check.query);
    const beforeValue = before ?? 0;
    const delta = after - beforeValue;
    if (delta !== check.countDelta) {
      return {
        kind: 'state',
        detail: `countDelta mismatch for '${check.query}': expected ${check.countDelta >= 0 ? '+' : ''}${check.countDelta}, got ${delta >= 0 ? '+' : ''}${delta} (before=${beforeValue}, after=${after})`,
      };
    }
  }

  if (check.equals !== undefined) {
    const actual = scalarOf(row);
    if (!deepEqual(actual, check.equals)) {
      return { kind: 'state', detail: `equals mismatch for '${check.query}': expected ${JSON.stringify(check.equals)}, got ${JSON.stringify(actual)}` };
    }
  }

  if (check.gte !== undefined) {
    const actual = numericScalarOf(row, check.query);
    if (!(actual >= check.gte)) {
      return { kind: 'state', detail: `gte mismatch for '${check.query}': expected >= ${check.gte}, got ${actual}` };
    }
  }

  if (check.lte !== undefined) {
    const actual = numericScalarOf(row, check.query);
    if (!(actual <= check.lte)) {
      return { kind: 'state', detail: `lte mismatch for '${check.query}': expected <= ${check.lte}, got ${actual}` };
    }
  }

  return undefined;
}

function checkState(db: SqlDb, checks: readonly StateCheck[], before: readonly (number | undefined)[]): AssertFailure[] {
  const failures: AssertFailure[] = [];
  checks.forEach((check, i) => {
    const failure = checkOneState(db, check, before[i]);
    if (failure) failures.push(failure);
  });
  return failures;
}

// --- response -----------------------------------------------------------------

function checkResponse(events: readonly Event[], expect: NonNullable<TurnExpect['response']>): AssertFailure[] {
  const finalText = (findAnswerFinal(events)?.text ?? '').toLowerCase();
  const failures: AssertFailure[] = [];

  for (const phrase of expect.mustMention ?? []) {
    if (!finalText.includes(phrase.toLowerCase())) {
      failures.push({ kind: 'response', detail: `answer.final did not mention '${phrase}'` });
    }
  }
  for (const phrase of expect.mustNotClaim ?? []) {
    if (finalText.includes(phrase.toLowerCase())) {
      failures.push({ kind: 'response', detail: `answer.final wrongly claimed '${phrase}'` });
    }
  }
  return failures;
}

// --- behavior -------------------------------------------------------------------

function clarifyQuestionOf(events: readonly Event[]): string | undefined {
  const planReady = findPlanReady(events);
  if (planReady && planReady.outcome.kind === 'clarify') return planReady.outcome.question;
  // A replan-path clarify (LLD §5.4 joiner `decision:'clarify'`) never gets
  // its own PlanOutcome — the only surfaced text is the composed answer.
  const completed = findTurnCompleted(events);
  if (completed?.status === 'clarify') return findAnswerFinal(events)?.text;
  return undefined;
}

function checkBehavior(events: readonly Event[], expect: NonNullable<TurnExpect['behavior']>): AssertFailure[] {
  const failures: AssertFailure[] = [];

  if (expect.confirmation !== undefined) {
    const hasConfirmation = events.some((e) => e.t === 'confirmation.required');
    if (hasConfirmation !== expect.confirmation) {
      failures.push({
        kind: 'behavior',
        detail: `expected confirmation.required to be ${expect.confirmation ? 'present' : 'absent'}, was ${hasConfirmation ? 'present' : 'absent'}`,
      });
    }
  }

  if (expect.clarify !== undefined) {
    const isClarify = findTurnCompleted(events)?.status === 'clarify';
    if (isClarify !== expect.clarify) {
      failures.push({
        kind: 'behavior',
        detail: `expected turn status ${expect.clarify ? "'clarify'" : "not 'clarify'"}, got '${findTurnCompleted(events)?.status ?? '(no turn.completed)'}'`,
      });
    }
  }

  // I2 (Task 16 review): the EXACT expected `turn.completed.status`.
  // `confirmation`/`clarify` above are convenience shorthands that each
  // only pin down ONE bit of the 5-way status — neither can distinguish
  // a genuine `'refused'` outcome from an outright `'failed'` pipeline
  // error (both have no confirmation and aren't `'clarify'`), which is
  // exactly the gap that let an `unsupported`-category scenario pass
  // vacuously against a turn that silently crashed instead of actually
  // refusing. Use `status` whenever a scenario cares which EXACT outcome
  // occurred.
  if (expect.status !== undefined) {
    const actualStatus = findTurnCompleted(events)?.status;
    if (actualStatus !== expect.status) {
      failures.push({
        kind: 'behavior',
        detail: `expected turn status '${expect.status}', got '${actualStatus ?? '(no turn.completed)'}'`,
      });
    }
  }

  if (expect.mustNotAsk && expect.mustNotAsk.length > 0) {
    const question = (clarifyQuestionOf(events) ?? '').toLowerCase();
    const reasked = expect.mustNotAsk.filter((term) => question.includes(term.toLowerCase()));
    if (reasked.length > 0) {
      failures.push({
        kind: 'behavior',
        detail: `clarify question re-asked known field(s) [${reasked.join(', ')}]: "${question}"`,
      });
    }
  }

  return failures;
}

// --- global backstop (I3, Task 16 review) ------------------------------------

/**
 * Runs UNCONDITIONALLY, regardless of what `expect` declares (even a
 * turn with NO `behavior` block at all): `turn.completed.status ===
 * 'failed'` is an automatic failure unless the scenario explicitly wrote
 * `behavior.status: 'failed'` to say "yes, I expect this turn to fail
 * outright." Without this, a scenario whose assertions happen to still be
 * satisfiable against a crashed/failed turn (e.g. a `response.mustMention`
 * that trivially matches empty text, or no `response`/`behavior` checks
 * at all) would silently "pass" on a pipeline bug that has nothing to do
 * with what the scenario was actually testing.
 */
function checkFailedStatusBackstop(events: readonly Event[], expect: TurnExpect): AssertFailure[] {
  const completed = findTurnCompleted(events);
  if (completed?.status === 'failed' && expect.behavior?.status !== 'failed') {
    return [
      {
        kind: 'behavior',
        detail: "turn.completed.status === 'failed' — an unexpected pipeline failure (a scenario that genuinely expects this must assert behavior.status:'failed' explicitly)",
      },
    ];
  }
  return [];
}

// --- public entry point ------------------------------------------------------

/**
 * Evaluates one turn's `expect` block. `before` must be
 * `snapshotStateChecks(db, expect.state)`'s result, captured by the caller
 * BEFORE the turn was posted to the server.
 */
export function assertTurn(
  events: readonly Event[],
  expect: TurnExpect,
  db: SqlDb,
  before: readonly (number | undefined)[] = [],
): AssertResult {
  const failures: AssertFailure[] = [...checkFailedStatusBackstop(events, expect)];

  if (expect.planActions) failures.push(...checkPlanActions(events, expect.planActions));
  if (expect.paramChecks) failures.push(...checkParamChecks(events, expect.paramChecks));
  if (expect.state) failures.push(...checkState(db, expect.state, before));
  if (expect.response) failures.push(...checkResponse(events, expect.response));
  if (expect.behavior) failures.push(...checkBehavior(events, expect.behavior));

  return { pass: failures.length === 0, failures };
}
