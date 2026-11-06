import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLoopTurn, type LoopSessionDeps, type RunLoopTurnInput } from '../src/loop/agent';
import { costMeter } from '../src/llm/client';
import { __resetIndexForTest } from '../src/agent/retrieval';
import { openEventLog, type EventLog } from '../src/events/log';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import { createRefStore, type RefStore } from '../src/agent/refs';
import { buildRegistry, type Registry } from '../src/catalog/registry';
import { type ActionContext, type ActionDef, type Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import type { ConfirmBroker } from '../src/agent/executor';
import type { Event } from '../src/events/types';
import { createMemoryStore, type MemoryStore } from '../src/memory/store';
import type { MemoryExtractionInput } from '../src/memory/extract';
import { z } from 'zod';

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;
function action(slug: string, risk: Risk, handler: Handler): ActionDef {
  return {
    id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug, risk,
    entities: [slug.split('.')[0] as string], inputSchema: z.object({}).catchall(z.unknown()),
    outputSchema: z.any(), searchCard: { synonyms: [], examplePhrasings: [] }, handler: handler as ActionDef['handler'],
  };
}
const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };
const approveAll: ConfirmBroker = { request: async () => true };

function textResponse(text: string): unknown {
  return { id: 'gen', object: 'chat.completion', created: 2, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 } };
}
function toolCallResponse(name: string, args: Record<string, unknown>): unknown {
  return { id: 'gen', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
interface Seen { bodies: string[] }
function scriptedFetch(script: unknown[], seen?: Seen): typeof fetch {
  let i = 0;
  return (async (_i: unknown, init?: RequestInit) => {
    if (seen && init?.body) seen.bodies.push(String(init.body));
    const payload = JSON.parse(JSON.stringify(script[Math.min(i, script.length - 1)])) as { choices?: { message?: { tool_calls?: { id: string }[] } }[] };
    for (const c of payload.choices ?? []) for (const tc of c.message?.tool_calls ?? []) tc.id = `call_${i}_${randomUUID().slice(0, 8)}`;
    i += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const tmpPaths: string[] = [];
function tmpDbPath(): string { const p = join(tmpdir(), `ask-ai-memturn-${randomUUID()}.db`); tmpPaths.push(p); return p; }
const sessionId = 'sess_mem';
let eventLog: EventLog; let sessionsDb: SessionsDb; let refs: RefStore; let memory: MemoryStore;

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  __resetIndexForTest();
  const p = tmpDbPath();
  eventLog = openEventLog(p);
  sessionsDb = openSessions(p);
  refs = createRefStore(sessionsDb, sessionId);
  let t = 1000;
  memory = createMemoryStore(sessionsDb, () => (t += 1));
});
afterEach(() => {
  eventLog.close(); sessionsDb.close();
  while (tmpPaths.length) { const p = tmpPaths.pop() as string; for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(p + s)) rmSync(p + s, { force: true }); }
});

async function drive(userText: string, script: unknown[], overrides: Partial<LoopSessionDeps>, seen?: Seen): Promise<Event[]> {
  const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
  const events: Event[] = [];
  const input: RunLoopTurnInput = {
    sessionId, turnId: `t_${randomUUID()}`, userText,
    sessionDeps: { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, testFetch: scriptedFetch(script, seen), ...overrides },
  };
  for await (const ev of runLoopTurn(input)) events.push(ev);
  return events;
}
function finalOf(events: readonly Event[]): string {
  const ev = events.find((e) => e.t === 'answer.final');
  if (!ev || ev.t !== 'answer.final') throw new Error('no answer.final');
  return ev.text;
}
function llmCallsOf(events: readonly Event[]): number {
  const ev = events.find((e) => e.t === 'turn.completed');
  return ev && ev.t === 'turn.completed' ? ev.metrics.llmCalls : -1;
}

describe('runLoopTurn — memory recall', () => {
  it('injects a <memories> block into the user prompt when memory is enabled', async () => {
    memory.add({ userId: 'user_1', category: 'preference', kind: 'profile', key: 'date-format', body: 'prefers EU date format', source: 'tool' });
    const seen: Seen = { bodies: [] };
    await drive('hello', [textResponse('Hi!')], { memory, memoryEnabled: true, memoryWritable: true, runExtraction: async () => {} }, seen);
    expect(seen.bodies[0]).toContain('<memories>');
    expect(seen.bodies[0]).toContain('prefers EU date format');
  });

  it('omits <memories>, binds no memory tools, and does not extract when memory is disabled', async () => {
    memory.add({ userId: 'user_1', category: 'preference', kind: 'collection', body: 'prefers EU dates', source: 'tool' });
    const seen: Seen = { bodies: [] };
    let extracted = false;
    await drive('hello', [textResponse('Hi!')], { memory, memoryEnabled: false, memoryWritable: false, runExtraction: async () => { extracted = true; } }, seen);
    // The static system prompt mentions "<memories>"; the real signal that
    // recall did NOT happen is the absence of the recalled content and the
    // closing block tag (only emitted in the user prompt).
    expect(seen.bodies[0]).not.toContain('prefers EU dates');
    expect(seen.bodies[0]).not.toContain('</memories>');
    // Global-off must also remove the recall READ path, not just injection.
    // The static system prompt MENTIONS the tool names in prose, so assert on
    // the JSON tool DEFINITION form (`"name":"memory__recall"`) instead.
    expect(seen.bodies[0]).not.toContain('"name":"memory__recall"');
    expect(seen.bodies[0]).not.toContain('"name":"memory__save"');
    expect(extracted).toBe(false);
  });

  it('binds the memory tools when memory is enabled', async () => {
    const seen: Seen = { bodies: [] };
    await drive('hello', [textResponse('Hi!')], { memory, memoryEnabled: true, memoryWritable: true, runExtraction: async () => {} }, seen);
    expect(seen.bodies[0]).toContain('"name":"memory__recall"');
    expect(seen.bodies[0]).toContain('"name":"memory__save"');
  });

  it('a figure recalled from memory is NOT flagged and triggers NO grounding re-run', async () => {
    memory.add({ userId: 'user_1', category: 'goal', kind: 'collection', body: 'quarterly target is $50,000', source: 'user' });
    const events = await drive(
      'what is my quarterly target?',
      [textResponse('From what I remember, your quarterly target is $50,000.')],
      { memory, memoryEnabled: true, memoryWritable: true, runExtraction: async () => {} },
    );
    expect(llmCallsOf(events)).toBe(1); // no grounded re-run
    expect(finalOf(events)).not.toMatch(/could not verify/i);
  });
});

describe('runLoopTurn — post-turn extraction', () => {
  it('runs extraction once on a done+writable turn with the turn material', async () => {
    const calls: MemoryExtractionInput[] = [];
    await drive('I prefer short answers', [textResponse('Noted.')], {
      memory, memoryEnabled: true, memoryWritable: true, runExtraction: async (i) => { calls.push(i); },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userId).toBe('user_1');
    expect(calls[0]!.userText).toBe('I prefer short answers');
    expect(calls[0]!.answerText).toBe('Noted.');
  });

  it('does NOT run extraction on a refused turn', async () => {
    let ran = false;
    await drive('do something impossible', [
      toolCallResponse('session__refuse', { reason: 'no supported action for that' }),
    ], { memory, memoryEnabled: true, memoryWritable: true, runExtraction: async () => { ran = true; } });
    expect(ran).toBe(false);
  });

  it('does NOT run extraction when the session is incognito (writable false) but still recalls', async () => {
    memory.add({ userId: 'user_1', category: 'preference', kind: 'collection', body: 'prefers EU dates', source: 'tool' });
    const seen: Seen = { bodies: [] };
    let ran = false;
    await drive('hello', [textResponse('Hi!')], {
      memory, memoryEnabled: true, memoryWritable: false, runExtraction: async () => { ran = true; },
    }, seen);
    expect(seen.bodies[0]).toContain('</memories>'); // recall block present (user prompt)
    expect(seen.bodies[0]).toContain('prefers EU dates'); // recall still on
    expect(ran).toBe(false); // writes off
  });
});
