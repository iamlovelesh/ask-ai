/**
 * @openai/agents runtime glue (plan rev 3, Task 4).
 *
 * Everything the tool loop needs from the SDK, wired to THIS codebase's
 * invariants (spike-verified, docs/SPIKES.md 2026-11-06):
 *  - OpenRouter via `OpenAIProvider({ openAIClient, useResponses: false })`
 *    — explicit per-runner provider, never the sticky global client setter;
 *  - `setTracingDisabled(true)` at module init — the SDK's default exporter
 *    would otherwise ship run data to OpenAI's trace backend;
 *  - `MeteredModel` decorator — every model call pays into `llm/client.ts`'s
 *    process-wide cost meter (same hard EVAL_BUDGET_USD ceiling as
 *    `llmCall`) and emits one `kind:'llm'` span, with the owning turnId
 *    carried via AsyncLocalStorage so concurrent sessions never cross wires;
 *  - budgets: `maxTurns` with an honest no-extra-model-call fallback
 *    (`errorHandlers.maxTurns` is a RUN option) and a wall-clock deadline
 *    via `signal: AbortSignal.timeout(...)` mapped to `LoopDeadlineError`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import OpenAI from 'openai';
import {
  Agent,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RunResult,
  type RunState,
  type StreamEvent,
} from '@openai/agents';
import { BudgetExceededError, budgetUsd, costMeter, meterLlmCost } from './client.js';
import { withBackoff, type BackoffOptions } from './backoff.js';
import { priceFor } from './prices.js';
import { getDefaultSpans } from '../events/trace.js';

setTracingDisabled(true);

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Per-run context for model calls — turnId for span attribution plus an
 * optional per-call usage callback so the loop driver can keep per-turn
 * metrics even when the run ends by abort. AsyncLocalStorage keeps
 * concurrent sessions from crossing wires. */
interface TurnCallContext {
  turnId: string;
  onLlmCall?: (usage: { tokensIn: number; tokensOut: number; costUsd: number }) => void;
  /** Checked before every model call — an exit tool's abort must stop the
   * loop even when the transport (e.g. a test mock fetch) ignores signals. */
  signal?: AbortSignal;
  /** Checked before every model call; throws LoopDeadlineError when the
   * ACTIVE time (wall clock minus human confirmation waits) is spent —
   * round-4: a hard AbortSignal.timeout failed turns while users were
   * still deciding at a gate. */
  checkDeadline?: () => void;
}

const turnContext = new AsyncLocalStorage<TurnCallContext>();

export class LoopDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`loop wall-clock deadline of ${deadlineMs}ms exceeded`);
    this.name = 'LoopDeadlineError';
  }
}

class MeteredModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly modelName: string,
    private readonly backoff: BackoffOptions | undefined,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const limit = budgetUsd();
    if (costMeter.total() >= limit) {
      throw new BudgetExceededError(costMeter.total(), limit);
    }
    const ctx = turnContext.getStore();
    if (ctx?.signal?.aborted) {
      throw new Error('Run aborted before model call');
    }
    ctx?.checkDeadline?.();
    const spans = getDefaultSpans();
    const handle = spans.start({ turnId: ctx?.turnId ?? 'unknown', kind: 'llm', name: 'loop' });
    const startedAt = performance.now();
    try {
      // 429/5xx/network retries live HERE (same policy as llmCall's
      // withBackoff) — the inner OpenAI client has maxRetries: 0 so this is
      // the single retry authority. Live evidence: OpenRouter's 20-rpm
      // new-account haiku limit failed whole turns without it.
      const { value: response } = await withBackoff(() => this.inner.getResponse(request), this.backoff);
      const tokensIn = response.usage.inputTokens;
      const tokensOut = response.usage.outputTokens;
      const costUsd = this.price(tokensIn, tokensOut);
      meterLlmCost(costUsd);
      ctx?.onLlmCall?.({ tokensIn, tokensOut, costUsd });
      spans.end(handle, { tokensIn, tokensOut, costUsd, meta: { ms: performance.now() - startedAt } });
      return response;
    } catch (err) {
      spans.end(handle, { meta: { error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
  }

  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    // The loop agent never streams model output today (answer chunking is
    // done by the caller); delegate unmetered rather than guess at partial
    // usage shapes.
    return this.inner.getStreamedResponse(request);
  }

  private price(tokensIn: number, tokensOut: number): number {
    const price = priceFor(this.modelName);
    const cost = (tokensIn / 1_000_000) * price.inPerM + (tokensOut / 1_000_000) * price.outPerM;
    return Number.isFinite(cost) ? cost : 0;
  }
}

class MeteredProvider implements ModelProvider {
  constructor(
    private readonly inner: OpenAIProvider,
    private readonly backoff: BackoffOptions | undefined,
  ) {}

  async getModel(modelName?: string): Promise<Model> {
    const model = await this.inner.getModel(modelName);
    return new MeteredModel(model, modelName ?? 'unknown', this.backoff);
  }
}

export interface CreateLoopRunnerOptions {
  testFetch?: typeof fetch;
  /** Test seam: fast backoff (e.g. { baseMs: 1 }); production uses defaults. */
  backoff?: BackoffOptions;
}

// Module-level test seam, mirroring `llm/client.ts`'s `__setTestFetch`:
// callers that construct their own deps (unit tests) pass `testFetch`
// directly; integration layers (SessionRuntime) have no test plumbing, so
// tests inject here instead.
let loopTestFetch: typeof fetch | undefined;

/** Test-only: override (or clear) the fetch used by `createLoopRunner`
 * when the caller does not supply one. Never call from application code. */
export function __setLoopTestFetch(fn: typeof fetch | undefined): void {
  loopTestFetch = fn;
}

/** A Runner wired to OpenRouter with metering and tracing-off. One runner
 * can serve many runLoopOnce calls; per-call state (turnId, deadline)
 * travels with the call, not the runner. */
export function createLoopRunner(opts: CreateLoopRunnerOptions = {}): Runner {
  const effectiveFetch = opts.testFetch ?? loopTestFetch;
  const client = new OpenAI({
    apiKey: process.env['OPENROUTER_API_KEY'] || 'test-key',
    baseURL: OPENROUTER_BASE_URL,
    maxRetries: 0, // withBackoff in MeteredModel is the single retry authority
    ...(effectiveFetch !== undefined ? { fetch: effectiveFetch } : {}),
  });
  const provider = new OpenAIProvider({ openAIClient: client, useResponses: false });
  return new Runner({ modelProvider: new MeteredProvider(provider, opts.backoff), tracingDisabled: true });
}

export interface RunLoopOnceOptions {
  runner: Runner;
  agent: Agent;
  input: string | RunState<undefined, Agent>;
  maxTurns: number;
  deadlineMs: number;
  turnId: string;
  /** Extra abort source (exit tools, stuck-stop). An abort from HERE throws
   * `LoopStoppedError` — a benign, caller-interpreted stop. */
  stopSignal?: AbortSignal;
  onLlmCall?: TurnCallContext['onLlmCall'];
  /** Time spent suspended at confirmation gates — EXCLUDED from the
   * deadline so human decision time never fails a turn. */
  gateWaitMs?: () => number;
}

export const MAX_TURNS_FALLBACK =
  'I could not finish within my step limit — please narrow the request or try again.';

export class LoopStoppedError extends Error {
  constructor() {
    super('loop stopped by an exit tool');
    this.name = 'LoopStoppedError';
  }
}

/** One loop run with budgets applied. Throws `LoopDeadlineError` on
 * wall-clock breach, `LoopStoppedError` on stopSignal abort,
 * `BudgetExceededError` on $ cap; maxTurns exhaustion returns the honest
 * `MAX_TURNS_FALLBACK` final output WITHOUT another model call. */
export async function runLoopOnce(opts: RunLoopOnceOptions): Promise<RunResult<undefined, Agent>> {
  // The deadline is ACTIVE time: wall clock minus gate-wait. Enforced as a
  // pre-model-call check (not an AbortSignal.timeout) so a human taking two
  // minutes at a confirmation never kills the turn; per-call hangs are
  // bounded separately by modelSettings.timeoutMs.
  const startedAt = performance.now();
  const checkDeadline = (): void => {
    const active = performance.now() - startedAt - (opts.gateWaitMs?.() ?? 0);
    if (active > opts.deadlineMs) throw new LoopDeadlineError(opts.deadlineMs);
  };
  const signal = opts.stopSignal;
  const ctx: TurnCallContext = {
    turnId: opts.turnId,
    checkDeadline,
    ...(signal ? { signal } : {}),
    ...(opts.onLlmCall ? { onLlmCall: opts.onLlmCall } : {}),
  };
  try {
    return await turnContext.run(ctx, () =>
      opts.runner.run(opts.agent, opts.input as string, {
        maxTurns: opts.maxTurns,
        ...(signal ? { signal } : {}),
        // Defense when a provider ignores parallel_tool_calls: local tool
        // execution stays serial, so gate/step events can never interleave.
        toolExecution: { maxFunctionToolConcurrency: 1 },
        errorHandlers: {
          maxTurns: () => ({ finalOutput: MAX_TURNS_FALLBACK }),
        },
      }),
    );
  } catch (err) {
    if (opts.stopSignal?.aborted) throw new LoopStoppedError();
    throw err;
  }
}
