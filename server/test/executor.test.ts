import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { execute, foldExecutor, type ConfirmBroker, type ExecuteInput } from '../src/agent/executor';
import { createRefStore, type RefStore } from '../src/agent/refs';
import { buildRegistry, type Registry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef, ActionContext, Risk } from '../src/catalog/types';
import { ActionError } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import { openCrm, crmDbPath, closeRegistered } from '../src/store/db';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import type { Event, Plan } from '../src/events/types';

// --- scriptable fake action -------------------------------------------------

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

// --- a fake Crm whose tx just runs the fn with a no-op StoreTx -------------

const noopTx: StoreTx = {
  all: () => [],
  get: () => undefined,
  run: () => ({ changes: 0 }),
};

const fakeCrm: Crm = {
  tx: (fn) => fn(noopTx),
  close: () => {},
};

// --- harness ----------------------------------------------------------------

let sessions: SessionsDb;
let refs: RefStore;

beforeEach(() => {
  sessions = openSessions(':memory:');
  refs = createRefStore(sessions, 'sess_exec');
});

afterEach(() => {
  sessions.close();
});

const approveAll: ConfirmBroker = { request: async () => true };
const denyAll: ConfirmBroker = { request: async () => false };

function baseInput(
  plan: Plan,
  registry: Registry,
  overrides: Partial<ExecuteInput> = {},
): ExecuteInput {
  const events: Event[] = [];
  const onEvent = (e: Event): void => {
    events.push(e);
  };
  const input: ExecuteInput = {
    plan,
    planHash: 'hash_test',
    planRev: 0,
    stepOrder: plan.steps.map((s) => s.id),
    turnId: '1',
    sessionId: 'sess_exec',
    registry,
    crm: fakeCrm,
    refs,
    handles: [],
    onEvent,
    confirm: approveAll,
    retryDelayMs: 0,
    ...overrides,
  };
  // expose the collected events via a side channel for assertions
  (input as ExecuteInput & { _events: Event[] })._events = events;
  return input;
}

function eventsOf(input: ExecuteInput): Event[] {
  return (input as ExecuteInput & { _events: Event[] })._events;
}

// ---------------------------------------------------------------------------

