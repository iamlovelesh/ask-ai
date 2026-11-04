import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  llmCall,
  costMeter,
  BudgetExceededError,
  __setTestFetch,
  __setTestSpans,
  __setTestBackoffOptions,
} from '../src/llm/client';
import { openSpans, type Spans } from '../src/events/trace';
import { withBackoff, isRetryableError } from '../src/llm/backoff';
import { priceFor } from '../src/llm/prices';

// --- OpenRouter-shaped fetch mocking ----------------------------------------

interface ChatSuccessOpts {
  content?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
    cost?: number;
  };
  model?: string;
}

function chatSuccessBody(opts: ChatSuccessOpts = {}): unknown {
  const content = opts.content ?? 'hello from the model';
  const usage =
    opts.usage !== undefined
      ? { total_tokens: opts.usage.prompt_tokens + opts.usage.completion_tokens, ...opts.usage }
      : undefined;
  return {
    id: `gen_${randomUUID()}`,
    model: opts.model ?? 'anthropic/claude-haiku-4.5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
  };
}

function errorBody(message: string): unknown {
  return { error: { message, code: 'rate_limited', type: 'rate_limit_error' } };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Returns a `fetch` that replays `responses` in order, repeating the last
 * entry once exhausted. Also exposes a call counter. */
function sequenceFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  callCount: () => number;
} {
  let i = 0;
  const fn = (async (_url: unknown, _init?: unknown): Promise<Response> => {
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return jsonResponse(spec.status, spec.body);
  }) as typeof fetch;
  return { fetch: fn, callCount: () => i };
}

// --- test fixtures -----------------------------------------------------

let spansPath: string;
let spans: Spans;

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  spansPath = join(tmpdir(), `ask-ai-llm-client-spans-${randomUUID()}.db`);
  spans = openSpans(spansPath);
  __setTestSpans(spans);
  // Real backoff sleeps 1s/2s/4s/8s — shrink to milliseconds for the suite.
  __setTestBackoffOptions({ baseMs: 1 });
});

afterEach(() => {
  __setTestFetch(undefined);
  __setTestSpans(undefined);
  __setTestBackoffOptions(undefined);
  spans.close();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = spansPath + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe('llmCall — happy path', () => {
  it('returns text, usage, and a spanId; writes exactly one span', async () => {
    const { fetch: fakeFetch } = sequenceFetch([
      {
        status: 200,
        body: chatSuccessBody({
          content: 'Here is your answer.',
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, cost: 0.00042 },
        }),
      },
    ]);
    __setTestFetch(fakeFetch);

    const turnId = `turn_${randomUUID()}`;
    const result = await llmCall({
      stage: 'compose',
      model: 'anthropic/claude-haiku-4.5',
      system: 'You are helpful.',
      prompt: 'Say hi',
      turnId,
    });

    expect(result.value).toBe('Here is your answer.');
    expect(result.usage.model).toBe('anthropic/claude-haiku-4.5');
    expect(result.usage.tokensIn).toBe(20);
    expect(result.usage.tokensOut).toBe(8);
    expect(result.usage.attempt).toBe(1);
    expect(result.usage.costUsd).toBeCloseTo(0.00042, 6);

    const recorded = spans.forTurn(turnId);
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.kind).toBe('llm');
    expect(recorded[0]!.id).toBe(result.spanId);
    expect(recorded[0]!.tokensIn).toBe(20);
    expect(recorded[0]!.costUsd).toBeCloseTo(0.00042, 6);
  });

  it('returns a parsed+typed object when a schema is supplied', async () => {
    const schema = z.object({ answer: z.string(), confidence: z.number() });
    const { fetch: fakeFetch } = sequenceFetch([
      {
        status: 200,
        body: chatSuccessBody({
          content: JSON.stringify({ answer: '42', confidence: 0.9 }),
          usage: { prompt_tokens: 30, completion_tokens: 10, cost: 0.0001 },
        }),
      },
    ]);
    __setTestFetch(fakeFetch);

    const result = await llmCall({
      stage: 'plan',
      model: 'anthropic/claude-haiku-4.5',
      schema,
      system: 'sys',
      prompt: 'plan it',
      turnId: `turn_${randomUUID()}`,
    });

    expect(result.value).toEqual({ answer: '42', confidence: 0.9 });
  });
});

