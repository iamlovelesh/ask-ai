import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { execute, type ConfirmBroker, type ExecuteInput } from '../src/agent/executor';
import { createRefStore, type RefStore } from '../src/agent/refs';
import { validate, parseRefGrammar } from '../src/agent/validator';
import { buildRegistry, type Registry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef, ActionContext, Risk } from '../src/catalog/types';
import type { Crm, StoreTx, Row } from '../src/store/db';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import type { Event, Plan, PlanOutcome } from '../src/events/types';

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;

function action(slug: string, risk: Risk, handler: Handler, outputSchema: z.ZodTypeAny = z.any()): ActionDef {
  return {
    id: slug,
    slug,
    module: slug.split('.')[0] as string,
    name: slug,
    description: slug,
    risk,
    entities: [slug.split('.')[0] as string],
    inputSchema: z.any(),
    outputSchema,
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: handler as ActionDef['handler'],
  };
}

/** A StoreTx that answers id-IN queries from an in-memory row map: `SELECT *`
 * returns full rows, `SELECT id` returns presence rows. Params are the ids. */
function rowStoreTx(rowsById: Map<string, Row>): StoreTx {
  return {
    all: (sql: string, params?: unknown[]) => {
      const ids = (params ?? []).map((p) => String(p));
      if (/select\s+\*/i.test(sql)) return ids.map((id) => rowsById.get(id)).filter((r): r is Row => r !== undefined);
      return ids.filter((id) => rowsById.has(id)).map((id) => ({ id }));
    },
    get: () => undefined,
    run: () => ({ changes: 0 }),
  };
}

let sessions: SessionsDb;
let refs: RefStore;

beforeEach(() => {
  sessions = openSessions(':memory:');
  refs = createRefStore(sessions, 'sess_e1e5');
});
afterEach(() => sessions.close());

const approveAll: ConfirmBroker = { request: async () => true };
const denyAll: ConfirmBroker = { request: async () => false };

function run(plan: Plan, registry: Registry, crm: Crm, overrides: Partial<ExecuteInput> = {}) {
  const events: Event[] = [];
  const input: ExecuteInput = {
    plan,
    planHash: 'h',
    planRev: 0,
    stepOrder: plan.steps.map((s) => s.id),
    turnId: '1',
    sessionId: 'sess_e1e5',
    registry,
    crm,
    refs,
    handles: [],
    onEvent: (e) => events.push(e),
    confirm: approveAll,
    retryDelayMs: 0,
    ...overrides,
  };
  return { input, events, result: execute(input) };
}

function step(id: string, actionSlug: string, params: Record<string, unknown>, extra: Partial<Plan['steps'][number]> = {}): Plan['steps'][number] {
  return { id, action: actionSlug, params, dependsOn: [], ...extra };
}

const listSchema = z.union([
  z.object({ items: z.array(z.object({ id: z.string(), score: z.number() })), total: z.number() }),
  z.object({ __spill: z.literal(true), total: z.number(), sample: z.array(z.object({ id: z.string(), score: z.number() })) }),
]);

// --- E5: index ref grammar --------------------------------------------------

describe('E5 — index ref grammar', () => {
  it('parses $s1.items[0].id and $r_t2_s1.items[2] but not $s1.items[-1]', () => {
    expect(parseRefGrammar('$s1.items[0].id')).toEqual({ form: 'step', stepId: 's1', path: '.items[0].id' });
    expect(parseRefGrammar('$r_t2_s1.items[2]')).toEqual({ form: 'crossTurn', handleId: 'r_t2_s1', path: '.items[2]' });
    expect(parseRefGrammar('$s1.items[-1].id')).toBeNull();
  });

  it('validator accepts a [0] index ref against a list output, flags nothing', () => {
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }), listSchema), action('leads.get', 'read', async () => ({}))]],
      coreOps,
    );
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'g',
        steps: [
          step('s1', 'leads.search_leads', {}),
          step('s2', 'leads.get', { id: '$s1.items[0].id' }, { dependsOn: ['s1'] }),
        ],
      },
    };
    const verdict = validate(outcome, new Set(), [], registry);
    expect(verdict.ok).toBe(true);
  });

  it('validator rejects $s1.items[-1] as REF_GRAMMAR', () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }), listSchema), action('leads.get', 'read', async () => ({}))]], coreOps);
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: { goal: 'g', steps: [step('s1', 'leads.search_leads', {}), step('s2', 'leads.get', { id: '$s1.items[-1].id' }, { dependsOn: ['s1'] })] },
    };
    const verdict = validate(outcome, new Set(), [], registry);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.some((e) => e.code === 'REF_GRAMMAR')).toBe(true);
  });

  it('executor resolves [0] to the first element and errors cleanly out-of-range', async () => {
    const seen: unknown[] = [];
    const registry = buildRegistry(
      [[
        action('leads.search_leads', 'read', async () => ({ items: [{ id: 'lead_7' }, { id: 'lead_8' }, { id: 'lead_9' }], total: 3 })),
        action('leads.get', 'read', async (i) => { seen.push(i['id']); return { ok: true }; }),
      ]],
      coreOps,
    );
    const crm: Crm = { tx: (fn) => fn(rowStoreTx(new Map())), close: () => {} };

    const plan: Plan = { goal: 'g', steps: [step('s1', 'leads.search_leads', {}), step('s2', 'leads.get', { id: '$s1.items[0].id' }, { dependsOn: ['s1'] })] };
    const { result } = run(plan, registry, crm);
    const r = await result;
    expect(r.stepStates['s2']?.state).toBe('done');
    expect(seen).toEqual(['lead_7']);

    // out-of-range [99] → clean REF_RESOLUTION failure, no silent pass-through
    const plan2: Plan = { goal: 'g', steps: [step('s1', 'leads.search_leads', {}), step('s2', 'leads.get', { id: '$s1.items[99].id' }, { dependsOn: ['s1'] })] };
    const { result: result2 } = run(plan2, registry, crm);
    const r2 = await result2;
    expect(r2.stepStates['s2']?.state).toBe('failed');
    expect(r2.stepStates['s2']?.error?.code).toBe('REF_RESOLUTION');
  });

  it('resolves a cross-turn handle [2] from the stored sample', async () => {
    const handle = refs.put({
      action: 'leads.search_leads', turnId: '2', stepId: 's1', entityType: 'leads', total: 3,
      idList: [], sample: [{ id: 'lead_a' }, { id: 'lead_b' }, { id: 'lead_c' }],
    });
    const seen: unknown[] = [];
    const registry = buildRegistry([[action('leads.get', 'read', async (i) => { seen.push(i['id']); return { ok: true }; })]], coreOps);
    const crm: Crm = { tx: (fn) => fn(rowStoreTx(new Map())), close: () => {} };
    const plan: Plan = { goal: 'g', steps: [step('s2', 'leads.get', { id: `$${handle.ref}.items[2].id` })] };
    const { result } = run(plan, registry, crm, { handles: [handle] });
    const r = await result;
    expect(r.stepStates['s2']?.state).toBe('done');
    expect(seen).toEqual(['lead_c']);
  });
});

