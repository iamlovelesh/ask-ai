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

// --- wire-shape normalization (Task 6 round-2 + round-3 fixes, docs/
// SPIKES.md §1b/§1c) ---------------------------------------------------------
//
// `planner.ts`'s `plan()`, `pipeline.ts`'s repair call site, and
// `joiner.ts`'s `joinerRepair` now request flat, all-fields-required WIRE
// schemas (`flatPlanOutcomeSchema` / `wireJoinerDecisionSchema`, each
// built from `wireStepSchema`) instead of the old discriminated unions — a
// real provider's structured-output decoding enforces that shape
// mechanically, but THIS mock replays raw JS values as-is, so a terse,
// old-style scripted value (e.g. `{kind:'respond', text:'hi'}`, or a step
// with a plain `params` object and no `forEach`/`when`/`expects`) would
// fail the wire schema's own `required`/`type` checks before the test ever
// reaches the behavior it's checking. Rather than rewrite every
// `queueMockLlm([...])` call site across `pipeline.test.ts`/`api.test.ts`
// to spell out every wire placeholder, normalize here:
//   - any value duck-typed as a `PlanOutcome` (`kind` matching one of the 5
//     real literals) gets the 4 unused kind-specific fields defaulted;
//   - any value duck-typed as a `JoinerDecision` (`decision` matching one
//     of the 4 real literals) gets `patchedSteps`/`question` defaulted;
//   - every step object reachable through `plan.steps` or `patchedSteps`
//     (recursively, for repair/replan scenarios with nested patches) is
//     normalized to the wire `Step` shape: a plain `params` object is
//     JSON-stringified, and `forEach`/`when`/`expects`, if omitted or
//     partially specified, are filled out to their sentinel/null wire
//     defaults.
// Values that duck-type as NEITHER (a deliberately-malformed value a test
// uses to exercise the parse-failure path, e.g. `{nonsense:true}` or
// `{kind:'final',...}` with an invalid `kind`) pass through unchanged —
// malformed-on-purpose stays malformed.
const PLAN_OUTCOME_KINDS: ReadonlySet<string> = new Set(['plan', 'search', 'clarify', 'unsupported', 'respond']);
const JOINER_DECISIONS: ReadonlySet<string> = new Set(['patch', 'proceed', 'clarify', 'abort']);

function normalizeWireStep(step: unknown): unknown {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) return step;
  const s = step as Record<string, unknown>;
  const params = typeof s['params'] === 'string' ? s['params'] : JSON.stringify(s['params'] ?? {});
  const whenIn = (s['when'] as Record<string, unknown> | undefined) ?? {};
  const expectsIn = (s['expects'] as Record<string, unknown> | undefined) ?? {};
  return {
    ...s,
    params,
    forEach: typeof s['forEach'] === 'string' ? s['forEach'] : '',
    when: { ref: '', op: 'eq', value: null, ...whenIn },
    expects: { nonEmpty: null, maxCount: null, minCount: null, ...expectsIn },
  };
}

function normalizeWireSteps(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map(normalizeWireStep);
}

function normalizeMockValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;

  if (typeof obj['kind'] === 'string' && PLAN_OUTCOME_KINDS.has(obj['kind'])) {
    const merged = { plan: { goal: '', steps: [] }, queries: [], question: null, reason: null, text: null, ...obj };
    const plan = merged['plan'] as Record<string, unknown>;
    return { ...merged, plan: { ...plan, steps: normalizeWireSteps(plan['steps']) } };
  }

  if (typeof obj['decision'] === 'string' && JOINER_DECISIONS.has(obj['decision'])) {
    const merged = { patchedSteps: [], question: null, ...obj };
    return { ...merged, patchedSteps: normalizeWireSteps(merged['patchedSteps']) };
  }

  return value;
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
    const value = normalizeMockValue(values[i]);
    i += 1;
    return jsonResponse(200, chatCompletionBody(JSON.stringify(value), 'mock-model'));
  }) as typeof fetch;
  return { fetch: fn, callCount: () => i };
}
