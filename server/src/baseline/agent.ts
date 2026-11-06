/**
 * Baseline agent (LLD §8) — the "summarized-catalog + dispatch-tool ReAct"
 * benchmark comparator. One model, one tool (`call_action{slug,params}`),
 * the FULL action catalog resent verbatim in every step's system prompt
 * (`baseline/catalog-summary.ts`) rather than the optimized agent's
 * retrieval-shortlisted ~20-card context — that repetition IS the baseline's
 * defining cost/latency trade-off, not an oversight.
 *
 * Deliberately NOT the optimized `agent/pipeline.ts`: there is no Plan DSL,
 * no retrieval, no planner/validator/joiner/repair machinery, no model
 * routing (always `PLANNER_MODEL` — LLD §8 "runnable on every matrix
 * model"), and no cross-turn `$ref` grammar (every `call_action` param is a
 * plain JSON literal the model copies from a prior step's observation, or
 * types in from the user's request). What IS shared with the optimized
 * agent, verbatim:
 *   - the SAME confirmation gate predicate (`agent/executor.ts`'s exported
 *     `shouldGate` — risk ∈ {destructive,bulk,external} OR affectedCount >
 *     `BUDGETS.confirmTargetThreshold`);
 *   - the SAME handler execution path (`crm.tx` + `ActionContext`) and
 *     idempotency key scheme, here `${turnId}:0:b${step}:0` (baseline has
 *     no `planRev` to increment, hence the constant `0`; `b${step}` is the
 *     ReAct step counter, 1-based);
 *   - the SAME `Event` vocabulary and wire shapes, so Task 15's SSE/UI
 *     renders a baseline turn with the exact same components as an
 *     optimized one (`turn.started`, `step.started`/`step.finished`/
 *     `step.failed`, `confirmation.required`/`confirmation.resolved`,
 *     `answer.delta`/`answer.final`, `turn.completed`, `memory.snapshot`).
 *
 * Event-shape notes specific to this agent:
 *   - `plan.ready`/`repair`/`replan`/`search`/`retrieval.done` are NEVER
 *     emitted — there is no planning phase to report on.
 *   - `confirmation.required.planRev` is always `0` and `.planHash` is a
 *     constant sha256 of `turnId` for the whole turn — both fields exist
 *     only to satisfy the SHARED `Event` union's required shape; neither
 *     carries real "which plan revision" semantics the way the optimized
 *     executor's does (there is no Plan DSL revision to track).
 *   - `TurnMetrics.repairs`/`.replans`/`.searchRounds` are always `0`.
 *   - `memory.snapshot.state` is always `emptyWorkingState()` — LLD §8/the
 *     Task 14 brief: "NOT required for baseline — emit it anyway as
 *     empty-state for event-shape uniformity." The baseline never folds a
 *     `WorkingState` (no frame/entities/handles model); this keeps every
 *     turn, baseline or optimized, ending with the same event shape.
 *   - no automatic TRANSIENT retry and no "stuck ×3/×4" detection (LLD §5.3
 *     is an EXECUTOR behavior): the baseline's whole premise is that the
 *     MODEL itself sees every error as a tool observation and decides
 *     whether to retry, adjust params, or give up — folding in the
 *     executor's deterministic retry/halt logic would blur exactly the
 *     comparison the baseline exists to provide.
 *   - TTFUR (`metrics.ttfurMs`) is measured at the EARLIER of: the first
 *     tool-intent event this turn emits (`confirmation.required` if the
 *     first dispatched call gates, else `step.started`) or the first
 *     `answer.delta` chunk — LLD §8: "first assistant-visible token or
 *     first tool-intent event." See `markTtfur()` below for the single
 *     call site this invariant funnels through.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Registry } from '../catalog/registry.js';
import { ActionError, type ActionContext, type ActionDef } from '../catalog/types.js';
import type { Crm } from '../store/db.js';
import { VirtualClock } from '../store/clock.js';
import type { RefStore } from '../agent/refs.js';
import type { EventLog } from '../events/log.js';
import type { ConfirmationScope, Event, LlmUsage, TurnMetrics, TurnStatus } from '../events/types.js';
import { shouldGate, type ConfirmBroker } from '../agent/executor.js';
import { emptyWorkingState } from '../agent/memory.js';
import type { TurnResult } from '../agent/pipeline.js';
import { llmCall } from '../llm/client.js';
import { plannerModel } from '../llm/router.js';
import { buildCatalogSummary } from './catalog-summary.js';
import { getDefaultSpans, type SpanHandle } from '../events/trace.js';

// --- public contract ---------------------------------------------------------

/** The subset of the optimized agent's `SessionDeps` (`agent/pipeline.ts`)
 * the baseline actually needs — structurally compatible, so Task 15's HTTP
 * layer can hold ONE deps object and route to either `runTurn` or
 * `runBaselineTurn` based on a session's `agent` field without reshaping
 * anything. */