// --- E1: full-set bulk semantics -------------------------------------------

describe('E1 — full-set bulk semantics over a spill', () => {
  function spilledSearch(total: number, withFullIds: boolean): ActionDef {
    const allIds = Array.from({ length: total }, (_, i) => `lead_${i + 1}`);
    const sample = allIds.slice(0, 20).map((id) => ({ id, score: 99 }));
    return action('leads.search_leads', 'read', async () => {
      const out: Record<string, unknown> = { __spill: true, total, sample };
      if (withFullIds) out['idList'] = allIds;
      return out;
    });
  }

  function crmWith(total: number): Crm {
    const rowsById = new Map<string, Row>();
    for (let i = 1; i <= total; i += 1) rowsById.set(`lead_${i}`, { id: `lead_${i}`, score: 99 });
    return { tx: (fn) => fn(rowStoreTx(rowsById)), close: () => {} };
  }

  it('core.filter over a spilled 165-row result processes all 165 (hydrated)', async () => {
    const registry = buildRegistry([[spilledSearch(165, true)]], coreOps);
    const plan: Plan = {
      goal: 'g',
      steps: [
        step('s1', 'leads.search_leads', {}),
        step('s2', 'core.filter', { in: '$s1.items', field: 'score', op: 'gt', value: 0 }, { dependsOn: ['s1'] }),
      ],
    };
    const { result } = run(plan, registry, crmWith(165));
    const r = await result;
    expect(r.stepStates['s2']?.state).toBe('done');
    const out = r.stepStates['s2']?.result as { items: unknown[] };
    expect(out.items.length).toBe(165);
  });

  it('forEach gate shows the TRUE full-set count (165), not the 20-row sample', async () => {
    const registry = buildRegistry(
      [[spilledSearch(165, true), action('leads.assign_lead_owner', 'write', async () => ({ ok: true }))]],
      coreOps,
    );
    const plan: Plan = {
      goal: 'g',
      steps: [
        step('s1', 'leads.search_leads', {}),
        step('s2', 'leads.assign_lead_owner', { id: '$item.id', owner_id: 'user_6' }, { dependsOn: ['s1'], forEach: '$s1.items' }),
      ],
    };
    const { events, result } = run(plan, registry, crmWith(165), { confirm: denyAll });
    await result;
    const conf = events.find((e) => e.t === 'confirmation.required') as Extract<Event, { t: 'confirmation.required' }>;
    expect(conf).toBeDefined();
    expect(conf.scope.affectedCount).toBe(165);
  });

  it('impossible hydration (sample-only spill) fails TRUNCATED_INPUT with no partial execution', async () => {
    const assigned: unknown[] = [];
    const registry = buildRegistry(
      [[spilledSearch(165, false), action('leads.assign_lead_owner', 'write', async (i) => { assigned.push(i); return { ok: true }; })]],
      coreOps,
    );
    const plan: Plan = {
      goal: 'g',
      steps: [
        step('s1', 'leads.search_leads', {}),
        step('s2', 'leads.assign_lead_owner', { id: '$item.id', owner_id: 'user_6' }, { dependsOn: ['s1'], forEach: '$s1.items' }),
      ],
    };
    const { result } = run(plan, registry, crmWith(165));
    const r = await result;
    expect(r.stepStates['s2']?.state).toBe('failed');
    expect(r.stepStates['s2']?.error?.code).toBe('TRUNCATED_INPUT');
    expect(assigned).toHaveLength(0);
  });
});
