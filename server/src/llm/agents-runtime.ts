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
  type AgentOutputType,
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
  /** Applied to each model response's output items before the Runner
   * resolves tool calls — the loop's unknown-tool rescue (round-7b N1)
   * repairs names here because the Runner's tool lookup map is captured
   * BEFORE the model call. */
  fixResponse?: (output: unknown[]) => void;
  /** Cached input-token count from the MOST RECENT model call, stashed by the
   * cache-control fetch middleware (OpenRouter returns it in
   * `usage.prompt_tokens_details.cached_tokens`, but the @openai/agents SDK
   * drops it from `response.usage`). MeteredModel reads it to price cached
   * tokens at the cheaper rate. */
  lastCachedIn?: number;
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
      if (ctx?.fixResponse && Array.isArray(response.output)) ctx.fixResponse(response.output);
      const tokensIn = response.usage.inputTokens;
      const tokensOut = response.usage.outputTokens;
      const cachedIn = cachedInputOf(response.usage) || ctx?.lastCachedIn || 0;
      const costUsd = this.price(tokensIn, tokensOut, cachedIn);
      meterLlmCost(costUsd);
      ctx?.onLlmCall?.({ tokensIn, tokensOut, costUsd });
      spans.end(handle, { tokensIn, tokensOut, costUsd, meta: { ms: performance.now() - startedAt } });
      return response;
    } catch (err) {
      spans.end(handle, { meta: { error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    // Streaming path (answer-token streaming): same budget/abort/deadline
    // gate as getResponse, then pass events through and meter each
    // `response_done` (one per model turn) from the usage it carries. No
    // withBackoff — you cannot cleanly retry a half-consumed stream; the
    // pre-call checks plus single-turn exposure bound the risk.
    const limit = budgetUsd();
    if (costMeter.total() >= limit) throw new BudgetExceededError(costMeter.total(), limit);
    const ctx = turnContext.getStore();
    if (ctx?.signal?.aborted) throw new Error('Run aborted before model call');
    ctx?.checkDeadline?.();
    const spans = getDefaultSpans();
    const handle = spans.start({ turnId: ctx?.turnId ?? 'unknown', kind: 'llm', name: 'loop-stream' });
    const startedAt = performance.now();
    try {
      for await (const ev of this.inner.getStreamedResponse(request)) {
        const done = ev as { type?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number }; output?: unknown[] } };
        if (done.type === 'response_done' && done.response) {
          // Rescue unbound/unknown tool names on the assembled response BEFORE
          // the Runner resolves it — parity with getResponse. Without this, a
          // streamed model call to an unbound tool throws ModelBehaviorError
          // ("Tool X not found") and kills the whole turn.
          if (ctx?.fixResponse && Array.isArray(done.response.output)) ctx.fixResponse(done.response.output);
          if (done.response.usage) {
            const tokensIn = done.response.usage.inputTokens ?? 0;
            const tokensOut = done.response.usage.outputTokens ?? 0;
            const cachedIn = cachedInputOf(done.response.usage) || ctx?.lastCachedIn || 0;
            const costUsd = this.price(tokensIn, tokensOut, cachedIn);
            meterLlmCost(costUsd);
            ctx?.onLlmCall?.({ tokensIn, tokensOut, costUsd });
          }
        }
        yield ev;
      }
      spans.end(handle, { meta: { ms: performance.now() - startedAt } });
    } catch (err) {
      spans.end(handle, { meta: { error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
  }

  private price(tokensIn: number, tokensOut: number, cachedIn = 0): number {
    const price = priceFor(this.modelName);
    const fresh = Math.max(0, tokensIn - cachedIn);
    const cost =
      (fresh / 1_000_000) * price.inPerM +
      (cachedIn / 1_000_000) * price.cachedPerM +
      (tokensOut / 1_000_000) * price.outPerM;
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

/** Wraps a fetch so every outgoing chat-completions request tags its system
 * message with an Anthropic `cache_control: {type:'ephemeral'}` breakpoint —
 * the stable, expensive prefix (system prompt + the full action catalog) is
 * then cache-read on subsequent calls that share it. No-op for non-completions
 * requests and for bodies without a string-content system message. */
export function injectCacheControlFetch(baseFetch: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (init && typeof init.body === 'string' && url.includes('/chat/completions')) {
        const body = JSON.parse(init.body) as { messages?: Array<{ role: string; content: unknown }> };
        const sys = body.messages?.find((m) => m.role === 'system');
        if (sys && typeof sys.content === 'string' && sys.content.length > 0) {
          sys.content = [{ type: 'text', text: sys.content, cache_control: { type: 'ephemeral' } }];
          init = { ...init, body: JSON.stringify(body) };
        }
      }
    } catch {
      /* passthrough on any shape we don't recognize — never break the call */
    }
    const res = await baseFetch(input as never, init as never);
    try {
      // OpenRouter returns cached_tokens in the response usage, but the SDK
      // drops it — read it off a clone and stash on the turn context so pricing
      // can apply the cached rate (see MeteredModel.price / lastCachedIn).
      const clone = (res as Response).clone();
      const j = (await clone.json()) as { usage?: { prompt_tokens_details?: { cached_tokens?: number } } };
      const cached = j?.usage?.prompt_tokens_details?.cached_tokens;
      const ctx = turnContext.getStore();
      if (ctx && typeof cached === 'number') ctx.lastCachedIn = cached;
    } catch { /* non-JSON / streamed — leave lastCachedIn unset */ }
    return res;
  }) as typeof fetch;
}

/** Cached input-token count from a model response's usage, read from the
 * `inputTokensDetails` map the SDK carries through from the provider
 * (`prompt_tokens_details.cached_tokens` on OpenRouter/OpenAI). 0 when absent. */
function cachedInputOf(usage: unknown): number {
  const d = (usage as { inputTokensDetails?: Record<string, unknown> } | undefined)?.inputTokensDetails;
  if (d && typeof d === 'object') {
    for (const k of ['cached_tokens', 'cachedTokens', 'cached_input_tokens']) {
      const v = (d as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return 0;
}

/** A Runner wired to OpenRouter with metering and tracing-off. One runner
 * can serve many runLoopOnce calls; per-call state (turnId, deadline)
 * travels with the call, not the runner. */
export function createLoopRunner(opts: CreateLoopRunnerOptions = {}): Runner {
  const effectiveFetch = opts.testFetch ?? loopTestFetch;
  // Prompt caching: Anthropic only caches a prefix when the request carries an
  // explicit `cache_control` breakpoint (Gemini/GPT auto-cache; Anthropic does
  // NOT). The @openai/agents → OpenAIProvider path never sends one, so the big
  // catalog-in-prompt system message was re-billed at full price on every one
  // of the ~3–4 model calls per turn. We inject the breakpoint at the fetch
  // layer (spike-verified: 99.9% of the system prefix caches on the 2nd call),
  // which is provider-format-agnostic. Only in production — tests supply their
  // own mock fetch and don't exercise caching.
  const fetchImpl = effectiveFetch ?? injectCacheControlFetch(globalThis.fetch);
  const client = new OpenAI({
    apiKey: process.env['OPENROUTER_API_KEY'] || 'test-key',
    baseURL: OPENROUTER_BASE_URL,
    maxRetries: 0, // withBackoff in MeteredModel is the single retry authority
    fetch: fetchImpl,
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
  /** See TurnCallContext.fixResponse. */
  fixResponse?: TurnCallContext['fixResponse'];
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
export async function runLoopOnce(opts: RunLoopOnceOptions): Promise<RunResult<undefined, Agent<undefined, AgentOutputType>>> {
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
    ...(opts.fixResponse ? { fixResponse: opts.fixResponse } : {}),
  };
  try {
    // Boundary cast: the runner infers the agent's default context (`unknown`),
    // but RunResult's constraint wants `Agent<undefined, AgentOutputType>`. The
    // runtime value is the real run result; the cast only reconciles the SDK's
    // invariant generic under exactOptionalPropertyTypes.
    const result = await turnContext.run(ctx, () =>
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
    return result as unknown as RunResult<undefined, Agent<undefined, AgentOutputType>>;
  } catch (err) {
    if (opts.stopSignal?.aborted) throw new LoopStoppedError();
    throw err;
  }
}

export interface RunLoopStreamedOptions extends RunLoopOnceOptions {
  /** Called with each chunk of the FINAL answer text as the model produces
   * it (answer-token streaming). Tool-call rounds emit no text, so this
   * fires only for the user-facing answer. */
  onTextDelta: (chunk: string) => void;
}

/** Streaming twin of `runLoopOnce` (Live+correct answer streaming): same
 * budgets, but the run is driven in `stream: true` mode and the final
 * answer's tokens are forwarded to `onTextDelta` as they arrive. Returns the
 * completed result; the caller still verifies the full text and emits the
 * authoritative `answer.final` (which supersedes the streamed preview). */
export async function runLoopStreamed(
  opts: RunLoopStreamedOptions,
): Promise<RunResult<undefined, Agent<undefined, AgentOutputType>>> {
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
    ...(opts.fixResponse ? { fixResponse: opts.fixResponse } : {}),
  };
  try {
    return await turnContext.run(ctx, async () => {
      const streamed = await opts.runner.run(opts.agent, opts.input as string, {
        stream: true,
        maxTurns: opts.maxTurns,
        ...(signal ? { signal } : {}),
        toolExecution: { maxFunctionToolConcurrency: 1 },
        errorHandlers: {
          maxTurns: () => ({ finalOutput: MAX_TURNS_FALLBACK }),
        },
      });
      for await (const chunk of streamed.toTextStream()) {
        if (chunk) opts.onTextDelta(chunk);
      }
      await streamed.completed;
      return streamed as unknown as RunResult<undefined, Agent<undefined, AgentOutputType>>;
    });
  } catch (err) {
    if (opts.stopSignal?.aborted) throw new LoopStoppedError();
    throw err;
  }
}