describe('executor — conformance plan', () => {
  it('executes the flagship plan end-to-end with scripted reads and fan-out writes', async () => {
    const assignKeys: string[] = [];
    const taskKeys: string[] = [];

    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({
            items: Array.from({ length: 5 }, (_, i) => ({
              id: `lead_${i + 1}`,
              contact_id: `c${i + 1}`,
              name: `Lead ${i + 1}`,
            })),
            total: 5,
          })),
          action('conversations.search_conversations', 'read', async () => ({
            items: [{ contact_id: 'c1' }], // only c1 replied
            total: 1,
          })),
          action('appointments.search_appointments', 'read', async () => ({
            items: [{ contact_id: 'c2' }], // only c2 booked
            total: 1,
          })),
          action('users.list_users', 'read', async () => ({
            items: [{ id: 'u1' }, { id: 'u2' }],
            total: 2,
          })),
          action('leads.assign_lead_owner', 'write', async (_i, ctx) => {
            assignKeys.push(ctx.idempotencyKey);
            return { ok: true };
          }),
          action('tasks.create_task', 'write', async (_i, ctx) => {
            taskKeys.push(ctx.idempotencyKey);
            return { id: `task_${ctx.idempotencyKey}` };
          }),
        ],
      ],
      coreOps,
    );

    const plan: Plan = {
      goal: 'conformance',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: { created_after: 'x' }, dependsOn: [] },
        {
          id: 's2',
          action: 'conversations.search_conversations',
          params: { contact_ids: '$s1.items[*].contact_id', has_inbound_reply: true },
          dependsOn: ['s1'],
        },
        {
          id: 's3',
          action: 'core.anti_join',
          params: { in: '$s1.items', key: 'contact_id', exclude: '$s2.items', excludeKey: 'contact_id' },
          dependsOn: ['s1', 's2'],
        },
        {
          id: 's4',
          action: 'appointments.search_appointments',
          params: { contact_ids: '$s3.items[*].contact_id', status: 'booked' },
          dependsOn: ['s3'],
        },
        {
          id: 's5',
          action: 'core.anti_join',
          params: { in: '$s3.items', key: 'contact_id', exclude: '$s4.items', excludeKey: 'contact_id' },
          dependsOn: ['s3', 's4'],
        },
        { id: 's6', action: 'users.list_users', params: { role: 'sales_rep' }, dependsOn: [] },
        {
          id: 's7',
          action: 'core.distribute',
          params: { items: '$s5.items', across: '$s6.items[*].id', strategy: 'round_robin' },
          dependsOn: ['s5', 's6'],
        },
        {
          id: 's8',
          action: 'leads.assign_lead_owner',
          params: { lead_id: '$item.item.id', owner_id: '$item.assignee' },
          forEach: '$s7.items',
          dependsOn: ['s7'],
        },
        {
          id: 's9',
          action: 'tasks.create_task',
          params: { title: 'Follow up with $item.item.name', owner_id: '$item.assignee' },
          forEach: '$s7.items',
          dependsOn: ['s7'],
        },
      ],
    };

    const input = baseInput(plan, registry);
    const result = await execute(input);

    expect(result.status).toBe('done');
    // s1(5) minus replied c1 => 4; minus booked c2 => 3 leads remain → fan-out 3
    expect(assignKeys).toHaveLength(3);
    expect(taskKeys).toHaveLength(3);
    // per-item idempotency keys distinct
    expect(new Set(assignKeys).size).toBe(3);
    expect(assignKeys).toEqual(['1:0:s8:0', '1:0:s8:1', '1:0:s8:2']);
    // no confirmation (all writes affect ≤50, risk write)
    expect(eventsOf(input).some((e) => e.t === 'confirmation.required')).toBe(false);
    // s9 title template interpolated with $item.item.name
    const s9 = eventsOf(input).find((e) => e.t === 'step.finished' && e.stepId === 's9');
    expect(s9).toBeDefined();
  });
});