describe('llmCall — cost fallback (Review Focus 5)', () => {
  it('falls back to the price table when usage.cost is missing, and the result is always finite', async () => {
    const { fetch: fakeFetch } = sequenceFetch([
      {
        status: 200,
        body: chatSuccessBody({
          // usage present (so tokensIn/out are real) but no native `cost` field.
          usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
        }),
      },
    ]);
    __setTestFetch(fakeFetch);

    const result = await llmCall({
      stage: 'compose',
      model: 'anthropic/claude-haiku-4.5',
      system: 'sys',
      prompt: 'p',
      turnId: `turn_${randomUUID()}`,
    });

    expect(Number.isFinite(result.usage.costUsd)).toBe(true);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    // Matches the price table exactly: 1M in @ $1/M + 0.5M out @ $5/M.
    expect(result.usage.costUsd).toBeCloseTo(1.0 * 1 + 0.5 * 5, 4);
  });

  it('never produces NaN even for a model that is not in the price table', async () => {
    const { fetch: fakeFetch } = sequenceFetch([
      {
        status: 200,
        body: chatSuccessBody({
          model: 'some-vendor/unmapped-model',
          usage: { prompt_tokens: 500, completion_tokens: 200 },
        }),
      },
    ]);
    __setTestFetch(fakeFetch);

    const result = await llmCall({
      stage: 'compose',
      model: 'some-vendor/unmapped-model',
      system: 'sys',
      prompt: 'p',
      turnId: `turn_${randomUUID()}`,
    });

    expect(Number.isNaN(result.usage.costUsd)).toBe(false);
    expect(Number.isFinite(result.usage.costUsd)).toBe(true);
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  it('is finite even when usage is entirely absent from the response', async () => {
    const { fetch: fakeFetch } = sequenceFetch([{ status: 200, body: chatSuccessBody({}) }]);
    __setTestFetch(fakeFetch);

    const result = await llmCall({
      stage: 'compose',
      model: 'anthropic/claude-haiku-4.5',
      system: 'sys',
      prompt: 'p',
      turnId: `turn_${randomUUID()}`,
    });

    expect(Number.isFinite(result.usage.costUsd)).toBe(true);
    expect(result.usage.tokensIn).toBe(0);
    expect(result.usage.tokensOut).toBe(0);
  });
});

describe('llmCall — retry/backoff', () => {
  it('retries on 429 twice then succeeds, recording attempt=3', async () => {
    const { fetch: fakeFetch, callCount } = sequenceFetch([
      { status: 429, body: errorBody('rate limited') },
      { status: 429, body: errorBody('rate limited') },
      { status: 200, body: chatSuccessBody({ usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.00001 } }) },
    ]);
    __setTestFetch(fakeFetch);

    const result = await llmCall({
      stage: 'compose',
      model: 'anthropic/claude-haiku-4.5',
      system: 'sys',
      prompt: 'p',
      turnId: `turn_${randomUUID()}`,
    });

    expect(result.usage.attempt).toBe(3);
    expect(callCount()).toBe(3);
  });

  it('gives up with a non-retryable error immediately (no retry loop)', async () => {
    const { fetch: fakeFetch, callCount } = sequenceFetch([
      { status: 400, body: errorBody('bad request') },
    ]);
    __setTestFetch(fakeFetch);

    await expect(
      llmCall({
        stage: 'compose',
        model: 'anthropic/claude-haiku-4.5',
        system: 'sys',
        prompt: 'p',
        turnId: `turn_${randomUUID()}`,
      }),
    ).rejects.toThrow();
    expect(callCount()).toBe(1);
  });
});

describe('llmCall — budget guard', () => {
  // `costMeter.add` is not public (controller ruling: only `llmCall` may
  // mutate the process-wide meter), so these tests build up real spend
  // through `llmCall` itself rather than poking the meter directly.
  async function spend(costUsd: number): Promise<void> {
    const { fetch: spendFetch } = sequenceFetch([
      {
        status: 200,
        body: chatSuccessBody({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: costUsd } }),
      },
    ]);
    __setTestFetch(spendFetch);
    await llmCall({
      stage: 'compose',
      model: 'anthropic/claude-haiku-4.5',
      system: 'sys',
      prompt: 'p',
      turnId: `turn_${randomUUID()}`,
    });
  }

  it('throws typed BudgetExceededError once cumulative cost reaches EVAL_BUDGET_USD, without calling fetch', async () => {
    process.env['EVAL_BUDGET_USD'] = '1';
    costMeter.__resetForTest();

    // This call is allowed through (cumulative starts at 0 < budget 1) and
    // pushes cumulative spend to 2 — now over the $1 budget.
    await spend(2);
    expect(costMeter.total()).toBeCloseTo(2);

    // The next call must be refused BEFORE any network call.
    let fetchCalls = 0;
    __setTestFetch((async () => {
      fetchCalls++;
      throw new Error('fetch should not have been called');
    }) as typeof fetch);

    await expect(
      llmCall({
        stage: 'compose',
        model: 'anthropic/claude-haiku-4.5',
        system: 'sys',
        prompt: 'p',
        turnId: `turn_${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchCalls).toBe(0);
  });

  it('BudgetExceededError carries the cumulative and limit figures', async () => {
    process.env['EVAL_BUDGET_USD'] = '0.5';
    costMeter.__resetForTest();

    await spend(0.5);

    try {
      await llmCall({
        stage: 'compose',
        model: 'anthropic/claude-haiku-4.5',
        system: 'sys',
        prompt: 'p',
        turnId: `turn_${randomUUID()}`,
      });
      expect.unreachable('expected BudgetExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const budgetErr = err as BudgetExceededError;
      expect(budgetErr.cumulativeUsd).toBeCloseTo(0.5);
      expect(budgetErr.limitUsd).toBeCloseTo(0.5);
    }
  });
});

describe('withBackoff (unit)', () => {
  it('retries a retryable error up to maxAttempts then rethrows', async () => {
    let calls = 0;
    const retryable = Object.assign(new Error('boom'), { status: 503 });
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw retryable;
        },
        { maxAttempts: 3, baseMs: 1 },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(3);
  });

  it('does not retry a non-retryable error', async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw Object.assign(new Error('nope'), { status: 404 });
        },
        { maxAttempts: 5, baseMs: 1 },
      ),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });

  it('defaults to maxAttempts=6 (5 retries) so the documented 16s cap is reachable', async () => {
    const delays: number[] = [];
    const fakeSleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw Object.assign(new Error('boom'), { status: 503 });
        },
        { baseMs: 1000, sleep: fakeSleep }, // no maxAttempts override — exercise the default
      ),
    ).rejects.toThrow('boom');

    // 6 attempts total: 5 retry delays, doubling from 1s, capped at 16s.
    // The delay recorded immediately before the 6th (final) attempt is
    // exactly 16_000ms — the reviewer-mandated boundary assertion.
    expect(calls).toBe(6);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(delays[4]).toBe(16_000);
  });

  it('isRetryableError recognizes 429/5xx and rejects 4xx (except 429)', () => {
    expect(isRetryableError(Object.assign(new Error(), { status: 429 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error(), { status: 500 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error(), { status: 503 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error(), { status: 404 }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error(), { status: 400 }))).toBe(false);
  });
});

describe('priceFor', () => {
  it('has entries for the matrix models', () => {
    expect(priceFor('anthropic/claude-haiku-4.5').inPerM).toBeGreaterThan(0);
    expect(priceFor('google/gemini-2.5-flash-lite').inPerM).toBeGreaterThan(0);
    expect(priceFor('openai/gpt-5-mini').inPerM).toBeGreaterThan(0);
  });

  it('returns a conservative, finite default for unknown models', () => {
    const price = priceFor('totally/unknown-model');
    expect(Number.isFinite(price.inPerM)).toBe(true);
    expect(Number.isFinite(price.outPerM)).toBe(true);
    expect(Number.isFinite(price.cachedPerM)).toBe(true);
    expect(price.inPerM).toBeGreaterThan(0);
  });
});