export interface BaselineSessionDeps {
  registry: Registry;
  crm: Crm;
  refs: RefStore;
  eventLog: EventLog;
  confirm: ConfirmBroker;
}

export interface RunBaselineTurnInput {
  sessionId: string;
  turnId: string;
  userText: string;
  sessionDeps: BaselineSessionDeps;
}

// --- loop budget (LLD §8: AI SDK `stopWhen: stepCountIs(12)`) ---------------

const MAX_BASELINE_STEPS = 12;

// --- the dispatch-tool decision schema ---------------------------------------
//
// The LLD prescribes an AI SDK tool loop with ONE dispatch tool
// (`call_action{slug,params}`); this module hand-rolls the equivalent loop
// on top of `llmCall` + a tool-call JSON convention (the alternative the
// Task 14 brief explicitly allows) rather than wiring the AI SDK's native
// `tools`/`stopWhen` machinery through `generateText`. Rationale: `llmCall`
// already gives every call site (planner/joiner/baseline) uniform span +
// cost + backoff accounting and an OFFLINE test seam
// (`__setTestFetch`/`queueMockLlm`) that replays `generateObject`-shaped
// JSON — reusing it here means the baseline's tests need NO new mock
// infrastructure, and its usage/cost flows through the EXACT SAME
// accounting path as every other LLM call in this codebase. The schema
// below *is* `call_action{slug,params}` — one discriminated union member
// per the tool's single action plus the loop's natural "I'm done" exit.

// WIRE schema: flat object with sentinel fields — the same provider-safe
// construct the optimized planner uses (docs/SPIKES.md §1b/§1c: root
// discriminated unions map to `oneOf` and free-form records map to
// empty-schema `additionalProperties`, both rejected by Anthropic/OpenAI
// structured-output endpoints). `paramsJson` is a JSON-encoded string the
// adapter parses; '' sentinels mean "absent".
const baselineWireSchema = z.object({
  kind: z.enum(['call_action', 'final']),
  slug: z.string(), // '' when kind='final'
  paramsJson: z.string(), // '{}' or '' when kind='final'
  text: z.string(), // '' when kind='call_action'
});

type BaselineDecision =
  | { kind: 'call_action'; slug: string; params: Record<string, unknown> }
  | { kind: 'final'; text: string };

function toBaselineDecision(wire: z.infer<typeof baselineWireSchema>): BaselineDecision {
  if (wire.kind === 'final') return { kind: 'final', text: wire.text };
  let params: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(wire.paramsJson === '' ? '{}' : wire.paramsJson);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      params = parsed as Record<string, unknown>;
    }
  } catch {
    // leave {} — the registry validation downstream reports the bad params
    // back into the observation history, same as any other invalid input.
  }
  return { kind: 'call_action', slug: wire.slug, params };
}

// --- system prompt (instructions + FULL catalog, resent every step) --------

const INSTRUCTIONS = `You are a CRM automation agent. You have access to EXACTLY ONE tool,
"call_action", which invokes a named action from the catalog below with a
JSON params object. On every turn you must respond with EXACTLY one JSON
object, no prose, no markdown fences:

  {"kind":"call_action","slug":"<module.action_name>","paramsJson":"{\\"status\\":\\"new\\"}","text":""}
  {"kind":"final","slug":"","paramsJson":"","text":"<your final answer to the user>"}

Rules:
- ALWAYS include all four fields (kind, slug, paramsJson, text); use "" for
  the ones your kind does not need.
- "slug" MUST be copied EXACTLY as written in the catalog below (a
  "module.action_name" string) — never invent, abbreviate, or guess a slug.
- "paramsJson" is a JSON-ENCODED STRING containing the params object for
  that action — literals only; there is no ref syntax here. If you need an
  id you saw in an earlier step's result, copy it as a literal string.
- After each call_action you will be shown the result (or error) as an
  observation, then asked to decide again. Use that observation to decide
  your next step.
- If an action you called failed or does not exist, read the error and
  either correct your call or choose a different action — do not repeat an
  identical failing call.
- Some actions require user confirmation before they run (destructive,
  bulk, or wide-reaching changes); if confirmation is denied, the action was
  NOT executed — say so honestly in your final answer, do not claim it
  happened.
- You have at most ${MAX_BASELINE_STEPS} steps total, including failed or
  invalid attempts — work efficiently.
- Respond with {"kind":"final",...} as soon as you have enough information
  to answer the user, or when no further action would help. Be honest about
  partial progress or failures — never fabricate a result you did not
  actually obtain from a call_action result.

Below is the full action catalog, grouped by module. Each line is
"slug: one-line description".`;

