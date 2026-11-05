import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runTurn, type SessionDeps } from '../src/agent/pipeline';
import { queueMockLlm } from './helpers/mock-llm';
import { __setTestFetch, __setTestBackoffOptions, costMeter } from '../src/llm/client';
import { openEventLog, type EventLog } from '../src/events/log';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import { createRefStore, type RefStore } from '../src/agent/refs';
import { buildRegistry, type Registry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef, ActionContext, Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import type { ConfirmBroker } from '../src/agent/executor';
import type { Event } from '../src/events/types';

// --- harness (mirrors pipeline.test.ts) -------------------------------------

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;

function action(slug: string, risk: Risk, handler: Handler): ActionDef {
  return {
    id: slug,
    slug,
    module: slug.split('.')[0] as string,
    name: slug,
    description: slug,
    risk,
    entities: [slug.split('.')[0] as string],
    inputSchema: z.any(),
    outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: handler as ActionDef['handler'],
  };
}

const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };
const approveAll: ConfirmBroker = { request: async () => true };

/** A chat-completion body whose assistant message content is RAW text — what
 * the polish call (`generateText`, no schema) reads back verbatim. Distinct
 * from `queueMockLlm`, which JSON-stringifies each value for the structured
 * `generateObject` plan path. */
function rawTextResponse(text: string): Response {
  const body = {
    id: `gen_${randomUUID()}`,
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.0001 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * A fetch that serves the plan call (call #1) through `queueMockLlm` (so the
 * wire schema is satisfied), then serves the polish call (call #2) with a
 * caller-supplied raw-text handler. Any call beyond #2 throws.
 */
function planThenPolishFetch(planOutcome: unknown, polish: () => Response): typeof fetch {
  const planQueue = queueMockLlm([planOutcome]);
  let calls = 0;
  return (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    calls += 1;
    if (calls === 1) return (planQueue.fetch as (u: unknown, i: unknown) => Promise<Response>)(url, init);
    if (calls === 2) return polish();
    throw new Error(`unexpected LLM call #${calls}`);
  }) as typeof fetch;
}

const tmpPaths: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `ask-ai-polish-${randomUUID()}.db`);
  tmpPaths.push(p);
  return p;
}
function cleanup(p: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = p + suffix;
    if (existsSync(f)) rmSync(f, { force: true });
  }
}

let eventLog: EventLog;
let sessionsDb: SessionsDb;
let refs: RefStore;
const sessionId = 'sess_polish';

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  delete process.env['COMPOSER_POLISH'];
  __setTestBackoffOptions({ baseMs: 1 });
  const dbPath = tmpDbPath();
  eventLog = openEventLog(dbPath);
  sessionsDb = openSessions(dbPath);
  refs = createRefStore(sessionsDb, sessionId);
});

afterEach(() => {
  __setTestFetch(undefined);
  __setTestBackoffOptions(undefined);
  delete process.env['COMPOSER_POLISH'];
  eventLog.close();
  sessionsDb.close();
  while (tmpPaths.length) cleanup(tmpPaths.pop() as string);
});

function deps(registry: Registry): SessionDeps {
  return { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, playbooks: [] };
}

async function drive(registry: Registry, userText: string): Promise<Event[]> {
  const events: Event[] = [];
  for await (const ev of runTurn({ sessionId, turnId: `t_${randomUUID()}`, userText, sessionDeps: deps(registry) })) {
    events.push(ev);
  }
  return events;
}

function finalText(events: readonly Event[]): string {
  const ev = events.find((e) => e.t === 'answer.final');
  if (!ev || ev.t !== 'answer.final') throw new Error('no answer.final');
  return ev.text;
}
function completed(events: readonly Event[]): Extract<Event, { t: 'turn.completed' }> {
  const ev = events.find((e) => e.t === 'turn.completed');
  if (!ev || ev.t !== 'turn.completed') throw new Error('no turn.completed');
  return ev;
}

const ONE_STEP_PLAN = {
  kind: 'plan',
  plan: { goal: 'find leads', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] },
};
function oneStepRegistry(): Registry {
  return buildRegistry(
    [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
    coreOps,
  );
}
/** The pure-template text this plan composes to — the fallback target. */
const TEMPLATE_TEXT = 'I found 1 lead.';

// --- polish OFF (default) ---------------------------------------------------

describe('composer polish — OFF by default', () => {
  it('makes exactly ONE LLM call (plan only) and uses the template text verbatim', async () => {
    const queue = queueMockLlm([ONE_STEP_PLAN]);
    __setTestFetch(queue.fetch);

    const events = await drive(oneStepRegistry(), 'find my leads');

    // If polish had run it would have attempted a 2nd call and queueMockLlm
    // would THROW (exhausted) — so callCount===1 proves polish never ran.
    expect(queue.callCount()).toBe(1);
    expect(completed(events).metrics.llmCalls).toBe(1);
    expect(finalText(events)).toBe(TEMPLATE_TEXT);
  });
});

// --- polish ON --------------------------------------------------------------

describe('composer polish — ON (COMPOSER_POLISH=1)', () => {
  it('passes the polished reply through as the final answer and counts the extra call honestly', async () => {
    process.env['COMPOSER_POLISH'] = '1';
    const POLISHED = 'I found 1 lead for you.';
    __setTestFetch(planThenPolishFetch(ONE_STEP_PLAN, () => rawTextResponse(POLISHED)));

    const events = await drive(oneStepRegistry(), 'find my leads');

    expect(finalText(events)).toBe(POLISHED);
    // The extra polish call is counted honestly (plan + polish = 2).
    expect(completed(events).metrics.llmCalls).toBe(2);
    // The delta stream reassembles to the same polished text.
    const delta = events.filter((e) => e.t === 'answer.delta').map((e) => (e.t === 'answer.delta' ? e.text : '')).join('');
    expect(delta).toBe(POLISHED);
  });

  it('falls back to the template text when the polish response is empty/missing', async () => {
    process.env['COMPOSER_POLISH'] = '1';
    __setTestFetch(planThenPolishFetch(ONE_STEP_PLAN, () => rawTextResponse('   ')));

    const events = await drive(oneStepRegistry(), 'find my leads');

    expect(finalText(events)).toBe(TEMPLATE_TEXT);
    // The call was still attempted (and succeeded HTTP-wise), so it counts.
    expect(completed(events).metrics.llmCalls).toBe(2);
  });

  it('falls back to the template text when the polish call errors', async () => {
    process.env['COMPOSER_POLISH'] = '1';
    __setTestFetch(
      planThenPolishFetch(ONE_STEP_PLAN, () => new Response('boom', { status: 500 })),
    );

    const events = await drive(oneStepRegistry(), 'find my leads');

    // Silent fallback — the turn still completes 'done' with the template.
    expect(finalText(events)).toBe(TEMPLATE_TEXT);
    expect(completed(events).status).toBe('done');
  });

  it('does not polish a clarify outcome (only operations summaries)', async () => {
    process.env['COMPOSER_POLISH'] = '1';
    const queue = queueMockLlm([{ kind: 'clarify', question: 'Which lead did you mean?' }]);
    __setTestFetch(queue.fetch);

    const events = await drive(oneStepRegistry(), 'do the thing');

    // Only the plan call — clarify is returned verbatim, never polished (a
    // 2nd call would exhaust the queue and throw).
    expect(queue.callCount()).toBe(1);
    expect(finalText(events)).toBe('Which lead did you mean?');
  });
});