describe('executor — confirmation gate', () => {
  it('denied confirmation cancels the step, skips dependents, status cancelled, zero handler calls', async () => {
    let writeCalls = 0;
    let dependentCalls = 0;
    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({ items: [{ id: 'lead_1' }], total: 1 })),
          action('leads.delete_lead', 'destructive', async () => {
            writeCalls += 1;
            return { ok: true };
          }),
          action('tasks.create_task', 'write', async () => {
            dependentCalls += 1;
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );
    const plan: Plan = {
      goal: 'deny',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
        { id: 's2', action: 'leads.delete_lead', params: { id: '$s1.items[*].id' }, dependsOn: ['s1'] },
        { id: 's3', action: 'tasks.create_task', params: {}, dependsOn: ['s2'] },
      ],
    };
    const input = baseInput(plan, registry, { confirm: denyAll });
    const result = await execute(input);

    expect(result.status).toBe('cancelled');
    expect(result.stepStates['s2']?.state).toBe('cancelled');
    expect(result.stepStates['s3']?.state).toBe('skipped');
    expect(writeCalls).toBe(0);
    expect(dependentCalls).toBe(0);
    const resolved = eventsOf(input).find((e) => e.t === 'confirmation.resolved');
    expect(resolved).toMatchObject({ approved: false });
  });

  it('bulk-risk action with only 3 targets still gates', async () => {
    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({
            items: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }],
            total: 3,
          })),
          action('campaigns.launch_segment', 'bulk', async () => ({ ok: true })),
        ],
      ],
      coreOps,
    );
    const plan: Plan = {
      goal: 'bulk',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
        { id: 's2', action: 'campaigns.launch_segment', params: { ids: '$s1.items[*].id' }, dependsOn: ['s1'] },
      ],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);
    expect(result.status).toBe('done');
    const req = eventsOf(input).find((e) => e.t === 'confirmation.required');
    expect(req).toBeDefined();
    expect(req && req.t === 'confirmation.required' && req.scope.affectedCount).toBe(3);
  });

  it('51 resolved targets gate a plain write action', async () => {
    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({
            items: Array.from({ length: 51 }, (_, i) => ({ id: `l${i}` })),
            total: 51,
          })),
          action('leads.bulk_update', 'write', async () => ({ ok: true })),
        ],
      ],
      coreOps,
    );
    const plan: Plan = {
      goal: '51',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
        { id: 's2', action: 'leads.bulk_update', params: { ids: '$s1.items[*].id' }, dependsOn: ['s1'] },
      ],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);
    expect(result.status).toBe('done');
    const req = eventsOf(input).find((e) => e.t === 'confirmation.required');
    expect(req && req.t === 'confirmation.required' && req.scope.affectedCount).toBe(51);
  });

  it('forEach creating 120 gates once with aggregate affectedCount 120', async () => {
    let created = 0;
    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({
            items: Array.from({ length: 120 }, (_, i) => ({ id: `l${i}` })),
            total: 120,
          })),
          action('tasks.create_task', 'write', async () => {
            created += 1;
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );
    const plan: Plan = {
      goal: '120',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
        {
          id: 's2',
          action: 'tasks.create_task',
          params: { lead_id: '$item.id' },
          forEach: '$s1.items',
          dependsOn: ['s1'],
        },
      ],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);
    expect(result.status).toBe('done');
    expect(created).toBe(120);
    const reqs = eventsOf(input).filter((e) => e.t === 'confirmation.required');
    expect(reqs).toHaveLength(1);
    expect(reqs[0] && reqs[0].t === 'confirmation.required' && reqs[0].scope.affectedCount).toBe(120);
  });

  it('a LITERAL array of 60 ids gates a plain write action (affectedCount 60)', async () => {
    const registry = buildRegistry(
      [[action('leads.bulk_update', 'write', async () => ({ ok: true }))]],
      coreOps,
    );
    const ids = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const plan: Plan = {
      goal: 'literal-array',
      steps: [{ id: 's1', action: 'leads.bulk_update', params: { ids }, dependsOn: [] }],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);
    expect(result.status).toBe('done');
    const req = eventsOf(input).find((e) => e.t === 'confirmation.required');
    expect(req && req.t === 'confirmation.required' && req.scope.affectedCount).toBe(60);
  });

  it('forEach fan-out of 501 is REFUSED with LIMIT_EXCEEDED and no handler calls', async () => {
    let created = 0;
    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({
            items: Array.from({ length: 501 }, (_, i) => ({ id: `l${i}` })),
            total: 501,
          })),
          action('tasks.create_task', 'write', async () => {
            created += 1;
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );
    const plan: Plan = {
      goal: '501',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
        {
          id: 's2',
          action: 'tasks.create_task',
          params: { lead_id: '$item.id' },
          forEach: '$s1.items',
          dependsOn: ['s1'],
        },
      ],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);
    expect(result.status).toBe('failed');
    expect(created).toBe(0);
    expect(result.stepStates['s2']?.error?.code).toBe('LIMIT_EXCEEDED');
    expect(eventsOf(input).some((e) => e.t === 'confirmation.required')).toBe(false);
  });
});

