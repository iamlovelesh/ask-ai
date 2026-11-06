import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SessionRuntime } from '../src/api/turn-runtime';
import { openEventLog, type EventLog } from '../src/events/log';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import { buildRegistry } from '../src/catalog/registry';
import { __resetIndexForTest } from '../src/agent/retrieval';
import { __setLoopTestFetch } from '../src/llm/agents-runtime';
import { costMeter, __setTestFetch, __setTestBackoffOptions } from '../src/llm/client';
import { queueMockLlm } from './helpers/mock-llm';
import type { ActionContext, ActionDef, Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import type { Event } from '../src/events/types';

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;

function action(slug: string, risk: Risk, handler: Handler): ActionDef {
  return {
    id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug,
    risk, entities: [slug.split('.')[0] as string],
    inputSchema: z.object({}).catchall(z.unknown()), outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: handler as ActionDef['handler'],
  };
}

const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };

function toolCallResponse(name: string, args: Record<string, unknown>): unknown {
  return {
    id: 'gen', object: 'chat.completion', created: 1, model: 'anthropic/claude-haiku-4.5',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function textResponse(text: string): unknown {
  return {
    id: 'gen', object: 'chat.completion', created: 2, model: 'anthropic/claude-haiku-4.5',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function loopFetch(script: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const payload = JSON.parse(JSON.stringify(script[Math.min(i, script.length - 1)])) as {
      choices?: { message?: { tool_calls?: { id: string }[] } }[];
    };
    for (const c of payload.choices ?? []) for (const tc of c.message?.tool_calls ?? []) tc.id = `call_${i}_${randomUUID().slice(0, 6)}`;
    i += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const tmpPaths: string[] = [];
let eventLog: EventLog;
let sessionsDb: SessionsDb;

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  __setTestBackoffOptions({ baseMs: 1 });
  __resetIndexForTest();
  const p = join(tmpdir(), `ask-ai-rt-${randomUUID()}.db`);
  tmpPaths.push(p);
  eventLog = openEventLog(p);
  sessionsDb = openSessions(p);
});

afterEach(() => {
  __setLoopTestFetch(undefined);
  __setTestFetch(undefined);
  __setTestBackoffOptions(undefined);
  eventLog.close();
  sessionsDb.close();
  while (tmpPaths.length) {
    const p = tmpPaths.pop() as string;
    for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(p + s)) rmSync(p + s, { force: true });
  }
});

function makeRuntime(actions: ActionDef[]): SessionRuntime {
  const registry = buildRegistry([actions], []);
  return new SessionRuntime(sessionsDb, eventLog, registry, [], () => fakeCrm);
}

async function waitForCompleted(sessionId: string, timeoutMs = 10_000): Promise<Event[]> {
  const startedAt = Date.now();
  for (;;) {
    const events = eventLog.list(sessionId).map((se) => se.event);
    if (events.some((e) => e.t === 'turn.completed')) return events;
    if (Date.now() - startedAt > timeoutMs) throw new Error('turn never completed');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitFor(sessionId: string, type: Event['t'], timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (eventLog.list(sessionId).some((se) => se.event.t === type)) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`no ${type} event`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('SessionRuntime agent routing', () => {
  it("agent:'optimized' drives the tool loop — no plan.ready, loop-shaped events", async () => {
    __setLoopTestFetch(loopFetch([toolCallResponse('leads__search_leads', { query: 'x' }), textResponse('Found 2 leads.')]));
    const runtime = makeRuntime([action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }, { id: 'l2' }], total: 2 }))]);
    const sessionId = eventLog.createSession('t');
    runtime.startTurn({ sessionId, userText: 'find leads', agent: 'optimized' });
    const events = await waitForCompleted(sessionId);
    const types = events.map((e) => e.t);
    expect(types).not.toContain('plan.ready');
    expect(types).toContain('step.started');
    const final = events.find((e) => e.t === 'answer.final');
    expect(final && final.t === 'answer.final' ? final.text : '').toBe('Found 2 leads.');
  });

  it("agent:'plandsl' still drives the plan-DSL pipeline — plan.ready emitted", async () => {
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'list leads', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);
    const runtime = makeRuntime([action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]);
    const sessionId = eventLog.createSession('t');
    runtime.startTurn({ sessionId, userText: 'list leads', agent: 'plandsl' });
    const events = await waitForCompleted(sessionId, 20_000);
    expect(events.map((e) => e.t)).toContain('plan.ready');
  });

  it('cancel during a loop gate denies the confirmation and finalizes cancelled with zero writes', async () => {
    let invocations = 0;
    // The model stubbornly keeps calling the tool after the denial — cancel
    // must still end the turn promptly as 'cancelled' (review I4), not let
    // it loop or re-gate.
    __setLoopTestFetch(loopFetch([toolCallResponse('invoices__send_reminders', { ids: ['a', 'b'] })]));
    const runtime = makeRuntime([action('invoices.send_reminders', 'bulk', async () => { invocations += 1; return {}; })]);
    const sessionId = eventLog.createSession('t');
    runtime.startTurn({ sessionId, userText: 'send reminders', agent: 'optimized' });
    await waitFor(sessionId, 'confirmation.required');
    expect(runtime.cancel(sessionId)).toBe(true);
    const events = await waitForCompleted(sessionId);
    const completed = events.find((e) => e.t === 'turn.completed');
    expect(completed && completed.t === 'turn.completed' ? completed.status : '').toBe('cancelled');
    expect(invocations).toBe(0);
  });
});
