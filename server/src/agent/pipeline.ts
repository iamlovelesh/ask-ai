/**
 * Agent pipeline (LLD §5, §2.3 event sequence): `runTurn()` wires the whole
 * agent together — fold → rewrite → retrieve → route → plan → validate
 * (repair ≤2) → execute (joiner checkpoints, replan ≤2) → compose —
 * enforcing `agent/validator.ts`'s `BUDGETS` (≤6 LLM calls/turn, ≤2 search
 * rounds, 120s wall clock) and emitting the full LLD §2.3 event sequence.
 *
 * Every emitted `Event` is both (a) persisted/fanned-out via
 * `sessionDeps.eventLog.append` (the REAL live channel — Task 15's SSE
 * subscribes to `eventLog.subscribe`, not to this generator) and (b)
 * yielded from this generator, in the same order, for direct consumption
 * (tests, or any caller that just wants to drain `runTurn` itself). Because
 * `execute()` is a single `await` that reports intermediate events via a
 * synchronous callback rather than by yielding, this module buffers those
 * callback events and replays them (already emitted/persisted in real
 * time) immediately after `execute()` resolves — the ORDER is exact, only
 * the yield timing relative to execution is deferred.
 */

import { createHash } from 'node:crypto';
import { NoObjectGeneratedError } from 'ai';
import type { Registry } from '../catalog/registry.js';
import type { Crm } from '../store/db.js';
import { VirtualClock } from '../store/clock.js';
import type { RefStore } from './refs.js';
import type { EventLog, SeqEvent } from '../events/log.js';
import type { Event, LlmUsage, TurnMetrics, TurnStatus } from '../events/types.js';
import {
  execute,
  type ConfirmBroker,
  type ExecuteInput,
  type ExecutionResult,
  type StepFailureCtx,
  type WriteStratumCtx,
  type WriteStratumDecision,
} from './executor.js';
import { retrieve, renderCards, type Card, type SessionCtx } from './retrieval.js';
import type { Playbook } from '../playbooks/loader.js';
import { matchPlaybook } from '../playbooks/loader.js';
import { buildPlannerPrompt, plan as plannerPlan, narrowFlatOutcome, type PlannerPromptCtx, type PlanResult } from './planner.js';
import { validate, repairPrompt, BUDGETS, type HandleRef, type Provenance, type ValidationError } from './validator.js';
import { checkStratum, joinerRepair, type JoinerViolation } from './joiner.js';
import { compose, shouldPolish, POLISH_SYSTEM, polishPrompt, polishPreservesFacts, type ComposeInput, type ComposeStepState } from './composer.js';
import {
  foldMemory,
  renderWorkingState,
  maskTurns,
  rewriteQuery,
  type WorkingState,
  type TurnTranscript,
} from './memory.js';
import { llmCall, BudgetExceededError } from '../llm/client.js';
import { flatPlanOutcomeSchema, type FlatPlanOutcome, type Plan, type PlanOutcome, type Step } from './plan-schema.js';
import { pickPlannerModel, escalate, fastModel, plannerModel, repairEscalationModel } from '../llm/router.js';
import { getDefaultSpans } from '../events/trace.js';

// --- public contract (Task 13) ----------------------------------------------

export interface SessionDeps {
  registry: Registry;
  crm: Crm;
  refs: RefStore;
  eventLog: EventLog;
  confirm: ConfirmBroker;
  playbooks: Playbook[];
  /** Reserved for Task 14's baseline agent to share `SessionDeps`' shape —
   * `runTurn` itself only ever implements the optimized path. */
  agent?: 'optimized';
  /** Test-only override of `BUDGETS.turnTimeoutMs` (LLD §5.1's 120_000ms is
   * too long to exercise in a unit test). Production callers omit this —
   * it defaults to the canonical budget. */
  turnTimeoutMs?: number;
}

export interface RunTurnInput {
  sessionId: string;
  turnId: string;
  userText: string;
  sessionDeps: SessionDeps;
}

export interface TurnResult {
  status: TurnStatus;
  metrics: TurnMetrics;
}

// --- small pure helpers ------------------------------------------------------

/** `answer.delta` chunk size (brief: "~80-char chunks fine"). */
const DELTA_CHUNK_CHARS = 80;

/** Hard ceiling on the conversational-reply polish call (Feature C). On
 * timeout the pipeline silently keeps the template text — a slow polish must
 * never delay a turn's answer beyond this. */
const POLISH_TIMEOUT_MS = 5000;

function chunkText(text: string, size = DELTA_CHUNK_CHARS): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/** Deterministic hash for a NON-plan `PlanOutcome` (search/clarify/
 * unsupported/respond) — `plan.ready.planHash` is non-optional on the
 * `Event` type even though `validate()`'s `Valid.planHash` is only ever set
 * for `kind:'plan'`; hashing the decided outcome itself keeps the field
 * meaningful (a content fingerprint of what was decided this round) rather
 * than a dummy constant. */
function hashOutcome(outcome: PlanOutcome): string {
  return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
}

/** Rebuilds the per-turn transcripts `agent/memory.ts`'s `maskTurns` needs
 * from a session's raw event history. */
