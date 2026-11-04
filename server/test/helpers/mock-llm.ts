/**
 * MockLLM test infra (Task 13) — a scriptable, OFFLINE OpenRouter-shaped
 * `fetch` for `llm/client.ts`'s `__setTestFetch` seam.
 *
 * Design choice (documented per the brief's "your call, document"): a FIFO
 * queue of plain JS VALUES — whatever `generateObject`'s schema expects for
 * that call (a `PlanOutcome`, a joiner `JoinerDecision`, ...) — consumed ONE
 * PER `llmCall` invocation, in call order, NOT keyed by `stage`.
 *
 * `__setTestFetch` only ever sees a raw HTTP request/response pair; it has
 * no visibility into `llmCall`'s `stage` option (that's a client-side
 * label, never serialized onto the wire). Keying by `stage` would need a
 * SECOND test seam on `llm/client.ts` (e.g. `__setTestPlanner`) — a bigger
 * surface than this task needs. Every `pipeline.test.ts` test already knows
 * the EXACT sequence of LLM calls the pipeline makes for its scenario (plan
 * → search → repair → joinerRepair, in that order) — "next queued value, in
 * order" is sufficient, and it's exactly what lets a test assert "exactly N
 * calls were made" / "the (N+1)th is never consumed" precisely.
 */

import { randomUUID } from 'node:crypto';

export interface MockLlmQueue {
  /** Pass to `__setTestFetch` from `llm/client.ts`. */
  fetch: typeof fetch;
  /** Requests actually consumed so far (≤ the scripted queue length). */
  callCount: () => number;
}

function chatCompletionBody(content: string, model: string): unknown {
  return {
    id: `gen_${randomUUID()}`,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.0001 },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Builds a `fetch` that replays `values` IN ORDER, one `generateObject`
 * result per call: `llmCall`'s `generateObject` path parses the assistant
 * message's `content` string as JSON against whatever schema the caller
 * passed, so any schema-shaped JS value works here.
 *
 * Calling it more times than `values.length` THROWS (synchronously, inside
 * the returned `fetch`) rather than repeating the last entry — the opposite
 * of `llm-client.test.ts`'s `sequenceFetch`, which intentionally repeats.
 * A pipeline test asserting "the pipeline makes no further calls" wants
 * over-calling to be a loud, immediate test failure, not a silently reused
 * stale response.
 */
export function queueMockLlm(values: readonly unknown[]): MockLlmQueue {
  let i = 0;
  const fn = (async (): Promise<Response> => {
    if (i >= values.length) {
      throw new Error(
        `queueMockLlm: exhausted after ${values.length} scripted response(s) — the pipeline made an ` +
          'extra, unscripted LLM call.',
      );
    }
    const value = values[i];
    i += 1;
    return jsonResponse(200, chatCompletionBody(JSON.stringify(value), 'mock-model'));
  }) as typeof fetch;
  return { fetch: fn, callCount: () => i };
}
