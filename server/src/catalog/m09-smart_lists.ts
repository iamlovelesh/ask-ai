/**
 * M09 Smart Lists — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'smart_list'`. `config` (JSON) is
 * `{ filter_rules: Record<string, unknown> }`. The filter-execution engine
 * is intentionally scoped to `contacts` (the catalog's most common
 * segmentation target) and interprets a documented subset of filter keys
 * — `lifecycle_stage`/`owner_id`/`company_id`/`source` — the same filter
 * vocabulary `contacts.search_contacts` (M01) already exposes, so a smart
 * list's `filter_rules` is literally "a saved `search_contacts` filter
 * set." Unrecognized keys in `filter_rules` are ignored (not errors) —
 * this module doesn't implement a general filter DSL/compiler.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08): every action on this module's own
 * `id` needs an action-scoped synthHint (`${slug}:id`).
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';
import { parseJsonObject } from './json.js';

const MODULE = 'smart_lists';
const KIND = 'smart_list';

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'smart-list'}-${id}`;
}

interface FilterRules {
  lifecycle_stage?: string;
  owner_id?: string;
  company_id?: string;
  source?: string;
}

function readFilterRules(row: Row): FilterRules {
  const config = parseJsonObject(row['config']);
  const rules = config['filter_rules'];
  return rules && typeof rules === 'object' && !Array.isArray(rules) ? (rules as FilterRules) : {};
}

/** Build the WHERE clause for the contacts segment a smart list defines. */
function buildContactsWhere(rules: FilterRules): { whereSql: string; params: unknown[] } {
  const where: string[] = ['archived = 0'];
  const params: unknown[] = [];
  if (rules.lifecycle_stage) {
    where.push('lifecycle_stage = ?');
    params.push(rules.lifecycle_stage);
  }
  if (rules.owner_id) {
    where.push('owner_id = ?');
    params.push(rules.owner_id);
  }
  if (rules.company_id) {
    where.push('company_id = ?');
    params.push(rules.company_id);
  }
  if (rules.source) {
    where.push('source = ?');
    params.push(rules.source);
  }
  return { whereSql: where.join(' AND '), params };
}

interface SmartListView {
  id: string;
  name: string;
  status: string;
  filter_rules: FilterRules;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): SmartListView {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    filter_rules: readFilterRules(row),
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getSmartListRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Smart list '${id}' does not exist.`);
  return row;
}

const smartListView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  filter_rules: z.record(z.string(), z.unknown()),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_smart_list -------------------------------------------------------

const createSmartListInput = z.strictObject({
  name: z.string().min(1),
  filter_rules: z.record(z.string(), z.unknown()).optional(),
});
type CreateSmartListInput = z.infer<typeof createSmartListInput>;

const createSmartList: ActionDef<CreateSmartListInput, SmartListView> = {
  id: 'M09.A01',
  slug: 'smart_lists.create_smart_list',
  module: MODULE,
  name: 'Create smart list',
  description: 'Create a new saved contact segment.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createSmartListInput,
  outputSchema: smartListView,
  searchCard: {
    synonyms: ['add smart list', 'new segment'],
    examplePhrasings: ['Create a smart list of customers owned by Dana'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [
        id,
        now,
        now,
        KIND,
        input.name,
        slugify(input.name, id),
        KIND,
        JSON.stringify({ filter_rules: input.filter_rules ?? {} }),
      ],
    );
    return toView(getSmartListRow(ctx.db, id));
  }),
};

// --- A02 get_smart_list_definition ---------------------------------------------

const getSmartListDefinitionInput = z.strictObject({ id: z.string() });

const getSmartListDefinition: ActionDef<z.infer<typeof getSmartListDefinitionInput>, SmartListView> = {
  id: 'M09.A02',
  slug: 'smart_lists.get_smart_list_definition',
  module: MODULE,
  name: 'Get smart list definition',
  description: 'Fetch a smart list and its filter rules.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getSmartListDefinitionInput,
  outputSchema: smartListView,
  searchCard: {
    synonyms: ['smart list details', 'look up segment'],
    examplePhrasings: ['What filters define this smart list?'],
  },
  handler: async (input, ctx) => toView(getSmartListRow(ctx.db, input.id)),
};

// --- A03 list_smart_lists -----------------------------------------------------

const listSmartListsInput = z.strictObject({
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListSmartListsInput = z.infer<typeof listSmartListsInput>;
const listSmartListsOutput = listOutputSchema(smartListView);
type ListSmartListsOutput = ListOrSpill<SmartListView>;

const listSmartLists: ActionDef<ListSmartListsInput, ListSmartListsOutput> = {
  id: 'M09.A03',
  slug: 'smart_lists.list_smart_lists',
  module: MODULE,
  name: 'List smart lists',
  description: 'List non-archived smart lists.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listSmartListsInput,
  outputSchema: listSmartListsOutput,
  searchCard: {
    synonyms: ['all smart lists', 'show segments'],
    examplePhrasings: ['List our saved segments'],
  },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM structures WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 rename_smart_list -----------------------------------------------------

const renameSmartListInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const renameSmartList: ActionDef<z.infer<typeof renameSmartListInput>, SmartListView> = {
  id: 'M09.A04',
  slug: 'smart_lists.rename_smart_list',
  module: MODULE,
  name: 'Rename smart list',
  description: 'Rename a smart list.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: renameSmartListInput,
  outputSchema: smartListView,
  searchCard: {
    synonyms: ['edit smart list name'],
    examplePhrasings: ['Rename this smart list to Q4 Customers'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getSmartListRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET name = ?, updated_at = ? WHERE id = ?`, [
      input.name,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getSmartListRow(ctx.db, input.id));
  }),
};

