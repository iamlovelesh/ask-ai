import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from '../src/store/clock';
import { buildTurnTools, StuckTracker, type BuildTurnToolsInput, type LoopExits } from '../src/loop/tools';
import type { ActionContext, ActionDef } from '../src/catalog/types';

// A fake "create saved report" action whose handler mints a fresh struct id on
// every call — so a duplicate create is directly observable as struct_2.
function makeCreateAction(): { action: ActionDef; calls: () => number } {
  let n = 0;
  const action: ActionDef = {
    id: 'reports.create_saved_report',
    slug: 'reports.create_saved_report',
    module: 'reports',
    name: 'Create saved report',
    description: 'Create a saved report',
    risk: 'write',
    entities: ['structure'],
    inputSchema: z.object({ name: z.string(), type: z.string() }),
    outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: (async (input: Record<string, unknown>, _ctx: ActionContext) => {
      n += 1;
      return { id: `struct_${n}`, name: input['name'], type: input['type'], status: 'active' };
    }) as ActionDef['handler'],
  };
  return { action, calls: () => n };
}

function freshExits(): LoopExits {
  return { denied: false, writesLanded: 0, writeActions: new Map(), writeEntities: new Set(), toolOutputs: [], appliedFilters: [], stop: () => {} };
}

// A contacts.create_contact action with an observable call counter.
function makeCreateContactAction(): { action: ActionDef; calls: () => number } {
  let n = 0;
  const action: ActionDef = {
    id: 'contacts.create_contact',
    slug: 'contacts.create_contact',
    module: 'contacts',
    name: 'Create contact',
    description: 'Create a contact',
    risk: 'write',
    entities: ['contacts'],
    inputSchema: z.object({ name: z.string(), email: z.string() }),
    outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: (async (input: Record<string, unknown>, _ctx: ActionContext) => {
      n += 1;
      return { id: `con_${n}`, name: input['name'], email: input['email'] };
    }) as ActionDef['handler'],
  };
  return { action, calls: () => n };
}

// A CRM whose `contacts` table already holds one row (email `taken@x.com`), so
// recordExistsInCrm can match a re-import by natural key.
function buildInputWithExistingContact(action: ActionDef, exits: LoopExits): BuildTurnToolsInput {
  const base = buildInput(action, exits);
  const existingEmail = 'taken@x.com';
  const db = {
    all: (sql: string) =>
      /PRAGMA table_info/i.test(sql) ? [{ name: 'id' }, { name: 'name' }, { name: 'email' }] : [],
    get: (sql: string, params: unknown[]) => {
      if (/SELECT \* FROM contacts WHERE lower\(email\)/i.test(sql)) {
        const v = String(params?.[0] ?? '').toLowerCase();
        return v === existingEmail ? { id: 'con_999', name: 'Already Here', email: existingEmail } : undefined;
      }
      return undefined;
    },
    run: () => ({ changes: 0 }),
  };
  const crm = { tx: (fn: (d: unknown) => unknown) => fn(db), close: () => {} } as unknown as BuildTurnToolsInput['crm'];
  return { ...base, crm };
}

function buildInput(action: ActionDef, exits: LoopExits): BuildTurnToolsInput {
  const registry = {
    get: (slug: string) => (slug === action.slug ? action : undefined),
    all: () => [action],
  } as unknown as BuildTurnToolsInput['registry'];
  const noopTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
  const crm = { tx: (fn: (db: unknown) => unknown) => fn(noopTx), close: () => {} } as unknown as BuildTurnToolsInput['crm'];
  return {
    registry,
    cards: [{ slug: action.slug } as BuildTurnToolsInput['cards'][number]],
    crm,
    refs: { put: () => ({ ref: 'r_1' }) } as unknown as BuildTurnToolsInput['refs'],
    confirm: { request: async () => true } as unknown as BuildTurnToolsInput['confirm'],
    clock: new VirtualClock(),
    turnId: 't_1',
    emit: () => {},
    sessionCtx: { usedActionSlugs: [], activeModules: [] },
    exits,
    stuck: new StuckTracker(),
    markTtfur: () => {},
    counters: { stepsOk: 0, stepsFailed: 0, step: 0, gateWaitMs: 0, virtualReads: 0 },
    planHash: 'h',
    actingUserId: 'user_1',
    knownIds: new Set<string>(),
  };
}

function findTool(tools: ReturnType<typeof buildTurnTools>, name: string): { invoke: (ctx: unknown, input: string) => Promise<unknown> } {
  const t = tools.find((x) => (x as { name?: string }).name === name) as never;
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}

