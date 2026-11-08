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
import { listOutputSchema } from '../src/catalog/list-output';
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

describe('runTurn — mechanical search-before-refuse (P6)', () => {
  it('a volunteered "unsupported" is retried once via a forced search+replan, then a plan runs', async () => {
    const queue = queueMockLlm([
      { kind: 'unsupported', reason: 'I can only look up contacts, not companies.' },
      { kind: 'plan', plan: { goal: 'after forced search', steps: [{ id: 's1', action: 'companies.search_companies', params: {}, dependsOn: [] }] } },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [[action('companies.search_companies', 'read', async () => ({ items: [{ id: 'co_1', name: 'Acme' }], total: 1 }))]],
      coreOps,
    );

    const events = await drive(registry, 'whats going on with acme');

    expect(queue.callCount()).toBe(2); // the forced replan happened
    const searchEvent = events.find((e) => e.t === 'search');
    expect(searchEvent).toBeDefined();
    if (searchEvent && searchEvent.t === 'search') expect(searchEvent.reason).toBe('auto-retry before refusing');
    expect(completedOf(events).status).toBe('done'); // not 'refused'
    expect(completedOf(events).metrics.searchRounds).toBe(1);
  });

  it('a second "unsupported" after the forced retry stands as a refusal (no raw leak)', async () => {
    const queue = queueMockLlm([
      { kind: 'unsupported', reason: 'first refusal' },
      { kind: 'unsupported', reason: 'I genuinely cannot do that.' },
    ]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]],
      coreOps,
    );

    const events = await drive(registry, 'do something impossible');

    expect(queue.callCount()).toBe(2);
    const completed = completedOf(events);
    expect(completed.status).toBe('refused');
    const final = events.find((e) => e.t === 'answer.final');
    if (final && final.t === 'answer.final') {
      expect(final.text).not.toContain('exhausting search rounds');
      expect(final.text).not.toContain('matching action');
    }
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

describe('runTurn — repair escalation (Fix C, task-refconverge)', () => {
  function actionWith(slug: string, risk: Risk, outputSchema: z.ZodType<unknown>, handler: Handler): ActionDef {
    return {
      id: slug,
      slug,
      module: slug.split('.')[0] as string,
      name: slug,
      description: slug,
      risk,
      entities: [slug.split('.')[0] as string],
      inputSchema: z.strictObject({}),
      outputSchema,
      searchCard: { synonyms: [], examplePhrasings: [] },
      handler: handler as ActionDef['handler'],
    };
  }

  /** Wraps `queueMockLlm`'s fetch to additionally capture the `model` field
   * of every outgoing request body — `queueMockLlm` itself ignores the
   * request entirely (FIFO value replay only), so this is the only way to
   * assert WHICH model a given repair round actually dialed. */
  function withModelCapture(queue: ReturnType<typeof queueMockLlm>): { fetch: typeof fetch; models: string[] } {
    const models: string[] = [];
    const wrapped = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      try {
        const bodyText = typeof init?.body === 'string' ? init.body : undefined;
        const body = bodyText ? (JSON.parse(bodyText) as { model?: unknown }) : undefined;
        if (typeof body?.model === 'string') models.push(body.model);
      } catch {
        // a malformed body is the real fetch's problem to report, not this probe's
      }
      return queue.fetch(url, init);
    }) as typeof fetch;
    return { fetch: wrapped, models };
  }

  it('round ≥2 STILL on a ref-path issue escalates to REPAIR_ESCALATION_MODEL once; round 1 does not', async () => {
    const brokenPlan = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'x.search_x', params: {}, dependsOn: [] },
          { id: 's2', action: 'y.act', params: {}, dependsOn: ['s1'], when: { ref: '$s1.bogus', op: 'nonempty' } },
        ],
      },
    };
    const fixedPlan = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', action: 'x.search_x', params: {}, dependsOn: [] },
          { id: 's2', action: 'y.act', params: {}, dependsOn: ['s1'], when: { ref: '$s1.items[*].id', op: 'nonempty' } },
        ],
      },
    };
    // `$s1.bogus` is NOT uniquely autofixable (the row schema only has
    // `id` — zero fuzzy-match/structural candidates) — a real REF_PATH_
    // MISMATCH repair round is unavoidable, and round 1's repair (below)
    // re-sends the SAME broken ref, forcing a round-2 escalation.
    const queue = queueMockLlm([
      brokenPlan, // 1: initial plan
      brokenPlan, // 2: repair round 1 (normal escalate(model)) — STILL broken
      fixedPlan, // 3: repair round 2 — escalated model — now valid
    ]);
    const { fetch: captureFetch, models } = withModelCapture(queue);
    __setTestFetch(captureFetch);

    const registry = buildRegistry(
      [
        [
          actionWith('x.search_x', 'read', listOutputSchema(z.object({ id: z.string() })), async () => ({
            items: [{ id: 'row_1' }],
            total: 1,
          })),
          actionWith('y.act', 'read', z.unknown(), async () => ({ ok: true })),
        ],
      ],
      coreOps,
    );

    const events = await drive(registry, 'do the ref thing');

    expect(queue.callCount()).toBe(3); // 3 plan responses consumed from the queue
    expect(completedOf(events).status).toBe('done');
    expect(completedOf(events).metrics.repairs).toBe(2);

    // Model sequence: [0] = initial plan call (routing-picked, not asserted);
    // [1] = repair round 1, ALWAYS `escalate(model)` == the default planner
    // model; [2] = repair round 2, the ONE call that must have escalated
    // further, to `REPAIR_ESCALATION_MODEL`; [3] = the final compose call,
    // which uses FAST_MODEL once the plan is valid and executes to `done`.
    expect(models).toHaveLength(4);
    expect(models[1]).toBe('anthropic/claude-haiku-4.5');
    expect(models[2]).toBe('anthropic/claude-sonnet-4.5');
    expect(models[2]).not.toBe(models[1]);
  });

  it('does NOT escalate when round ≥2 is triggered by a NON-ref issue (e.g. UNKNOWN_SLUG repeated)', async () => {
    const badSlugPlan = { kind: 'plan', plan: { goal: 'g', steps: [{ id: 's1', action: 'bogus.not_real', params: {}, dependsOn: [] }] } };
    const goodPlan = { kind: 'plan', plan: { goal: 'g', steps: [{ id: 's1', action: 'x.search_x', params: {}, dependsOn: [] }] } };
    const queue = queueMockLlm([badSlugPlan, badSlugPlan, goodPlan]);
    const { fetch: captureFetch, models } = withModelCapture(queue);
    __setTestFetch(captureFetch);

    const registry = buildRegistry(
      [[actionWith('x.search_x', 'read', z.unknown(), async () => ({ items: [], total: 0 }))]],
      coreOps,
    );

    const events = await drive(registry, 'unknown slug twice');

    expect(queue.callCount()).toBe(3);
    expect(completedOf(events).metrics.repairs).toBe(2);
    // Both repair rounds stay on the normal planner model — UNKNOWN_SLUG
    // is not a ref-path/grammar issue, so Fix C's escalation never fires.
    expect(models[1]).toBe('anthropic/claude-haiku-4.5');
    expect(models[2]).toBe('anthropic/claude-haiku-4.5');
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
  it('exhausts the LLM-call budget across plan/repair/replan and fails honestly', async () => {
    // BUDGETS.maxLlmCallsPerTurn rose 6→8 with maxRepairs 2→4 (TRIAGE rec #3).
    // 2 search + 1 plan + 3 repair (3rd valid) + 2 joiner replans + 1 final
    // joiner-abort decision = 9 calls; the turn then fails honestly with no
    // write ever applied.
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

    expect(queue.callCount()).toBe(9); // all 9 scripted responses are consumed
    expect(created).toBe(0); // the turn aborts before any patched write ever runs

    const completed = completedOf(events);
    expect(completed.status).toBe('failed');
    expect(completed.metrics.llmCalls).toBe(9);
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

  it('a malformed response gets exactly ONE structured retry (E8a); both bad → fails honestly, completed+snapshot still emitted', async () => {
    // E8(a): a NoObjectGeneratedError now ALWAYS gets one augmented retry on
    // PLANNER_MODEL, even when the turn was routed straight to the planner
    // model (previously: no retry, 1 call). Two bad responses → 2 calls, then
    // an honest failure.
    const queue = queueMockLlm([{ nonsense: true }, { nonsense: true }]);
    __setTestFetch(queue.fetch);

    const registry = buildRegistry([], coreOps);

    const events = await drive(registry, 'create a contact, and then do something else');

    expect(queue.callCount()).toBe(2); // initial + ONE structured retry
    const completed = completedOf(events);
    expect(completed.status).toBe('failed');
    expect(completed.metrics.llmCalls).toBe(2);

    // the generic top-level guard still gets the turn to a clean finish.
    expect(typesOf(events).slice(-3)).toEqual(['answer.final', 'turn.completed', 'memory.snapshot']);
  });
});

// --- engine-wave E8: parse-failure retry + sticky escalation ---------------

describe('runTurn — E8 parse-failure retry + sticky repair escalation', () => {
  function actionE8(slug: string, risk: Risk, outputSchema: z.ZodType<unknown>, handler: Handler): ActionDef {
    return {
      id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug,
      risk, entities: [slug.split('.')[0] as string], inputSchema: z.strictObject({}),
      outputSchema, searchCard: { synonyms: [], examplePhrasings: [] }, handler: handler as ActionDef['handler'],
    };
  }

  function capture(queue: ReturnType<typeof queueMockLlm>): { fetch: typeof fetch; models: string[]; prompts: string[] } {
    const models: string[] = [];
    const prompts: string[] = [];
    const wrapped = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      try {
        const bodyText = typeof init?.body === 'string' ? init.body : undefined;
        const body = bodyText ? (JSON.parse(bodyText) as { model?: unknown; messages?: { content?: unknown }[] }) : undefined;
        if (typeof body?.model === 'string') models.push(body.model);
        prompts.push(JSON.stringify(body?.messages ?? ''));
      } catch { /* ignore */ }
      return queue.fetch(url, init);
    }) as typeof fetch;
    return { fetch: wrapped, models, prompts };
  }

  it('E8(a): a parse failure gets ONE augmented retry on PLANNER_MODEL and succeeds (2 calls)', async () => {
    const good = { kind: 'plan', plan: { goal: 'ok', steps: [{ id: 's1', action: 'x.search_x', params: {}, dependsOn: [] }] } };
    const queue = queueMockLlm([{ nonsense: true }, good]);
    const cap = capture(queue);
    __setTestFetch(cap.fetch);
    const registry = buildRegistry([[actionE8('x.search_x', 'read', z.unknown(), async () => ({ items: [], total: 0 }))]], coreOps);

    // Multi-intent text → routed straight to PLANNER_MODEL; previously that
    // meant NO retry. E8(a) retries anyway.
    const events = await drive(registry, 'do the thing, and then do the other thing');

    expect(queue.callCount()).toBe(2);
    expect(completedOf(events).status).toBe('done');
    expect(cap.models[1]).toBe('anthropic/claude-haiku-4.5'); // PLANNER_MODEL
    expect(cap.prompts[1]).toContain('RETRY'); // the augmented retry directive
  });

  it('E8(b): once escalated, every REMAINING repair round stays on REPAIR_ESCALATION_MODEL', async () => {
    const broken = {
      kind: 'plan',
      plan: { goal: 'g', steps: [
        { id: 's1', action: 'x.search_x', params: {}, dependsOn: [] },
        { id: 's2', action: 'y.act', params: {}, dependsOn: ['s1'], when: { ref: '$s1.bogus', op: 'nonempty' } },
      ] },
    };
    const fixed = {
      kind: 'plan',
      plan: { goal: 'g', steps: [
        { id: 's1', action: 'x.search_x', params: {}, dependsOn: [] },
        { id: 's2', action: 'y.act', params: {}, dependsOn: ['s1'], when: { ref: '$s1.items[*].id', op: 'nonempty' } },
      ] },
    };
    // initial, repair1 (haiku), repair2 (escalate→sonnet, still broken),
    // repair3 (STICKY sonnet → fixed).
    const queue = queueMockLlm([broken, broken, broken, fixed]);
    const cap = capture(queue);
    __setTestFetch(cap.fetch);
    const registry = buildRegistry(
      [[
        actionE8('x.search_x', 'read', listOutputSchema(z.object({ id: z.string() })), async () => ({ items: [{ id: 'r1' }], total: 1 })),
        actionE8('y.act', 'read', z.unknown(), async () => ({ ok: true })),
      ]],
      coreOps,
    );

    const events = await drive(registry, 'do the sticky ref thing');

    expect(queue.callCount()).toBe(4);
    expect(completedOf(events).status).toBe('done');
    expect(completedOf(events).metrics.repairs).toBe(3);
    expect(cap.models[1]).toBe('anthropic/claude-haiku-4.5'); // repair round 1
    expect(cap.models[2]).toBe('anthropic/claude-sonnet-4.5'); // round 2 escalates
    expect(cap.models[3]).toBe('anthropic/claude-sonnet-4.5'); // round 3 STAYS escalated (sticky)
  });
});

describe('runTurn — E9 current_user context', () => {
  it('injects a current_user line into the planner prompt (default user_1)', async () => {
    const queue = queueMockLlm([{ kind: 'respond', text: 'hi' }]);
    const prompts: string[] = [];
    const wrapped = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const bodyText = typeof init?.body === 'string' ? init.body : undefined;
      if (bodyText) prompts.push(bodyText);
      return queue.fetch(url, init);
    }) as typeof fetch;
    __setTestFetch(wrapped);
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], coreOps);
    await drive(registry, 'what are my open leads');
    expect(prompts.some((p) => p.includes('current_user: user_1'))).toBe(true);
  });
});