describe('executor — unresolved ref (REF_RESOLUTION)', () => {
  it('a param ref to a missing field fails the step with REF_RESOLUTION; the literal never reaches the handler', async () => {
    let handlerCalls = 0;
    let handlerSawParams: unknown;
    const registry = buildRegistry(
      [
        [
          // a search/list result — `.id` does NOT exist on it (the rows do)
          action('courses.search_courses', 'read', async () => ({
            items: [{ id: 'course_1' }, { id: 'course_2' }],
            total: 2,
          })),
          action('enrollments.enroll_learner_in_course', 'write', async (i) => {
            handlerCalls += 1;
            handlerSawParams = i;
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );
    const plan: Plan = {
      goal: 'unresolved-ref',
      steps: [
        { id: 's1', action: 'courses.search_courses', params: {}, dependsOn: [] },
        // `$s1.id` is invalid — s1's result is a LIST, so `.id` resolves to
        // undefined. Must fail LOUDLY, never leak `$s1.id`/undefined through.
        {
          id: 's2',
          action: 'enrollments.enroll_learner_in_course',
          params: { contact_id: 'con_1', course_id: '$s1.id' },
          dependsOn: ['s1'],
        },
      ],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);

    expect(result.status).toBe('failed');
    expect(result.stepStates['s2']?.state).toBe('failed');
    expect(result.stepStates['s2']?.error?.code).toBe('REF_RESOLUTION');
    expect(result.stepStates['s2']?.error?.message).toContain('$s1.id');
    // the handler was never invoked — the literal/undefined never reached it
    expect(handlerCalls).toBe(0);
    expect(handlerSawParams).toBeUndefined();
    // no confirmation gate fired either (resolution throws before the gate)
    expect(eventsOf(input).some((e) => e.t === 'confirmation.required')).toBe(false);
  });
});

describe('executor — resilience', () => {
  it('TRANSIENT error retries once with the SAME key, then succeeds (one result)', async () => {
    const keys: string[] = [];
    let attempts = 0;
    const registry = buildRegistry(
      [
        [
          action('leads.update_lead_details', 'write', async (_i, ctx) => {
            keys.push(ctx.idempotencyKey);
            attempts += 1;
            if (attempts === 1) throw new ActionError('TRANSIENT', 'please retry');
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );
    const plan: Plan = {
      goal: 'transient',
      steps: [{ id: 's1', action: 'leads.update_lead_details', params: { id: 'l1' }, dependsOn: [] }],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);
    expect(result.status).toBe('done');
    expect(attempts).toBe(2);
    expect(result.metrics.retries).toBe(1);
    expect(keys).toEqual(['1:0:s1:0', '1:0:s1:0']); // same key both attempts
    const finished = eventsOf(input).filter((e) => e.t === 'step.finished');
    expect(finished).toHaveLength(1);
  });

  it('forEach with a per-item $item.when invokes the handler only for qualifying items', async () => {
    const createdFor: unknown[] = [];
    const registry = buildRegistry(
      [
        [
          action('leads.search_leads', 'read', async () => ({
            items: [
              { id: 'l1', score: 60 },
              { id: 'l2', score: 40 },
              { id: 'l3', score: 70 },
            ],
            total: 3,
          })),
          action('tasks.create_task', 'write', async (i) => {
            createdFor.push(i['lead_id']);
            return { ok: true };
          }),
        ],
      ],
      coreOps,
    );
    const plan: Plan = {
      goal: 'per-item-when',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
        {
          id: 's2',
          action: 'tasks.create_task',
          params: { lead_id: '$item.id' },
          forEach: '$s1.items',
          when: { ref: '$item.score', op: 'gt', value: 50 },
          dependsOn: ['s1'],
        },
      ],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);
    expect(result.status).toBe('done');
    // only l1 (60) and l3 (70) qualify; l2 (40) is filtered out
    expect(createdFor).toEqual(['l1', 'l3']);
    const started = eventsOf(input).find((e) => e.t === 'step.started' && e.stepId === 's2');
    expect(started && started.t === 'step.started' && started.itemCount).toBe(2);
  });

  it('identical failure ×4 halts the turn (status halted, halted stuck)', async () => {
    const registry = buildRegistry(
      [[action('reports.flaky', 'read', async () => {
        throw new ActionError('CONFLICT', 'always conflicts');
      })]],
      coreOps,
    );
    const plan: Plan = {
      goal: 'stuck',
      steps: [
        { id: 's1', action: 'reports.flaky', params: {}, dependsOn: [] },
        { id: 's2', action: 'reports.flaky', params: {}, dependsOn: [] },
        { id: 's3', action: 'reports.flaky', params: {}, dependsOn: [] },
        { id: 's4', action: 'reports.flaky', params: {}, dependsOn: [] },
      ],
    };
    const input = baseInput(plan, registry);
    const result = await execute(input);
    expect(result.status).toBe('halted');
    expect(result.halted).toBe('stuck');
  });
});

describe('executor — cross-turn ref drift (Review Focus 4)', () => {
  const PROFILE = 'test-executor-drift';

  function cleanup(): void {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = crmDbPath(PROFILE) + suffix;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  }

  it('resolves a 200-id handle with 30 missing to "170 of 200" and re-confirms the gated step', async () => {
    cleanup();
    const crm = openCrm(PROFILE);
    try {
      // CRM: 170 of the 200 referenced leads still exist.
      crm.tx((db) => {
        for (let i = 1; i <= 170; i += 1) db.run('INSERT INTO leads (id) VALUES (?)', [`lead_${i}`]);
        return null;
      });

      // The cross-turn handle (minted in "turn 3, step s1") — ref r_t3_s1.
      refs.put({
        action: 'leads.search_leads',
        turnId: '3',
        stepId: 's1',
        entityType: 'leads',
        total: 200,
        idList: Array.from({ length: 200 }, (_, i) => `lead_${i + 1}`),
        sample: Array.from({ length: 20 }, (_, i) => ({ id: `lead_${i + 1}`, name: `Lead ${i + 1}` })),
      });

      let received: unknown;
      const registry = buildRegistry(
        [[action('leads.bulk_update', 'write', async (i) => {
          received = i;
          return { ok: true };
        })]],
        coreOps,
      );

      const plan: Plan = {
        goal: 'drift',
        steps: [
          {
            id: 'sd',
            action: 'leads.bulk_update',
            params: { lead_ids: '$r_t3_s1' },
            dependsOn: [],
          },
        ],
      };

      const input = baseInput(plan, registry, { crm, turnId: '4' });
      const result = await execute(input);

      expect(result.status).toBe('done');
      const req = eventsOf(input).find((e) => e.t === 'confirmation.required');
      expect(req).toBeDefined();
      if (req && req.t === 'confirmation.required') {
        expect(req.scope.affectedCount).toBe(170);
        expect(req.scope.description).toContain('170 of 200');
      }
      const finished = eventsOf(input).find((e) => e.t === 'step.finished');
      expect(finished && finished.t === 'step.finished' && finished.summary).toContain('170 of 200');
      // handler saw only surviving ids
      expect((received as { lead_ids: string[] }).lead_ids).toHaveLength(170);
    } finally {
      closeRegistered(PROFILE);
      cleanup();
    }
  });

  /** Set up a CRM with `present` leads, a cross-turn handle of `total` ids
   * (ref r_t3_s1), and run a single plain-write step referencing it. */
  async function runDriftCase(
    profile: string,
    present: number,
    total: number,
  ): Promise<{ result: Awaited<ReturnType<typeof execute>>; events: Event[] }> {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = crmDbPath(profile) + suffix;
      if (existsSync(p)) rmSync(p, { force: true });
    }
    const crm = openCrm(profile);
    try {
      crm.tx((db) => {
        for (let i = 1; i <= present; i += 1) db.run('INSERT INTO leads (id) VALUES (?)', [`lead_${i}`]);
        return null;
      });
      refs.put({
        action: 'leads.search_leads',
        turnId: '3',
        stepId: 's1',
        entityType: 'leads',
        total,
        idList: Array.from({ length: total }, (_, i) => `lead_${i + 1}`),
        sample: [],
      });
      const registry = buildRegistry(
        [[action('leads.bulk_update', 'write', async () => ({ ok: true }))]],
        coreOps,
      );
      const plan: Plan = {
        goal: 'drift-branch',
        steps: [{ id: 'sd', action: 'leads.bulk_update', params: { lead_ids: '$r_t3_s1' }, dependsOn: [] }],
      };
      const input = baseInput(plan, registry, { crm, turnId: '4' });
      const result = await execute(input);
      return { result, events: eventsOf(input) };
    } finally {
      closeRegistered(profile);
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const p = crmDbPath(profile) + suffix;
        if (existsSync(p)) rmSync(p, { force: true });
      }
    }
  }

  it('FORCES a gate on >25% drift even when survivors ≤50 and risk is plain write', async () => {
    // total 60, 20 missing (33% > 25%), survivors 40 (≤50) → ONLY the drift
    // branch can gate this (not affectedCount, not risk class).
    const { result, events } = await runDriftCase('test-exec-drift-force', 40, 60);
    expect(result.status).toBe('done');
    const req = events.find((e) => e.t === 'confirmation.required');
    expect(req).toBeDefined();
    if (req && req.t === 'confirmation.required') {
      expect(req.scope.affectedCount).toBe(40);
      expect(req.scope.description).toContain('40 of 60');
    }
  });

  it('does NOT gate when drift ≤25% and survivors ≤50 (control)', async () => {
    // total 60, 10 missing (16.7% ≤ 25%), survivors 50 (not >50) → no gate.
    const { result, events } = await runDriftCase('test-exec-drift-control', 50, 60);
    expect(result.status).toBe('done');
    expect(events.some((e) => e.t === 'confirmation.required')).toBe(false);
  });
});

describe('executor — foldExecutor resume', () => {
  it('reconstructs plan, planRev, completed results, frontier, and pending confirmId', () => {
    const plan: Plan = {
      goal: 'resume',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
        { id: 's2', action: 'leads.delete_lead', params: {}, dependsOn: ['s1'] },
        { id: 's3', action: 'tasks.create_task', params: {}, dependsOn: ['s2'] },
      ],
    };
    const events: Event[] = [
      {
        t: 'plan.ready',
        turnId: '1',
        outcome: { kind: 'plan', plan },
        planRev: 1,
        planHash: 'h',
        llm: { model: 'm', tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, latencyMs: 0, attempt: 1 },
      },
      { t: 'step.started', turnId: '1', stepId: 's1', action: 'leads.search_leads' },
      {
        t: 'step.finished',
        turnId: '1',
        stepId: 's1',
        summary: 'found 3',
        inlineResult: { items: [{ id: 'l1' }], total: 1 },
        ms: 5,
      },
      {
        t: 'confirmation.required',
        turnId: '1',
        confirmId: 'cf_pending',
        planRev: 1,
        planHash: 'h',
        stepId: 's2',
        scope: { actions: ['leads.delete_lead'], affectedCount: 1, targetSample: ['l1'], description: 'x' },
      },
    ];

    const state = foldExecutor(events);
    expect(state.plan?.goal).toBe('resume');
    expect(state.planRev).toBe(1);
    expect(state.completed['s1']).toMatchObject({ total: 1 });
    expect(state.pendingConfirmation).toEqual({ confirmId: 'cf_pending', stepId: 's2' });
    // s2's deps (s1) are complete → it is the frontier (paused awaiting confirm)
    expect(state.frontier).toContain('s2');
    expect(state.frontier).not.toContain('s3');
  });

  it('a resolved confirmation leaves no pending gate', () => {
    const plan: Plan = {
      goal: 'resolved',
      steps: [{ id: 's1', action: 'leads.delete_lead', params: {}, dependsOn: [] }],
    };
    const events: Event[] = [
      {
        t: 'plan.ready',
        turnId: '1',
        outcome: { kind: 'plan', plan },
        planRev: 2,
        planHash: 'h',
        llm: { model: 'm', tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, latencyMs: 0, attempt: 1 },
      },
      {
        t: 'confirmation.required',
        turnId: '1',
        confirmId: 'cf_1',
        planRev: 2,
        planHash: 'h',
        stepId: 's1',
        scope: { actions: ['leads.delete_lead'], affectedCount: 1, targetSample: [], description: 'x' },
      },
      { t: 'confirmation.resolved', turnId: '1', confirmId: 'cf_1', approved: true },
    ];
    const state = foldExecutor(events);
    expect(state.pendingConfirmation).toBeUndefined();
    expect(state.planRev).toBe(2);
  });
});