function buildTranscripts(events: readonly SeqEvent[]): TurnTranscript[] {
  const byTurn = new Map<string, TurnTranscript>();
  const order: string[] = [];
  for (const { event: ev } of events) {
    if (ev.t === 'turn.started') {
      if (!byTurn.has(ev.turnId)) {
        byTurn.set(ev.turnId, { turnId: ev.turnId, userText: ev.userText, steps: [] });
        order.push(ev.turnId);
      }
    } else if (ev.t === 'step.finished') {
      byTurn.get(ev.turnId)?.steps.push({ summary: ev.summary });
    } else if (ev.t === 'answer.final') {
      const t = byTurn.get(ev.turnId);
      if (t) t.answer = ev.text;
    }
  }
  return order.map((id) => byTurn.get(id) as TurnTranscript);
}

/** Retrieval's session-continuity signals (LLD §4), derived from the same
 * raw event history rather than kept as separate session state. */
function buildSessionCtx(events: readonly SeqEvent[]): SessionCtx {
  const usedActionSlugs = new Set<string>();
  const activeModules = new Set<string>();
  for (const { event: ev } of events) {
    if (ev.t === 'step.started') {
      usedActionSlugs.add(ev.action);
      const dot = ev.action.indexOf('.');
      activeModules.add(dot >= 0 ? ev.action.slice(0, dot) : ev.action);
    }
  }
  return { usedActionSlugs: [...usedActionSlugs], activeModules: [...activeModules] };
}

/** Merges retrieval over every `search` query (LLD §5.3 outcome: the
 * planner names what it's looking for, not a single string) — dedup by
 * slug, keep the best score, re-sort, cap at the same TOP_K `retrieve()`
 * itself uses (20). */
function mergeRetrieval(queries: readonly string[], session: SessionCtx): Card[] {
  const bySlug = new Map<string, Card>();
  for (const q of queries) {
    for (const card of retrieve(q, session).cards) {
      const existing = bySlug.get(card.slug);
      if (!existing || card.score > existing.score) bySlug.set(card.slug, card);
    }
  }
  return [...bySlug.values()].sort((a, b) => b.score - a.score).slice(0, 20);
}

// --- turn budget tracking (LLD §5.1 BUDGETS.maxLlmCallsPerTurn, across
// plan+search+repair+replan — one counter for the whole turn) ---------------

class TurnBudget {
  llmCalls = 0;
  repairs = 0;
  replans = 0;
  searchRounds = 0;
  planRev = 0;
  tokensIn = 0;
  tokensOut = 0;
  costUsd = 0;
  /** Engine-wave E7: ms spent awaiting confirmation decisions — excluded
   * from the turn deadline (both the executor's own check and this budget's
   * `timedOut`, which guards in-execution LLM calls like joiner replans). */
  gateWaitMs = 0;

  readonly deadlineAtMs: number;

  constructor(
    startedAtMs: number,
    readonly turnTimeoutMs: number,
  ) {
    this.deadlineAtMs = startedAtMs + turnTimeoutMs;
  }

  exceeded(): boolean {
    return this.llmCalls >= BUDGETS.maxLlmCallsPerTurn;
  }

  /** LLD §5.3 "loop until all terminal or TIMEOUT" / §5.1 `turnTimeoutMs` —
   * real wall-clock (`performance.now()`), never the pinned `VirtualClock`. */
  timedOut(): boolean {
    return performance.now() - this.gateWaitMs >= this.deadlineAtMs;
  }

  record(usage: LlmUsage): void {
    this.llmCalls += 1;
    this.tokensIn += usage.tokensIn;
    this.tokensOut += usage.tokensOut;
    this.costUsd += usage.costUsd;
  }

  /** Counts an LLM call that WAS made (a real request went out) but threw
   * before producing a usable result — e.g. `NoObjectGeneratedError` — so
   * it still consumes a slot in `maxLlmCallsPerTurn`, even though there's
   * no `LlmUsage` to add to tokens/cost. */
  recordFailedCall(): void {
    this.llmCalls += 1;
  }

  describeReason(reason: BudgetReason): string {
    if (reason === 'callBudget') return `LLM call budget exceeded for this turn (max ${BUDGETS.maxLlmCallsPerTurn} calls).`;
    if (reason === 'timeout') return `Turn exceeded its ${this.turnTimeoutMs}ms wall-clock budget (turnTimeoutMs).`;
    return 'The session cost budget (EVAL_BUDGET_USD) was exceeded.';
  }
}

type BudgetReason = 'callBudget' | 'costBudget' | 'timeout';
type BudgetedCall<T> = { ok: true; value: T } | { ok: false; reason: BudgetReason };

/** The two non-LLM-specific pre-call gates every LLM-consuming call shares:
 * the call-count ceiling and the turn's wall-clock deadline. Shared by
 * `callBudgeted` and `attemptPlannerCall` so both enforce identically. */
function budgetPreCheck(budget: TurnBudget): 'ok' | 'callBudget' | 'timeout' {
  if (budget.exceeded()) return 'callBudget';
  if (budget.timedOut()) return 'timeout';
  return 'ok';
}

/** Wraps every LLM-consuming call (search-replan/repair/joinerRepair) with
 * the SAME enforcement points: (1) refuse to even dial out once
 * `maxLlmCallsPerTurn` is reached — this is what makes "the 7th scripted
 * call never happens" true; (2) refuse once the turn's wall-clock deadline
 * has passed (LLD §5.1 `turnTimeoutMs`); (3) catch `BudgetExceededError`
 * (the process-wide $ ceiling `llm/client.ts` enforces) so it NEVER escapes
 * as an uncaught exception — LLD: "BudgetExceededError anywhere →
 * turn.completed{status:'failed'}... never a crash." */
