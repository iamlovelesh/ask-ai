/**
 * Task 15 — HTTP API + SSE + sessions (LLD §6). Fastify `inject()` against
 * a REAL `EventLog`/`SessionsDb`/`Spans` (tmp sqlite files) and a minimal
 * custom `Registry` driven by `MockLLM` (same harness convention as
 * `pipeline.test.ts`/`baseline.test.ts`) — no network, no real CRM except
 * in the dedicated reset test, which uses a disposable profile + a
 * temp-copied template so the COMMITTED `crm-standard.template.db` is never
 * touched.
 *
 * SSE responses are injected with `payloadAsStream: true` (light-my-request)
 * so the `inject()` promise resolves as soon as headers are written, handing
 * back a live `Readable` the test can read progressively — exactly how a
 * real client would see a chunked `text/event-stream` response.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { registerSessionsRoutes } from '../src/api/sessions';
import { registerStreamRoutes } from '../src/api/stream';
import { registerAdminRoutes } from '../src/api/admin';
import { registerMetricsRoutes } from '../src/api/metrics';
import { SessionRuntime } from '../src/api/turn-runtime';
import type { AppDeps } from '../src/api/types';

import { openEventLog, type EventLog } from '../src/events/log';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import { openSpans, type Spans } from '../src/events/trace';
import { VirtualClock } from '../src/store/clock';
import { createRefStore } from '../src/agent/refs';
import { buildRegistry, type Registry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef, ActionContext, Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import { crmDbPath, openCrm, getCrm, closeRegistered } from '../src/store/db';
import type { Playbook } from '../src/playbooks/loader';

import { queueMockLlm } from './helpers/mock-llm';
import { __setTestFetch, __setTestBackoffOptions, __setTestSpans, costMeter } from '../src/llm/client';

// --- scriptable fake action (same convention as pipeline.test.ts) ----------

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;

function action(slug: string, risk: Risk, handler: Handler, inputSchema: z.ZodType<unknown> = z.record(z.string(), z.unknown())): ActionDef {
  return {
    id: slug,
    slug,
    module: slug.split('.')[0] as string,
    name: slug,
    description: slug,
    risk,
    entities: [slug.split('.')[0] as string],
    inputSchema,
    outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: handler as ActionDef['handler'],
  };
}

const noopTx: StoreTx = {
  all: () => [],
  get: () => undefined,
  run: () => ({ changes: 0 }),
};

const fakeCrm: Crm = {
  tx: (fn) => fn(noopTx),
  close: () => {},
};

// --- harness -----------------------------------------------------------------

const tmpPaths: string[] = [];

function tmpDbPath(): string {
  const p = join(tmpdir(), `ask-ai-api-${randomUUID()}.db`);
  tmpPaths.push(p);
  return p;
}

function cleanupFile(p: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = p + suffix;
    if (existsSync(f)) rmSync(f, { force: true });
  }
}

let eventLog: EventLog;
let sessionsDb: SessionsDb;
let spans: Spans;
let apps: FastifyInstance[] = [];

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  __setTestBackoffOptions({ baseMs: 1 });
  const dbPath = tmpDbPath();
  eventLog = openEventLog(dbPath);
  sessionsDb = openSessions(dbPath);
  spans = openSpans(dbPath);
  __setTestSpans(spans);
  apps = [];
});

afterEach(async () => {
  __setTestFetch(undefined);
  __setTestBackoffOptions(undefined);
  __setTestSpans(undefined);
  for (const app of apps) await app.close();
  eventLog.close();
  sessionsDb.close();
  spans.close();
  while (tmpPaths.length) cleanupFile(tmpPaths.pop() as string);
});

interface BuildAppOpts {
  registry: Registry;
  getCrm?: () => Crm;
  profile?: string;
}

function buildApp(opts: BuildAppOpts): FastifyInstance {
  const app = Fastify({ logger: false });
  const playbooks: Playbook[] = [];
  const runtime = new SessionRuntime(sessionsDb, eventLog, opts.registry, playbooks, opts.getCrm ?? (() => fakeCrm));
  const deps: AppDeps = {
    registry: opts.registry,
    eventLog,
    sessionsDb,
    spans,
    runtime,
    profile: opts.profile ?? 'unused-fake-profile',
  };
  registerSessionsRoutes(app, deps);
  registerStreamRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerMetricsRoutes(app, deps);
  apps.push(app);
  return app;
}

async function createSession(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/sessions' });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

// --- SSE frame parsing (test-side only) --------------------------------------

interface ParsedFrame {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

function parseOneFrame(raw: string): ParsedFrame {
  const lines = raw.split('\n');
  const idLine = lines.find((l) => l.startsWith('id: '));
  const eventLine = lines.find((l) => l.startsWith('event: '));
  const dataLine = lines.find((l) => l.startsWith('data: '));
  const id = idLine ? idLine.slice('id: '.length) : '';
  const event = eventLine ? eventLine.slice('event: '.length) : '';
  const data = dataLine ? (JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>) : {};
  return { id, event, data };
}

/**
 * Attaches EXACTLY ONE persistent `data`/`end`/`error` listener to `stream`
 * for its whole lifetime and buffers every frame — unlike a listen/match/
 * remove-listener approach, this never risks losing frames pushed between
 * two separate reads. Node Readable streams: once switched into flowing
 * mode (which attaching a `data` listener does), removing that listener
 * does NOT switch the stream back to paused mode — anything pushed while
 * no listener is attached is simply LOST. Since `sessions.ts`/`stream.ts`
 * push events in real time regardless of whether anyone's "reading" (SSE
 * delivery is fully decoupled from turn execution — Task 13 note), a test
 * that calls `app.inject(...)` (confirm, etc.) between two reads of the
 * SAME stream can easily let the whole rest of a turn fly by unobserved.
 * `FrameReader` fixes this by reading continuously from construction;
 * `waitFor` resolves against whatever's already buffered OR a future
 * frame, and `drain` waits for the stream to end.
 *
 * "Dropping" a connection in these tests means: construct a `FrameReader`,
 * consume what's needed, then simply stop interacting with it — never
 * destroy the underlying stream (destroying a light-my-request fake-socket
 * Readable risks an unhandled push-after-destroy error on the server side;
 * ceasing to read is both safe and a faithful simulation of a client that
 * went away, since the server has no way to tell the difference either way).
 */