// --- A05 update_filter_rules -----------------------------------------------------

const updateFilterRulesInput = z.strictObject({
  id: z.string(),
  filter_rules: z.record(z.string(), z.unknown()),
});

const updateFilterRules: ActionDef<z.infer<typeof updateFilterRulesInput>, SmartListView> = {
  id: 'M09.A05',
  slug: 'smart_lists.update_filter_rules',
  module: MODULE,
  name: 'Update filter rules',
  description: 'Replace the filter rules that define a smart list segment.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateFilterRulesInput,
  outputSchema: smartListView,
  searchCard: {
    synonyms: ['edit smart list filters', 'change segment criteria'],
    examplePhrasings: ['Update this smart list to only include leads'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSmartListRow(ctx.db, input.id);
    const config = parseJsonObject(row['config']);
    ctx.db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify({ ...config, filter_rules: input.filter_rules }),
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getSmartListRow(ctx.db, input.id));
  }),
};

// --- A06 preview_matching_records -----------------------------------------------

const previewMatchingRecordsInput = z.strictObject({
  id: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
});
const contactSummary = z.object({ id: z.string(), name: z.string() });
const previewMatchingRecordsOutput = listOutputSchema(contactSummary);
type PreviewMatchingRecordsOutput = ListOrSpill<z.infer<typeof contactSummary>>;

const previewMatchingRecords: ActionDef<
  z.infer<typeof previewMatchingRecordsInput>,
  PreviewMatchingRecordsOutput
> = {
  id: 'M09.A06',
  slug: 'smart_lists.preview_matching_records',
  module: MODULE,
  name: 'Preview matching records',
  description: "Preview the contacts a smart list's filter rules currently match.",
  risk: 'read',
  entities: ['structures', 'contacts'],
  inputSchema: previewMatchingRecordsInput,
  outputSchema: previewMatchingRecordsOutput,
  searchCard: {
    synonyms: ['preview segment', 'who matches this smart list'],
    examplePhrasings: ['Show me who matches this smart list right now'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const row = getSmartListRow(ctx.db, input.id);
    const rules = readFilterRules(row);
    const { whereSql, params } = buildContactsWhere(rules);
    const limit = input.limit ?? 50;
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT id, name FROM contacts WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(
      rows.map((r) => ({ id: r['id'] as string, name: r['name'] as string })),
      total,
    );
  },
};

// --- A07 count_matching_records -------------------------------------------------

const countMatchingRecordsInput = z.strictObject({ id: z.string() });
const countMatchingRecordsOutput = z.object({ id: z.string(), name: z.string(), total: z.number() });

const countMatchingRecords: ActionDef<
  z.infer<typeof countMatchingRecordsInput>,
  z.infer<typeof countMatchingRecordsOutput>
> = {
  id: 'M09.A07',
  slug: 'smart_lists.count_matching_records',
  module: MODULE,
  name: 'Count matching records',
  description: "Count the contacts a smart list's filter rules currently match.",
  risk: 'read',
  entities: ['structures', 'contacts'],
  inputSchema: countMatchingRecordsInput,
  outputSchema: countMatchingRecordsOutput,
  searchCard: {
    synonyms: ['segment size', 'how many match this smart list'],
    examplePhrasings: ['How many contacts are in this smart list?'],
  },
  handler: async (input, ctx) => {
    const row = getSmartListRow(ctx.db, input.id);
    const rules = readFilterRules(row);
    const { whereSql, params } = buildContactsWhere(rules);
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    return { id: input.id, name: row['name'] as string, total };
  },
};

// --- A08 export_matching_records -------------------------------------------------

const exportMatchingRecordsInput = z.strictObject({ id: z.string() });
const exportSummary = z.object({ id: z.string(), name: z.string(), total: z.number(), sample: z.array(contactSummary) });

const exportMatchingRecords: ActionDef<
  z.infer<typeof exportMatchingRecordsInput>,
  z.infer<typeof exportSummary>
> = {
  id: 'M09.A08',
  slug: 'smart_lists.export_matching_records',
  module: MODULE,
  name: 'Export matching records',
  description:
    'Generate an export of the contacts matching a smart list (segment-wide — always gates) and stamp the smart list with its last-export time.',
  risk: 'bulk',
  entities: ['structures', 'contacts'],
  inputSchema: exportMatchingRecordsInput,
  outputSchema: exportSummary,
  searchCard: {
    synonyms: ['export smart list', 'download segment'],
    examplePhrasings: ['Export everyone in this smart list to CSV'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSmartListRow(ctx.db, input.id);
    const rules = readFilterRules(row);
    const { whereSql, params } = buildContactsWhere(rules);
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const sampleRows = ctx.db.all(
      `SELECT id, name FROM contacts WHERE ${whereSql} ORDER BY created_at DESC LIMIT 20`,
      params,
    );
    const config = parseJsonObject(row['config']);
    ctx.db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify({ ...config, last_exported_at: ctx.clock.now() }),
      ctx.clock.now(),
      input.id,
    ]);
    return {
      id: input.id,
      name: row['name'] as string,
      total,
      sample: sampleRows.map((r) => ({ id: r['id'] as string, name: r['name'] as string })),
    };
  }),
};