async function callBudgeted<T extends { usage: LlmUsage }>(
  budget: TurnBudget,
  fn: () => Promise<T>,
): Promise<BudgetedCall<T>> {
  const pre = budgetPreCheck(budget);
  if (pre !== 'ok') return { ok: false, reason: pre };
  try {
    const value = await fn();
    budget.record(value.usage);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof BudgetExceededError) return { ok: false, reason: 'costBudget' };
    throw err;
  }
}

// --- planning phase (plan → search loop → repair loop) ----------------------

type PlanningOutcome =
  | { kind: 'ready'; outcome: PlanOutcome; planHash?: string; stepOrder?: string[] }
  | { kind: 'failed'; reason: string };

type PlanAttempt =
  | { outcome: 'ok'; result: PlanResult }
  | { outcome: 'budget'; reason: BudgetReason }
  | { outcome: 'parseError'; message?: string };

/**
 * One attempt at the TOP-level planner call (the initial call, or a
 * re-plan after a `search` round — never repair/joinerRepair, which
 * already always use `escalate(model)`). Distinguishes a budget/timeout
 * refusal from a genuine parse/validation failure
 * (`NoObjectGeneratedError` — the AI SDK's catch-all for "the model's
 * response didn't parse or didn't validate against the schema", the
 * failure mode most likely to hit a weak `FAST_MODEL`) so the caller can
 * decide whether an escalated retry is worth trying. A caught parse error
 * still counts toward `maxLlmCallsPerTurn` (a real request went out, it
 * just didn't produce a usable `PlanOutcome`).
 */
async function attemptPlannerCall(
  budget: TurnBudget,
  ctx: PlannerPromptCtx,
  turnId: string,
  model: string,
): Promise<PlanAttempt> {
  const pre = budgetPreCheck(budget);
  if (pre !== 'ok') return { outcome: 'budget', reason: pre };
  try {
    const result = await plannerPlan({ ...ctx, turnId }, model);
    budget.record(result.usage);
    return { outcome: 'ok', result };
  } catch (err) {
    if (err instanceof BudgetExceededError) return { outcome: 'budget', reason: 'costBudget' };
    if (NoObjectGeneratedError.isInstance(err)) {
      budget.recordFailedCall();
      const message = err instanceof Error ? err.message : undefined;
      return message !== undefined ? { outcome: 'parseError', message } : { outcome: 'parseError' };
    }
    throw err;
  }
}

interface PlanningPhaseArgs {
  turnId: string;
  baseCtx: PlannerPromptCtx;
  model: string;
  shortlist: Set<string>;
  session: SessionCtx;
  registry: Registry;
  handleRefs: readonly HandleRef[];
  budget: TurnBudget;
  /** Engine-wave E4: id-provenance context (known ids + text the planner
   * saw) so a fabricated literal id is caught. */
  provenance: Provenance;
  /** Fix 3: the pinned `VirtualClock`'s "now" (ms), threaded into every
   * `validate()` call here so a relative `@…` date-expression param
   * resolves against the turn's ACTUAL pinned time, never a fresh
   * `VirtualClock`'s default (same value today, but this is the correct
   * place to source it from). */
  nowMs: number;
  emit: (e: Event) => void;
  /** Called exactly once, at the moment a VALID plan's `plan.ready` is
   * emitted — never for search/clarify/unsupported/respond (LLD metrics:
   * "ttfurMs ... plan.ready for plan turns, answer.delta for
   * respond/clarify"). */
  markPlanReady: () => void;
}

