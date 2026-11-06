/**
 * M14 Message Templates — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'template'`. `config` (JSON) is
 * `{ channel: 'sms'|'email', subject?: string, body: string, variables:
 * string[], history: Array<{subject?,body,saved_at}> }`.
 *
 * `{{var}}` is the placeholder syntax throughout: `validate_template_variables`
 * diffs the placeholders actually referenced in `subject`/`body` against the
 * sample data's keys (real regex extraction, not a canned result);
 * `render_template_with_sample_data` does real string substitution.
 * `update_template_content` pushes the PRIOR content onto `config.history`
 * before overwriting, which is what `restore_template_version` reads back.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10): `entities[0]` is
 * `'structures'` — every action on this module's own `id` needs an
 * action-scoped synthHint (`${slug}:id`).
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

const MODULE = 'message_templates';
const KIND = 'template';
const CHANNELS = ['sms', 'email'] as const;
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'template'}-${id}`;
}

function extractPlaceholders(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      const name = match[1];
      if (name) found.add(name);
    }
  }
  return [...found];
}

function renderText(text: string, data: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(data, name) ? String(data[name]) : whole,
  );
}

interface HistoryEntry {
  subject?: string | null;
  body: string;
  saved_at: number;
}

interface TemplateConfig {
  channel: (typeof CHANNELS)[number];
  subject: string | null;
  body: string;
  variables: string[];
  history: HistoryEntry[];
}

function readConfig(row: Row): TemplateConfig {
  const config = parseJsonObject(row['config']);
  return {
    channel: (config['channel'] as TemplateConfig['channel'] | undefined) ?? 'email',
    subject: (config['subject'] as string | null | undefined) ?? null,
    body: (config['body'] as string | undefined) ?? '',
    variables: Array.isArray(config['variables']) ? (config['variables'] as string[]) : [],
    history: Array.isArray(config['history']) ? (config['history'] as HistoryEntry[]) : [],
  };
}

function writeConfig(db: StoreTx, id: string, config: TemplateConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(config),
    now,
    id,
  ]);
}

interface TemplateView {
  id: string;
  name: string;
  status: string;
  channel: string;
  subject: string | null;
  body: string;
  variables: string[];
  version_count: number;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): TemplateView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    channel: config.channel,
    subject: config.subject,
    body: config.body,
    variables: config.variables,
    version_count: config.history.length,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getTemplateRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Template '${id}' does not exist.`);
  return row;
}

const templateView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  variables: z.array(z.string()),
  version_count: z.number(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_message_template --------------------------------------------

const createMessageTemplateInput = z.strictObject({
  name: z.string().min(1),
  channel: z.enum(CHANNELS),
  subject: z.string().optional(),
  body: z.string().min(1),
  variables: z.array(z.string().min(1)).optional(),
});
type CreateMessageTemplateInput = z.infer<typeof createMessageTemplateInput>;

const createMessageTemplate: ActionDef<CreateMessageTemplateInput, TemplateView> = {
  id: 'M14.A01',
  slug: 'message_templates.create_message_template',
  module: MODULE,
  name: 'Create message template',
  description: 'Create a new SMS/email message template.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createMessageTemplateInput,
  outputSchema: templateView,
  searchCard: {
    synonyms: ['add template', 'new message template'],
    examplePhrasings: ['Create an email template for order confirmations'],
  },
  jit: 'Use {{variable_name}} placeholders in body/subject; declare them via define_template_variables.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: TemplateConfig = {
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      variables: input.variables ?? [],
      history: [],
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getTemplateRow(ctx.db, id));
  }),
};

// --- A02 get_template ----------------------------------------------------------

const getTemplateInput = z.strictObject({ id: z.string() });

const getTemplate: ActionDef<z.infer<typeof getTemplateInput>, TemplateView> = {
  id: 'M14.A02',
  slug: 'message_templates.get_template',
  module: MODULE,
  name: 'Get template',
  description: 'Fetch a single message template by id.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getTemplateInput,
  outputSchema: templateView,
  searchCard: {
    synonyms: ['template details', 'look up template'],
    examplePhrasings: ['Show me this message template'],
  },
  handler: async (input, ctx) => toView(getTemplateRow(ctx.db, input.id)),
};

// --- A03 search_templates --------------------------------------------------------

const searchTemplatesInput = z.strictObject({
  channel: z.enum(CHANNELS).optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchTemplatesInput = z.infer<typeof searchTemplatesInput>;
const searchTemplatesOutput = listOutputSchema(templateView);
type SearchTemplatesOutput = ListOrSpill<TemplateView>;

const searchTemplates: ActionDef<SearchTemplatesInput, SearchTemplatesOutput> = {
  id: 'M14.A03',
  slug: 'message_templates.search_templates',
  module: MODULE,
  name: 'Search templates',
  description: 'Search non-archived message templates by status (channel filtered in-memory).',
  risk: 'read',
  entities: ['structures'],
  inputSchema: searchTemplatesInput,
  outputSchema: searchTemplatesOutput,
  searchCard: {
    synonyms: ['find templates', 'list templates'],
    examplePhrasings: ['Show me all active email templates'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ? COLLATE NOCASE');
      params.push(input.status);
    }
    const whereSql = where.join(' AND ');
    // `channel` lives inside `config` (JSON), so it's filtered in JS. The
    // `kind='template'` subset is always small (tens of rows, never
    // thousands) — fetching every SQL-matching row (bounded by kind+status,
    // not an artificial LIMIT) before the JS channel filter keeps `total`
    // the TRUE total rather than an under-count from a truncated pool.
    const candidateRows = ctx.db.all(
      `SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC`,
      params,
    );
    const filtered = input.channel
      ? candidateRows.filter((r) => readConfig(r).channel === input.channel)
      : candidateRows;
    const limit = input.limit ?? 50;
    return toListOrSpill(filtered.slice(0, limit).map(toView), filtered.length);
  },
};

// --- A04 update_template_content --------------------------------------------------

const updateTemplateContentInput = z.strictObject({
  id: z.string(),
  subject: z.string().optional(),
  body: z.string().min(1),
});

const updateTemplateContent: ActionDef<z.infer<typeof updateTemplateContentInput>, TemplateView> = {
  id: 'M14.A04',
  slug: 'message_templates.update_template_content',
  module: MODULE,
  name: 'Update template content',
  description: "Replace a template's subject/body, archiving the prior content into its version history.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateTemplateContentInput,
  outputSchema: templateView,
  searchCard: {
    synonyms: ['edit template content', 'update template body'],
    examplePhrasings: ['Update this template to mention our new pricing'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTemplateRow(ctx.db, input.id);
    const config = readConfig(row);
    const now = ctx.clock.now();
    const history = [...config.history, { subject: config.subject, body: config.body, saved_at: now }];
    writeConfig(
      ctx.db,
      input.id,
      { ...config, subject: input.subject ?? config.subject, body: input.body, history },
      now,
    );
    return toView(getTemplateRow(ctx.db, input.id));
  }),
};

// --- A05 archive_template -----------------------------------------------------

const archiveTemplateInput = z.strictObject({ id: z.string() });
const archiveTemplateOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const archiveTemplate: ActionDef<z.infer<typeof archiveTemplateInput>, z.infer<typeof archiveTemplateOutput>> = {
  id: 'M14.A05',
  slug: 'message_templates.archive_template',
  module: MODULE,
  name: 'Archive template',
  description: 'Soft-delete a message template.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: archiveTemplateInput,
  outputSchema: archiveTemplateOutput,
  searchCard: {
    synonyms: ['delete template', 'remove template'],
    examplePhrasings: ['Archive the old welcome email template'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTemplateRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET archived = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, archived: true as const };
  }),
};

// --- A06 duplicate_template -----------------------------------------------------

const duplicateTemplateInput = z.strictObject({ id: z.string() });
const duplicateTemplateOutput = z.object({ id: z.string(), name: z.string(), duplicated_from: z.string() });

const duplicateTemplate: ActionDef<
  z.infer<typeof duplicateTemplateInput>,
  z.infer<typeof duplicateTemplateOutput>
> = {
  id: 'M14.A06',
  slug: 'message_templates.duplicate_template',
  module: MODULE,
  name: 'Duplicate template',
  description: 'Clone a message template (content + variables, fresh version history) as a new definition.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: duplicateTemplateInput,
  outputSchema: duplicateTemplateOutput,
  searchCard: {
    synonyms: ['copy template', 'clone template'],
    examplePhrasings: ['Duplicate this template so I can tweak it for a different segment'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const source = getTemplateRow(ctx.db, input.id);
    const sourceConfig = readConfig(source);
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const name = `${source['name'] as string} (copy)`;
    const config: TemplateConfig = { ...sourceConfig, history: [] };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, name, slugify(name, id), source['owner_id'] ?? null, KIND, JSON.stringify(config)],
    );
    return { id, name, duplicated_from: input.id };
  }),
};

// --- A07 define_template_variables --------------------------------------------

const defineTemplateVariablesInput = z.strictObject({
  id: z.string(),
  variables: z.array(z.string().min(1)),
});

const defineTemplateVariables: ActionDef<z.infer<typeof defineTemplateVariablesInput>, TemplateView> = {
  id: 'M14.A07',
  slug: 'message_templates.define_template_variables',
  module: MODULE,
  name: 'Define template variables',
  description: 'Declare the list of `{{var}}` placeholder names a template expects.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: defineTemplateVariablesInput,
  outputSchema: templateView,
  searchCard: {
    synonyms: ['set template variables', 'declare template placeholders'],
    examplePhrasings: ['This template uses first_name and order_number variables'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTemplateRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, variables: input.variables }, ctx.clock.now());
    return toView(getTemplateRow(ctx.db, input.id));
  }),
};

// --- A08 validate_template_variables --------------------------------------------

const validateTemplateVariablesInput = z.strictObject({
  id: z.string(),
  sample_data: z.record(z.string(), z.unknown()),
});
const validateTemplateVariablesOutput = z.object({
  id: z.string(),
  name: z.string(),
  ok: z.boolean(),
  missing: z.array(z.string()),
  extra: z.array(z.string()),
});
type ValidateTemplateVariablesOutput = z.infer<typeof validateTemplateVariablesOutput>;

const validateTemplateVariables: ActionDef<
  z.infer<typeof validateTemplateVariablesInput>,
  ValidateTemplateVariablesOutput
> = {
  id: 'M14.A08',
  slug: 'message_templates.validate_template_variables',
  module: MODULE,
  name: 'Validate template variables',
  description:
    'Diff the `{{var}}` placeholders actually referenced in a template against supplied sample data keys.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: validateTemplateVariablesInput,
  outputSchema: validateTemplateVariablesOutput,
  searchCard: {
    synonyms: ['check template variables', 'missing template fields'],
    examplePhrasings: ['Does my sample data cover every variable this template needs?'],
  },
  handler: async (input, ctx) => {
    const row = getTemplateRow(ctx.db, input.id);
    const config = readConfig(row);
    const referenced = extractPlaceholders(config.subject, config.body);
    const provided = Object.keys(input.sample_data);
    const missing = referenced.filter((v) => !provided.includes(v));
    const extra = provided.filter((v) => !referenced.includes(v));
    return { id: input.id, name: row['name'] as string, ok: missing.length === 0, missing, extra };
  },
};

// --- A09 render_template_with_sample_data --------------------------------------------

const renderTemplateWithSampleDataInput = z.strictObject({
  id: z.string(),
  sample_data: z.record(z.string(), z.unknown()),
});
const renderTemplateWithSampleDataOutput = z.object({
  id: z.string(),
  name: z.string(),
  rendered_subject: z.string().nullable(),
  rendered_body: z.string(),
});
type RenderTemplateWithSampleDataOutput = z.infer<typeof renderTemplateWithSampleDataOutput>;

const renderTemplateWithSampleData: ActionDef<
  z.infer<typeof renderTemplateWithSampleDataInput>,
  RenderTemplateWithSampleDataOutput
> = {
  id: 'M14.A09',
  slug: 'message_templates.render_template_with_sample_data',
  module: MODULE,
  name: 'Render template with sample data',
  description: 'Substitute `{{var}}` placeholders with supplied sample data (unresolved placeholders are left intact).',
  risk: 'read',
  entities: ['structures'],
  inputSchema: renderTemplateWithSampleDataInput,
  outputSchema: renderTemplateWithSampleDataOutput,
  searchCard: {
    synonyms: ['preview template render', 'render template'],
    examplePhrasings: ['Show me what this template looks like for Jane Doe'],
  },
  handler: async (input, ctx) => {
    const row = getTemplateRow(ctx.db, input.id);
    const config = readConfig(row);
    return {
      id: input.id,
      name: row['name'] as string,
      rendered_subject: config.subject ? renderText(config.subject, input.sample_data) : null,
      rendered_body: renderText(config.body, input.sample_data),
    };
  },
};

// --- A10 restore_template_version --------------------------------------------

const restoreTemplateVersionInput = z.strictObject({
  id: z.string(),
  version_index: z.number().int().min(0),
});

const restoreTemplateVersion: ActionDef<z.infer<typeof restoreTemplateVersionInput>, TemplateView> = {
  id: 'M14.A10',
  slug: 'message_templates.restore_template_version',
  module: MODULE,
  name: 'Restore template version',
  description: "Restore a template's content from its version history (0 = oldest saved version).",
  risk: 'write',
  entities: ['structures'],
  inputSchema: restoreTemplateVersionInput,
  outputSchema: templateView,
  searchCard: {
    synonyms: ['revert template', 'restore old template version'],
    examplePhrasings: ['Revert this template back to its previous version'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTemplateRow(ctx.db, input.id);
    const config = readConfig(row);
    const target = config.history[input.version_index];
    if (!target) {
      throw new ActionError(
        'NOT_FOUND',
        `Template '${input.id}' has no saved version at index ${input.version_index} (has ${config.history.length}).`,
      );
    }
    const now = ctx.clock.now();
    const history = [
      ...config.history,
      { subject: config.subject, body: config.body, saved_at: now },
    ];
    writeConfig(
      ctx.db,
      input.id,
      { ...config, subject: target.subject ?? null, body: target.body, history },
      now,
    );
    return toView(getTemplateRow(ctx.db, input.id));
  }),
};

export const m14MessageTemplates: ActionDef[] = [
  createMessageTemplate as ActionDef,
  getTemplate as ActionDef,
  searchTemplates as ActionDef,
  updateTemplateContent as ActionDef,
  archiveTemplate as ActionDef,
  duplicateTemplate as ActionDef,
  defineTemplateVariables as ActionDef,
  validateTemplateVariables as ActionDef,
  renderTemplateWithSampleData as ActionDef,
  restoreTemplateVersion as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (pristine: 'active' → 16, 'archived' → 14). This module's own actions DO
 * shift these during the same smoke run (`create_message_template`/
 * `duplicate_template` each add an 'active' row; `archive_template` drops
 * one row out of the `archived=0` view entirely) — empirically verified via
 * `npm run smoke -- --module m14` (and the full `--modules m11-m17` /
 * all-module run): live value is 'active' → 17, 'archived' → 14, margin 3.
 * (NOTE: `synthesizeInput`'s id-resolution `ORDER BY id` is LEXICOGRAPHIC
 * on the TEXT `id` column, not numeric — a freshly-inserted higher-numbered
 * row can sort before an existing lower-numbered one, e.g. `'struct_381' <
 * 'struct_41'` lexicographically — so which row ends up "offset 0" during a
 * run isn't the naive "oldest row" a numeric reading would suggest. Verify
 * empirically via `npm run smoke`, don't hand-trace it.)
 */
export const m14DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'message_templates.search_templates',
    paramsA: { status: 'active' },
    paramsB: { status: 'archived' },
    expectDifferentCounts: true,
  },
];

/**
 * Every action below has `entities[0] === 'structures'` with `kind =
 * 'template'` — the bare `id` field needs an action-scoped hint.
 */
export const m14SynthHints: SynthHints = {
  'message_templates.get_template:id': { table: 'structures', kind: KIND },
  'message_templates.update_template_content:id': { table: 'structures', kind: KIND },
  'message_templates.archive_template:id': { table: 'structures', kind: KIND },
  'message_templates.duplicate_template:id': { table: 'structures', kind: KIND },
  'message_templates.define_template_variables:id': { table: 'structures', kind: KIND },
  'message_templates.validate_template_variables:id': { table: 'structures', kind: KIND },
  'message_templates.render_template_with_sample_data:id': { table: 'structures', kind: KIND },
  'message_templates.restore_template_version:id': { table: 'structures', kind: KIND },
};
