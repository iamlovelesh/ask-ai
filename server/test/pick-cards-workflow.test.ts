import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from '../src/catalog/registry';
import type { ActionDef } from '../src/catalog/types';
import { pickCards } from '../src/loop/agent';

function act(slug: string): ActionDef {
  return {
    id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug,
    risk: 'read', entities: [slug.split('.')[0] as string],
    inputSchema: z.object({}).catchall(z.unknown()), outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: (async () => ({})) as ActionDef['handler'],
  };
}

// >24 actions so retrieval/binding is in play (small registries bind everything).
const filler = Array.from({ length: 30 }, (_, i) => act(`contacts.filler_${i}`));
const workflows = ['create_workflow', 'add_workflow_step', 'publish_workflow', 'list_workflows'].map((n) => act(`workflows.${n}`));
const triggers = ['create_event_trigger', 'bind_trigger_to_workflow', 'enable_trigger'].map((n) => act(`event_triggers.${n}`));
const registry = buildRegistry([[...filler, ...workflows, ...triggers]], []);
const emptyCtx = { usedActionSlugs: [], activeModules: [] };

describe('pickCards — automation authoring force-bind', () => {
  it('pins the whole workflows module when the request is about a workflow', () => {
    const slugs = pickCards('create a workflow that updates a deal', registry, emptyCtx).map((c) => c.slug);
    expect(slugs).toContain('workflows.create_workflow');
    expect(slugs).toContain('workflows.add_workflow_step');
    expect(slugs).toContain('workflows.publish_workflow');
  });

  it('pins event_triggers too on trigger/event intent', () => {
    const slugs = pickCards('create a trigger that fires when a lead is created', registry, emptyCtx).map((c) => c.slug);
    expect(slugs).toContain('event_triggers.create_event_trigger');
    expect(slugs).toContain('event_triggers.enable_trigger');
  });

  it('does NOT pin workflow actions for an unrelated request', () => {
    const slugs = pickCards('show me my newest contacts', registry, emptyCtx).map((c) => c.slug);
    expect(slugs).not.toContain('workflows.create_workflow');
  });
});