async function runPlanningPhase(args: PlanningPhaseArgs): Promise<PlanningOutcome> {
  const { turnId, model, registry, handleRefs, budget, emit, nowMs } = args;
  let ctx = args.baseCtx;
  let shortlist = args.shortlist;
  let searchRounds = 0;
  // P6: at most one MECHANICAL search+replan is forced before an
  // `unsupported` the planner volunteered (without asking to search) is
  // allowed to stand.
  let autoSearchUsed = false;

  for (;;) {
    let attempt = await attemptPlannerCall(budget, ctx, turnId, model);
    if (attempt.outcome === 'parseError' && budgetPreCheck(budget) === 'ok') {
      // Engine-wave E8(a): a NoObjectGeneratedError (the model didn't emit a
      // schema-conforming JSON object at all) gets exactly ONE structured
      // retry — on the full PLANNER_MODEL, with the parse error + an explicit
      // "return ONLY the JSON object" appended to the request. Fires
      // regardless of which model was routed first (not only FAST_MODEL), and
      // still counts against maxLlmCallsPerTurn/budget via attemptPlannerCall.
      const note =
        `\n\n[RETRY: your previous reply could not be parsed as the required JSON` +
        `${attempt.message ? ` (${attempt.message})` : ''}. Return ONLY the JSON object ` +
        `with ALL SIX fields ("kind"/"plan"/"queries"/"question"/"reason"/"text") — ` +
        `no prose, no explanation, no markdown fences.]`;
      const retryCtx = { ...ctx, rewrittenRequest: `${ctx.rewrittenRequest}${note}` };
      attempt = await attemptPlannerCall(budget, retryCtx, turnId, plannerModel());
    }
    if (attempt.outcome === 'parseError') {
      return {
        kind: 'failed',
        reason: 'The planner returned a response that could not be parsed or validated against the schema, and no further escalation is available.',
      };
    }
    if (attempt.outcome === 'budget') return { kind: 'failed', reason: budget.describeReason(attempt.reason) };
    const rawOutcome = attempt.result.outcome;
    let llmUsage = attempt.result.usage;

    if (rawOutcome.kind === 'search' && searchRounds < BUDGETS.maxSearchRounds) {
      searchRounds += 1;
      budget.searchRounds += 1;
      budget.planRev += 1;
      const ev: Event = {
        t: 'search',
        turnId,
        round: searchRounds,
        reason: rawOutcome.queries.join(' | '),
        llm: llmUsage,
      };
      emit(ev);
      const merged = mergeRetrieval(rawOutcome.queries, args.session);
      shortlist = new Set(merged.map((c) => c.slug));
      ctx = { ...ctx, cards: renderCards(merged) };
      continue;
    }

    // P6 (mechanical search-before-refuse): a volunteered `unsupported` with
    // search budget still available is NOT accepted on the planner's word —
    // round-2 showed the planner giving up ("no reports module", "can only
    // look up companies… cannot look up a company") while the very action
    // that answers the request (opportunities.search_opportunities,
    // companies.search_companies) sat in the candidate list. Force ONE real
    // retrieval round on the rewritten + raw request and re-plan; only if it
    // comes back `unsupported` AGAIN does the refusal stand. Budget-respecting
    // (counts a search round) and at most once per turn.
    if (
      rawOutcome.kind === 'unsupported' &&
      !autoSearchUsed &&
      searchRounds < BUDGETS.maxSearchRounds &&
      budgetPreCheck(budget) === 'ok'
    ) {
      autoSearchUsed = true;
      searchRounds += 1;
      budget.searchRounds += 1;
      budget.planRev += 1;
      emit({ t: 'search', turnId, round: searchRounds, reason: 'auto-retry before refusing', llm: llmUsage });
      const merged = mergeRetrieval([ctx.rewrittenRequest, ctx.rawRequest], args.session);
      shortlist = new Set(merged.map((c) => c.slug));
      const nudge =
        `\n\n[A capability search has already been run for this request. The candidate ` +
        `actions below DO include read/search actions for the relevant entities — build a ` +
        `plan using them (optionally with core.* ops) if ANY combination can satisfy the ` +
        `request. Only answer "unsupported" if no combination genuinely can.]`;
      ctx = { ...ctx, cards: renderCards(merged), rewrittenRequest: `${ctx.rewrittenRequest}${nudge}` };
      continue;
    }

    const outcome: PlanOutcome =
      rawOutcome.kind === 'search'
        ? { kind: 'unsupported', reason: "I couldn't find a way to do that with the actions available to me." }
        : rawOutcome;

    if (outcome.kind !== 'plan') {
      // `plan.ready` is REUSED here, not a separate event — LLD §2.3's
      // event union only has ONE "the planning phase settled" event, and it
      // carries whatever `PlanOutcome` was decided (search/clarify/
      // unsupported/respond included, not only `kind:'plan'`); see
      // `hashOutcome`'s doc comment for why `planHash` is a content hash
      // rather than `validate()`'s real plan hash in this branch.
      const ev: Event = {
        t: 'plan.ready',
        turnId,
        outcome,
        planRev: budget.planRev,
        planHash: hashOutcome(outcome),
        llm: llmUsage,
      };
      emit(ev);
      return { kind: 'ready', outcome };
    }

    // kind === 'plan' → validate, repair loop (LLD §5.1 maxRepairs:2).
    let candidateOutcome: PlanOutcome = outcome;
    let repairs = 0;
    // Fix C (task-refconverge): bounded, ONCE-per-turn escalation past the
    // normal repair model when round ≥2 is STILL triggered by a ref-path/
    // grammar issue that round 1's repair didn't clear.
    let refRepairEscalated = false;
    for (;;) {
      const verdict = validate(candidateOutcome, shortlist, handleRefs, registry, args.provenance, nowMs);
      if (verdict.ok) {
        const planHash = verdict.planHash as string;
        const ev: Event = {
          t: 'plan.ready',
          turnId,
          outcome: verdict.outcome,
          planRev: budget.planRev,
          planHash,
          llm: llmUsage,
          ...(verdict.autofixes && verdict.autofixes.length > 0 ? { refAutofixes: verdict.autofixes } : {}),
        };
        emit(ev);
        args.markPlanReady();
        const ready: PlanningOutcome = { kind: 'ready', outcome: verdict.outcome, planHash };
        if (verdict.stepOrder) ready.stepOrder = verdict.stepOrder;
        return ready;
      }
      if (repairs >= BUDGETS.maxRepairs) {
        return {
          kind: 'failed',
          reason: `Plan repair exhausted after ${BUDGETS.maxRepairs} attempt(s): ${describeErrors(verdict.errors)}`,
        };
      }
      repairs += 1;
      budget.repairs += 1;
      budget.planRev += 1;
      // LLD §5.5 "misroute escalates via validator failure" — repair
      // normally uses the full planner model, regardless of what was
      // routed initially. Fix C (task-refconverge): when round ≥2 is
      // STILL a ref-path/grammar issue (round 1's repair didn't clear it),
      // escalate ONE level further, to `REPAIR_ESCALATION_MODEL`
      // (default claude-sonnet-4.5, ~$0.015/call) — at most once per turn,
      // and only on turns that would otherwise be heading for repair
      // exhaustion. `BUDGETS.maxLlmCallsPerTurn`/the cost meter are still
      // enforced exactly as for any other repair call, via `callBudgeted`
      // below — this only changes WHICH model name is dialed.
      // Engine-wave E8(b): escalation is STICKY. The first time a round ≥2 is
      // still a ref-path/grammar issue, flip to REPAIR_ESCALATION_MODEL — and
      // STAY there for every remaining repair round this turn. (Previously it
      // escalated for exactly ONE round then regressed to haiku and looped on
      // multistep-enrollments — round2 escalated, rounds 3-4 back on haiku,
      // identical errors.)
      const isRefIssue = verdict.errors.some((e) => e.code === 'REF_PATH_MISMATCH' || e.code === 'REF_GRAMMAR');
      if (!refRepairEscalated && repairs >= 2 && isRefIssue) refRepairEscalated = true;
      const repairModel = refRepairEscalated ? repairEscalationModel() : escalate(model);
      const plannerSystem = buildPlannerPrompt(ctx).system;
      const repairPlan = verdict.plan ?? (candidateOutcome as Extract<PlanOutcome, { kind: 'plan' }>).plan;
      const promptText = repairPrompt(repairPlan, verdict.errors);
      // `schema: flatPlanOutcomeSchema`, not `planOutcomeSchema` — the same
      // root-level-`oneOf` cross-provider defect fixed in `planner.ts`'s
      // `plan()` applies here too (this is the OTHER place that ever asks
      // a real provider for a `PlanOutcome` directly); `narrowFlatOutcome`
      // (exported by `planner.ts`, reused rather than duplicated) converts
      // back to `PlanOutcome` below.
      const repairAttempt = await callBudgeted(budget, () =>
        llmCall<FlatPlanOutcome>({
          stage: 'repair',
          model: repairModel,
          schema: flatPlanOutcomeSchema,
          system: plannerSystem,
          prompt: promptText,
          turnId,
        }),
      );
      if (!repairAttempt.ok) return { kind: 'failed', reason: budget.describeReason(repairAttempt.reason) };
      const repairEvent: Event = {
        t: 'repair',
        turnId,
        round: repairs,
        reason: describeErrors(verdict.errors),
        llm: repairAttempt.value.usage,
      };
      emit(repairEvent);
      candidateOutcome = narrowFlatOutcome(repairAttempt.value.value as FlatPlanOutcome, {
        model: repairModel,
        usage: repairAttempt.value.usage,
        spanId: repairAttempt.value.spanId,
      });
      llmUsage = repairAttempt.value.usage;
    }
  }
}