class FrameReader {
  private buffer = '';
  private readonly frames: ParsedFrame[] = [];
  private ended = false;
  private error: Error | undefined;
  private readonly waiters: { predicate: (f: ParsedFrame) => boolean; resolve: (f: ParsedFrame) => void; reject: (e: Error) => void }[] = [];
  private readonly endWaiters: { resolve: (frames: ParsedFrame[]) => void; reject: (e: Error) => void }[] = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.on('end', () => this.onEnd());
    stream.on('error', (err: Error) => this.onError(err));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (raw.trim().length === 0 || raw.startsWith(':')) continue;
      const f = parseOneFrame(raw);
      this.frames.push(f);
      const stillWaiting: typeof this.waiters = [];
      for (const w of this.waiters) {
        if (w.predicate(f)) w.resolve(f);
        else stillWaiting.push(w);
      }
      this.waiters.length = 0;
      this.waiters.push(...stillWaiting);
    }
  }

  private onEnd(): void {
    this.ended = true;
    for (const w of this.waiters) w.reject(new Error('stream ended before the predicate matched'));
    this.waiters.length = 0;
    for (const w of this.endWaiters) w.resolve(this.frames);
    this.endWaiters.length = 0;
  }

  private onError(err: Error): void {
    this.error = err;
    for (const w of this.waiters) w.reject(err);
    this.waiters.length = 0;
    for (const w of this.endWaiters) w.reject(err);
    this.endWaiters.length = 0;
  }

  /** Resolves with the first frame (already buffered, or yet to arrive)
   * matching `predicate`. */
  waitFor(predicate: (f: ParsedFrame) => boolean, timeoutMs = 5000): Promise<ParsedFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.reject(new Error('stream already ended without a match'));
    return new Promise((resolve, reject) => {
      const entry = {
        predicate,
        resolve: (f: ParsedFrame) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`FrameReader.waitFor timed out; frames so far: ${JSON.stringify(this.frames)}`));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  /** Resolves with every frame once the stream ends (the server closes
   * after `memory.snapshot`, per `sse.ts`'s close policy). */
  drain(timeoutMs = 5000): Promise<ParsedFrame[]> {
    if (this.ended) return Promise.resolve(this.frames);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`FrameReader.drain timed out; frames so far: ${JSON.stringify(this.frames)}`)),
        timeoutMs,
      );
      this.endWaiters.push({
        resolve: (frames) => {
          clearTimeout(timer);
          resolve(frames);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}

// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/messages — full turn over SSE', () => {
  it('SSE frames parse to the Task 13 event sequence', async () => {
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'find leads', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'find my leads' },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const frames = await new FrameReader(res.stream()).drain();
    const types = frames.map((f) => f.event);

    expect(types.slice(0, 3)).toEqual(['turn.started', 'retrieval.done', 'plan.ready']);
    expect(types.slice(-2)).toEqual(['turn.completed', 'memory.snapshot']);
    expect(types).toContain('step.started');
    expect(types).toContain('step.finished');
    expect(types).toContain('answer.final');

    // every frame carries a monotonically increasing `seq`.
    const seqs = frames.map((f) => Number(f.data['seq']));
    expect(seqs.every((n) => Number.isFinite(n))).toBe(true);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);

    // every frame's `id:` line equals its `data.seq` (LLD §6 Last-Event-ID
    // resumability — a native EventSource only ever populates
    // `Last-Event-ID` from a frame's `id:` line on reconnect).
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(Number(f.id)).toBe(Number(f.data['seq']));

    // session title = first 40 chars of the first message.
    const sessionsRes = await app.inject({ method: 'GET', url: '/api/sessions' });
    const rows = sessionsRes.json() as { id: string; title: string | null }[];
    const row = rows.find((r) => r.id === sessionId);
    expect(row?.title).toBe('find my leads'.slice(0, 40));
  });
});