// An update action with a NESTED `patch` object of optional strings — mirrors
// contacts.update_contact_details, where the model often sends null for the
// patch fields it is not setting.
function makeUpdateAction(): { action: ActionDef; lastPatch: () => Record<string, unknown> | undefined } {
  let seen: Record<string, unknown> | undefined;
  const action: ActionDef = {
    id: 'contacts.update_contact_details',
    slug: 'contacts.update_contact_details',
    module: 'contacts',
    name: 'Update contact details',
    description: 'Update a contact',
    risk: 'write',
    entities: ['contacts'],
    inputSchema: z.strictObject({
      id: z.string(),
      patch: z
        .strictObject({
          name: z.string().min(1).optional(),
          first_name: z.string().optional(),
          title: z.string().optional(),
        })
        .refine((p) => Object.keys(p).length > 0, { message: 'patch must not be empty' }),
    }),
    outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: (async (input: Record<string, unknown>) => {
      seen = input['patch'] as Record<string, unknown>;
      return { id: input['id'], ...(input['patch'] as object) };
    }) as ActionDef['handler'],
  };
  return { action, lastPatch: () => seen };
}

describe('web__search tool is config-gated', () => {
  it('is bound only when WEB_SEARCH_ENABLED is on and an OpenRouter key is present', () => {
    const { action } = makeCreateAction();
    const has = () => buildTurnTools(buildInput(action, freshExits())).some((t) => (t as { name?: string }).name === 'web__search');
    const prevFlag = process.env['WEB_SEARCH_ENABLED'];
    const prevKey = process.env['OPENROUTER_API_KEY'];
    try {
      process.env['OPENROUTER_API_KEY'] = 'sk-or-test';
      delete process.env['WEB_SEARCH_ENABLED'];
      expect(has()).toBe(false); // opt-in flag off → not bound even with a key
      process.env['WEB_SEARCH_ENABLED'] = '1';
      expect(has()).toBe(true);
    } finally {
      if (prevFlag === undefined) delete process.env['WEB_SEARCH_ENABLED'];
      else process.env['WEB_SEARCH_ENABLED'] = prevFlag;
      if (prevKey === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = prevKey;
    }
  });
});

describe('approval card template on the gate scope', () => {
  async function templateFor(slug: string, risk: 'write' | 'destructive'): Promise<string | undefined> {
    const action: ActionDef = {
      id: slug, slug, module: slug.split('.')[0]!, name: slug, description: 'x', risk, entities: ['contacts'],
      inputSchema: z.strictObject({ id: z.string() }), outputSchema: z.any(),
      searchCard: { synonyms: [], examplePhrasings: [] },
      handler: (async (input: Record<string, unknown>) => ({ id: input['id'] })) as ActionDef['handler'],
    };
    let captured: { template?: string } | undefined;
    const base = buildInput(action, freshExits());
    const confirm = { request: async (r: { scope: { template?: string } }) => { captured = r.scope; return true; } } as unknown as BuildTurnToolsInput['confirm'];
    const tools = buildTurnTools({ ...base, confirm, knownIds: new Set(['con_1']) });
    const tool = findTool(tools, slug.replace('.', '__'));
    await tool.invoke({}, JSON.stringify({ id: 'con_1' }));
    return captured?.template;
  }

  it('tags gates by action kind — update/delete/merge/send', async () => {
    expect(await templateFor('contacts.update_contact_details', 'write')).toBe('recordUpdate');
    expect(await templateFor('contacts.delete_contact', 'destructive')).toBe('recordDelete');
    expect(await templateFor('contacts.merge_duplicate_contacts', 'destructive')).toBe('merge');
    expect(await templateFor('messages.send_message', 'write')).toBe('email');
  });
});

describe('nested-null param scrub', () => {
  it('strips nulls INSIDE a patch object so the update validates (model sends null for unset fields)', async () => {
    const { action, lastPatch } = makeUpdateAction();
    const exits = freshExits();
    const tools = buildTurnTools({ ...buildInput(action, exits), knownIds: new Set(['con_1']) });
    const tool = findTool(tools, 'contacts__update_contact_details');
    // name/first_name sent as null (not setting them); only title is real.
    const obs = (await tool.invoke({}, JSON.stringify({ id: 'con_1', patch: { name: null, first_name: null, title: 'VP Sales' } }))) as string;
    expect(obs).not.toMatch(/VALIDATION ERROR|PARAM_SCHEMA/);
    expect(lastPatch()).toEqual({ title: 'VP Sales' }); // nulls dropped, real value kept
  });
});

describe('create idempotency (duplicate saved report guard)', () => {
  it('reuses the record on an identical create re-issued the same turn', async () => {
    const { action, calls } = makeCreateAction();
    const exits = freshExits();
    const tools = buildTurnTools(buildInput(action, exits));
    const tool = findTool(tools, 'reports__create_saved_report');
    const args = JSON.stringify({ name: 'Pipeline Summary', type: 'pipeline_summary' });

    const first = (await tool.invoke({}, args)) as string;
    const second = (await tool.invoke({}, args)) as string;

    // The handler ran exactly once — the duplicate was short-circuited.
    expect(calls()).toBe(1);
    expect(first).toContain('struct_1');
    expect(second).toMatch(/already created|reusing/i);
    expect(second).toContain('struct_1'); // reuse carries the original id
    expect(second).not.toContain('struct_2');

    // The ledger counts ONE change, not two.
    expect(exits.writesLanded).toBe(1);
    expect(exits.writeActions.get('Create saved report')).toBe(1);
    expect(exits.writeEntities.has('structure')).toBe(true);
  });

  it('dedupes a single create whose natural key already EXISTS in the CRM (re-import guard)', async () => {
    const { action, calls } = makeCreateContactAction();
    const exits = freshExits();
    const tools = buildTurnTools(buildInputWithExistingContact(action, exits));
    const tool = findTool(tools, 'contacts__create_contact');

    const obs = (await tool.invoke({}, JSON.stringify({ name: 'Already Here', email: 'taken@x.com' }))) as string;

    // Handler NEVER ran — the existing record short-circuited the create.
    expect(calls()).toBe(0);
    expect(obs).toMatch(/already exist|reusing|not creat/i);
    expect(obs).toContain('con_999'); // the existing record's id is surfaced
    expect(exits.writesLanded).toBe(0);
  });

  it('does NOT dedupe a non-person create (workflow/structure) by name — only people/orgs dedup', async () => {
    // Regression: create_workflow (entities:['structures']) matched an existing
    // structure by name, returned "already exists", and the model could not
    // then use that id — an infinite create_workflow retry loop.
    let n = 0;
    const action: ActionDef = {
      id: 'workflows.create_workflow', slug: 'workflows.create_workflow', module: 'workflows',
      name: 'Create workflow', description: 'Create a workflow', risk: 'write', entities: ['structures'],
      inputSchema: z.object({ name: z.string() }), outputSchema: z.any(),
      searchCard: { synonyms: [], examplePhrasings: [] },
      handler: (async (input: Record<string, unknown>) => { n += 1; return { id: `struct_${n}`, name: input['name'] }; }) as ActionDef['handler'],
    };
    const exits = freshExits();
    const base = buildInput(action, exits);
    const db = {
      all: (sql: string) => (/PRAGMA table_info/i.test(sql) ? [{ name: 'id' }, { name: 'name' }] : []),
      get: (sql: string, params: unknown[]) =>
        /SELECT \* FROM structures WHERE lower\(name\)/i.test(sql) && String(params?.[0]).toLowerCase() === 'new lead follow-up task'
          ? { id: 'struct_422', name: 'New Lead Follow-up Task' } : undefined,
      run: () => ({ changes: 0 }),
    };
    const crm = { tx: (fn: (d: unknown) => unknown) => fn(db), close: () => {} } as unknown as BuildTurnToolsInput['crm'];
    const tools = buildTurnTools({ ...base, crm });
    const tool = findTool(tools, 'workflows__create_workflow');
    const obs = (await tool.invoke({}, JSON.stringify({ name: 'New Lead Follow-up Task' }))) as string;
    expect(n).toBe(1); // handler RAN — the workflow was actually created, not skipped
    expect(obs).not.toMatch(/already exist/i);
  });

  it('registers a reused record id as seen, so the model can reference it next step', async () => {
    const { action } = makeCreateContactAction();
    const exits = freshExits();
    const knownIds = new Set<string>();
    const tools = buildTurnTools({ ...buildInputWithExistingContact(action, exits), knownIds });
    const tool = findTool(tools, 'contacts__create_contact');
    await tool.invoke({}, JSON.stringify({ name: 'Already Here', email: 'taken@x.com' }));
    // con_999 (the reused existing record) must be provenance-known now
    expect(knownIds.has('con_999')).toBe(true);
  });

  it('still creates a contact whose email is NOT yet in the CRM', async () => {
    const { action, calls } = makeCreateContactAction();
    const exits = freshExits();
    const tools = buildTurnTools(buildInputWithExistingContact(action, exits));
    const tool = findTool(tools, 'contacts__create_contact');

    await tool.invoke({}, JSON.stringify({ name: 'Fresh Person', email: 'fresh@x.com' }));

    expect(calls()).toBe(1);
    expect(exits.writesLanded).toBe(1);
  });

  it('does NOT dedupe a genuinely different create (different name)', async () => {
    const { action, calls } = makeCreateAction();
    const exits = freshExits();
    const tools = buildTurnTools(buildInput(action, exits));
    const tool = findTool(tools, 'reports__create_saved_report');

    await tool.invoke({}, JSON.stringify({ name: 'Pipeline Summary', type: 'pipeline_summary' }));
    await tool.invoke({}, JSON.stringify({ name: 'Revenue by Owner', type: 'pipeline_summary' }));

    expect(calls()).toBe(2);
    expect(exits.writesLanded).toBe(2);
  });
});
