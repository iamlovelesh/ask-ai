/**
 * The production tool-loop agent (plan rev 3, Task 5) — replaces the
 * plan-DSL pipeline as AgentKind 'optimized'.
 *
 * Shape mirrors `baseline/agent.ts` (same Event vocabulary, finalize/
 * metrics/ttfur discipline, one `turn.completed` + one `memory.snapshot`
 * however the turn ends) with the pivot's deltas: retrieval-scoped NATIVE
 * tools (zod schemas, Agents SDK), deterministic date rail, verbatim
 * recent-turn memory, honest clarify/refuse exits, StuckDetector-lite,
 * step + wall-clock budgets.
 *
 * Status semantics (ledgered ruling): a turn where any confirmation was
 * DENIED and no later write landed completes as 'cancelled' (matches the
 * old pipeline + /cancel flow); the model still narrates honestly.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Agent } from '@openai/agents';
import type { Registry } from '../catalog/registry.js';
import type { Crm } from '../store/db.js';
import { VirtualClock } from '../store/clock.js';
import type { RefStore } from '../agent/refs.js';
import type { EventLog } from '../events/log.js';
import type { Event, TurnMetrics, TurnStatus } from '../events/types.js';
import type { ConfirmBroker } from '../agent/executor.js';
import { emptyWorkingState } from '../agent/memory.js';
import type { TurnResult } from '../agent/pipeline.js';
import { retrieve, type Card, type SessionCtx } from '../agent/retrieval.js';
import { plannerModel } from '../llm/router.js';
import {
  createLoopRunner,
  runLoopOnce,
  runLoopStreamed,
  LoopDeadlineError,
  LoopStoppedError,
  MAX_TURNS_FALLBACK,
} from '../llm/agents-runtime.js';
import { BudgetExceededError } from '../llm/client.js';
import { buildLoopSystemPrompt, buildLoopUserPrompt } from './prompts.js';
import { buildCatalogSummary } from '../baseline/catalog-summary.js';
import { buildDateAnchors } from './date-rail.js';
import { renderRecentTurns } from './recent-turns.js';
import { buildTurnTools, harvestIds, StuckTracker, type LoopExits } from './tools.js';
import { numberCheck } from './number-check.js';
import { rescueToolCalls } from './tool-call-rescue.js';
import { unsanctionedFilters } from './scope-check.js';

export interface LoopSessionDeps {
  registry: Registry;
  crm: Crm;
  refs: RefStore;
  eventLog: EventLog;
  confirm: ConfirmBroker;
  /** Aborted by SessionRuntime.cancel — stops the loop promptly and
   * finalizes 'cancelled' (review I4: deny-at-gate alone let a cancelled
   * turn keep looping and even re-gate). */
  cancelSignal?: AbortSignal;
  /** Test seam: fetch handed to the runner's OpenAI client. */
  testFetch?: typeof fetch;
  /** Stream the final answer's tokens live (Live+correct). Default false so
   * the deterministic test/eval harness stays on the proven non-streaming
   * path; production wiring sets it true. The verified answer.final always
   * supersedes the streamed preview, so correctness is unchanged either way. */
  stream?: boolean;
}

export interface RunLoopTurnInput {
  sessionId: string;
  turnId: string;
  userText: string;
  sessionDeps: LoopSessionDeps;
  /** Test seam: budget overrides; production uses the defaults below. */
  budget?: { maxTurns?: number; deadlineMs?: number };
}

// 20, not 12: round-4 marketing killed a legitimate 10-campaign rundown at
// the 12-step cap. Cost stays bounded by the deadline + per-call maxTokens.
const MAX_LOOP_STEPS = 20;
const LOOP_DEADLINE_MS = 90_000;
/** Providers pre-authorize max_tokens against remaining account credit —
 * the SDK's unlimited default turned a low OpenRouter balance into 402s on
 * EVERY call. Answers here are short; 4096 is generous. */
const MAX_OUTPUT_TOKENS = 4096;
const DELTA_CHUNK_CHARS = 80;
/** When the whole deps registry fits in the tool budget, bind it all —
 * retrieval scoping only matters above this (and keeps small test
 * registries independent of the global retrieval index). */
const FULL_BIND_THRESHOLD = 24;

function chunkText(text: string, size = DELTA_CHUNK_CHARS): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function buildSessionCtx(events: readonly Event[]): SessionCtx {
  const used = new Set<string>();
  for (const e of events) if (e.t === 'step.started') used.add(e.action);
  return {
    usedActionSlugs: [...used],
    activeModules: [...new Set([...used].map((s) => s.split('.')[0] as string))],
  };
}