describe('GET /api/sessions/:id/events — replay', () => {
  it('returns answer.final, never answer.delta', async () => {
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'find leads', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const app = buildApp({ registry });
    const sessionId = await createSession(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'find my leads' },
      payloadAsStream: true,
    });
    await new FrameReader(res.stream()).drain();

    const eventsRes = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    expect(eventsRes.statusCode).toBe(200);
    const rows = eventsRes.json() as { seq: number; event: { t: string } }[];
    expect(rows.some((r) => r.event.t === 'answer.final')).toBe(true);
    expect(rows.every((r) => r.event.t !== 'answer.delta')).toBe(true);
  });
});

describe('SSE drop + reconnect (Review Focus 1)', () => {
  it('a confirmation.required missed mid-drop arrives via GET /stream, and confirm completes the turn', async () => {
    const registry = buildRegistry(
      [[
        action(
          'contacts.archive_contact',
          'destructive',
          async (input) => ({ id: (input as { id: string }).id, archived: true }),
          z.object({ id: z.string() }),
        ),
      ]],
      coreOps,
    );
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'archive contact', steps: [{ id: 's1', action: 'contacts.archive_contact', params: { id: 'c1' }, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    const res1 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'Archive this contact' },
      payloadAsStream: true,
    });
    expect(res1.statusCode).toBe(200);

    // Simulate a drop: read only the FIRST frame (turn.started) off a
    // ONE-SHOT reader, then never touch res1 again — well before
    // confirmation.required is even computed. `afterSeq` is this frame's seq.
    const reader1 = new FrameReader(res1.stream());
    const firstFrame = await reader1.waitFor(() => true);
    const afterSeq = Number(firstFrame.data['seq']);
    expect(afterSeq).toBeGreaterThanOrEqual(1);

    // Reconnect — replay (or live-catch) must surface the confirmation the
    // original connection never got to see.
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/stream?afterSeq=${afterSeq}`,
      payloadAsStream: true,
    });
    expect(res2.statusCode).toBe(200);

    const reader2 = new FrameReader(res2.stream());
    const confirmFrame = await reader2.waitFor((f) => f.event === 'confirmation.required');
    const confirmSeq = Number(confirmFrame.data['seq']);
    expect(confirmSeq).toBeGreaterThan(afterSeq);

    const confirmId = confirmFrame.data['confirmId'] as string;
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/confirm/${confirmId}`,
      payload: { approved: true },
    });
    expect(confirmRes.statusCode).toBe(204);

    // The SAME reconnect connection (still live-subscribed, same reader —
    // no risk of losing frames pushed while the confirm POST was in flight)
    // sees the turn through to completion.
    const completed = await reader2.waitFor((f) => f.event === 'turn.completed');
    expect(completed.data['status']).toBe('done');
  });
});