// --- A09 duplicate_smart_list -------------------------------------------------------

const duplicateSmartListInput = z.strictObject({ id: z.string() });
const duplicateSmartListOutput = z.object({ id: z.string(), name: z.string(), duplicated_from: z.string() });

const duplicateSmartList: ActionDef<
  z.infer<typeof duplicateSmartListInput>,
  z.infer<typeof duplicateSmartListOutput>
> = {
  id: 'M09.A09',
  slug: 'smart_lists.duplicate_smart_list',
  module: MODULE,
  name: 'Duplicate smart list',
  description: 'Clone a smart list (name + filter rules) as a new definition.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: duplicateSmartListInput,
  outputSchema: duplicateSmartListOutput,
  searchCard: {
    synonyms: ['copy smart list', 'clone segment'],
    examplePhrasings: ['Duplicate this smart list so I can tweak it'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const source = getSmartListRow(ctx.db, input.id);
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const name = `${source['name'] as string} (copy)`;
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, name, slugify(name, id), source['owner_id'] ?? null, KIND, source['config']],
    );
    return { id, name, duplicated_from: input.id };
  }),
};

// --- A10 delete_smart_list -------------------------------------------------------

const deleteSmartListInput = z.strictObject({ id: z.string() });
const deleteSmartListOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const deleteSmartList: ActionDef<z.infer<typeof deleteSmartListInput>, z.infer<typeof deleteSmartListOutput>> = {
  id: 'M09.A10',
  slug: 'smart_lists.delete_smart_list',
  module: MODULE,
  name: 'Delete smart list',
  description: 'Archive a smart list.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: deleteSmartListInput,
  outputSchema: deleteSmartListOutput,
  searchCard: {
    synonyms: ['remove smart list', 'delete segment'],
    examplePhrasings: ['Delete this smart list'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSmartListRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET archived = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, archived: true as const };
  }),
};

export const m09SmartLists: ActionDef[] = [
  createSmartList as ActionDef,
  getSmartListDefinition as ActionDef,
  listSmartLists as ActionDef,
  renameSmartList as ActionDef,
  updateFilterRules as ActionDef,
  previewMatchingRecords as ActionDef,
  countMatchingRecords as ActionDef,
  exportMatchingRecords as ActionDef,
  duplicateSmartList as ActionDef,
  deleteSmartList as ActionDef,
];

/** Tier-A discrimination: `status` counts (verified: 'active' → 12, 'inactive' → 8). */
export const m09DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'smart_lists.list_smart_lists',
    paramsA: { status: 'active' },
    paramsB: { status: 'inactive' },
    expectDifferentCounts: true,
  },
];

/**
 * `entities[0] === 'structures'` with `kind = 'smart_list'` — every action
 * on this module's own `id` needs an action-scoped hint.
 */
export const m09SynthHints: SynthHints = {
  'smart_lists.get_smart_list_definition:id': { table: 'structures', kind: KIND },
  'smart_lists.rename_smart_list:id': { table: 'structures', kind: KIND },
  'smart_lists.update_filter_rules:id': { table: 'structures', kind: KIND },
  'smart_lists.preview_matching_records:id': { table: 'structures', kind: KIND },
  'smart_lists.count_matching_records:id': { table: 'structures', kind: KIND },
  'smart_lists.export_matching_records:id': { table: 'structures', kind: KIND },
  'smart_lists.duplicate_smart_list:id': { table: 'structures', kind: KIND },
  'smart_lists.delete_smart_list:id': { table: 'structures', kind: KIND },
};