/** Round-6 billing G1: a zero-step answer stating dates/amounts/counts is a
 * fabrication risk — nothing in context contains full records. Triggers ONE
 * grounded re-run. Deterministic, narrow: data-shaped claims only. */
const DATA_CLAIM_RE =
  /\$\s?\d|\d{4}-\d{2}-\d{2}|\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}\b|\b\d+\s+(days?|weeks?|months?)\s+(overdue|ago|old)\b/i;

/** Round-7 billing F1: prose SCOPE/AUDIT claims ("paid invoices are
 * included", "none are voided", "all of them were counted") asserted with
 * zero tool reads are the numeral-free branch of the fabrication family —
 * NumberCheck can't see them, so they trigger grounding too. */
const AUDIT_CLAIM_RE =
  /\b(are|were|was|is)\s+(not\s+)?(included|excluded|counted|covered)\b|\b(all|none|every one)\s+(of\s+(them|those|these)\s+)?(are|were|have been)\b|\byes\s*[—,-]/i;

function needsGrounding(finalText: string, stepsRun: number): boolean {
  return stepsRun === 0 && (DATA_CLAIM_RE.test(finalText) || AUDIT_CLAIM_RE.test(finalText));
}

const GROUNDING_NOTE =
  'IMPORTANT: your previous draft answered without reading any data this turn. Every date, amount, and count you state must come from a tool result THIS turn — call the tools now, then answer.';

function pickCards(userText: string, registry: Registry, sessionCtx: SessionCtx): Card[] {
  const all = registry.all();
  if (all.length <= FULL_BIND_THRESHOLD) {
    return all.map((a) => ({ slug: a.slug, text: a.slug, score: 1 }));
  }
  const cards = retrieve(userText, sessionCtx).cards.filter((c) => registry.get(c.slug) !== undefined);
  // Review I10 (follow-up tool starvation): a terse follow-up ("now the
  // oldest one too") can miss retrieval entirely — actions ALREADY USED in
  // this session always ride along, ahead of any filler.
  const bound = new Set(cards.map((c) => c.slug));
  const sessionCards: Card[] = sessionCtx.usedActionSlugs
    .filter((slug) => !bound.has(slug) && registry.get(slug) !== undefined)
    .map((slug) => ({ slug, text: slug, score: 1 }));
  const combined = [...sessionCards, ...cards];
  if (combined.length > 0) return combined.slice(0, FULL_BIND_THRESHOLD);
  return all.slice(0, FULL_BIND_THRESHOLD).map((a) => ({ slug: a.slug, text: a.slug, score: 0 }));
}