describe('POST /api/sessions/:id/confirm/:confirmId — wrong/stale ids', () => {
  it('unknown confirmId -> 404; already-resolved confirmId -> 409', async () => {
    const registry = buildRegistry(
      [[
        action(
          'contacts.archive_contact',
          'destructive',
          async (input) => ({ id: (input as { id: string }).id, archived: true }),
          z.object({ id: z.string() }),
        ),
      ]],
      coreOps,
    );
    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    const unknownRes = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/confirm/cf_does-not-exist`,
      payload: { approved: true },
    });
    expect(unknownRes.statusCode).toBe(404);

    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'archive contact', steps: [{ id: 's1', action: 'contacts.archive_contact', params: { id: 'c1' }, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'Archive this contact' },
      payloadAsStream: true,
    });
    const reader = new FrameReader(res.stream());
    const confirmFrame = await reader.waitFor((f) => f.event === 'confirmation.required');
    const confirmId = confirmFrame.data['confirmId'] as string;

    const firstApprove = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/confirm/${confirmId}`,
      payload: { approved: true },
    });
    expect(firstApprove.statusCode).toBe(204);

    const secondApprove = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/confirm/${confirmId}`,
      payload: { approved: true },
    });
    expect(secondApprove.statusCode).toBe(409);

    // drain the turn to a clean finish (SAME reader — no lost frames).
    await reader.drain();
  });
});

describe('POST /api/sessions/:id/messages — one turn at a time', () => {
  it('a second POST while a turn is running -> 409', async () => {
    // Gated (destructive) action so the first turn is DETERMINISTICALLY
    // still in flight (suspended awaiting confirmation) when the second
    // POST arrives — a plain read-only turn can race to completion before
    // the second request is even sent, which would make this test flaky.
    const registry = buildRegistry(
      [[
        action(
          'contacts.archive_contact',
          'destructive',
          async (input) => ({ id: (input as { id: string }).id, archived: true }),
          z.object({ id: z.string() }),
        ),
      ]],
      coreOps,
    );
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'archive contact', steps: [{ id: 's1', action: 'contacts.archive_contact', params: { id: 'c1' }, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    const res1 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'Archive this contact' },
      payloadAsStream: true,
    });
    expect(res1.statusCode).toBe(200);

    const reader1 = new FrameReader(res1.stream());
    const confirmFrame = await reader1.waitFor((f) => f.event === 'confirmation.required');

    const res2 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'archive again' },
    });
    expect(res2.statusCode).toBe(409);

    // approve + drain so the first turn finishes cleanly.
    const confirmId = confirmFrame.data['confirmId'] as string;
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/confirm/${confirmId}`,
      payload: { approved: true },
    });
    expect(confirmRes.statusCode).toBe(204);
    await reader1.drain();
  });
});

