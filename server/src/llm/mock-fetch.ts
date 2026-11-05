/**
 * Offline MockLLM boot hook (Task 16 / LLD §9.3 runner E2E proof):
 * `MOCK_LLM_SCRIPT=<path to a JSON array>` (NODE_ENV-guarded — never active
 * in production) loads a FIFO queue of schema-shaped JS values at server
 * boot and wires them into `llm/client.ts`'s `__setTestFetch` seam for the
 * lifetime of the process — the SAME mechanism `server/test/helpers/
 * mock-llm.ts`'s `queueMockLlm` uses for unit tests, reimplemented here
 * (not imported: `server/test/**` is never part of the production build,
 * so `src/` cannot depend on it) so `eval/runner.ts` can spawn a REAL
 * server process and drive one full scenario end-to-end — spawn → reset →
 * SSE → assert → JSONL — with zero network calls and zero cost.
 *
 * Script format: a JSON array; each element is consumed, in order, as the
 * `object` result of exactly one `generateObject` call (`llmCall`'s
 * `schema` path) — a `PlanOutcome`, a joiner decision, a baseline
 * `call_action`/`final` decision, whatever that call site's schema
 * expects. Calling past the end of the array throws — a loud, immediate
 * failure rather than silently replaying a stale response — so a scripted
 * E2E scenario that makes an unexpected extra LLM call fails fast instead
 * of returning garbage.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { __setTestFetch } from './client.js';

function chatCompletionBody(content: string, model: string): unknown {
  return {
    id: `gen_${randomUUID()}`,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0 },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// --- wire-shape normalization — the SAME terse-value tolerance as
// `server/test/helpers/mock-llm.ts` (duplicated by design: src/ cannot
// import test helpers): planner/joiner/baseline call sites now request
// flat, all-fields-required WIRE schemas, so old-style scripted values
// (plain `params` objects, no `reasoning`, no sentinels) are filled out
// here before replay. Malformed-on-purpose values pass through unchanged.
const PLAN_OUTCOME_KINDS: ReadonlySet<string> = new Set(['plan', 'search', 'clarify', 'unsupported', 'respond']);
const JOINER_DECISIONS: ReadonlySet<string> = new Set(['patch', 'proceed', 'clarify', 'abort']);
const BASELINE_KINDS: ReadonlySet<string> = new Set(['call_action', 'final']);

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
    const merged = {
      reasoning: 'scripted reasoning',
      plan: { goal: '', steps: [] },
      queries: [],
      question: null,
      reason: null,
      text: null,
      ...obj,
    };
    const plan = merged['plan'] as Record<string, unknown>;
    return { ...merged, plan: { ...plan, steps: normalizeWireSteps(plan['steps']) } };
  }

  if (typeof obj['kind'] === 'string' && BASELINE_KINDS.has(obj['kind'])) {
    const params = obj['params'];
    return {
      kind: obj['kind'],
      slug: typeof obj['slug'] === 'string' ? obj['slug'] : '',
      paramsJson: typeof obj['paramsJson'] === 'string' ? obj['paramsJson'] : JSON.stringify(params ?? {}),
      text: typeof obj['text'] === 'string' ? obj['text'] : '',
    };
  }

  if (typeof obj['decision'] === 'string' && JOINER_DECISIONS.has(obj['decision'])) {
    const merged = { patchedSteps: [], question: null, ...obj };
    return { ...merged, patchedSteps: normalizeWireSteps(merged['patchedSteps']) };
  }

  return value;
}

/** Builds a `fetch` replaying `values` in order, one per `llmCall` invocation. */
export function buildMockFetch(values: readonly unknown[]): typeof fetch {
  let i = 0;
  return (async (): Promise<Response> => {
    if (i >= values.length) {
      throw new Error(
        `MOCK_LLM_SCRIPT exhausted after ${values.length} scripted response(s) — an unscripted extra LLM call was made.`,
      );
    }
    const value = normalizeMockValue(values[i]);
    i += 1;
    return jsonResponse(200, chatCompletionBody(JSON.stringify(value), 'mock-model'));
  }) as typeof fetch;
}

/**
 * Called once from `index.ts` at boot. No-op unless BOTH `MOCK_LLM_SCRIPT`
 * is set AND `NODE_ENV !== 'production'` — a production deployment must
 * never be able to silently short-circuit every LLM call via an env var.
 */
export function installMockLlmFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const scriptPath = env['MOCK_LLM_SCRIPT'];
  if (!scriptPath || env['NODE_ENV'] === 'production') return;

  const raw = readFileSync(scriptPath, 'utf-8');
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values)) {
    throw new Error(`MOCK_LLM_SCRIPT at '${scriptPath}' must contain a JSON array of scripted LLM responses.`);
  }
  __setTestFetch(buildMockFetch(values));
}
