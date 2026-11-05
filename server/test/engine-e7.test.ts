import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { execute, type ConfirmBroker, type ExecuteInput } from '../src/agent/executor';
import { createRefStore, type RefStore } from '../src/agent/refs';
import { buildRegistry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionDef, ActionContext, Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import type { Event, Plan } from '../src/events/types';

function action(slug: string, risk: Risk, handler: (i: Record<string, unknown>, c: ActionContext) => Promise<unknown>): ActionDef {
  return {
    id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug,
    risk, entities: [slug.split('.')[0] as string], inputSchema: z.any(), outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] }, handler: handler as ActionDef['handler'],
  };
}
const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };

let sessions: SessionsDb;
let refs: RefStore;
let nowMs = 0;
beforeEach(() => {
  sessions = openSessions(':memory:');
  refs = createRefStore(sessions, 's');
  nowMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
});
afterEach(() => { sessions.close(); vi.restoreAllMocks(); });

const TEN_MIN = 10 * 60 * 1000;

function runGated(approve: boolean) {
  let ran = 0;
  const registry = buildRegistry([[action('leads.delete_lead', 'destructive', async () => { ran += 1; return { ok: true }; })]], coreOps);
  // Broker simulates a slow human: 10 minutes of wall-clock pass before the decision.
  const confirm: ConfirmBroker = {
    request: async () => { nowMs += TEN_MIN; return approve; },
  };
  const events: Event[] = [];
  const plan: Plan = { goal: 'g', steps: [{ id: 's1', action: 'leads.delete_lead', params: {}, dependsOn: [] }] };
  const input: ExecuteInput = {
    plan, planHash: 'h', planRev: 0, stepOrder: ['s1'], turnId: '1', sessionId: 's',
    registry, crm: fakeCrm, refs, handles: [], onEvent: (e) => events.push(e),
    confirm, retryDelayMs: 0,
    deadlineAtMs: 100, // startedAt 0 + 100ms budget — far below the 10-min wait
  };
  return { input, events, ran: () => ran, result: execute(input) };
}

describe('E7 — confirmation wait does not burn the turn deadline (RC8)', () => {
  it('10-min pending confirm then APPROVE → done, write ran, no deadline trip', async () => {
    const h = runGated(true);
    const r = await h.result;
    expect(r.status).toBe('done');
    expect(h.ran()).toBe(1);
    expect(r.metrics.gateWaitMs).toBe(TEN_MIN);
  });

  it('10-min pending confirm then REJECT → cancelled (not failed), write never ran', async () => {
    const h = runGated(false);
    const r = await h.result;
    expect(r.status).toBe('cancelled');
    expect(h.ran()).toBe(0);
    expect(r.metrics.gateWaitMs).toBe(TEN_MIN);
  });

  it('a genuine over-deadline (active compute, no gate) still times out → failed', async () => {
    // No gate waiting; the handler itself advances the clock past the deadline.
    const registry = buildRegistry([[
      action('leads.search_leads', 'read', async () => { nowMs += 500; return { items: [], total: 0 }; }),
      action('leads.get', 'read', async () => ({})),
    ]], coreOps);
    const events: Event[] = [];
    const plan: Plan = { goal: 'g', steps: [
      { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
      { id: 's2', action: 'leads.get', params: {}, dependsOn: ['s1'] },
    ] };
    const input: ExecuteInput = {
      plan, planHash: 'h', planRev: 0, stepOrder: ['s1', 's2'], turnId: '1', sessionId: 's',
      registry, crm: fakeCrm, refs, handles: [], onEvent: (e) => events.push(e),
      confirm: { request: async () => true }, retryDelayMs: 0, deadlineAtMs: 100,
    };
    const r = await execute(input);
    expect(r.status).toBe('failed'); // real active-time overrun still trips
  });
});