describe('POST /api/sessions/:id/cancel', () => {
  it('cancelling a turn paused on confirmation denies it: status cancelled, zero handler calls, session accepts a new turn', async () => {
    let handlerCalls = 0;
    const registry = buildRegistry(
      [[
        action(
          'contacts.archive_contact',
          'destructive',
          async (input) => {
            handlerCalls += 1;
            return { id: (input as { id: string }).id, archived: true };
          },
          z.object({ id: z.string() }),
        ),
      ]],
      coreOps,
    );
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'archive contact', steps: [{ id: 's1', action: 'contacts.archive_contact', params: { id: 'c1' }, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'Archive this contact' },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);

    const reader = new FrameReader(res.stream());
    await reader.waitFor((f) => f.event === 'confirmation.required');

    const cancelRes = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/cancel` });
    expect(cancelRes.statusCode).toBe(204);

    const completed = await reader.waitFor((f) => f.event === 'turn.completed');
    expect(completed.data['status']).toBe('cancelled');
    await reader.drain();

    expect(handlerCalls).toBe(0);

    // the session's running-flag must have cleared — a brand new turn is accepted.
    const queue2 = queueMockLlm([{ kind: 'plan', plan: { goal: 'archive contact', steps: [{ id: 's1', action: 'contacts.archive_contact', params: { id: 'c1' }, dependsOn: [] }] } }]);
    __setTestFetch(queue2.fetch);
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'Archive this contact' },
      payloadAsStream: true,
    });
    expect(res2.statusCode).toBe(200);

    // drain + cancel this second turn too, for a clean teardown.
    const reader2 = new FrameReader(res2.stream());
    await reader2.waitFor((f) => f.event === 'confirmation.required');
    await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/cancel` });
    await reader2.drain();
    expect(handlerCalls).toBe(0);
  });

  it('a late POST /confirm {approved:true} after cancel -> 409, and the handler is STILL never called', async () => {
    let handlerCalls = 0;
    const registry = buildRegistry(
      [[
        action(
          'contacts.archive_contact',
          'destructive',
          async (input) => {
            handlerCalls += 1;
            return { id: (input as { id: string }).id, archived: true };
          },
          z.object({ id: z.string() }),
        ),
      ]],
      coreOps,
    );
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'archive contact', steps: [{ id: 's1', action: 'contacts.archive_contact', params: { id: 'c1' }, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'Archive this contact' },
      payloadAsStream: true,
    });
    const reader = new FrameReader(res.stream());
    const confirmFrame = await reader.waitFor((f) => f.event === 'confirmation.required');
    const confirmId = confirmFrame.data['confirmId'] as string;

    const cancelRes = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/cancel` });
    expect(cancelRes.statusCode).toBe(204);

    // The user believes they cancelled — a late/retried approve must NOT execute the write.
    const lateConfirm = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/confirm/${confirmId}`,
      payload: { approved: true },
    });
    expect(lateConfirm.statusCode).toBe(409);
    expect(handlerCalls).toBe(0);

    const completed = await reader.waitFor((f) => f.event === 'turn.completed');
    expect(completed.data['status']).toBe('cancelled');
    await reader.drain();
    expect(handlerCalls).toBe(0);
  });
});

describe('POST /api/sessions/:id/messages — baseline routing', () => {
  it('agent:"baseline" runs the baseline agent (no plan.ready)', async () => {
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );
    const queue = queueMockLlm([{ kind: 'final', text: 'Found 1 lead.' }]);
    __setTestFetch(queue.fetch);

    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'find leads', agent: 'baseline' },
      payloadAsStream: true,
    });
    const frames = await new FrameReader(res.stream()).drain();
    const types = frames.map((f) => f.event);

    expect(types).not.toContain('plan.ready');
    expect(types).toContain('turn.started');
    const completed = frames.find((f) => f.event === 'turn.completed');
    expect(completed?.data['status']).toBe('done');
  });
});

