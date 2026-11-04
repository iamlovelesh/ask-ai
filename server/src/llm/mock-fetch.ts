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

/** Builds a `fetch` replaying `values` in order, one per `llmCall` invocation. */
export function buildMockFetch(values: readonly unknown[]): typeof fetch {
  let i = 0;
  return (async (): Promise<Response> => {
    if (i >= values.length) {
      throw new Error(
        `MOCK_LLM_SCRIPT exhausted after ${values.length} scripted response(s) — an unscripted extra LLM call was made.`,
      );
    }
    const value = values[i];
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
