import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runBaselineTurn, type BaselineSessionDeps } from '../src/baseline/agent';
import { buildCatalogSummary, estimateTokens } from '../src/baseline/catalog-summary';
import { queueMockLlm } from './helpers/mock-llm';
import { __setTestFetch, __setTestBackoffOptions, costMeter } from '../src/llm/client';
import { openEventLog, type EventLog } from '../src/events/log';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import { createRefStore, type RefStore } from '../src/agent/refs';
import { buildRegistry, createRegistry, type Registry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef, ActionContext, Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import type { ConfirmBroker } from '../src/agent/executor';
import type { Event, EventType } from '../src/events/types';

// --- scriptable fake action (same convention as executor.test.ts /
// pipeline.test.ts) ----------------------------------------------------------

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;

function action(slug: string, risk: Risk, handler: Handler, inputSchema?: z.ZodType<unknown>): ActionDef {
  return {
    id: slug,
    slug,
    module: slug.split('.')[0] as string,
    name: slug,
    description: slug,
    risk,
    entities: [slug.split('.')[0] as string],
    inputSchema: inputSchema ?? z.record(z.string(), z.unknown()),
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
const denyAll: ConfirmBroker = { request: async () => false };

// --- harness -----------------------------------------------------------------

const tmpPaths: string[] = [];

function tmpDbPath(): string {
  const p = join(tmpdir(), `ask-ai-baseline-${randomUUID()}.db`);
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
const sessionId = 'sess_baseline';

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

function deps(registry: Registry, overrides: Partial<BaselineSessionDeps> = {}): BaselineSessionDeps {
  return { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, ...overrides };
}

async function drive(
  registry: Registry,
  userText: string,
  overrides: Partial<BaselineSessionDeps> = {},
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const ev of runBaselineTurn({
    sessionId,
    turnId: `t_${randomUUID()}`,
    userText,
    sessionDeps: deps(registry, overrides),
  })) {
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

function finalAnswerOf(events: readonly Event[]): string {
  const ev = events.find((e) => e.t === 'answer.final');
  if (!ev || ev.t !== 'answer.final') throw new Error('no answer.final event');
  return ev.text;
}

// ---------------------------------------------------------------------------

describe('runBaselineTurn — 2-tool-call turn', () => {
  it('dispatches both calls via the registry, emits the shared Event schema, sums usage across all 3 LLM calls', async () => {
    const queue = queueMockLlm([
      { kind: 'call_action', slug: 'leads.search_leads', params: {} },
      { kind: 'call_action', slug: 'tasks.create_task', params: { title: 'Follow up' } },
      { kind: 'final', text: 'Found 1 lead and created a follow-up task.' },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 })),
          action(
            'tasks.create_task',
            'write',
            async () => ({ id: 't1', name: 'Follow up' }),
            z.object({ title: z.string() }),
          ),
        ],
      ],
      coreOps,
    );

    const events = await drive(registry, 'find my leads and create a follow-up task');

    expect(queue.callCount()).toBe(3);

    const types = typesOf(events);
    expect(types[0]).toBe('turn.started');
    expect(types.slice(-3)).toEqual(['answer.final', 'turn.completed', 'memory.snapshot']);
    expect(types).toContain('step.started');
    expect(types).toContain('step.finished');
    expect(types.filter((t) => t === 'answer.delta').length).toBeGreaterThanOrEqual(1);
    // Baseline NEVER emits planning-phase events — different control flow
    // entirely from `agent/pipeline.ts`.
    expect(types).not.toContain('plan.ready');
    expect(types).not.toContain('retrieval.done');
    expect(types).not.toContain('confirmation.required');

    const started = events.filter((e): e is Extract<Event, { t: 'step.started' }> => e.t === 'step.started');
    expect(started.map((e) => e.action)).toEqual(['leads.search_leads', 'tasks.create_task']);
    expect(started.map((e) => e.stepId)).toEqual(['b1', 'b2']);

    expect(finalAnswerOf(events)).toBe('Found 1 lead and created a follow-up task.');

    const completed = completedOf(events);
    expect(completed.status).toBe('done');
    expect(completed.metrics.llmCalls).toBe(3);
    expect(completed.metrics.stepsOk).toBe(2);
    expect(completed.metrics.stepsFailed).toBe(0);
    expect(completed.metrics.repairs).toBe(0);
    expect(completed.metrics.replans).toBe(0);
    expect(completed.metrics.searchRounds).toBe(0);
    // Each scripted call reports usage {prompt_tokens:10, completion_tokens:10, cost:0.0001} —
    // metrics must SUM all 3 calls' usage, not just the last one.
    expect(completed.metrics.tokensIn).toBe(30);
    expect(completed.metrics.tokensOut).toBe(30);
    expect(completed.metrics.costUsd).toBeCloseTo(0.0003, 6);
    expect(Number.isFinite(completed.metrics.ttfurMs)).toBe(true);
    expect(completed.metrics.ttfurMs).toBeLessThanOrEqual(completed.metrics.totalMs);

    const snap = events.find((e) => e.t === 'memory.snapshot');
    expect(snap).toBeDefined();
    if (snap && snap.t === 'memory.snapshot') {
      expect(snap.state).toEqual({ frame: null, entities: {}, handles: [] });
    }
  });
});

describe('runBaselineTurn — invalid slug', () => {
  it('feeds the error back as an observation (counted as a step) instead of throwing; the loop continues', async () => {
    const queue = queueMockLlm([
      { kind: 'call_action', slug: 'bogus.nope', params: {} },
      { kind: 'final', text: 'I could not find a matching action, so no change was made.' },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], coreOps);

    const events = await drive(registry, 'do the bogus thing');

    expect(queue.callCount()).toBe(2);
    // The invalid slug never reaches dispatch — no step.* event for it.
    expect(typesOf(events)).not.toContain('step.started');
    expect(typesOf(events)).not.toContain('step.failed');

    const completed = completedOf(events);
    expect(completed.status).toBe('done');
    expect(completed.metrics.llmCalls).toBe(2);
    expect(completed.metrics.stepsOk).toBe(0);
    expect(completed.metrics.stepsFailed).toBe(0);
    expect(finalAnswerOf(events)).toBe('I could not find a matching action, so no change was made.');
  });
});

describe('runBaselineTurn — destructive action gate', () => {
  it('gates before dispatch; denial means the handler is NEVER called and the final answer is honest', async () => {
    let handlerCalled = false;
    const queue = queueMockLlm([
      { kind: 'call_action', slug: 'contacts.archive_contact', params: { contact_id: 'c1' } },
      { kind: 'final', text: 'I did not archive the contact — the request was not approved.' },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [
        [
          action('contacts.archive_contact', 'destructive', async () => {
            handlerCalled = true;
            return { id: 'c1', name: 'Archived' };
          }),
        ],
      ],
      coreOps,
    );

    const events = await drive(registry, 'archive contact c1', { confirm: denyAll });

    expect(queue.callCount()).toBe(2);
    expect(handlerCalled).toBe(false);
    expect(typesOf(events)).not.toContain('step.started');

    const req = events.find((e) => e.t === 'confirmation.required');
    expect(req).toBeDefined();
    if (req && req.t === 'confirmation.required') {
      expect(req.scope.actions).toEqual(['contacts.archive_contact']);
      expect(req.scope.affectedCount).toBe(1);
      expect(req.planRev).toBe(0);
      expect(typeof req.planHash).toBe('string');
      expect(req.planHash).toHaveLength(64);
    }
    const resolved = events.find((e) => e.t === 'confirmation.resolved');
    expect(resolved).toBeDefined();
    if (resolved && resolved.t === 'confirmation.resolved') expect(resolved.approved).toBe(false);

    const completed = completedOf(events);
    expect(completed.status).toBe('done');
    expect(finalAnswerOf(events)).toBe('I did not archive the contact — the request was not approved.');
  });

  it('a destructive call APPROVED runs the handler exactly once', async () => {
    let handlerCalls = 0;
    const queue = queueMockLlm([
      { kind: 'call_action', slug: 'contacts.archive_contact', params: { contact_id: 'c1' } },
      { kind: 'final', text: 'Archived the contact.' },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [
        [
          action('contacts.archive_contact', 'destructive', async () => {
            handlerCalls += 1;
            return { id: 'c1', name: 'Archived' };
          }),
        ],
      ],
      coreOps,
    );

    const events = await drive(registry, 'archive contact c1', { confirm: approveAll });

    expect(handlerCalls).toBe(1);
    expect(typesOf(events)).toContain('step.started');
    expect(typesOf(events)).toContain('step.finished');
    expect(completedOf(events).status).toBe('done');
  });
});

describe('runBaselineTurn — 12-step cap', () => {
  it('an honest failure when no "final" decision is ever produced within the cap', async () => {
    const scripted = Array.from({ length: 12 }, () => ({
      kind: 'call_action' as const,
      slug: 'leads.search_leads',
      params: {},
    }));
    const queue = queueMockLlm(scripted);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], coreOps);

    const events = await drive(registry, 'keep searching forever');

    // Exactly 12 calls — the 13th would throw inside queueMockLlm's fetch if
    // the loop ever over-ran its cap.
    expect(queue.callCount()).toBe(12);

    const completed = completedOf(events);
    expect(completed.status).toBe('failed');
    expect(completed.metrics.llmCalls).toBe(12);
    expect(completed.metrics.stepsOk).toBe(12);
    expect(finalAnswerOf(events)).toMatch(/12 steps/);
  });
});

describe('buildCatalogSummary', () => {
  it('contains all 500 catalog slugs, grouped by module, within the ~12k-token budget', () => {
    const registry = createRegistry();
    const text = buildCatalogSummary(registry);

    const nonCoreSlugs = registry.all().filter((a) => !a.slug.startsWith('core.')).map((a) => a.slug);
    expect(nonCoreSlugs).toHaveLength(500);
    for (const slug of nonCoreSlugs) {
      expect(text.includes(slug)).toBe(true);
    }

    // core.* built-in data ops are NOT part of the baseline's catalog.
    expect(text).not.toContain('core.filter');

    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(10_000);
    expect(tokens).toBeLessThanOrEqual(15_000);

    expect(text.startsWith('## Contacts')).toBe(true);
  });

  it('is deterministic for a given registry (safe to snapshot byte-for-byte)', () => {
    const registry = createRegistry();
    expect(buildCatalogSummary(registry)).toBe(buildCatalogSummary(registry));
    expect(buildCatalogSummary(registry)).toMatchSnapshot();
  });
});
