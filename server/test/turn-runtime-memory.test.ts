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
import { createMemoryStore } from '../src/memory/store';
import type { ActionContext, ActionDef, Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import type { Event } from '../src/events/types';

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;
function action(slug: string, risk: Risk, handler: Handler): ActionDef {
  return { id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug, risk, entities: [slug.split('.')[0] as string], inputSchema: z.object({}).catchall(z.unknown()), outputSchema: z.any(), searchCard: { synonyms: [], examplePhrasings: [] }, handler: handler as ActionDef['handler'] };
}
const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };

function textResponse(text: string): unknown {
  return { id: 'gen', object: 'chat.completion', created: 2, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
function capturingLoopFetch(script: unknown[], bodies: string[]): typeof fetch {
  let i = 0;
  return (async (_i: unknown, init?: RequestInit) => {
    if (init?.body) bodies.push(String(init.body));
    const payload = JSON.parse(JSON.stringify(script[Math.min(i, script.length - 1)]));
    i += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const tmpPaths: string[] = [];
let eventLog: EventLog; let sessionsDb: SessionsDb;

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  __setTestBackoffOptions({ baseMs: 1 });
  __resetIndexForTest();
  // Any fire-and-forget extractor llmCall no-ops (empty candidates).
  __setTestFetch(queueMockLlm([{ candidates: [] }, { candidates: [] }, { candidates: [] }]).fetch);
  const p = join(tmpdir(), `ask-ai-rtmem-${randomUUID()}.db`);
  tmpPaths.push(p);
  eventLog = openEventLog(p);
  sessionsDb = openSessions(p);
});
afterEach(() => {
  __setLoopTestFetch(undefined);
  __setTestFetch(undefined);
  __setTestBackoffOptions(undefined);
  eventLog.close(); sessionsDb.close();
  while (tmpPaths.length) { const p = tmpPaths.pop() as string; for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(p + s)) rmSync(p + s, { force: true }); }
});

function makeRuntime(): SessionRuntime {
  const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
  return new SessionRuntime(sessionsDb, eventLog, registry, [], () => fakeCrm, false);
}

async function waitForCompleted(sessionId: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (eventLog.list(sessionId).some((se) => se.event.t === 'turn.completed')) return;
    if (Date.now() - start > timeoutMs) throw new Error('turn never completed');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('SessionRuntime memory wiring', () => {
  it('recalls user memory into the loop prompt by default (store wired, enabled read)', async () => {
    const mem = createMemoryStore(sessionsDb);
    mem.add({ userId: 'user_1', category: 'preference', kind: 'collection', body: 'prefers EU date format', source: 'tool' });
    const bodies: string[] = [];
    __setLoopTestFetch(capturingLoopFetch([textResponse('Hi!')], bodies));
    const runtime = makeRuntime();
    const sessionId = eventLog.createSession('t');
    runtime.startTurn({ sessionId, userText: 'hello', agent: 'optimized' });
    await waitForCompleted(sessionId);
    expect(bodies[0]).toContain('prefers EU date format');
  });

  it('does not recall when memory is globally off (enabled flag read)', async () => {
    const mem = createMemoryStore(sessionsDb);
    mem.add({ userId: 'user_1', category: 'preference', kind: 'collection', body: 'prefers EU date format', source: 'tool' });
    mem.setEnabled('user_1', false);
    const bodies: string[] = [];
    __setLoopTestFetch(capturingLoopFetch([textResponse('Hi!')], bodies));
    const runtime = makeRuntime();
    const sessionId = eventLog.createSession('t');
    runtime.startTurn({ sessionId, userText: 'hello', agent: 'optimized' });
    await waitForCompleted(sessionId);
    expect(bodies[0]).not.toContain('prefers EU date format');
  });

  it('still recalls under incognito (enabled true, writable false)', async () => {
    const mem = createMemoryStore(sessionsDb);
    mem.add({ userId: 'user_1', category: 'preference', kind: 'collection', body: 'prefers EU date format', source: 'tool' });
    const bodies: string[] = [];
    __setLoopTestFetch(capturingLoopFetch([textResponse('Hi!')], bodies));
    const runtime = makeRuntime();
    const sessionId = eventLog.createSession('t');
    mem.setIncognito(sessionId, true);
    runtime.startTurn({ sessionId, userText: 'hello', agent: 'optimized' });
    await waitForCompleted(sessionId);
    expect(bodies[0]).toContain('prefers EU date format');
  });
});
