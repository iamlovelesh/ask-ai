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
 *
 * task-harness-fairness: `paramChecks` used to compare ONLY the plan's
 * literal `step.params[param]` text, which penalized a plan that legitimately
 * resolves an id via a ref (e.g. `"$s1.items[0].id"` → `"struct_200"` at
 * execution time) — the literal text never equals the resolved value, so
 * the check failed even though the agent did exactly the right thing.
 * `checkOneParam` now also checks the step's RESOLVED runtime params,
 * carried on `step.started.resolvedParams` (an additive/optional field on
 * the server's event payload — see `server/src/events/types.ts`); either
 * the literal plan match OR the resolved-value match is sufficient.
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
  // plandsl agent: complex iff the validated plan has >1 step.
  if (plan !== undefined) return plan.steps.length > 1;
  // Tool-loop agent (no plan.ready): it never emits a multi-step plan outcome,
  // so bucket by what it actually DID — a turn that dispatched more than one
  // action is a complex turn. Without this, every loop turn fell into "direct"
  // and the complex-latency bucket was always empty (n=0).
  return dispatchedActions(events).length > 1;
}

// --- planActions -------------------------------------------------------------

/** Actions actually dispatched this turn, in order — the plan-less (tool
 * loop) agent's equivalent of a plan's step list (task-harness-fairness:
 * a transcript with no `plan.ready` must not auto-fail plan checks). */
function dispatchedActions(events: readonly Event[]): string[] {
  return events
    .filter((e): e is Extract<Event, { t: 'step.started' }> => e.t === 'step.started')
    .map((e) => e.action);
}

