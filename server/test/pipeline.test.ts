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
import type { Event, EventType } from '../src/events/types';

// --- scriptable fake action (same convention as executor.test.ts) ----------

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

const noopTx: StoreTx = {
  all: () => [],
  get: () => undefined,
  run: () => ({ changes: 0 }),
};

const fakeCrm: Crm = {
  tx: (fn) => fn(noopTx),
  close: () => {},
};

const approveAll: ConfirmBroker = { request: async () => true };

// --- harness -----------------------------------------------------------------

const tmpPaths: string[] = [];

function tmpDbPath(): string {
  const p = join(tmpdir(), `ask-ai-pipeline-${randomUUID()}.db`);
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
const sessionId = 'sess_pipeline';

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  __setTestBackoffOptions({ baseMs: 1 });
  const dbPath = tmpDbPath();
  eventLog = openEventLog(dbPath);
  sessionsDb = openSessions(dbPath);
  refs = createRefStore(sessionsDb, sessionId);
});

afterEach(() => {
  __setTestFetch(undefined);
  __setTestBackoffOptions(undefined);
  eventLog.close();
  sessionsDb.close();
  while (tmpPaths.length) cleanup(tmpPaths.pop() as string);
});

function deps(registry: Registry, overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    registry,
    crm: fakeCrm,
    refs,
    eventLog,
    confirm: approveAll,
    playbooks: [],
    ...overrides,
  };
}

async function drive(registry: Registry, userText: string, overrides: Partial<SessionDeps> = {}): Promise<Event[]> {
  const events: Event[] = [];
  for await (const ev of runTurn({ sessionId, turnId: `t_${randomUUID()}`, userText, sessionDeps: deps(registry, overrides) })) {
    events.push(ev);
  }
  return events;
}

function typesOf(events: readonly Event[]): EventType[] {
  return events.map((e) => e.t);
}

function completedOf(events: readonly Event[]): Extract<Event, { t: 'turn.completed' }> {
  const ev = events.find((e) => e.t === 'turn.completed');
  if (!ev || ev.t !== 'turn.completed') throw new Error('no turn.completed event');
  return ev;
}

// ---------------------------------------------------------------------------

describe('runTurn — direct 1-step plan', () => {
  it('exactly 1 LLM call; event sequence matches LLD §2.3; plan.ready AFTER validation', async () => {
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'find leads', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );

    const events = await drive(registry, 'find my leads');

    expect(queue.callCount()).toBe(1);

    const types = typesOf(events);
    expect(types.slice(0, 3)).toEqual(['turn.started', 'retrieval.done', 'plan.ready']);
    expect(types.slice(-3)).toEqual(['answer.final', 'turn.completed', 'memory.snapshot']);
    expect(types).toContain('step.started');
    expect(types).toContain('step.finished');
    expect(types.filter((t) => t === 'answer.delta').length).toBeGreaterThanOrEqual(1);
    // step.started/finished happen strictly AFTER plan.ready, AFTER AFTER validation.
    expect(types.indexOf('step.started')).toBeGreaterThan(types.indexOf('plan.ready'));

    const planReady = events.find((e) => e.t === 'plan.ready');
    expect(planReady).toBeDefined();
    if (planReady && planReady.t === 'plan.ready') {
      expect(planReady.outcome.kind).toBe('plan');
      // a real sha256 hex digest — proof `planHash` came from `validate()`,
      // i.e. plan.ready really did fire AFTER validation succeeded.
      expect(planReady.planHash).toMatch(/^[0-9a-f]{64}$/);
    }

    const completed = completedOf(events);
    expect(completed.status).toBe('done');
    expect(Number.isFinite(completed.metrics.ttfurMs)).toBe(true);
    expect(Number.isFinite(completed.metrics.totalMs)).toBe(true);
    expect(completed.metrics.ttfurMs).toBeLessThanOrEqual(completed.metrics.totalMs);
    expect(completed.metrics.llmCalls).toBe(1);
  });
});

describe('runTurn — search outcome', () => {
  it('re-retrieves and re-plans; 2 LLM calls total; a search event is emitted', async () => {
    const queue = queueMockLlm([
      { kind: 'search', queries: ['overdue invoices'] },
      { kind: 'plan', plan: { goal: 'after search', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]],
      coreOps,
    );

    const events = await drive(registry, 'something obscure');

    expect(queue.callCount()).toBe(2);
    const searchEvent = events.find((e) => e.t === 'search');
    expect(searchEvent).toBeDefined();
    if (searchEvent && searchEvent.t === 'search') {
      expect(searchEvent.round).toBe(1);
    }
    expect(completedOf(events).status).toBe('done');
    expect(completedOf(events).metrics.searchRounds).toBe(1);
  });
});

describe('runTurn — clarify short-circuit', () => {
  it('asks exactly one question, runs zero handlers, status clarify', async () => {
    const queue = queueMockLlm([{ kind: 'clarify', question: 'Which lead did you mean?' }]);
    __setTestFetch(queue.fetch);

    let handlerCalls = 0;
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => {
        handlerCalls += 1;
        return { items: [], total: 0 };
      })]],
      coreOps,
    );

    const events = await drive(registry, 'do the thing');

    expect(handlerCalls).toBe(0);
    expect(events.some((e) => e.t === 'step.started')).toBe(false);
    const final = events.find((e) => e.t === 'answer.final');
    expect(final && final.t === 'answer.final' && final.text).toBe('Which lead did you mean?');
    expect(completedOf(events).status).toBe('clarify');
  });
});