export async function* runLoopTurn(input: RunLoopTurnInput): AsyncGenerator<Event, TurnResult> {
  const { sessionId, turnId, userText, sessionDeps } = input;
  const { registry, crm, refs, eventLog, confirm } = sessionDeps;
  const clock = new VirtualClock();
  const startedAtMs = performance.now();
  const maxTurns = input.budget?.maxTurns ?? MAX_LOOP_STEPS;
  const deadlineMs = input.budget?.deadlineMs ?? LOOP_DEADLINE_MS;
  const planHash = createHash('sha256').update(turnId).digest('hex');

  let ttfurAtMs: number | undefined;
  const markTtfur = (): void => {
    if (ttfurAtMs === undefined) ttfurAtMs = performance.now();
  };

  let llmCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;

  const buffer: Event[] = [];
  const record = (e: Event): void => {
    eventLog.append(sessionId, e);
    buffer.push(e);
  };
  // True once answer tokens have been streamed live (via `record` answer.delta
  // during the model call); finalize then skips the end-of-turn chunk replay.
  let streamedLive = false;

  const counters = { stepsOk: 0, stepsFailed: 0, step: 0, gateWaitMs: 0, virtualReads: 0 };
  const stopController = new AbortController();
  const exits: LoopExits = {
    denied: false,
    writesLanded: 0,
    writeActions: new Map(),
    toolOutputs: [],
    appliedFilters: [],
    stop: () => stopController.abort(),
  };
  const cancelSignal = sessionDeps.cancelSignal;
  if (cancelSignal !== undefined) {
    if (cancelSignal.aborted) stopController.abort();
    else cancelSignal.addEventListener('abort', () => stopController.abort(), { once: true });
  }
  const wasCancelled = (): boolean => cancelSignal?.aborted === true;

  async function* finalize(status: TurnStatus, finalText: string): AsyncGenerator<Event, TurnResult> {
    for (const e of buffer.splice(0, buffer.length)) yield e;
    // Non-streaming: replay the answer as chunked deltas here. Streaming:
    // the deltas already went out live during the model call (and are in the
    // buffer above), so skip the replay — answer.final below is authoritative.
    if (!streamedLive) {
      for (const chunk of chunkText(finalText)) {
        markTtfur();
        const ev: Event = { t: 'answer.delta', turnId, text: chunk };
        eventLog.append(sessionId, ev);
        yield ev;
      }
    }
    markTtfur();
    const finalEv: Event = { t: 'answer.final', turnId, text: finalText };
    eventLog.append(sessionId, finalEv);
    yield finalEv;

    const metrics: TurnMetrics = {
      ttfurMs: (ttfurAtMs as number) - startedAtMs,
      totalMs: performance.now() - startedAtMs,
      llmCalls,
      repairs: 0,
      replans: 0,
      searchRounds: 0,
      tokensIn,
      tokensOut,
      costUsd,
      stepsOk: counters.stepsOk,
      stepsFailed: counters.stepsFailed,
    };
    const completedEv: Event = { t: 'turn.completed', turnId, status, metrics };
    eventLog.append(sessionId, completedEv);
    yield completedEv;

    const snapEv: Event = { t: 'memory.snapshot', turnId, state: emptyWorkingState() };
    eventLog.append(sessionId, snapEv);
    yield snapEv;

    eventLog.touchSession(sessionId, { turns: 1, tokens: tokensIn + tokensOut, costUsd });
    return { status, metrics };
  }

  try {
    record({ t: 'turn.started', turnId, sessionId, userText, ts: clock.now() });

    const priorEvents = eventLog.list(sessionId).map((se) => se.event);
    const sessionCtx = buildSessionCtx(priorEvents);
    const cards = pickCards(userText, registry, sessionCtx);
    // Acting-user identity (engine-wave E9 parity): "<id> (<name>)" for the
    // prompt, bare id for the identity-param substitution rail.
    const demoUserId = process.env['DEMO_USER_ID'] || 'user_1';
    let currentUser = demoUserId;
    try {
      const nameRow = crm.tx((db) => db.get('SELECT name FROM users WHERE id = ?', [demoUserId]));
      const name = nameRow?.['name'];
      if (typeof name === 'string' && name.length > 0) currentUser = `${demoUserId} (${name})`;
    } catch {
      // no users table / lookup failure → bare id
    }
    // Provenance firewall seed: ids the USER typed + ids from prior turns.
    const knownIds = new Set<string>();
    harvestIds(userText, knownIds);
    harvestIds(JSON.stringify(priorEvents), knownIds);
    const tools = buildTurnTools({
      registry,
      cards,
      crm,
      refs,
      confirm,
      clock,
      turnId,
      emit: record,
      sessionCtx,
      exits,
      stuck: new StuckTracker(),
      markTtfur,
      counters,
      planHash,
      actingUserId: demoUserId,
      knownIds,
    });

    // P1 (pattern): the full catalog rides in the (cacheable) system
    // prompt so the model always knows what exists — retrieval misses can no
    // longer hide capabilities. Only for real-size registries; tiny test
    // registries already full-bind.
    const catalogText = registry.all().length > FULL_BIND_THRESHOLD ? buildCatalogSummary(registry) : undefined;
    const agent = new Agent({
      name: 'ask-ai',
      model: plannerModel(),
      instructions: buildLoopSystemPrompt(catalogText),
      tools,
      // timeoutMs: per-model-call cap (review I9) so one hung provider call
      // cannot eat the whole 90s turn deadline.
      modelSettings: { parallelToolCalls: false, maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: 60_000 },
    });
    // Grounded re-run twin (round-6b item 1): toolChoice 'required' FORCES
    // the first call to be a tool read (the SDK's resetToolChoice default
    // then returns to auto), so a fabrication-prone zero-step answer cannot
    // simply repeat itself.
    const groundedAgent = new Agent({
      name: 'ask-ai',
      model: plannerModel(),
      instructions: buildLoopSystemPrompt(catalogText),
      tools,
      modelSettings: { parallelToolCalls: false, maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: 60_000, toolChoice: 'required' },
    });

    const runner = createLoopRunner(sessionDeps.testFetch !== undefined ? { testFetch: sessionDeps.testFetch } : {});
    const prompt = buildLoopUserPrompt({
      userText,
      nowIso: clock.iso(),
      dateAnchors: buildDateAnchors(clock.now()),
      recentTurns: renderRecentTurns(priorEvents),
      currentUser,
    });

    let finalText: string | undefined;
    try {
      // Round-7b N1: a model call to an unbound/unknown tool name must be
      // repaired (rename or reroute to catalog search), never a dead turn.
      // Names are read at response time — the tools array grows mid-run.
      const fixResponse = (output: unknown[]): void => {
        const names = new Set(
          tools
            .map((t) => (t as { name?: unknown }).name)
            .filter((n): n is string => typeof n === 'string'),
        );
        rescueToolCalls(output, names);
      };
      const onLlmCall = (u: { tokensIn: number; tokensOut: number; costUsd: number }): void => {
        llmCalls += 1;
        tokensIn += u.tokensIn;
        tokensOut += u.tokensOut;
        costUsd += u.costUsd;
      };
      // Live+correct answer streaming: forward the model's answer tokens as
      // answer.delta events the moment they arrive (via eventLog → SSE), with
      // a reset marker at the start of each answer call so a verification
      // re-run visibly replaces the prior draft rather than appending to it.
      // The authoritative answer.final (verified) still supersedes all deltas.
      const streaming = sessionDeps.stream === true;
      const streamDeltas = (input2: string, agentToUse: Agent): Promise<string> =>
        runLoopStreamed({
          runner, agent: agentToUse, input: input2, maxTurns, deadlineMs, turnId,
          stopSignal: stopController.signal, gateWaitMs: () => counters.gateWaitMs, fixResponse, onLlmCall,
          onTextDelta: (chunk) => {
            markTtfur();
            record({ t: 'answer.delta', turnId, text: chunk });
          },
        }).then((r) => (typeof r.finalOutput === 'string' ? r.finalOutput : JSON.stringify(r.finalOutput ?? '')));
      const runOnce = async (input2: string, agentToUse: Agent = agent): Promise<string> => {
        if (streaming) {
          streamedLive = true;
          record({ t: 'answer.delta', turnId, text: '', reset: true });
          return streamDeltas(input2, agentToUse);
        }
        const result = await runLoopOnce({
          runner,
          agent: agentToUse,
          input: input2,
          maxTurns,
          deadlineMs,
          turnId,
          stopSignal: stopController.signal,
          gateWaitMs: () => counters.gateWaitMs,
          fixResponse,
          onLlmCall,
        });
        return typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput ?? '');
      };
      finalText = await runOnce(prompt);
      // ONE verification re-run budget, shared by both checks:
      //  - zero-step grounding (no data read at all), or
      //  - NumberCheck (P2, Chatwoot pattern): figures/dates in the draft
      //    must exist in or derive from this turn's tool outputs.
      const canRetry = finalText !== MAX_TURNS_FALLBACK && exits.clarify === undefined && exits.refused === undefined;
      if (canRetry) {
        if (needsGrounding(finalText, counters.step + counters.virtualReads)) {
          finalText = await runOnce(`${prompt}\n\n${GROUNDING_NOTE}`, groundedAgent);
        } else {
          const check = numberCheck(finalText, exits.toolOutputs, userText);
          if (!check.ok) {
            finalText = await runOnce(
              `${prompt}\n\nIMPORTANT: your previous draft stated figures I could not find in any tool result this turn: ${check.unsupported.slice(0, 8).join(', ')}. Re-read the data with tools, use data__aggregate_ref (with subtract_field for owed/outstanding amounts) for any total — never do arithmetic yourself — and answer using ONLY figures that appear verbatim in tool results. Do NOT show intermediate calculations or scratch work in the answer.`,
              groundedAgent,
            );
          }
        }
        // Persistent unsupported figures get an explicit, honest caution.
        if (exits.clarify === undefined && exits.refused === undefined && finalText !== MAX_TURNS_FALLBACK) {
          const finalCheck = numberCheck(finalText, exits.toolOutputs, userText);
          if (!finalCheck.ok) {
            // Cap the caution (round-7b N2): a 33-item scratch list buries
            // the one real warning and reads as leaked internal state.
            const listed = finalCheck.unsupported.slice(0, 5);
            const rest = finalCheck.unsupported.length - listed.length;
            finalText += `\n\n⚠ Please double-check these figures against the records — I could not verify them: ${listed.join(', ')}${rest > 0 ? ` (and ${rest} more)` : ''}`;
          }
          // Scope-claim disclosure (support round-7b N1): a totality answer
          // computed with filters the user never asked for must say so —
          // deterministically, whatever the model claimed.
          for (const f of unsanctionedFilters(finalText, userText, exits.appliedFilters)) {
            finalText += `\n\n⚠ Note: this was computed with the filter ${f.key} = "${f.value}" applied — it is NOT a total across all records.`;
          }
        }
      }
    } catch (err) {
      if (err instanceof LoopStoppedError) {
        // interpreted below via exits
      } else if (err instanceof LoopDeadlineError) {
        return yield* finalize(
          'failed',
          `I ran out of time on this one (${Math.round(deadlineMs / 1000)}s). ` +
            `${counters.stepsOk} step(s) succeeded before the deadline — please try again or narrow the request.`,
        );
      } else {
        throw err;
      }
    }

    // honest exits set by tools (these stop the run mid-flight)
    if (wasCancelled()) {
      return yield* finalize('cancelled', 'Okay — I stopped. Nothing further was changed.');
    }
    if (exits.clarify !== undefined) return yield* finalize('clarify', exits.clarify);
    if (exits.refused !== undefined) return yield* finalize('refused', exits.refused);
    if (exits.stuck !== undefined) return yield* finalize('failed', exits.stuck);

    if (finalText === undefined) {
      return yield* finalize('failed', 'I was unable to produce an answer. Please try again.');
    }
    if (finalText === MAX_TURNS_FALLBACK) {
      // Round-4 billing C3: the cap message concealed 12 real sends. Always
      // disclose what DID happen before the cap.
      const disclosure =
        exits.writesLanded > 0
          ? ` Before stopping, ${counters.stepsOk} step(s) ran and ${exits.writesLanded} change(s) were made — those DID take effect.`
          : counters.stepsOk > 0
            ? ` Before stopping, ${counters.stepsOk} read step(s) completed; nothing was changed.`
            : ' Nothing was changed.';
      return yield* finalize('failed', finalText + disclosure);
    }

    // Deterministic status inference (quick-20 evidence, 2026-11-06): small
    // models sometimes bypass the exit tools —
    //  - a final answer that IS a question is a clarify, whatever channel
    //    it arrived through;
    //  - a turn whose every dispatched action failed is a failed turn even
    //    when the model narrates the failure gracefully.
    const asksQuestion =
      finalText.trimEnd().endsWith('?') ||
      /\b(i need to (know|clarify)|could you (provide|tell|confirm|specify)|please (provide|specify|confirm)|which (one|of these)? ?(do you mean|would you like))\b/i.test(
        finalText,
      );
    const status: TurnStatus =
      exits.denied && exits.writesLanded === 0
        ? 'cancelled'
        : asksQuestion
          ? 'clarify'
          : counters.stepsFailed > 0 && counters.stepsOk === 0
            ? 'failed'
            : 'done';
    // Deterministic actions ledger (round-6 support F1: "both cancelled"
    // after ONE cancel): the server, not the model, states what changed.
    if (status === 'done' && exits.writesLanded > 0) {
      const parts = [...exits.writeActions.entries()].map(([name, n]) => `${name} ×${n}`).join(', ');
      finalText += `\n\n— Changes this turn: ${exits.writesLanded} (${parts})`;
    }
    return yield* finalize(status, finalText);
  } catch (err) {
    if (wasCancelled()) {
      return yield* finalize('cancelled', 'Okay — I stopped. Nothing further was changed.');
    }
    if (err instanceof BudgetExceededError) {
      // Review I1: this can trip MID-turn, after steps (even writes) ran —
      // report progress honestly, never "nothing happened".
      const progress =
        counters.stepsOk > 0
          ? `I completed ${counters.stepsOk} step(s) before stopping — anything I reported done above did happen.`
          : 'No actions were performed.';
      return yield* finalize('failed', `I had to stop: the usage budget for this environment is exhausted. ${progress}`);
    }
    // Review I2: raw SDK/provider/db error text never reaches the user.
    // Server-side context goes to stderr (coding-style: log detailed error
    // context server-side; user gets a friendly line).
    console.error(`[loop] turn ${turnId} unexpected error:`, err);
    return yield* finalize(
      'failed',
      'Something went wrong on my side and I could not complete this request. Nothing beyond the steps already reported was changed — please try again.',
    );
  }
}
