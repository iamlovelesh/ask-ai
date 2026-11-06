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

function toolNamesFor(principal: Principal): string[] {
  const exits: LoopExits = {
    denied: false, writesLanded: 0, writeActions: new Map(), toolOutputs: [], appliedFilters: [], stop: () => {},
  };
  const tools = buildTurnTools({
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
  return tools.map((t) => t.name);
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
