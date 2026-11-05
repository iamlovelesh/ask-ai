/**
 * LLM client (LLD §10, §9.2, §5.5): wraps `ai` v5 `generateObject`/
 * `generateText` over the OpenRouter provider with `usage:{include:true}`,
 * exponential backoff (`llm/backoff.ts`), span recording (`events/trace.ts`),
 * cost accounting (OpenRouter-native cost else `llm/prices.ts`), and a
 * cumulative session budget guard (`EVAL_BUDGET_USD`).
 */

import type { ZodType } from 'zod';
import { generateObject, generateText, type JSONValue, type LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { withBackoff, type BackoffOptions } from './backoff.js';
import { priceFor } from './prices.js';
import { isGpt5Family } from './router.js';
import { getDefaultSpans, type Spans, type SpanHandle } from '../events/trace.js';
import type { LlmUsage } from '../events/types.js';

export type Stage = 'plan' | 'repair' | 'replan' | 'compose' | 'baseline' | 'spike';

export interface LlmCallOptions<T> {
  stage: Stage;
  model: string;
  schema?: ZodType<T>;
  system: string;
  prompt: string;
  turnId: string;
  maxOutputTokens?: number;
  /** Passthrough to the AI SDK's `providerOptions` (provider-id-keyed JSON).
   * Merged UNDER the automatic GPT-5 minimal-reasoning default below — an
   * explicit caller value for the same provider key wins. Most callers never
   * need this; it exists for the rare case a caller wants to override/extend
   * the provider options LLD §5.5 otherwise sets automatically. */
  providerOptions?: Record<string, Record<string, JSONValue>>;
}

export interface LlmCallResult<T> {
  value: T | string;
  usage: LlmUsage;
  spanId: string;
}

/** Thrown when making this call would push cumulative session cost over `EVAL_BUDGET_USD`. */
export class BudgetExceededError extends Error {
  readonly cumulativeUsd: number;
  readonly limitUsd: number;

  constructor(cumulativeUsd: number, limitUsd: number) {
    super(
      `EVAL_BUDGET_USD exceeded: cumulative $${cumulativeUsd.toFixed(4)} ` +
        `>= limit $${limitUsd.toFixed(4)}`,
    );
    this.name = 'BudgetExceededError';
    this.cumulativeUsd = cumulativeUsd;
    this.limitUsd = limitUsd;
  }
}

// Module-level, process-wide cumulative cost tracker.
//
// INTENTIONALLY global-per-process, not per-session: this is the hard $
// ceiling (EVAL_BUDGET_USD) across ALL usage sharing this OpenRouter key —
// eval runs, live demo traffic, everything in this process — because a
// halted server is a far better failure mode than an overspent API key.
//
// This is NOT where per-session spend lives. Per-session accounting is
// `sessions.cost_usd`, maintained via `EventLog.touchSession` (events/log.ts)
// — api/ and pipeline code should read/display cost from there, not from
// this meter. This meter only answers "are we still allowed to spend?".
//
// Mutation is deliberately NOT public: only `llmCall` (below, in this file)
// may add to it, via the module-private `addCost`. The exported `costMeter`
// object exposes just `total()` (read) and `__resetForTest()` (test-only
// reset) — no public `add`.
let cumulativeUsd = 0;

function addCost(usd: number): number {
  cumulativeUsd += usd;
  return cumulativeUsd;
}

export const costMeter = {
  total(): number {
    return cumulativeUsd;
  },
  /** Test-only: zero the process-wide meter between test cases. */
  __resetForTest(): void {
    cumulativeUsd = 0;
  },
};

function budgetUsd(): number {
  const raw = Number(process.env['EVAL_BUDGET_USD'] ?? 25);
  return Number.isFinite(raw) ? raw : 25;
}

// --- test seam: inject a fake fetch so unit tests never hit the network ----

let testFetch: typeof fetch | undefined;

/** Test-only: override (or clear, passing `undefined`) the fetch used for
 * OpenRouter requests. Never call this from application code. */
export function __setTestFetch(fn: typeof fetch | undefined): void {
  testFetch = fn;
}

// --- spans -------------------------------------------------------------
//
// Delegates to `events/trace.ts`'s shared process-wide default sink (Task
// 19 carry-forward: `agent/pipeline.ts`, `agent/executor.ts`, and
// `baseline/agent.ts` now also write spans — kind:'retrieval'/'step'/
// 'joiner'/'compose' — onto that SAME sink, so a single `__setTestSpans`
// override here redirects every one of them, not just `llmCall`'s
// kind:'llm' spans).

function getSpans(): Spans {
  return getDefaultSpans();
}

/** Test-only: swap the `Spans` sink (e.g. onto a tmp DB) between test
 * files. Re-exported verbatim from `events/trace.ts`. */
export { __setTestSpans } from '../events/trace.js';

// --- test seam: shrink the real 1s→16s backoff schedule for fast tests -----

let testBackoffOptions: BackoffOptions | undefined;

/** Test-only: override backoff timing (e.g. `{ baseMs: 1 }`) so retry tests
 * don't sleep for real seconds. Pass `undefined` to restore production
 * defaults (1s → 16s, max 5 attempts). */
export function __setTestBackoffOptions(opts: BackoffOptions | undefined): void {
  testBackoffOptions = opts;
}

// --- cost accounting -----------------------------------------------------

interface OpenRouterUsageMeta {
  cost?: number;
  promptTokensDetails?: { cachedTokens: number };
}

function readOpenRouterUsageMeta(providerMetadata: unknown): OpenRouterUsageMeta | undefined {
  if (providerMetadata === null || typeof providerMetadata !== 'object') return undefined;
  const openrouter = (providerMetadata as Record<string, unknown>)['openrouter'];
  if (openrouter === null || typeof openrouter !== 'object') return undefined;
  const usage = (openrouter as Record<string, unknown>)['usage'];
  if (usage === null || typeof usage !== 'object') return undefined;
  return usage as OpenRouterUsageMeta;
}

function tablePriceCost(model: string, tokensIn: number, tokensOut: number, tokensCached: number): number {
  const price = priceFor(model);
  const nonCachedIn = Math.max(0, tokensIn - tokensCached);
  const cost =
    (nonCachedIn / 1_000_000) * price.inPerM +
    (tokensCached / 1_000_000) * price.cachedPerM +
    (tokensOut / 1_000_000) * price.outPerM;
  return Number.isFinite(cost) ? cost : 0;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Normalized shape extracted from `generateObject`/`generateText` so
 * `withBackoff`'s generic has one stable result type across both branches
 * (the SDK's own `GenerateObjectResult`/`GenerateTextResult` don't unify
 * cleanly under `exactOptionalPropertyTypes`). */
interface RawGenResult {
  text?: string;
  object?: unknown;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cachedInputTokens?: number | undefined;
  };
  providerMetadata?: unknown;
}

// --- the call --------------------------------------------------------------

export async function llmCall<T = string>(opts: LlmCallOptions<T>): Promise<LlmCallResult<T>> {
  const limitUsd = budgetUsd();
  if (costMeter.total() >= limitUsd) {
    throw new BudgetExceededError(costMeter.total(), limitUsd);
  }

  const openrouter = createOpenRouter({
    apiKey: process.env['OPENROUTER_API_KEY'] || 'test-key',
    ...(testFetch !== undefined ? { fetch: testFetch } : {}),
  });
  // The OpenRouter package bundles its own (structurally equivalent but
  // nominally distinct) copy of @ai-sdk/provider's LanguageModelV2 type; cast
  // through `unknown` rather than fight exactOptionalPropertyTypes variance
  // across the two copies.
  const model = openrouter.chat(opts.model, { usage: { include: true } }) as unknown as LanguageModel;

  const handle: SpanHandle = getSpans().start({ turnId: opts.turnId, kind: 'llm', name: opts.stage });
  // Wall-clock elapsed time for the call, deliberately NOT the virtual clock
  // (which is pinned/deterministic and does not tick) — real latency needs a
  // real monotonic timer, same as `store/reset.ts`'s `performance.now()` use.
  const startedAtMs = performance.now();

  // LLD §5.5: "GPT-5 family models always minimal reasoning effort" — applied
  // automatically so every call site (planner/joiner/baseline) gets it for
  // free; `opts.providerOptions`, if supplied, wins per provider key.
  const providerOptions: Record<string, Record<string, JSONValue>> | undefined = isGpt5Family(opts.model)
    ? { openrouter: { reasoning: { effort: 'minimal' } }, ...opts.providerOptions }
    : opts.providerOptions;

  try {
    const { value: generated, attempts } = await withBackoff<RawGenResult>(async () => {
      const common = {
        model,
        system: opts.system,
        prompt: opts.prompt,
        maxRetries: 0,
        ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
        ...(providerOptions !== undefined ? { providerOptions } : {}),
      };
      if (opts.schema) {
        const result = await generateObject({ ...common, schema: opts.schema });
        return { object: result.object, usage: result.usage, providerMetadata: result.providerMetadata };
      }
      const result = await generateText(common);
      return { text: result.text, usage: result.usage, providerMetadata: result.providerMetadata };
    }, testBackoffOptions);

    const latencyMs = performance.now() - startedAtMs;
    const usageRaw = generated.usage;
    const orUsage = readOpenRouterUsageMeta(generated.providerMetadata);

    const tokensIn = usageRaw.inputTokens ?? 0;
    const tokensOut = usageRaw.outputTokens ?? 0;
    const tokensCached = orUsage?.promptTokensDetails?.cachedTokens ?? usageRaw.cachedInputTokens ?? 0;

    const nativeCost = orUsage?.cost;
    const costUsd =
      typeof nativeCost === 'number' && Number.isFinite(nativeCost)
        ? nativeCost
        : tablePriceCost(opts.model, tokensIn, tokensOut, tokensCached);

    addCost(costUsd);

    const usage: LlmUsage = {
      model: opts.model,
      tokensIn,
      tokensOut,
      tokensCached,
      costUsd,
      latencyMs,
      attempt: attempts,
    };

    getSpans().end(handle, {
      tokensIn,
      tokensOut,
      costUsd,
      meta: { stage: opts.stage, attempts },
    });

    const value: T | string = opts.schema ? (generated.object as T) : generated.text ?? '';

    return { value, usage, spanId: handle.id };
  } catch (err) {
    getSpans().end(handle, { meta: { stage: opts.stage, error: describeError(err) } });
    throw err;
  }
}
