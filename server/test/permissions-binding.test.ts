import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from '../src/catalog/registry';
import { buildTurnTools, StuckTracker, type LoopExits } from '../src/loop/tools';
import { buildCatalogSummary } from '../src/baseline/catalog-summary';
import { VirtualClock } from '../src/store/clock';
import { openSessions } from '../src/store/sessions-db';
import { openScheduledTasks } from '../src/agent/scheduled-tasks';
import { randomUUID } from 'node:crypto';
import type { Crm } from '../src/store/db';
import type { ActionDef, Risk } from '../src/catalog/types';
import type { RefStore } from '../src/agent/refs';
import type { Principal } from '../src/agent/permissions';

function action(slug: string, risk: Risk): ActionDef {
  return {
    id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug,
    risk, entities: [slug.split('.')[0] as string],
    inputSchema: z.object({}).catchall(z.unknown()), outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: (async () => ({})) as ActionDef['handler'],
  };
}

const readAction = action('leads.search_leads', 'read');
const writeAction = action('leads.update_lead', 'write');
const destructiveAction = action('leads.delete_lead', 'destructive');
const registry = buildRegistry([[readAction, writeAction, destructiveAction]], []);

const viewer: Principal = { userId: 'user_9', role: 'viewer' };
const member: Principal = { userId: 'user_9', role: 'member' };

function toolsFor(principal: Principal): ReturnType<typeof buildTurnTools> {
  const exits: LoopExits = {
    denied: false, writesLanded: 0, writeActions: new Map(), writeEntities: new Set(), toolOutputs: [], appliedFilters: [], stop: () => {},
  };
  return buildTurnTools({
    registry,
    cards: [
      { slug: 'leads.search_leads', text: '', score: 1 },
      { slug: 'leads.update_lead', text: '', score: 1 },
      { slug: 'leads.delete_lead', text: '', score: 1 },
    ],
    crm: { tx: (fn) => fn({} as never), close: () => {} } as Crm,
    refs: {} as RefStore,
    confirm: { request: async () => true },
    clock: new VirtualClock(0),
    turnId: 't1',
    emit: () => {},
    sessionCtx: { usedActionSlugs: [], activeModules: [] },
    exits,
    stuck: new StuckTracker(),
    markTtfur: () => {},
    counters: { stepsOk: 0, stepsFailed: 0, step: 0, gateWaitMs: 0, virtualReads: 0 },
    planHash: 'h',
    actingUserId: principal.userId,
    knownIds: new Set<string>(),
    principal,
    sessionId: 'sess_x',
    scheduler: openScheduledTasks(openSessions(`/tmp/permsched-${randomUUID()}.db`)),
  });
}

function toolNamesFor(principal: Principal): string[] {
  return toolsFor(principal).map((t) => t.name);
}

const admin: Principal = { userId: 'user_1', role: 'admin' };

/** Invoke a meta-tool (apply_to_ref / batch) by name with raw args. */
async function invokeTool(principal: Principal, name: string, args: unknown): Promise<string> {
  const t = toolsFor(principal).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not bound`);
  return (await t.invoke({} as never, JSON.stringify(args))) as string;
}

describe('permission-pruned tool binding (#1)', () => {
  it('a viewer is bound ONLY the read tool, not write/destructive', () => {
    const names = toolNamesFor(viewer);
    expect(names).toContain('leads__search_leads');
    expect(names).not.toContain('leads__update_lead');
    expect(names).not.toContain('leads__delete_lead');
  });

  it('a member is bound read and write, but not destructive', () => {
    const names = toolNamesFor(member);
    expect(names).toContain('leads__search_leads');
    expect(names).toContain('leads__update_lead');
    expect(names).not.toContain('leads__delete_lead');
  });

  it('the schedule-follow-up tool is write-class: members get it, viewers do not (review CRITICAL)', () => {
    expect(toolNamesFor(member)).toContain('session__schedule_follow_up');
    expect(toolNamesFor(viewer)).not.toContain('session__schedule_follow_up');
  });

  it('the workflow__run tool is write-class: members get it, viewers do not', () => {
    expect(toolNamesFor(member)).toContain('workflow__run');
    expect(toolNamesFor(viewer)).not.toContain('workflow__run');
  });

  it('the workflow__schedule tool is write-class: members get it, viewers do not', () => {
    expect(toolNamesFor(member)).toContain('workflow__schedule');
    expect(toolNamesFor(viewer)).not.toContain('workflow__schedule');
  });

  // The bulk meta-tools (data__apply_to_ref / data__batch) are bound for
  // everyone, so they MUST re-check the principal against the action they
  // dispatch — otherwise they bypass per-tool pruning (review CRITICAL).
  it('data__apply_to_ref refuses a destructive action for a viewer and member', async () => {
    expect(await invokeTool(viewer, 'data__apply_to_ref', { ref: 'r_t1_s1', action: 'leads__delete_lead' })).toContain('PERMISSION');
    expect(await invokeTool(member, 'data__apply_to_ref', { ref: 'r_t1_s1', action: 'leads__delete_lead' })).toContain('PERMISSION');
  });

  it('data__apply_to_ref refuses a WRITE action for a viewer but not for a member', async () => {
    expect(await invokeTool(viewer, 'data__apply_to_ref', { ref: 'r_t1_s1', action: 'leads__update_lead' })).toContain('PERMISSION');
    // a member MAY write → it passes the permission gate (and fails later on the
    // missing ref, with a non-PERMISSION message).
    expect(await invokeTool(member, 'data__apply_to_ref', { ref: 'r_t1_s1', action: 'leads__update_lead' })).not.toContain('PERMISSION');
  });

  it('data__batch refuses a destructive action for a viewer/member but admin passes the gate', async () => {
    expect(await invokeTool(viewer, 'data__batch', { action: 'leads__delete_lead', records: [{ id: 'lead_1' }] })).toContain('PERMISSION');
    expect(await invokeTool(member, 'data__batch', { action: 'leads__delete_lead', records: [{ id: 'lead_1' }] })).toContain('PERMISSION');
    expect(await invokeTool(admin, 'data__batch', { action: 'leads__delete_lead', records: [{ id: 'lead_1' }] })).not.toContain('PERMISSION');
  });

  it('the model-facing catalog summary is pruned to the principal’s permissions', () => {
    const viewerSummary = buildCatalogSummary(registry, viewer);
    expect(viewerSummary).toContain('leads.search_leads');
    expect(viewerSummary).not.toContain('leads.update_lead');
    expect(viewerSummary).not.toContain('leads.delete_lead');

    const adminSummary = buildCatalogSummary(registry); // undefined principal = admin = everything
    expect(adminSummary).toContain('leads.update_lead');
    expect(adminSummary).toContain('leads.delete_lead');
  });
});