describe('runTurn — repair loop', () => {
  it('invalid plan (unknown slug) → repair → valid; succeeds with 2 LLM calls', async () => {
    const queue = queueMockLlm([
      { kind: 'plan', plan: { goal: 'r', steps: [{ id: 's1', action: 'bogus.not_real', params: {}, dependsOn: [] }] } },
      { kind: 'plan', plan: { goal: 'r', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );

    const events = await drive(registry, 'repair me');

    expect(queue.callCount()).toBe(2);
    const repairEvent = events.find((e) => e.t === 'repair');
    expect(repairEvent).toBeDefined();
    if (repairEvent && repairEvent.t === 'repair') {
      expect(repairEvent.round).toBe(1);
      expect(repairEvent.reason).toContain('UNKNOWN_SLUG');
    }
    expect(completedOf(events).status).toBe('done');
    expect(completedOf(events).metrics.repairs).toBe(1);
  });
});

describe('runTurn — joiner checkpoint', () => {
  it('forEach over an empty source → joinerRepair "patch" → replan event + the patched step runs', async () => {
    const queue = queueMockLlm([
      {
        kind: 'plan',
        plan: {
          goal: 'joiner',
          steps: [
            { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
            { id: 's2', action: 'tasks.create_task', params: { lead_id: '$item.id' }, forEach: '$s1.items', dependsOn: ['s1'] },
          ],
        },
      },
      { decision: 'patch', patchedSteps: [{ id: 's2b', action: 'tasks.create_task', params: {}, dependsOn: [] }] },
    ]);
    __setTestFetch(queue.fetch);

    let created = 0;
    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({ items: [], total: 0 })),
          action('tasks.create_task', 'write', async () => {
            created += 1;
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );

    const events = await drive(registry, 'sweep my leads');

    expect(queue.callCount()).toBe(2);
    const replanEvent = events.find((e) => e.t === 'replan');
    expect(replanEvent).toBeDefined();
    if (replanEvent && replanEvent.t === 'replan') expect(replanEvent.round).toBe(1);

    const s2bFinished = events.find((e) => e.t === 'step.finished' && e.stepId === 's2b');
    expect(s2bFinished).toBeDefined();
    expect(created).toBe(1);
    expect(completedOf(events).status).toBe('done');
    expect(completedOf(events).metrics.replans).toBe(1);
  });
});

describe('runTurn — LLM call budget', () => {
  it('scripts 7 LLM-call demand; the 7th is never made; turn fails honestly at 6', async () => {
    const queue = queueMockLlm([
      { kind: 'search', queries: ['q1'] }, // 1
      { kind: 'search', queries: ['q2'] }, // 2
      { kind: 'plan', plan: { goal: 'g', steps: [{ id: 's1', action: 'bogus.not_real', params: {}, dependsOn: [] }] } }, // 3 invalid
      { kind: 'plan', plan: { goal: 'g', steps: [{ id: 's1', action: 'bogus.not_real', params: {}, dependsOn: [] }] } }, // 4 repair1, still invalid
      {
        kind: 'plan',
        plan: {
          goal: 'g',
          steps: [
            { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [], expects: { nonEmpty: true } },
            { id: 's2', action: 'tasks.create_task', params: {}, dependsOn: ['s1'] },
          ],
        },
      }, // 5 repair2, valid
      { decision: 'patch', patchedSteps: [{ id: 's2b', action: 'tasks.create_task', params: {}, dependsOn: [] }] }, // 6 joiner round 1
      { decision: 'abort' }, // 7 — scripted but NEVER consumed (blocked by the global budget)
    ]);
    __setTestFetch(queue.fetch);

    let created = 0;
    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({ items: [], total: 0 })),
          action('tasks.create_task', 'write', async () => {
            created += 1;
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );

    const events = await drive(registry, 'expensive request');

    expect(queue.callCount()).toBe(6); // the 7th scripted response is never fetched
    expect(created).toBe(0); // the turn aborts before any patched write ever runs

    const completed = completedOf(events);
    expect(completed.status).toBe('failed');
    expect(completed.metrics.llmCalls).toBe(6);
    expect(completed.metrics.repairs).toBe(2);
    expect(completed.metrics.searchRounds).toBe(2);
    expect(completed.metrics.replans).toBe(1);
    expect(Number.isFinite(completed.metrics.ttfurMs)).toBe(true);
    expect(Number.isFinite(completed.metrics.totalMs)).toBe(true);
    expect(completed.metrics.ttfurMs).toBeLessThanOrEqual(completed.metrics.totalMs);

    const final = events.find((e) => e.t === 'answer.final');
    expect(final && final.t === 'answer.final' && final.text.length).toBeGreaterThan(0);
  });
});
