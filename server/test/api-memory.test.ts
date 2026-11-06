import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerMemoryRoutes } from '../src/api/memory';
import { registerSessionsRoutes } from '../src/api/sessions';
import { SessionRuntime } from '../src/api/turn-runtime';
import type { AppDeps } from '../src/api/types';
import { openEventLog, type EventLog } from '../src/events/log';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import { openSpans, type Spans } from '../src/events/trace';
import { buildRegistry } from '../src/catalog/registry';
import { createMemoryStore, type MemoryStore } from '../src/memory/store';
import type { Crm, StoreTx } from '../src/store/db';

const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };

const tmpPaths: string[] = [];
let eventLog: EventLog; let sessionsDb: SessionsDb; let spans: Spans; let app: FastifyInstance; let mem: MemoryStore;

beforeEach(() => {
  const p = join(tmpdir(), `ask-ai-apimem-${randomUUID()}.db`);
  tmpPaths.push(p);
  eventLog = openEventLog(p);
  sessionsDb = openSessions(p);
  spans = openSpans(p);
  mem = createMemoryStore(sessionsDb);
  const registry = buildRegistry([[]], []);
  const runtime = new SessionRuntime(sessionsDb, eventLog, registry, [], () => fakeCrm, false);
  const deps: AppDeps = { registry, eventLog, sessionsDb, spans, runtime, profile: 'fake' };
  app = Fastify({ logger: false });
  registerMemoryRoutes(app, deps);
  registerSessionsRoutes(app, deps); // for session creation in the incognito test
});
afterEach(async () => {
  await app.close();
  eventLog.close(); sessionsDb.close(); spans.close();
  while (tmpPaths.length) { const p = tmpPaths.pop() as string; for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(p + s)) rmSync(p + s, { force: true }); }
});

describe('GET /api/memories', () => {
  it('lists live memories for the user and excludes invalidated ones', async () => {
    mem.add({ userId: 'user_1', category: 'preference', kind: 'collection', body: 'keeps this', source: 'tool' });
    const gone = mem.add({ userId: 'user_1', category: 'fact', kind: 'collection', body: 'gone', source: 'tool' });
    mem.invalidate(gone.id);
    const res = await app.inject({ method: 'GET', url: '/api/memories' });
    expect(res.statusCode).toBe(200);
    const bodies = (res.json() as { memories: { body: string }[] }).memories.map((m) => m.body);
    expect(bodies).toContain('keeps this');
    expect(bodies).not.toContain('gone');
  });
});

describe('PATCH /api/memories/:id', () => {
  it('edits a memory', async () => {
    const m = mem.add({ userId: 'user_1', category: 'preference', kind: 'collection', body: 'old', source: 'tool' });
    const res = await app.inject({ method: 'PATCH', url: `/api/memories/${m.id}`, payload: { body: 'new' } });
    expect(res.statusCode).toBe(200);
    expect(mem.get(m.id)!.body).toBe('new');
  });
  it('404s on unknown id and rejects an invalid body', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/memories/mem_nope', payload: { body: 'x' } })).statusCode).toBe(404);
    const m = mem.add({ userId: 'user_1', category: 'fact', kind: 'collection', body: 'b', source: 'tool' });
    expect((await app.inject({ method: 'PATCH', url: `/api/memories/${m.id}`, payload: { category: 'bogus' } })).statusCode).toBe(400);
  });
});

describe('DELETE /api/memories/:id', () => {
  it('hard-deletes a memory', async () => {
    const m = mem.add({ userId: 'user_1', category: 'fact', kind: 'collection', body: 'bye', source: 'tool' });
    const res = await app.inject({ method: 'DELETE', url: `/api/memories/${m.id}` });
    expect(res.statusCode).toBe(204);
    expect(mem.get(m.id)).toBeUndefined();
  });
});

describe('settings', () => {
  it('GET/PUT /api/memories/settings round-trips and actually gates', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/memories/settings' })).json()).toEqual({ enabled: true });
    const put = await app.inject({ method: 'PUT', url: '/api/memories/settings', payload: { enabled: false } });
    expect(put.statusCode).toBe(204);
    expect(mem.isEnabled('user_1')).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/memories/settings' })).json()).toEqual({ enabled: false });
  });
});

describe('PUT /api/sessions/:id/incognito', () => {
  it('sets the per-session incognito flag', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/sessions' });
    const sessionId = (created.json() as { id: string }).id;
    const res = await app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}/incognito`, payload: { incognito: true } });
    expect(res.statusCode).toBe(204);
    expect(mem.isIncognito(sessionId)).toBe(true);
  });
  it('404s for an unknown session', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/nope/incognito', payload: { incognito: true } })).statusCode).toBe(404);
  });
});

describe('cross-user isolation (Review Focus)', () => {
  it('does not edit or delete another user’s memory (404, unchanged)', async () => {
    const other = mem.add({ userId: 'user_2', category: 'fact', kind: 'collection', body: 'secret of user 2', source: 'tool' });
    expect((await app.inject({ method: 'PATCH', url: `/api/memories/${other.id}`, payload: { body: 'hacked' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/memories/${other.id}` })).statusCode).toBe(404);
    expect(mem.get(other.id)!.body).toBe('secret of user 2'); // untouched
  });
});
