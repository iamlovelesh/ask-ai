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
  it('scripts 9 LLM-call demand; the 9th is never made; turn fails honestly at 8', async () => {
    // BUDGETS.maxLlmCallsPerTurn rose 6→8 with maxRepairs 2→4 (TRIAGE rec #3).
    // 2 search + 1 plan + 3 repair (3rd valid) + 2 joiner replans = 8 calls;
    // the 3rd joiner violation aborts WITHOUT an LLM call (maxReplans=2), so
    // the 9th scripted response is never fetched.
    const queue = queueMockLlm([
      { kind: 'search', queries: ['q1'] }, // 1
      { kind: 'search', queries: ['q2'] }, // 2
      { kind: 'plan', plan: { goal: 'g', steps: [{ id: 's1', action: 'bogus.not_real', params: {}, dependsOn: [] }] } }, // 3 invalid
      { kind: 'plan', plan: { goal: 'g', steps: [{ id: 's1', action: 'bogus.not_real', params: {}, dependsOn: [] }] } }, // 4 repair1, still invalid
      { kind: 'plan', plan: { goal: 'g', steps: [{ id: 's1', action: 'bogus.not_real', params: {}, dependsOn: [] }] } }, // 5 repair2, still invalid
      {
        kind: 'plan',
        plan: {
          goal: 'g',
          steps: [
            { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [], expects: { nonEmpty: true } },
            { id: 's2', action: 'tasks.create_task', params: {}, dependsOn: ['s1'] },
          ],
        },
      }, // 6 repair3, valid — s1 (empty, expects nonEmpty) violates at the write stratum
      { decision: 'patch', patchedSteps: [{ id: 's2b', action: 'tasks.create_task', params: {}, dependsOn: [] }] }, // 7 joiner replan 1 (still violates via kept s1)
      { decision: 'patch', patchedSteps: [{ id: 's2c', action: 'tasks.create_task', params: {}, dependsOn: [] }] }, // 8 joiner replan 2
      { decision: 'abort' }, // 9 — scripted but NEVER consumed (blocked by the global budget / maxReplans)
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

    expect(queue.callCount()).toBe(8); // the 9th scripted response is never fetched
    expect(created).toBe(0); // the turn aborts before any patched write ever runs

    const completed = completedOf(events);
    expect(completed.status).toBe('failed');
    expect(completed.metrics.llmCalls).toBe(8);
    expect(completed.metrics.repairs).toBe(3);
    expect(completed.metrics.searchRounds).toBe(2);
    expect(completed.metrics.replans).toBe(2);
    expect(Number.isFinite(completed.metrics.ttfurMs)).toBe(true);
    expect(Number.isFinite(completed.metrics.totalMs)).toBe(true);
    expect(completed.metrics.ttfurMs).toBeLessThanOrEqual(completed.metrics.totalMs);

    const final = events.find((e) => e.t === 'answer.final');
    expect(final && final.t === 'answer.final' && final.text.length).toBeGreaterThan(0);
  });
});

describe('runTurn — turn timeout (turnTimeoutMs, reviewer I-1)', () => {
  it('a slow handler crossing a tiny deadline stops BETWEEN strata: status failed, timeout message, memory.snapshot still last', async () => {
    const queue = queueMockLlm([
      {
        kind: 'plan',
        plan: {
          goal: 'slow',
          steps: [
            { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
            { id: 's2', action: 'tasks.create_task', params: {}, dependsOn: ['s1'] },
          ],
        },
      },
    ]);
    __setTestFetch(queue.fetch);

    let created = 0;
    const registry = buildRegistry(
      [
        [
          // Deliberately slow — longer than the 50ms test deadline below —
          // so the deadline is crossed WHILE this read runs, and the check
          // (which only ever runs BETWEEN strata) catches it on the very
          // next loop iteration, before s2's stratum is even scheduled.
          action('leads.search_leads', 'read', async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return { items: [], total: 0 };
          }),
          action('tasks.create_task', 'write', async () => {
            created += 1;
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );

    const events = await drive(registry, 'find my leads', { turnTimeoutMs: 50 });

    expect(queue.callCount()).toBe(1); // the plan itself was fine — only execution timed out
    expect(created).toBe(0); // s2's stratum never started

    const completed = completedOf(events);
    expect(completed.status).toBe('failed');
    expect(Number.isFinite(completed.metrics.ttfurMs)).toBe(true);
    expect(Number.isFinite(completed.metrics.totalMs)).toBe(true);

    const final = events.find((e) => e.t === 'answer.final');
    expect(final && final.t === 'answer.final' && final.text).toMatch(/deadline|timeout/i);

    // memory.snapshot is still emitted LAST, even on a timeout failure.
    expect(typesOf(events).slice(-3)).toEqual(['answer.final', 'turn.completed', 'memory.snapshot']);
  });
});

describe('runTurn — top-level error guard + fast-model escalation (reviewer I-2)', () => {
  it('a malformed response from the routed FAST model escalates once to the planner model and succeeds — 2 calls', async () => {
    const queue = queueMockLlm([
      { nonsense: true }, // fails `planOutcomeSchema` → NoObjectGeneratedError
      { kind: 'plan', plan: { goal: 'ok', steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]],
      coreOps,
    );

    // "create a contact" scores 0.70 (> τ) against the REAL catalog's
    // contacts.create_contact, is ≤12 words, and carries no multi-intent
    // marker → router.ts routes this turn to FAST_MODEL.
    const events = await drive(registry, 'create a contact');

    expect(queue.callCount()).toBe(2);
    const completed = completedOf(events);
    expect(completed.status).toBe('done');
    expect(completed.metrics.llmCalls).toBe(2);
  });

  it('a malformed response from the routed PLANNER model has no further escalation — fails honestly, completed+snapshot still emitted', async () => {
    const queue = queueMockLlm([{ nonsense: true }]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry([], coreOps);

    // A comma + "and"/"then" forces the multi-intent branch regardless of
    // retrieval score → router.ts routes this turn to PLANNER_MODEL, so
    // there is no weaker model left to escalate FROM.
    const events = await drive(registry, 'create a contact, and then do something else');

    expect(queue.callCount()).toBe(1); // no retry attempted
    const completed = completedOf(events);
    expect(completed.status).toBe('failed');
    expect(completed.metrics.llmCalls).toBe(1);

    // the generic top-level guard still gets the turn to a clean finish.
    expect(typesOf(events).slice(-3)).toEqual(['answer.final', 'turn.completed', 'memory.snapshot']);
  });
});
