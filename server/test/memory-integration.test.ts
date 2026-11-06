/**
 * Cross-session integration (memory-layer plan Task 11): a fact learned in
 * session A is recalled in session B; deleting it via the HTTP API removes it
 * from session C's recall; a global off switch suppresses recall entirely in
 * session D. One shared sessions.db across all four turns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runLoopTurn, type RunLoopTurnInput } from '../src/loop/agent';
import { costMeter } from '../src/llm/client';
import { __resetIndexForTest } from '../src/agent/retrieval';
import { openEventLog, type EventLog } from '../src/events/log';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import { openSpans, type Spans } from '../src/events/trace';
import { createRefStore } from '../src/agent/refs';
import { buildRegistry } from '../src/catalog/registry';
import { SessionRuntime } from '../src/api/turn-runtime';
import { registerMemoryRoutes } from '../src/api/memory';
import { createMemoryStore, type MemoryStore } from '../src/memory/store';
import type { AppDeps } from '../src/api/types';
import type { ActionContext, ActionDef, Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import type { Event } from '../src/events/types';

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;
function action(slug: string, risk: Risk, handler: Handler): ActionDef {
  return { id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug, risk, entities: [slug.split('.')[0] as string], inputSchema: z.object({}).catchall(z.unknown()), outputSchema: z.any(), searchCard: { synonyms: [], examplePhrasings: [] }, handler: handler as ActionDef['handler'] };
}
const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };
function textResponse(text: string): unknown { return { id: 'g', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; }
function toolCallResponse(name: string, args: Record<string, unknown>): unknown { return { id: 'g', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `c_${randomUUID().slice(0, 6)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; }
function capturingFetch(script: unknown[], bodies: string[]): typeof fetch {
  let i = 0;
  return (async (_i: unknown, init?: RequestInit) => {
    if (init?.body) bodies.push(String(init.body));
    const payload = JSON.parse(JSON.stringify(script[Math.min(i, script.length - 1)])) as { choices?: { message?: { tool_calls?: { id: string }[] } }[] };
    for (const c of payload.choices ?? []) for (const tc of c.message?.tool_calls ?? []) tc.id = `c_${i}_${randomUUID().slice(0, 6)}`;
    i += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const tmpPaths: string[] = [];
let eventLog: EventLog; let sessionsDb: SessionsDb; let spans: Spans; let memory: MemoryStore;

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  __resetIndexForTest();
  const p = join(tmpdir(), `ask-ai-memint-${randomUUID()}.db`);
  tmpPaths.push(p);
  eventLog = openEventLog(p);
  sessionsDb = openSessions(p);
  spans = openSpans(p);
  memory = createMemoryStore(sessionsDb);
});
afterEach(() => {
  eventLog.close(); sessionsDb.close(); spans.close();
  while (tmpPaths.length) { const p = tmpPaths.pop() as string; for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(p + s)) rmSync(p + s, { force: true }); }
});

async function turn(sessionId: string, userText: string, script: unknown[], bodies: string[], opts: { enabled?: boolean; writable?: boolean } = {}): Promise<Event[]> {
  const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
  const events: Event[] = [];
  const input: RunLoopTurnInput = {
    sessionId, turnId: `t_${randomUUID()}`, userText,
    sessionDeps: {
      registry, crm: fakeCrm, refs: createRefStore(sessionsDb, sessionId), eventLog,
      confirm: { request: async () => true }, testFetch: capturingFetch(script, bodies),
      memory, memoryEnabled: opts.enabled ?? true, memoryWritable: opts.writable ?? true,
      runExtraction: async () => {}, // isolate: exercise the tool write-path, not the extractor
    },
  };
  for await (const ev of runLoopTurn(input)) events.push(ev);
  return events;
}

function apiApp(): FastifyInstance {
  const registry = buildRegistry([[]], []);
  const runtime = new SessionRuntime(sessionsDb, eventLog, registry, [], () => fakeCrm, false);
  const deps: AppDeps = { registry, eventLog, sessionsDb, spans, runtime, profile: 'fake' };
  const app = Fastify({ logger: false });
  registerMemoryRoutes(app, deps);
  return app;
}

describe('memory cross-session integration', () => {
  it('learns in A, recalls in B, forgets via API for C, and off-switch suppresses D', async () => {
    // (a) Session A — the model saves a durable preference via the tool.
    await turn('A', 'I prefer EU date format', [
      toolCallResponse('memory__save', { category: 'preference', body: 'prefers EU date format', key: 'date-format' }),
      textResponse('Noted — I will remember that.'),
    ], []);
    const live = memory.listLive('user_1');
    expect(live).toHaveLength(1);
    expect(live[0]!.body).toBe('prefers EU date format');
    const memId = live[0]!.id;

    // (b) Session B — a fresh session recalls the fact in its <memories> block.
    const bBodies: string[] = [];
    await turn('B', 'what format do I like?', [textResponse('From what I remember, EU dates.')], bBodies);
    expect(bBodies[0]).toContain('prefers EU date format');

    // (c) Delete via the HTTP API, then session C no longer recalls it.
    const app = apiApp();
    const del = await app.inject({ method: 'DELETE', url: `/api/memories/${memId}` });
    expect(del.statusCode).toBe(204);
    await app.close();
    const cBodies: string[] = [];
    await turn('C', 'hello again', [textResponse('Hi!')], cBodies);
    expect(cBodies[0]).not.toContain('prefers EU date format');

    // (d) Re-learn, then global off switch suppresses recall entirely in D.
    memory.add({ userId: 'user_1', category: 'preference', kind: 'collection', body: 'prefers EU date format', source: 'tool' });
    memory.setEnabled('user_1', false);
    const dBodies: string[] = [];
    await turn('D', 'anything?', [textResponse('Hi!')], dBodies, { enabled: false, writable: false });
    expect(dBodies[0]).not.toContain('prefers EU date format');
    expect(dBodies[0]).not.toContain('</memories>');
  });
});