function describeErrors(errors: readonly ValidationError[]): string {
  return errors.map((e) => `${e.stepId ? `[${e.stepId}] ` : ''}${e.code}`).join(', ');
}

// --- composer-input mapping for each terminal path --------------------------

function composeInputFor(
  outcome: Exclude<PlanOutcome, { kind: 'plan' }>,
): { composeInput: ComposeInput | undefined; finalText?: string; status: TurnStatus } {
  if (outcome.kind === 'respond') {
    return { composeInput: undefined, finalText: outcome.text, status: 'done' };
  }
  if (outcome.kind === 'clarify') {
    return { composeInput: { outcome: 'clarify', question: outcome.question }, status: 'clarify' };
  }
  // 'unsupported' — and defensively 'search', which `runPlanningPhase`
  // never actually returns (it always resolves a trailing `search` to a
  // synthetic `unsupported` first), but the `PlanOutcome` union doesn't
  // statically know that.
  const reason =
    outcome.kind === 'unsupported'
      ? outcome.reason
      : "I couldn't find a way to do that with the actions available to me.";
  return { composeInput: { outcome: 'refused', reason }, status: 'refused' };
}

function composeInputForExecution(
  plan: Plan,
  result: ExecutionResult,
): { composeInput: ComposeInput; status: TurnStatus } {
  const stepStates: Record<string, ComposeStepState> = {};
  for (const [id, rec] of Object.entries(result.stepStates)) stepStates[id] = rec;

  switch (result.status) {
    case 'done':
      return { composeInput: { outcome: 'done', plan, stepStates }, status: 'done' };
    case 'cancelled':
      return {
        composeInput: { outcome: 'cancelled', plan, stepStates, reason: 'A confirmation was denied.' },
        status: 'cancelled',
      };
    case 'halted':
      return {
        composeInput: {
          outcome: 'halted',
          plan,
          stepStates,
          reason: 'This action failed repeatedly with the same error — a different approach is needed.',
        },
        status: 'failed',
      };
    case 'clarify':
      return {
        composeInput: { outcome: 'clarify', question: result.clarifyQuestion ?? 'Could you clarify your request?' },
        status: 'clarify',
      };
    default: {
      const composeInput: ComposeInput = { outcome: 'failed', plan, stepStates };
      if (result.abortReason !== undefined) composeInput.reason = result.abortReason;
      return { composeInput, status: 'failed' };
    }
  }
}

// --- runTurn -----------------------------------------------------------------

