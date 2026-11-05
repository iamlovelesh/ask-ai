import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { shouldGate, execute, type ConfirmBroker, type ExecuteInput } from '../src/agent/executor';
import { createRefStore, type RefStore } from '../src/agent/refs';
import { validate } from '../src/agent/validator';
import { buildRegistry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef, ActionContext, Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import type { Event, Plan, PlanOutcome } from '../src/events/types';

function action(slug: string, risk: Risk, handler: (i: Record<string, unknown>, c: ActionContext) => Promise<unknown>, name?: string): ActionDef {
  return {
    id: slug, slug, module: slug.split('.')[0] as string, name: name ?? slug, description: slug,
    risk, entities: [slug.split('.')[0] as string], inputSchema: z.any(), outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] }, handler: handler as ActionDef['handler'],
  };
}

const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };

let sessions: SessionsDb;
let refs: RefStore;
beforeEach(() => { sessions = openSessions(':memory:'); refs = createRefStore(sessions, 's'); });
afterEach(() => sessions.close());

const denyAll: ConfirmBroker = { request: async () => false };

function runPlan(plan: Plan, registry: ReturnType<typeof buildRegistry>, confirm: ConfirmBroker) {
  const events: Event[] = [];
  const input: ExecuteInput = {
    plan, planHash: 'h', planRev: 0, stepOrder: plan.steps.map((s) => s.id), turnId: '1',
    sessionId: 's', registry, crm: fakeCrm, refs, handles: [], onEvent: (e) => events.push(e),
    confirm, retryDelayMs: 0,
  };
  return { events, result: execute(input) };
}

describe('E6(a) — gate rule for small bulk writes', () => {
  it('shouldGate: plain write touching >3 records gates; 1-3 do not; reads never', () => {
    expect(shouldGate('write', 1)).toBe(false);
    expect(shouldGate('write', 3)).toBe(false);
    expect(shouldGate('write', 4)).toBe(true);
    expect(shouldGate('read', 3)).toBe(false);
    expect(shouldGate('destructive', 1)).toBe(true);
  });

  it('a forEach write over 5 items gates (RC5 5-ticket close)', async () => {
    const registry = buildRegistry(
      [[
        action('tickets.search', 'read', async () => ({ items: Array.from({ length: 5 }, (_, i) => ({ id: `t_${i}` })), total: 5 })),
        action('tickets.close', 'write', async () => ({ ok: true }), 'Close ticket'),
      ]],
      coreOps,
    );
    const plan: Plan = {
      goal: 'g',
      steps: [
        { id: 's1', action: 'tickets.search', params: {}, dependsOn: [] },
        { id: 's2', action: 'tickets.close', params: { id: '$item.id' }, dependsOn: ['s1'], forEach: '$s1.items' },
      ],
    };
    const { events, result } = runPlan(plan, registry, denyAll);
    const r = await result;
    expect(r.status).toBe('cancelled'); // denied
    expect(events.some((e) => e.t === 'confirmation.required')).toBe(true);
  });
});

describe('E6 (composer handoff) — human-readable gate description', () => {
  it('uses the action display name, true count, and record names (no slug)', async () => {
    const registry = buildRegistry(
      [[
        action('sms.send', 'write', async () => ({ ok: true }), 'Send SMS'),
      ]],
      coreOps,
    );
    const plan: Plan = {
      goal: 'g',
      steps: [
        { id: 's1', action: 'sms.send', params: { contact_ids: ['Jane Cooper', 'R. Patel', 'Sam Lee', 'Bo Kim'] }, dependsOn: [] },
      ],
    };
    const { events, result } = runPlan(plan, registry, denyAll);
    await result;
    const req = events.find((e) => e.t === 'confirmation.required') as Extract<Event, { t: 'confirmation.required' }>;
    expect(req).toBeDefined();
    expect(req.scope.description).toContain('Send SMS');
    expect(req.scope.description).toContain('Jane Cooper');
    expect(req.scope.description).toContain('and 1 more');
    expect(req.scope.description).not.toContain('sms.send'); // no raw slug
  });
});

describe('E6(c) — PLAN_MINIMALITY self-assignment backstop', () => {
  const assign = action('leads.assign_lead_owner', 'write', async () => ({ ok: true }));
  assign.inputSchema = z.strictObject({ id: z.string(), owner_id: z.string().optional() });
  const getLead = action('leads.get_lead', 'read', async () => ({ id: 'lead_2025', owner_id: 'user_3' }));
  getLead.inputSchema = z.strictObject({ id: z.string() });
  getLead.outputSchema = z.object({ id: z.string(), owner_id: z.string() });
  const registry = buildRegistry([[getLead, assign]], coreOps);

  it('flags assign_lead_owner(id:$s1.id, owner_id:$s1.owner_id) — writes the record onto itself', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'who owns lead_2025',
        steps: [
          { id: 's1', action: 'leads.get_lead', params: { id: 'lead_2025' }, dependsOn: [] },
          { id: 's2', action: 'leads.assign_lead_owner', params: { id: '$s1.id', owner_id: '$s1.owner_id' }, dependsOn: ['s1'] },
        ],
      },
    };
    const verdict = validate(outcome, new Set(), [], registry, { knownIds: new Set(), userText: 'who owns lead_2025' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.some((e) => e.code === 'PLAN_MINIMALITY')).toBe(true);
  });

  it('does NOT flag a write that supplies a new value (literal) or a second source', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'reassign lead_2025 to user_9',
        steps: [
          { id: 's1', action: 'leads.get_lead', params: { id: 'lead_2025' }, dependsOn: [] },
          { id: 's2', action: 'leads.assign_lead_owner', params: { id: '$s1.id', owner_id: 'user_9' }, dependsOn: ['s1'] },
        ],
      },
    };
    const verdict = validate(outcome, new Set(), [], registry, { knownIds: new Set(['user_9']), userText: 'reassign lead_2025 to user_9' });
    expect(verdict.ok).toBe(true);
  });

  it('does NOT flag a single-ref write (e.g. convert the fetched lead)', () => {
    const outcome: PlanOutcome = {
      kind: 'plan',
      plan: {
        goal: 'convert lead',
        steps: [
          { id: 's1', action: 'leads.get_lead', params: { id: 'lead_2025' }, dependsOn: [] },
          { id: 's2', action: 'leads.assign_lead_owner', params: { id: '$s1.id' }, dependsOn: ['s1'] },
        ],
      },
    };
    const verdict = validate(outcome, new Set(), [], registry, { knownIds: new Set(), userText: 'lead_2025' });
    if (!verdict.ok) expect(verdict.errors.some((e) => e.code === 'PLAN_MINIMALITY')).toBe(false);
  });
});