/** `instructions + <catalog>` — deterministic for a given `registry` (the
 * catalog is the only moving part), so this is the SAME string sent as the
 * SYSTEM prompt on every one of a turn's `MAX_BASELINE_STEPS` calls — LLD
 * §8: "resent per step — that's the point of the baseline." */
function buildBaselineSystemPrompt(registry: Registry): string {
  const catalog = buildCatalogSummary(registry);
  return `${INSTRUCTIONS}\n\n<catalog>\n${catalog}\n</catalog>`;
}

function buildUserPrompt(userText: string, nowIso: string, history: readonly string[]): string {
  const historyBlock = history.length === 0 ? '(no steps taken yet)' : history.join('\n');
  return [
    '<request>',
    userText,
    '</request>',
    '',
    '<context>',
    `now: ${nowIso}`,
    '</context>',
    '',
    '<history>',
    historyBlock,
    '</history>',
    '',
    'Decide the NEXT step now. Respond with exactly one JSON object as',
    'described above — no prose, no markdown fences.',
  ].join('\n');
}

// --- small pure helpers (deliberately local, NOT imported from executor.ts —
// the baseline's params are already-literal JSON, never `$ref` strings, so
// there is no ref-resolution environment to share) --------------------------

const DELTA_CHUNK_CHARS = 80;

function chunkText(text: string, size = DELTA_CHUNK_CHARS): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/** Deepest array length anywhere inside `value` — the baseline equivalent
 * of `executor.ts`'s `resolveValue`'s `maxArrayLen` instrumentation, minus
 * the ref-resolution it's built to track (baseline params are already
 * plain JSON by the time this runs). Used for the SAME `affectedCount`
 * formula the executor uses: `isWrite ? max(len,1) : len`. */
function maxArrayLength(value: unknown): number {
  if (Array.isArray(value)) {
    let max = value.length;
    for (const v of value) max = Math.max(max, maxArrayLength(v));
    return max;
  }
  if (value !== null && typeof value === 'object') {
    let max = 0;
    for (const v of Object.values(value as Record<string, unknown>)) max = Math.max(max, maxArrayLength(v));
    return max;
  }
  return 0;
}

function countRows(result: unknown): number {
  if (result !== null && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o['total'] === 'number') return o['total'];
    if (Array.isArray(o['items'])) return o['items'].length;
  }
  return 1;
}

interface SpillMarker {
  __spill: true;
  total: number;
  sample: unknown[];
}

function isSpill(x: unknown): x is SpillMarker {
  return (
    x !== null &&
    typeof x === 'object' &&
    (x as { __spill?: unknown }).__spill === true &&
    Array.isArray((x as { sample?: unknown }).sample)
  );
}

function rowId(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const id = (row as Record<string, unknown>)['id'];
  return id === undefined || id === null ? undefined : String(id);
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof ActionError) return { code: err.code, message: err.message };
  return { code: 'VALIDATION', message: err instanceof Error ? err.message : String(err) };
}

// --- runBaselineTurn ----------------------------------------------------------

