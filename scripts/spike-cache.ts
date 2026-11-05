/**
 * Task 6, Step 2 — Anthropic prompt-cache passthrough spike (LLD §10 Spike
 * A / §9.2 measurement conditions).
 *
 * Two calls to anthropic/claude-haiku-4.5 with an IDENTICAL system prompt
 * (the real, byte-stable planner system prompt from
 * `server/src/agent/planner.ts::buildPlannerPrompt` — ~1.2k tokens; see
 * docs/SPIKES.md for the discrepancy against the brief's "~3k" estimate)
 * and a different short user suffix, via `llmCall` (`stage:'spike'`,
 * default path — no explicit cache_control). Records whether
 * `usage.tokensCached` is nonzero on call 2.
 *
 * If call 2 shows zero cached tokens, ALSO runs up to 2 more calls that
 * bypass `llmCall` and set an explicit Anthropic `cacheControl: {type:
 * 'ephemeral'}` breakpoint on the system message via the OpenRouter AI SDK
 * provider's documented `providerOptions.openrouter.cacheControl` passthrough
 * (README: "Anthropic Prompt Caching"), to see whether the passthrough
 * exists at all when asked for explicitly.
 *
 * Run: `npx tsx scripts/spike-cache.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateText, type JSONValue, type LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import { buildPlannerPrompt, type PlannerPromptCtx } from '../server/src/agent/planner.js';
import { llmCall } from '../server/src/llm/client.js';
import { emptyWorkingState, renderWorkingState } from '../server/src/agent/memory.js';
import { priceFor } from '../server/src/llm/prices.js';

// NOTE: deliberately NOT passing `schema: planOutcomeSchema` on these calls.
// `scripts/spike-schema.ts` (run first) found that the real `PlanOutcome`
// schema's recursive `Value` type (`agent/plan-schema.ts`'s `valueSchema`,
// a `z.lazy` union including `z.record(z.string(), valueSchema)`) is
// rejected as an invalid JSON Schema by ALL THREE providers' structured
// output validators (Anthropic: "circular reference ... not supported";
// Google: "ref loop of required fields"; OpenAI: "'propertyNames' is not
// permitted") — see docs/SPIKES.md. Using that schema here would make every
// call in THIS spike fail on the same schema bug, telling us nothing about
// caching. This spike is schema-agnostic by design (`generateText`, no
// `schema` field) — it tests prompt-prefix caching, not structured output.

// --- minimal .env loader (no dotenv dep; never logs the value) ------------

function loadDotEnv(): void {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key !== '' && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const MODEL = 'anthropic/claude-haiku-4.5';

const CARDS = [
  'leads.search_leads — Search leads: Search non-archived leads by name and common filters. [query, status, source, owner_id, created_after, created_before, limit]',
  'tasks.create_task — Create task: Create a new task, optionally due/owned/linked to a contact. [title, description, due_date, owner_id, contact_id, priority]',
].join('\n');

const NOW_ISO = process.env['VIRTUAL_NOW'] || '2026-11-04T10:00:00Z';

function buildCtx(suffix: string): PlannerPromptCtx {
  const rawRequest = `Find leads created last week who have not replied. (${suffix})`;
  return {
    workingStateBlock: renderWorkingState(emptyWorkingState()),
    maskedTurns: '',
    cards: CARDS,
    rewrittenRequest: rawRequest,
    rawRequest,
    nowIso: NOW_ISO,
  };
}

interface CacheCallResult {
  label: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  latencyMs: number;
}

// --- Path A: the default llmCall path (no explicit cache_control) ---------

async function callViaLlmCall(label: string, suffix: string): Promise<CacheCallResult> {
  const { system, prompt } = buildPlannerPrompt(buildCtx(suffix));
  const started = performance.now();
  const result = await llmCall<string>({
    stage: 'spike',
    model: MODEL,
    system,
    prompt,
    turnId: `spike-cache-${label}`,
    maxOutputTokens: 16,
  });
  return {
    label,
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
    tokensCached: result.usage.tokensCached,
    costUsd: result.usage.costUsd,
    latencyMs: Math.round(performance.now() - started),
  };
}

// --- Path B: explicit cache_control on the system message, bypassing
// llmCall's flat system/prompt-string interface (it has no per-message
// providerOptions seam) to hand-build a `messages` array whose system
// message carries `providerOptions.openrouter.cacheControl` per the
// @openrouter/ai-sdk-provider README's "Anthropic Prompt Caching" section.
// ---------------------------------------------------------------------------

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

async function callWithExplicitCacheControl(label: string, suffix: string): Promise<CacheCallResult> {
  const { system, prompt } = buildPlannerPrompt(buildCtx(suffix));
  const openrouter = createOpenRouter({ apiKey: process.env['OPENROUTER_API_KEY'] || 'test-key' });
  // Same cast as `llm/client.ts`: the OpenRouter package bundles its own
  // (structurally equivalent but nominally distinct) copy of
  // @ai-sdk/provider's LanguageModelV2 type.
  const model = openrouter.chat(MODEL, { usage: { include: true } }) as unknown as LanguageModel;

  const started = performance.now();
  const result = await generateText({
    model,
    maxOutputTokens: 16,
    maxRetries: 0,
    messages: [
      {
        role: 'system',
        content: system,
        providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } as Record<string, JSONValue> },
      },
      { role: 'user', content: prompt },
    ],
  });
  const latencyMs = performance.now() - started;

  const tokensIn = result.usage.inputTokens ?? 0;
  const tokensOut = result.usage.outputTokens ?? 0;
  const orUsage = readOpenRouterUsageMeta(result.providerMetadata);
  const tokensCached = orUsage?.promptTokensDetails?.cachedTokens ?? result.usage.cachedInputTokens ?? 0;
  const nativeCost = orUsage?.cost;
  let costUsd: number;
  if (typeof nativeCost === 'number' && Number.isFinite(nativeCost)) {
    costUsd = nativeCost;
  } else {
    const price = priceFor(MODEL);
    const nonCachedIn = Math.max(0, tokensIn - tokensCached);
    costUsd =
      (nonCachedIn / 1_000_000) * price.inPerM +
      (tokensCached / 1_000_000) * price.cachedPerM +
      (tokensOut / 1_000_000) * price.outPerM;
  }

  return { label, tokensIn, tokensOut, tokensCached, costUsd, latencyMs: Math.round(latencyMs) };
}

async function main(): Promise<void> {
  if (!process.env['OPENROUTER_API_KEY']) {
    console.error('OPENROUTER_API_KEY not set (checked process.env and .env) — aborting.');
    process.exit(1);
  }

  console.error('[spike-cache] call 1 (llmCall, default path)...');
  const call1 = await callViaLlmCall('call1', 'first call');
  console.error('[spike-cache] call 2 (llmCall, default path, identical system)...');
  const call2 = await callViaLlmCall('call2', 'second call');

  const defaultPathConfirmed = call2.tokensCached > 0;

  const out: Record<string, unknown> = { defaultPath: { call1, call2, cachePassthroughConfirmed: defaultPathConfirmed } };

  if (!defaultPathConfirmed) {
    console.error('[spike-cache] default path showed zero cached tokens on call 2 — trying explicit cacheControl...');
    console.error('[spike-cache] explicit-cacheControl call 1...');
    const ccCall1 = await callWithExplicitCacheControl('cc_call1', 'explicit cc first call');
    console.error('[spike-cache] explicit-cacheControl call 2...');
    const ccCall2 = await callWithExplicitCacheControl('cc_call2', 'explicit cc second call');
    out['explicitCacheControlPath'] = {
      call1: ccCall1,
      call2: ccCall2,
      cachePassthroughConfirmed: ccCall2.tokensCached > 0,
    };
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error('[spike-cache] fatal:', err);
  process.exit(1);
});