describe('GET /api/metrics', () => {
  it('returns finite aggregates after 2 scripted turns', async () => {
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );
    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    for (let i = 0; i < 2; i += 1) {
      const queue = queueMockLlm([
        { kind: 'plan', plan: { goal: 'find leads', steps: [{ id: `s${i}`, action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
      ]);
      __setTestFetch(queue.fetch);
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/messages`,
        payload: { text: `find leads ${i}` },
        payloadAsStream: true,
      });
      await new FrameReader(res.stream()).drain();
    }

    const metricsRes = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(metricsRes.statusCode).toBe(200);
    const body = metricsRes.json() as {
      overall: Record<string, number>;
      byStatus: Record<string, Record<string, number>>;
      byAgent: Record<string, Record<string, number>>;
    };

    expect(body.overall['count']).toBe(2);
    for (const bucket of [body.overall, ...Object.values(body.byStatus), ...Object.values(body.byAgent)]) {
      for (const v of Object.values(bucket)) expect(Number.isFinite(v)).toBe(true);
    }
    expect(body.byAgent['optimized']?.['count']).toBe(2);
    expect(body.byStatus['done']?.['count']).toBe(2);
  });

  it('default window (no ?window) actually applies 24h — excludes an older turn', async () => {
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );
    const app = buildApp({ registry });
    const sessionId = await createSession(app);

    // Synthetic OLD turn (hand-crafted events, 25h before the pinned
    // VirtualClock "now" — `turn.started.ts` is stamped from that same
    // pinned clock in real turns, so the window cutoff must be computed in
    // the SAME domain; this directly exercises that).
    const now = new VirtualClock().now();
    const oldTurnId = 't_old';
    eventLog.append(sessionId, {
      t: 'turn.started',
      turnId: oldTurnId,
      sessionId,
      userText: 'old request',
      ts: now - 25 * 60 * 60 * 1000,
    });
    eventLog.append(sessionId, {
      t: 'turn.completed',
      turnId: oldTurnId,
      status: 'done',
      metrics: {
        ttfurMs: 100,
        totalMs: 200,
        llmCalls: 1,
        repairs: 0,
        replans: 0,
        searchRounds: 0,
        tokensIn: 10,
        tokensOut: 10,
        costUsd: 0.001,
        stepsOk: 1,
        stepsFailed: 0,
      },
    });

    // One REAL recent turn, at the pinned "now".
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'find leads', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'find leads now' },
      payloadAsStream: true,
    });
    await new FrameReader(res.stream()).drain();

    const metricsRes = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(metricsRes.statusCode).toBe(200);
    const body = metricsRes.json() as { window: string; overall: { count: number } };
    expect(body.window).toBe('24h');
    // Only the recent turn — the default window must actually filter, not
    // just label itself "24h" while counting everything.
    expect(body.overall.count).toBe(1);

    const allRes = await app.inject({ method: 'GET', url: '/api/metrics?window=all' });
    const allBody = allRes.json() as { overall: { count: number } };
    expect(allBody.overall.count).toBe(2);
  });
});

describe('POST /admin/reset', () => {
  it('restores the CRM from a disposable temp template and marks every session ref stale', async () => {
    const profile = `apitest_${randomUUID().slice(0, 8)}`;
    const dataDir = dirname(crmDbPath('standard'));
    const committedTemplate = join(dataDir, 'crm-standard.template.db');
    const tempTemplate = join(dataDir, `crm-${profile}.template.db`);
    copyFileSync(committedTemplate, tempTemplate);

    try {
      const registry = buildRegistry([], coreOps);
      const app = buildApp({ registry, getCrm: () => getCrm(profile), profile });

      // Fresh profile: `openCrm` applies DDL only — zero rows, unlike the template.
      openCrm(profile);
      const before = getCrm(profile).tx((db) => db.get('SELECT COUNT(*) as c FROM leads'));
      expect(Number(before?.['c'] ?? 0)).toBe(0);

      const refStore = createRefStore(sessionsDb, 'sess_reset_test');
      const handle = refStore.put({
        action: 'leads.search_leads',
        turnId: 't_reset',
        stepId: 's1',
        entityType: 'leads',
        total: 1,
        idList: ['l1'],
        sample: [{ id: 'l1' }],
      });
      expect(refStore.get(handle.ref)?.stale).toBeUndefined();

      const res = await app.inject({ method: 'POST', url: `/admin/reset?profile=${profile}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ms: number };
      expect(Number.isFinite(body.ms)).toBe(true);
      expect(body.ms).toBeGreaterThanOrEqual(0);

      const after = getCrm(profile).tx((db) => db.get('SELECT COUNT(*) as c FROM leads'));
      expect(Number(after?.['c'] ?? 0)).toBeGreaterThan(0);

      expect(refStore.get(handle.ref)?.stale).toBe(true);
    } finally {
      closeRegistered(profile);
      for (const base of [crmDbPath(profile), tempTemplate]) cleanupFile(base);
    }
  });

  it('GET /admin/catalog lists every registered module/action', async () => {
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]],
      coreOps,
    );
    const app = buildApp({ registry });
    const res = await app.inject({ method: 'GET', url: '/admin/catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { modules: { module: string; actions: { slug: string }[] }[] };
    const leadsModule = body.modules.find((m) => m.module === 'leads');
    expect(leadsModule?.actions.some((a) => a.slug === 'leads.search_leads')).toBe(true);
  });
});

describe('GET /api/traces/:turnId', () => {
  it('returns the span waterfall for a completed turn', async () => {
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'find leads', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const app = buildApp({ registry });
    const sessionId = await createSession(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'find leads' },
      payloadAsStream: true,
    });
    const frames = await new FrameReader(res.stream()).drain();
    const turnStarted = frames.find((f) => f.event === 'turn.started');
    const turnId = turnStarted?.data['turnId'] as string;

    const tracesRes = await app.inject({ method: 'GET', url: `/api/traces/${turnId}` });
    expect(tracesRes.statusCode).toBe(200);
    const body = tracesRes.json() as { spans: { kind: string }[] };
    expect(body.spans.some((s) => s.kind === 'llm')).toBe(true);
  });
});