export async function* runBaselineTurn(input: RunBaselineTurnInput): AsyncGenerator<Event, TurnResult> {
  const { sessionId, turnId, userText, sessionDeps } = input;
  const { registry, crm, refs, eventLog, confirm } = sessionDeps;
  const clock = new VirtualClock();
  const startedAtMs = performance.now();
  // LLD §2.4 kind:'step' spans, one per dispatched `call_action` — same
  // shared default sink `agent/pipeline.ts`'s retrieval/compose/joiner
  // spans and `llm/client.ts`'s kind:'llm' spans write onto, so a baseline
  // turn's trace waterfall is populated the same way an optimized turn's is
  // (LLD §8's "same Event vocabulary" extended to spans).
  const spans = getDefaultSpans();
  const model = plannerModel(); // LLD §8: no routing — always PLANNER_MODEL.
  const system = buildBaselineSystemPrompt(registry);
  // Synthetic — see this module's header comment on `planRev`/`planHash`.
  const planHash = createHash('sha256').update(turnId).digest('hex');

  let ttfurAtMs: number | undefined;
  function markTtfur(): void {
    if (ttfurAtMs === undefined) ttfurAtMs = performance.now();
  }

  let llmCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  function recordUsage(usage: LlmUsage): void {
    llmCalls += 1;
    tokensIn += usage.tokensIn;
    tokensOut += usage.tokensOut;
    costUsd += usage.costUsd;
  }

  const emit = (e: Event): void => {
    eventLog.append(sessionId, e);
  };
  const buffer: Event[] = [];
  function record(e: Event): void {
    emit(e);
    buffer.push(e);
  }

  let stepsOk = 0;
  let stepsFailed = 0;

  async function* finalize(status: TurnStatus, finalText: string): AsyncGenerator<Event, TurnResult> {
    for (const e of buffer.splice(0, buffer.length)) yield e;

    for (const chunk of chunkText(finalText)) {
      markTtfur();
      const ev: Event = { t: 'answer.delta', turnId, text: chunk };
      emit(ev);
      yield ev;
    }
    markTtfur();

    const finalEv: Event = { t: 'answer.final', turnId, text: finalText };
    emit(finalEv);
    yield finalEv;

    const totalMs = performance.now() - startedAtMs;
    const metrics: TurnMetrics = {
      ttfurMs: (ttfurAtMs as number) - startedAtMs,
      totalMs,
      llmCalls,
      repairs: 0,
      replans: 0,
      searchRounds: 0,
      tokensIn,
      tokensOut,
      costUsd,
      stepsOk,
      stepsFailed,
    };
    const completedEv: Event = { t: 'turn.completed', turnId, status, metrics };
    emit(completedEv);
    yield completedEv;

    // LLD §8 / Task 14 brief: NOT required for the baseline (it never folds
    // a WorkingState), emitted anyway — empty-state — purely so every turn
    // (baseline or optimized) ends with the same event shape.
    const snapEv: Event = { t: 'memory.snapshot', turnId, state: emptyWorkingState() };
    emit(snapEv);
    yield snapEv;

    eventLog.touchSession(sessionId, { turns: 1, tokens: tokensIn + tokensOut, costUsd });

    return { status, metrics };
  }

  // One top-level guard, same discipline as `agent/pipeline.ts`: ANY
  // unexpected error (a bug, a DB failure, `BudgetExceededError`, a
  // `NoObjectGeneratedError` the single-model baseline has no escalation
  // target for) is caught here and routed through an honest
  // `turn.completed{status:'failed'}` rather than left to crash the
  // generator — every turn, however it ends, gets a `turn.completed` AND a
  // `memory.snapshot`.
  try {
    record({ t: 'turn.started', turnId, sessionId, userText, ts: clock.now() });

    const history: string[] = [];

    for (let step = 1; step <= MAX_BASELINE_STEPS; step += 1) {
      const prompt = buildUserPrompt(userText, clock.iso(), history);
      const result = await llmCall<z.infer<typeof baselineWireSchema>>({
        stage: 'baseline',
        model,
        schema: baselineWireSchema,
        system,
        prompt,
        turnId,
      });
      recordUsage(result.usage);
      const decision = toBaselineDecision(result.value as z.infer<typeof baselineWireSchema>);

      if (decision.kind === 'final') {
        return yield* finalize('done', decision.text);
      }

      // decision.kind === 'call_action' — validate BEFORE dispatch (LLD §8:
      // "validated against the registry at dispatch"). A failed validation
      // is fed back as a tool-result observation and counts as a step — it
      // never throws out of the loop.
      const stepId = `b${step}`;
      const action: ActionDef | undefined = registry.get(decision.slug);
      if (!action) {
        history.push(
          `Step ${step}: call_action("${decision.slug}", ${JSON.stringify(decision.params)}) -> ` +
            `ERROR: unknown action slug "${decision.slug}" — it is not in the catalog. Choose a slug ` +
            'EXACTLY as listed.',
        );
        continue;
      }

      const parsed = action.inputSchema.safeParse(decision.params);
      if (!parsed.success) {
        history.push(
          `Step ${step}: call_action("${decision.slug}", ${JSON.stringify(decision.params)}) -> ` +
            `VALIDATION ERROR: ${describeIssues(parsed.error)}`,
        );
        continue;
      }
      const params = parsed.data;

      const isWrite = action.risk !== 'read';
      const affectedCount = isWrite ? Math.max(maxArrayLength(params), 1) : maxArrayLength(params);

      // Unified gate (LLD §5.3) — the SAME predicate the optimized executor
      // uses, imported verbatim. Baseline has no cross-turn refs, so there
      // is never a `drift` argument.
      if (isWrite && shouldGate(action.risk, affectedCount)) {
        const confirmId = `cf_${randomUUID()}`;
        // Engine-wave E6 (composer handoff): human-readable gate description
        // at the source (display name + noun + count), not the raw slug.
        const noun = action.entities[0] ?? 'record';
        const scope: ConfirmationScope = {
          actions: [action.slug],
          affectedCount,
          targetSample: [],
          description: `${action.name} — ${affectedCount} ${noun}${affectedCount === 1 ? '' : 's'}.`,
        };
        markTtfur(); // tool-intent: the model decided to call a gated action.
        record({ t: 'confirmation.required', turnId, confirmId, planRev: 0, planHash, stepId, scope });
        const verdict = await confirm.request({ turnId, confirmId, planRev: 0, planHash, stepId, scope });
        const approved = typeof verdict === 'boolean' ? verdict : verdict.approved;
        record({ t: 'confirmation.resolved', turnId, confirmId, approved });
        if (!approved) {
          history.push(
            `Step ${step}: call_action("${decision.slug}", ...) -> DENIED: the user did not approve ` +
              'this action; it was NOT executed.',
          );
          continue;
        }
      }

      markTtfur(); // tool-intent: dispatching for real.
      record({
        t: 'step.started',
        turnId,
        stepId,
        action: action.slug,
        resolvedParams: [params as Record<string, unknown>],
      });
      const stepSpan: SpanHandle = spans.start({ turnId, kind: 'step', name: action.slug, meta: { stepId } });
      const key = `${turnId}:0:${stepId}:0`;
      // Instrumentation timing, not domain time — use a real monotonic
      // timer. `clock` (VirtualClock, pinned) stays reserved for the
      // `ActionContext` handed to the handler below. Mirrors the executor
      // fix in `agent/executor.ts`.
      const startedStepAt = performance.now();

      try {
        const output: unknown = await crm.tx((db) =>
          action.handler(params, { db, clock, idempotencyKey: key, format: 'concise' } satisfies ActionContext),
        );
        const ms = performance.now() - startedStepAt;

        let finalResult: unknown = output;
        let spillRef: string | undefined;
        let count = countRows(output);
        if (isSpill(output)) {
          const handle = refs.put({
            action: action.slug,
            turnId,
            stepId,
            entityType: action.entities[0] ?? action.module,
            total: output.total,
            idList: output.sample.map((row) => rowId(row)).filter((id): id is string => id !== undefined),
            sample: output.sample,
          });
          spillRef = handle.ref;
          finalResult = { ref: handle.ref, total: output.total, sample: output.sample, items: output.sample };
          count = output.total;
        }

        const noun = action.entities[0] ?? 'record';
        const refNote = spillRef ? ` [ref ${spillRef}]` : '';
        const summary = `${action.slug}: ${isWrite ? affectedCount : count} ${noun}${refNote}`;

        const finishedEv: Extract<Event, { t: 'step.finished' }> = { t: 'step.finished', turnId, stepId, summary, ms };
        if (spillRef !== undefined) {
          finishedEv.resultRef = spillRef;
        } else {
          const serialized = JSON.stringify(finalResult ?? null);
          if (serialized.length <= 2048) finishedEv.inlineResult = finalResult;
        }
        record(finishedEv);
        stepsOk += 1;
        spans.end(stepSpan, { meta: { stepId, status: 'done' } });

        const observed = JSON.stringify(finalResult ?? null).slice(0, 1500);
        history.push(`Step ${step}: call_action("${decision.slug}", ${JSON.stringify(params)}) -> ${summary}. result=${observed}`);
      } catch (err) {
        const ms = performance.now() - startedStepAt;
        const error = describeError(err);
        record({ t: 'step.failed', turnId, stepId, error, ms });
        stepsFailed += 1;
        spans.end(stepSpan, { meta: { stepId, status: 'failed', errorCode: error.code } });
        history.push(
          `Step ${step}: call_action("${decision.slug}", ${JSON.stringify(params)}) -> ` +
            `ERROR[${error.code}]: ${error.message}`,
        );
      }
    }

    // Exhausted MAX_BASELINE_STEPS without a 'final' decision — honest
    // failure, never a silent/fabricated answer (LLD §8's 12-step cap).
    return yield* finalize(
      'failed',
      `I was unable to produce a final answer within ${MAX_BASELINE_STEPS} steps. ` +
        `${stepsOk} action(s) succeeded and ${stepsFailed} failed before the step limit was reached.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return yield* finalize('failed', `Unexpected error: ${message}`);
  }
}
