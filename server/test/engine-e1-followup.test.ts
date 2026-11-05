/**
 * Engine-wave E1 follow-up (task-hydration-report): the executor-side
 * full-set hydration (`RefStore.hydrate`, `TRUNCATED_INPUT`) landed in
 * `aa10c90`, but the standard SQL search/list handlers never populated the
 * spill's `idList`, so a spilled bulk op honestly FAILED instead of
 * hydrating all N. This file proves the follow-up: `toListOrSpill`'s new
 * `idCapture` option (`catalog/list-output.ts`) re-runs a handler's OWN
 * WHERE clause as `SELECT id FROM <table> WHERE <whereSql>` (no LIMIT) to
 * populate the full idList, and every standard handler wired to it now
 * carries the complete matching set through a spill.
 *
 * Two layers:
 *  1. A REAL handler (`leads.search_leads`) + REAL sqlite DB + REAL executor
 *     (forEach over the spilled result) — the end-to-end proof for one
 *     representative module.
 *  2. A catalog-wide SWEEP (below, `engine-e1-sweep.test.ts`-equivalent
 *     section) — the genericity proof: iterate the registry, synthesize a
 *     valid input per action, and assert every eligible list/search action's
 *     spill carries a complete idList.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { registry } from '../src/catalog/registry';
import type { ActionContext } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type Crm, type StoreTx } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';
import { execute, type ConfirmBroker, type ExecuteInput } from '../src/agent/executor';
import { createRefStore, type RefStore } from '../src/agent/refs';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import type { Event, Plan } from '../src/events/types';

const PROFILE = 'test-e1-followup';

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

function ctx(db: StoreTx, key = `k-${Math.random()}`): ActionContext {
  return { db, clock: new VirtualClock(), idempotencyKey: key, format: 'concise' };
}

function def(slug: string) {
  const d = registry.get(slug);
  if (!d) throw new Error(`action '${slug}' not registered`);
  return d;
}

let crm: Crm;

beforeEach(() => {
  cleanup();
  crm = openCrm(PROFILE);
});

afterAll(() => {
  closeRegistered(PROFILE);
  cleanup();
});

describe('leads.search_leads — spill carries a complete idList (engine-wave E1 follow-up)', () => {
  it('a spilled search_leads result has idList.length === total', async () => {
    await crm.tx((db) => {
      for (let i = 0; i < 60; i++) {
        def('leads.create_lead').handler(
          { name: `Spill Lead ${i}`, status: 'new', source: 'e1_followup_marker' },
          ctx(db, `e1fu-${i}`),
        );
      }
      return undefined;
    });

    const result = await crm.tx((db) =>
      def('leads.search_leads').handler({ source: 'e1_followup_marker' }, ctx(db)),
    );
    expect(result).toMatchObject({ __spill: true, total: 60 });
    const spilled = result as { __spill: true; total: number; idList?: string[] };
    expect(spilled.idList).toBeDefined();
    expect(spilled.idList).toHaveLength(60);

    const createdIds = crm.tx((db) =>
      db.all(`SELECT id FROM leads WHERE source = ?`, ['e1_followup_marker']).map((r) => String(r['id'])),
    );
    expect(new Set(spilled.idList)).toEqual(new Set(createdIds));
  });

  it('stays inline (no idList needed) at or under the 50-row cap', async () => {
    await crm.tx((db) => {
      for (let i = 0; i < 5; i++) {
        def('leads.create_lead').handler(
          { name: `Small Lead ${i}`, source: 'e1_followup_small' },
          ctx(db, `e1fu-small-${i}`),
        );
      }
      return undefined;
    });
    const result = await crm.tx((db) =>
      def('leads.search_leads').handler({ source: 'e1_followup_small' }, ctx(db)),
    );
    expect(result).toMatchObject({ total: 5 });
    expect('__spill' in (result as object)).toBe(false);
  });
});

describe('executor end-to-end: forEach over a spilled leads.search_leads result processes all N (real catalog, real DB)', () => {
  let sessions: SessionsDb;
  let refs: RefStore;
  const approveAll: ConfirmBroker = { request: async () => true };

  beforeEach(() => {
    sessions = openSessions(':memory:');
    refs = createRefStore(sessions, 'sess_e1fu');
  });

  it('assigns owner_id to ALL 60 matching leads, not just the 20-row sample', async () => {
    await crm.tx((db) => {
      for (let i = 0; i < 60; i++) {
        def('leads.create_lead').handler(
          { name: `Bulk Assign ${i}`, source: 'e1_followup_bulk' },
          ctx(db, `e1fu-bulk-${i}`),
        );
      }
      return undefined;
    });

    const step = (
      id: string,
      action: string,
      params: Record<string, unknown>,
      extra: Partial<Plan['steps'][number]> = {},
    ): Plan['steps'][number] => ({ id, action, params, dependsOn: [], ...extra });

    const plan: Plan = {
      goal: 'assign all source=e1_followup_bulk leads to user_6',
      steps: [
        step('s1', 'leads.search_leads', { source: 'e1_followup_bulk' }),
        step(
          's2',
          'leads.assign_lead_owner',
          { id: '$item.id', owner_id: 'user_6' },
          { dependsOn: ['s1'], forEach: '$s1.items' },
        ),
      ],
    };

    const events: Event[] = [];
    const input: ExecuteInput = {
      plan,
      planHash: 'h',
      planRev: 0,
      stepOrder: plan.steps.map((s) => s.id),
      turnId: '1',
      sessionId: 'sess_e1fu',
      registry,
      crm,
      refs,
      handles: [],
      onEvent: (e) => events.push(e),
      confirm: approveAll,
      retryDelayMs: 0,
    };
    const r = await execute(input);

    expect(r.stepStates['s2']?.state).toBe('done');
    expect(r.stepStates['s2']?.error).toBeUndefined();

    const assignedCount = crm.tx((db) =>
      db.get(`SELECT COUNT(*) AS n FROM leads WHERE source = ? AND owner_id = ?`, [
        'e1_followup_bulk',
        'user_6',
      ]),
    );
    expect(assignedCount?.['n']).toBe(60);

    const conf = events.find((e) => e.t === 'confirmation.required') as
      | Extract<Event, { t: 'confirmation.required' }>
      | undefined;
    expect(conf?.scope.affectedCount).toBe(60);
  });
});