function checkPlanActions(
  events: readonly Event[],
  expect: NonNullable<TurnExpect['planActions']>,
): AssertFailure[] {
  const planReady = findPlanReady(events);
  const plan = planReady ? planFromOutcome(planReady.outcome) : undefined;
  // Plan-less transcripts (tool-loop agent): assert against the actions
  // that actually RAN, in dispatch order.
  const actions = plan ? plan.steps.map((s) => s.action) : dispatchedActions(events);
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

/** Every `resolvedParams` entry (task-harness-fairness) that `step.started`
 * events recorded for a given plan step id — i.e. the FULLY RESOLVED
 * (ref-substituted) params the executor actually dispatched with. Empty for
 * a transcript from a build that predates the `resolvedParams` field (the
 * event payload addition is optional/additive), which just means resolved
 * matching degrades to "no resolved candidates" and literal matching is
 * still tried. */
function resolvedParamsForStep(events: readonly Event[], stepId: string): Record<string, unknown>[] {
  return events
    .filter((e): e is Extract<Event, { t: 'step.started' }> => e.t === 'step.started' && e.stepId === stepId)
    .flatMap((e) => e.resolvedParams ?? []);
}

function paramMatches(check: ParamCheck, actual: unknown): boolean {
  if (check.equals !== undefined) return deepEqual(actual, check.equals);
  if (check.contains !== undefined) return valueContains(actual, check.contains);
  return false;
}

function checkOneParam(plan: Plan | undefined, events: readonly Event[], check: ParamCheck): AssertFailure | undefined {
  const matchingSteps = (plan?.steps ?? []).filter((s) => s.action === check.action);
  if (matchingSteps.length === 0) {
    // Plan-less transcripts (tool-loop agent): check the RESOLVED runtime
    // params on any step.started events that dispatched this action.
    const dispatched = events.filter(
      (e): e is Extract<Event, { t: 'step.started' }> => e.t === 'step.started' && e.action === check.action,
    );
    if (dispatched.length > 0) {
      const satisfied = dispatched.some((e) => (e.resolvedParams ?? []).some((rp) => paramMatches(check, rp[check.param])));
      if (satisfied) return undefined;
      const seen = dispatched
        .flatMap((e) => e.resolvedParams ?? [])
        .map((rp) => JSON.stringify(rp[check.param] ?? null))
        .join(' | ');
      const expected = check.equals !== undefined ? `equals ${JSON.stringify(check.equals)}` : `contains ${JSON.stringify(check.contains)}`;
      return {
        kind: 'paramChecks',
        detail: `'${check.action}'.params.${check.param} expected to ${expected} — dispatched resolved-params saw [${seen}]`,
      };
    }
    return { kind: 'paramChecks', detail: `no step for action '${check.action}' in the plan or dispatched steps` };
  }

  // task-harness-fairness: a paramCheck passes if EITHER the plan's literal
  // `step.params[param]` matches (unchanged — a param that is a $ref string
  // is compared as-is here, no resolution attempted) OR the RESOLVED
  // runtime value recorded on that step's `step.started` event matches (a
  // plan that legitimately resolves ids via refs, e.g. "$s1.items[0].id" →
  // "struct_200" at runtime, must not fail a check written against the
  // resolved value — the two modes are either/or, not both-required). ANY
  // matching step satisfying either condition is enough to pass (a
  // forEach/multi-step plan may dispatch the same action several times).
  const satisfiedLiteral = matchingSteps.some((step) => paramMatches(check, step.params[check.param]));
  const satisfiedResolved = matchingSteps.some((step) =>
    resolvedParamsForStep(events, step.id).some((resolved) => paramMatches(check, resolved[check.param])),
  );

  if (satisfiedLiteral || satisfiedResolved) return undefined;

  const seenLiteral = matchingSteps.map((s) => JSON.stringify(s.params[check.param] ?? null)).join(' | ');
  const resolvedCandidates = matchingSteps.flatMap((s) => resolvedParamsForStep(events, s.id));
  const seenResolved =
    resolvedCandidates.length > 0
      ? resolvedCandidates.map((r) => JSON.stringify(r[check.param] ?? null)).join(' | ')
      : '(no step.started resolvedParams recorded)';
  const expected = check.equals !== undefined ? `equals ${JSON.stringify(check.equals)}` : `contains ${JSON.stringify(check.contains)}`;
  return {
    kind: 'paramChecks',
    detail: `'${check.action}'.params.${check.param} expected to ${expected} — plan-literal saw [${seenLiteral}], resolved-runtime saw [${seenResolved}]`,
  };
}

function checkParamChecks(events: readonly Event[], checks: readonly ParamCheck[]): AssertFailure[] {
  const plan = planFromOutcome(findPlanReady(events)?.outcome);
  const failures: AssertFailure[] = [];
  for (const check of checks) {
    const failure = checkOneParam(plan, events, check);
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

/** Removes thousands separators between digits ("3,372.33" -> "3372.33") so a
 * `mustMention` figure matches the answer regardless of digit-group formatting.
 * The figure IS mentioned — only the locale formatting differs — and the
 * NumberCheck rail already validates figures against tool output, so this is a
 * formatting-tolerant presence check, not a loosening of what must be said. */
function normalizeFigures(s: string): string {
  let prev = s;
  // repeat to collapse multi-group numbers like "1,234,567"
  for (let next = s.replace(/(\d),(\d)/g, '$1$2'); next !== prev; next = prev.replace(/(\d),(\d)/g, '$1$2')) {
    prev = next;
  }
  return prev;
}

function checkResponse(events: readonly Event[], expect: NonNullable<TurnExpect['response']>): AssertFailure[] {
  const finalText = (findAnswerFinal(events)?.text ?? '').toLowerCase();
  const finalTextNorm = normalizeFigures(finalText);
  const failures: AssertFailure[] = [];

  for (const phrase of expect.mustMention ?? []) {
    const p = phrase.toLowerCase();
    if (!finalText.includes(p) && !finalTextNorm.includes(normalizeFigures(p))) {
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
    const allowed = Array.isArray(expect.status) ? expect.status : [expect.status];
    if (actualStatus === undefined || !allowed.includes(actualStatus)) {
      failures.push({
        kind: 'behavior',
        detail: `expected turn status ${allowed.map((s) => `'${s}'`).join(' or ')}, got '${actualStatus ?? '(no turn.completed)'}'`,
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