export async function* runTurn(input: RunTurnInput): AsyncGenerator<Event, TurnResult> {
  const { sessionId, turnId, userText, sessionDeps } = input;
  const { registry, crm, refs, eventLog, confirm, playbooks } = sessionDeps;
  const clock = new VirtualClock();
  const startedAtMs = performance.now();
  const budget = new TurnBudget(startedAtMs, sessionDeps.turnTimeoutMs ?? BUDGETS.turnTimeoutMs);
  // LLD §2.4 span kinds: this turn's span sink, shared process-wide (Task 19
  // carry-forward — `llm/client.ts`'s llmCall writes kind:'llm' spans onto
  // the SAME default sink; this adds retrieval/compose/joiner here, and
  // step spans via `executeInput.spans` below).
  const spans = getDefaultSpans();

  // first-useful-event timestamp for TTFUR (LLD: plan.ready for plan-led
  // turns, first answer.delta for respond/clarify/refused/failed turns).
  let ttfurAtMs: number | undefined;

  const emit = (e: Event): void => {
    eventLog.append(sessionId, e);
  };

  const buffer: Event[] = [];
  function record(e: Event): void {
    emit(e);
    buffer.push(e);
  }

  /**
   * Feature C (flag-gated): rewrite the composed template text into a
   * natural assistant reply with ONE extra `FAST_MODEL` call, hard-bounded
   * by `POLISH_TIMEOUT_MS`. Returns the polished text, or `null` to signal
   * "keep the template" on ANY failure/timeout/budget issue (the call's
   * `.catch`, an empty/whitespace result, or the timeout winning the race).
   * The extra call, when it succeeds, is recorded into the turn budget so
   * metrics stay honest. A timed-out call's late cost is NOT back-counted
   * (metrics are already finalized by then) — it keeps the `.catch` so no
   * unhandled rejection escapes.
   */
  async function polishReply(templateText: string): Promise<string | null> {
    const call = llmCall<string>({
      stage: 'compose',
      model: fastModel(),
      system: POLISH_SYSTEM,
      prompt: polishPrompt(templateText),
      turnId,
      maxOutputTokens: 512,
    })
      .then((r) => ({ ok: true as const, r }))
      .catch(() => ({ ok: false as const }));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ ok: false }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false }), POLISH_TIMEOUT_MS);
    });

    const raced = await Promise.race([call, timeout]);
    if (timer) clearTimeout(timer);
    if (!raced.ok) return null;

    budget.record(raced.r.usage);
    const out = typeof raced.r.value === 'string' ? raced.r.value.trim() : '';
    return out.length > 0 ? out : null;
  }

  async function* finalize(status: TurnStatus, composeInput: ComposeInput | undefined, finalTextOverride?: string, stepsOk = 0, stepsFailed = 0): AsyncGenerator<Event, TurnResult> {
    // Drain every event `record()` accumulated so far (turn.started,
    // retrieval.done, plan.ready, search/repair/replan rounds, and — for a
    // plan-led turn — every executor callback event) in the order it
    // actually happened. These were already emitted (persisted + fanned
    // out) in real time via `record`'s own `emit()` call; this only mirrors
    // them into THIS generator's yield stream.
    for (const e of buffer.splice(0, buffer.length)) yield e;

    // compose span (LLD §2.4 kind:'compose') — only when `compose()` is
    // actually invoked; a `'respond'` outcome supplies `finalTextOverride`
    // directly and never calls the (pure, template-only) composer.
    let text: string;
    if (finalTextOverride !== undefined) {
      text = finalTextOverride;
    } else {
      const input = composeInput as ComposeInput;
      const composeSpan = spans.start({ turnId, kind: 'compose', name: 'compose' });
      const templateText = compose(input);
      spans.end(composeSpan, { meta: { outcome: input.outcome } });
      text = templateText;
      // Feature C: conversational reply polish (flag-gated, default off).
      // On ANY failure/timeout/budget issue this silently keeps the
      // template text — see `polishReply`.
      if (shouldPolish(input.outcome)) {
        const polished = await polishReply(templateText);
        // P2 fact-preservation backstop: discard a polish that introduces any
        // number/date/amount absent from the grounded template (an invented
        // count, a fabricated figure, a false success claim) and keep the
        // template text instead.
        if (polished !== null && polishPreservesFacts(templateText, polished)) text = polished;
      }
    }
    for (const chunk of chunkText(text)) {
      if (ttfurAtMs === undefined) ttfurAtMs = performance.now();
      const ev: Event = { t: 'answer.delta', turnId, text: chunk };
      emit(ev);
      yield ev;
    }
    if (ttfurAtMs === undefined) ttfurAtMs = performance.now();

    const finalEv: Event = { t: 'answer.final', turnId, text };
    emit(finalEv);
    yield finalEv;

    const totalMs = performance.now() - startedAtMs;
    const metrics: TurnMetrics = {
      ttfurMs: ttfurAtMs - startedAtMs,
      totalMs,
      llmCalls: budget.llmCalls,
      repairs: budget.repairs,
      replans: budget.replans,
      searchRounds: budget.searchRounds,
      tokensIn: budget.tokensIn,
      tokensOut: budget.tokensOut,
      costUsd: budget.costUsd,
      stepsOk,
      stepsFailed,
      ...(budget.gateWaitMs > 0 ? { gateWaitMs: budget.gateWaitMs } : {}),
    };
    const completedEv: Event = { t: 'turn.completed', turnId, status, metrics };
    emit(completedEv);
    yield completedEv;

    const newState = foldMemory(eventLog.list(sessionId));
    const snapEv: Event = { t: 'memory.snapshot', turnId, state: newState };
    emit(snapEv);
    yield snapEv;

    eventLog.touchSession(sessionId, {
      turns: 1,
      tokens: budget.tokensIn + budget.tokensOut,
      costUsd: budget.costUsd,
    });

    return { status, metrics };
  }

  // The ENTIRE pipeline body runs under one top-level guard: ANY unexpected
  // error (a bug, a DB failure, an `ai` SDK error that isn't
  // `BudgetExceededError`/`NoObjectGeneratedError` — anything at all) is
  // caught here and routed through `finalize('failed', ...)` rather than
  // left to crash the generator. Without this, a turn that hits e.g. a
  // schema-parse failure the planning-phase retry couldn't recover from
  // would propagate all the way out with NO `turn.completed` and NO
  // `memory.snapshot` ever emitted — exactly the failure mode this guards
  // against (every turn, however it ends, gets both).
  try {
    // --- 1. fold prior events → WorkingState; rewrite ONCE; retrieve -------

    const priorEvents = eventLog.list(sessionId);
    const priorState: WorkingState = foldMemory(priorEvents);
    const transcripts = buildTranscripts(priorEvents);
    const sessionCtx = buildSessionCtx(priorEvents);

    record({ t: 'turn.started', turnId, sessionId, userText, ts: clock.now() });

    const rewrittenQuery = rewriteQuery(userText, priorState);

    // retrieval span (LLD §2.4 kind:'retrieval') — `ms` is NOT re-measured
    // here; it's derived from `retrieval.ms`, the real wall-clock duration
    // `agent/retrieval.ts`'s `retrieve()` already measures internally
    // (`performance.now()`), so the span's duration matches the SAME
    // number `retrieval.done.ms` reports rather than a second, slightly
    // different measurement of the same call.
    const retrievalSpan = spans.start({ turnId, kind: 'retrieval', name: 'retrieval' });
    const retrieval = retrieve(rewrittenQuery, sessionCtx);
    spans.end(retrievalSpan, {
      endedAt: retrievalSpan.startedAt + retrieval.ms,
      meta: { candidates: retrieval.cards.length },
    });
    const matched = matchPlaybook(rewrittenQuery, playbooks);
    const retrievalEvent: Event = {
      t: 'retrieval.done',
      turnId,
      candidates: retrieval.cards.map((c) => c.slug),
      ms: retrieval.ms,
    };
    if (matched) retrievalEvent.playbook = matched.name;
    record(retrievalEvent);

    const shortlist = new Set(retrieval.cards.map((c) => c.slug));
    const handleRefs: HandleRef[] = priorState.handles.map((h) => ({ ref: h.ref, entityType: h.entityType }));

    // Engine-wave E9: the acting user, resolved to "<id> (<name>)" so the
    // planner can map me/my/I. DEMO_USER_ID (default user_1); name looked up
    // from the CRM at context-build time (best-effort — id alone if absent).
    const demoUserId = process.env['DEMO_USER_ID'] || 'user_1';
    let currentUser = demoUserId;
    try {
      const nameRow = crm.tx((db) => db.get('SELECT name FROM users WHERE id = ?', [demoUserId]));
      const name = nameRow?.['name'];
      if (typeof name === 'string' && name.length > 0) currentUser = `${demoUserId} (${name})`;
    } catch {
      // no users table / lookup failure → fall back to the bare id
    }

    const baseCtx: PlannerPromptCtx = {
      workingStateBlock: renderWorkingState(priorState),
      maskedTurns: maskTurns(transcripts),
      cards: renderCards(retrieval.cards),
      rewrittenRequest: rewrittenQuery,
      rawRequest: userText,
      nowIso: clock.iso(),
      currentUser,
    };
    if (matched) baseCtx.playbookBody = matched.body;

    const model = pickPlannerModel({
      rewrittenQuery,
      topCardScore: retrieval.cards[0]?.score ?? 0,
      cardCount: retrieval.cards.length,
    });

    // Engine-wave E4: id-provenance context. `knownIds` = entity ids the
    // planner legitimately has in working memory; the "seen text" is every
    // string the planner is shown this turn (raw request + masked transcript
    // + working-state block + the current_user line), so an id anywhere in
    // its context counts as provenanced — only a truly fabricated id (seen
    // nowhere) is flagged. P5: `current_user` (the acting user's id, resolved
    // from "me"/"my"/"I") is a legitimately-known id the planner is shown in
    // <context>; it MUST be provenanced or the P4 guard would reject a plan
    // that correctly writes it into a `host_user_id`/`owner_id`/`assignee_id`
    // param (marketing F10: "make me the host").
    const knownIds = new Set(Object.values(priorState.entities).map((e) => e.id));
    knownIds.add(demoUserId);
    const provenance: Provenance = {
      knownIds,
      userText: [userText, baseCtx.maskedTurns, baseCtx.workingStateBlock, currentUser].join('\n'),
    };

    // --- 2. plan (+ search/repair loops) ------------------------------------

    const planning = await runPlanningPhase({
      turnId,
      baseCtx,
      model,
      shortlist,
      session: sessionCtx,
      registry,
      handleRefs,
      budget,
      provenance,
      nowMs: clock.now(),
      emit: record,
      markPlanReady: () => {
        if (ttfurAtMs === undefined) ttfurAtMs = performance.now();
      },
    });

    if (planning.kind === 'failed') {
      return yield* finalize('failed', { outcome: 'failed', reason: planning.reason });
    }

    const outcome = planning.outcome;

    if (outcome.kind !== 'plan') {
      const { composeInput, finalText, status } = composeInputFor(outcome);
      return yield* finalize(status, composeInput, finalText);
    }

    // --- 3. execute (joiner checkpoints, replan ≤2) -------------------------

    const plan = outcome.plan;
    const planHash = planning.planHash as string;
    const stepOrder = planning.stepOrder ?? plan.steps.map((s) => s.id);

    let replanRounds = 0;

    /** Everything `onWriteStratum` does once `checkStratum` has already
     * found a violation — extracted so the caller can wrap exactly this
     * (the repair/decision work) in a 'joiner' span without a span around
     * every early return. */
    async function resolveJoinerViolation(
      ctx: WriteStratumCtx,
      violation: JoinerViolation,
    ): Promise<WriteStratumDecision> {
      if (replanRounds >= BUDGETS.maxReplans) {
        return {
          decision: 'abort',
          reason: `Joiner checkpoint violated and the replan budget (${BUDGETS.maxReplans}) is exhausted: ${violation.summary}`,
        };
      }
      replanRounds += 1;

      const repairModel = escalate(model);
      const summaries = buffer
        .filter((e): e is Extract<Event, { t: 'step.finished' }> => e.t === 'step.finished')
        .map((e) => e.summary);
      const attempt = await callBudgeted(budget, () =>
        joinerRepair({ plan: ctx.plan, violation, summaries, model: repairModel, turnId }),
      );
      if (!attempt.ok) {
        return { decision: 'abort', reason: budget.describeReason(attempt.reason) };
      }
      budget.replans += 1;
      const repairResult = attempt.value;
      const replanEvent: Event = {
        t: 'replan',
        turnId,
        round: replanRounds,
        reason: violation.summary,
        llm: repairResult.usage,
      };
      record(replanEvent);

      if (repairResult.decision === 'proceed') return { decision: 'proceed' };
      if (repairResult.decision === 'clarify') {
        return { decision: 'clarify', question: repairResult.question ?? 'Could you clarify your request?' };
      }
      if (repairResult.decision === 'abort') {
        return { decision: 'abort', reason: violation.summary };
      }

      // decision === 'patch' → re-validate the patched steps against the
      // registry BEFORE handing them back to the executor (LLD §5.4's
      // "patch (bumps planRev)" — the executor adopts planRev, this
      // callback computes it). Approximation: "kept" steps are those with
      // a recorded result at this checkpoint — good enough for a sanity
      // re-check; the executor itself computes the authoritative
      // kept/terminal set from its own step-lifecycle map when it applies
      // the patch.
      const keptSteps = ctx.plan.steps.filter((s) => Object.prototype.hasOwnProperty.call(ctx.completed, s.id));
      const candidatePlan: Plan = { goal: ctx.plan.goal, steps: [...keptSteps, ...(repairResult.patchedSteps as Step[])] };
      const revalidated = validate(
        { kind: 'plan', plan: candidatePlan },
        shortlist,
        handleRefs,
        registry,
        provenance,
        clock.now(),
      );
      if (!revalidated.ok) {
        return {
          decision: 'abort',
          reason: `Patched plan failed re-validation: ${describeErrors(revalidated.errors)}`,
        };
      }
      budget.planRev += 1;
      return { decision: 'patch', patchedSteps: repairResult.patchedSteps as Step[], planRev: budget.planRev };
    }

    const onWriteStratum = async (ctx: WriteStratumCtx): Promise<WriteStratumDecision> => {
      const verdict = checkStratum(ctx.plan, ctx.completed, ctx.upcoming);
      if (verdict.ok) return { decision: 'proceed' };

      // 'joiner' span (LLD §2.4) — deliberately only around the violation
      // path: `checkStratum`'s free pass (`verdict.ok`, the common case)
      // never gets a span, so a clean write-bearing stratum stays
      // span-free.
      const joinerSpan = spans.start({
        turnId,
        kind: 'joiner',
        name: 'joiner',
        meta: { stepId: verdict.violation.stepId, expect: verdict.violation.expect },
      });
      const decision = await resolveJoinerViolation(ctx, verdict.violation);
      spans.end(joinerSpan, { meta: { stepId: verdict.violation.stepId, decision: decision.decision } });
      return decision;
    };

    /** TRIAGE C1 residual: a runtime NOT_FOUND on a step with downstream
     * dependents routes the fabricated/unresolved id through ONE replan round
     * (reusing the joiner repair machinery + replan budget). The synthesized
     * violation carries the targeted hint: resolve the entity by name via the
     * module's list/search action and reference its result, never the
     * non-existent id. */
    const onStepFailure = async (ctx: StepFailureCtx): Promise<WriteStratumDecision> => {
      const violation: JoinerViolation = {
        stepId: ctx.failedStep.id,
        expect: 'resolvedEntityId',
        actual: `NOT_FOUND: ${ctx.error.message}`,
        summary:
          `Step '${ctx.failedStep.id}' (${ctx.failedStep.action}) failed at runtime with NOT_FOUND — ` +
          `the id "${ctx.error.message}" does not exist (it was likely typed in or inferred from a name ` +
          `rather than resolved). Resolve the entity by name/email via the module's list/search action and ` +
          `reference its result with a $ref, then retry '${ctx.failedStep.action}' and its dependents. ` +
          `Do not reuse the non-existent id.`,
      };
      return resolveJoinerViolation({ plan: ctx.plan, completed: ctx.completed, upcoming: [] }, violation);
    };

    const executeInput: ExecuteInput = {
      plan,
      planHash,
      planRev: budget.planRev,
      stepOrder,
      turnId,
      sessionId,
      registry,
      crm,
      refs,
      handles: priorState.handles,
      onEvent: record,
      confirm,
      onWriteStratum,
      onStepFailure,
      deadlineAtMs: budget.deadlineAtMs,
      onGateWait: (ms) => {
        budget.gateWaitMs += ms;
      },
      spans,
    };

    const execResult = await execute(executeInput);

    const stepsOk = Object.values(execResult.stepStates).filter((s) => s.state === 'done').length;
    const stepsFailed = Object.values(execResult.stepStates).filter((s) => s.state === 'failed').length;

    const { composeInput, status } = composeInputForExecution(plan, execResult);
    return yield* finalize(status, composeInput, undefined, stepsOk, stepsFailed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return yield* finalize('failed', { outcome: 'failed', reason: `Unexpected error: ${message}` });
  }
}
