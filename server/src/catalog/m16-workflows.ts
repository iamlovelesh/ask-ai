/**
 * M16 Workflows — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'workflow'`. `config` (JSON) is
 * `{ steps: Array<{step_id,type,config,order}>, execution_log:
 * Array<{at,step_id,status}> }`.
 *
 * `publish_workflow` validates `steps` is non-empty (`VALIDATION`) before
 * flipping `status` to `'active'`, per the brief. There is no execution
 * ENGINE in this task (no `execute_workflow` action exists in the catalog)
 * — `get_workflow_execution_history` legitimately returns an empty list
 * for every workflow (a documented degenerate implementation, same
 * category as M07's `view_note_revision_history` / M16's own sibling
 * `get_trigger_firing_history` in M17 — see task-9-b2-report).
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10/M14/M15): `entities[0]` is
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

const MODULE = 'workflows';
const KIND = 'workflow';
const STATUSES = ['draft', 'active', 'inactive'] as const;

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'workflow'}-${id}`;
}

interface WorkflowStep {
  step_id: string;
  type: string;
  config: Record<string, unknown>;
  order: number;
}

interface ExecutionLogEntry {
  at: number;
  step_id: string;
  status: 'success' | 'failed';
}

interface WorkflowConfig {
  steps: WorkflowStep[];
  execution_log: ExecutionLogEntry[];
}

function readConfig(row: Row): WorkflowConfig {
  const config = parseJsonObject(row['config']);
  return {
    steps: Array.isArray(config['steps']) ? (config['steps'] as WorkflowStep[]) : [],
    execution_log: Array.isArray(config['execution_log'])
      ? (config['execution_log'] as ExecutionLogEntry[])
      : [],
  };
}

function writeConfig(db: StoreTx, id: string, config: WorkflowConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(config),
    now,
    id,
  ]);
}

interface WorkflowView {
  id: string;
  name: string;
  status: string;
  steps: WorkflowStep[];
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): WorkflowView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    steps: config.steps,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getWorkflowRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Workflow '${id}' does not exist.`);
  return row;
}

const workflowStepSchema = z.object({
  step_id: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()),
  order: z.number(),
});
const workflowView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  steps: z.array(workflowStepSchema),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_workflow ---------------------------------------------------

const createWorkflowInput = z.strictObject({ name: z.string().min(1) });

const createWorkflow: ActionDef<z.infer<typeof createWorkflowInput>, WorkflowView> = {
  id: 'M16.A01',
  slug: 'workflows.create_workflow',
  module: MODULE,
  name: 'Create workflow',
  description: 'Create a new draft automation workflow.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createWorkflowInput,
  outputSchema: workflowView,
  searchCard: {
    synonyms: ['add workflow', 'new automation'],
    examplePhrasings: ['Create a workflow to follow up with new leads'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: WorkflowConfig = { steps: [], execution_log: [] };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getWorkflowRow(ctx.db, id));
  }),
};

// --- A02 get_workflow_definition ---------------------------------------------------

const getWorkflowDefinitionInput = z.strictObject({ id: z.string() });

const getWorkflowDefinition: ActionDef<z.infer<typeof getWorkflowDefinitionInput>, WorkflowView> = {
  id: 'M16.A02',
  slug: 'workflows.get_workflow_definition',
  module: MODULE,
  name: 'Get workflow definition',
  description: 'Fetch a single workflow and its ordered step list.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getWorkflowDefinitionInput,
  outputSchema: workflowView,
  searchCard: {
    synonyms: ['workflow details', 'look up automation'],
    examplePhrasings: ['Show me the steps in this workflow'],
  },
  handler: async (input, ctx) => toView(getWorkflowRow(ctx.db, input.id)),
};

// --- A03 list_workflows --------------------------------------------------------

const listWorkflowsInput = z.strictObject({
  status: z.enum(STATUSES).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListWorkflowsInput = z.infer<typeof listWorkflowsInput>;
const listWorkflowsOutput = listOutputSchema(workflowView);
type ListWorkflowsOutput = ListOrSpill<WorkflowView>;

const listWorkflows: ActionDef<ListWorkflowsInput, ListWorkflowsOutput> = {
  id: 'M16.A03',
  slug: 'workflows.list_workflows',
  module: MODULE,
  name: 'List workflows',
  description: 'List non-archived workflows.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listWorkflowsInput,
  outputSchema: listWorkflowsOutput,
  searchCard: {
    synonyms: ['all workflows', 'show automations'],
    examplePhrasings: ['List our active workflows'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ? COLLATE NOCASE');
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
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'structures', whereSql, params },
    });
  },
};

// --- A04 add_workflow_step --------------------------------------------------

const addWorkflowStepInput = z.strictObject({
  id: z.string(),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

const addWorkflowStep: ActionDef<z.infer<typeof addWorkflowStepInput>, WorkflowView> = {
  id: 'M16.A04',
  slug: 'workflows.add_workflow_step',
  module: MODULE,
  name: 'Add workflow step',
  description: 'Append a new step to a workflow.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addWorkflowStepInput,
  outputSchema: workflowView,
  searchCard: {
    synonyms: ['add automation step', 'new workflow action'],
    examplePhrasings: ['Add a send-email step to this workflow'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWorkflowRow(ctx.db, input.id);
    const config = readConfig(row);
    const step: WorkflowStep = {
      step_id: `step_${config.steps.length + 1}`,
      type: input.type,
      config: input.config ?? {},
      order: config.steps.length + 1,
    };
    writeConfig(ctx.db, input.id, { ...config, steps: [...config.steps, step] }, ctx.clock.now());
    return toView(getWorkflowRow(ctx.db, input.id));
  }),
};

// --- A05 update_workflow_step --------------------------------------------------

const updateWorkflowStepInput = z.strictObject({
  id: z.string(),
  step_id: z.string(),
  type: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const updateWorkflowStep: ActionDef<z.infer<typeof updateWorkflowStepInput>, WorkflowView> = {
  id: 'M16.A05',
  slug: 'workflows.update_workflow_step',
  module: MODULE,
  name: 'Update workflow step',
  description: "Update an existing step's type/config in place.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateWorkflowStepInput,
  outputSchema: workflowView,
  searchCard: {
    synonyms: ['edit workflow step', 'change automation step'],
    examplePhrasings: ['Change the delay on the second step of this workflow'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWorkflowRow(ctx.db, input.id);
    const config = readConfig(row);
    const idx = config.steps.findIndex((s) => s.step_id === input.step_id);
    if (idx === -1) {
      throw new ActionError('NOT_FOUND', `Workflow '${input.id}' has no step '${input.step_id}'.`);
    }
    const existing = config.steps[idx] as WorkflowStep;
    const updated: WorkflowStep = {
      ...existing,
      type: input.type ?? existing.type,
      config: input.config ?? existing.config,
    };
    const steps = [...config.steps];
    steps[idx] = updated;
    writeConfig(ctx.db, input.id, { ...config, steps }, ctx.clock.now());
    return toView(getWorkflowRow(ctx.db, input.id));
  }),
};

// --- A06 remove_workflow_step --------------------------------------------------

const removeWorkflowStepInput = z.strictObject({ id: z.string(), step_id: z.string() });

const removeWorkflowStep: ActionDef<z.infer<typeof removeWorkflowStepInput>, WorkflowView> = {
  id: 'M16.A06',
  slug: 'workflows.remove_workflow_step',
  module: MODULE,
  name: 'Remove workflow step',
  description: 'Remove a step from a workflow.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: removeWorkflowStepInput,
  outputSchema: workflowView,
  searchCard: {
    synonyms: ['delete workflow step', 'remove automation step'],
    examplePhrasings: ['Remove the second step from this workflow'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWorkflowRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.steps.some((s) => s.step_id === input.step_id)) {
      throw new ActionError('NOT_FOUND', `Workflow '${input.id}' has no step '${input.step_id}'.`);
    }
    const steps = config.steps
      .filter((s) => s.step_id !== input.step_id)
      .map((s, i) => ({ ...s, order: i + 1 }));
    writeConfig(ctx.db, input.id, { ...config, steps }, ctx.clock.now());
    return toView(getWorkflowRow(ctx.db, input.id));
  }),
};

// --- A07 validate_workflow --------------------------------------------------

const validateWorkflowInput = z.strictObject({ id: z.string() });
const validateWorkflowOutput = z.object({
  id: z.string(),
  name: z.string(),
  ok: z.boolean(),
  errors: z.array(z.string()),
});
type ValidateWorkflowOutput = z.infer<typeof validateWorkflowOutput>;

const validateWorkflow: ActionDef<z.infer<typeof validateWorkflowInput>, ValidateWorkflowOutput> = {
  id: 'M16.A07',
  slug: 'workflows.validate_workflow',
  module: MODULE,
  name: 'Validate workflow',
  description: 'Check a workflow for basic structural validity (non-empty, ordered steps) without publishing it.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: validateWorkflowInput,
  outputSchema: validateWorkflowOutput,
  searchCard: {
    synonyms: ['check workflow', 'dry-run workflow validation'],
    examplePhrasings: ['Is this workflow ready to publish?'],
  },
  handler: async (input, ctx) => {
    const row = getWorkflowRow(ctx.db, input.id);
    const config = readConfig(row);
    const errors: string[] = [];
    if (config.steps.length === 0) errors.push('Workflow has no steps.');
    const orders = config.steps.map((s) => s.order);
    if (new Set(orders).size !== orders.length) errors.push('Workflow has duplicate step order values.');
    return { id: input.id, name: row['name'] as string, ok: errors.length === 0, errors };
  },
};

// --- A08 publish_workflow --------------------------------------------------

const publishWorkflowInput = z.strictObject({ id: z.string() });

const publishWorkflow: ActionDef<z.infer<typeof publishWorkflowInput>, WorkflowView> = {
  id: 'M16.A08',
  slug: 'workflows.publish_workflow',
  module: MODULE,
  name: 'Publish workflow',
  description: 'Publish a workflow (requires at least one step).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: publishWorkflowInput,
  outputSchema: workflowView,
  searchCard: {
    synonyms: ['activate workflow', 'turn on automation'],
    examplePhrasings: ['Publish this workflow so it starts running'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWorkflowRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.steps.length === 0) {
      throw new ActionError('VALIDATION', `Workflow '${input.id}' has no steps — add at least one before publishing.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'active', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getWorkflowRow(ctx.db, input.id));
  }),
};

// --- A09 pause_workflow --------------------------------------------------

const pauseWorkflowInput = z.strictObject({ id: z.string() });

const pauseWorkflow: ActionDef<z.infer<typeof pauseWorkflowInput>, WorkflowView> = {
  id: 'M16.A09',
  slug: 'workflows.pause_workflow',
  module: MODULE,
  name: 'Pause workflow',
  description: 'Pause a published workflow.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: pauseWorkflowInput,
  outputSchema: workflowView,
  searchCard: {
    synonyms: ['deactivate workflow', 'turn off automation'],
    examplePhrasings: ['Pause this workflow'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWorkflowRow(ctx.db, input.id);
    if (row['status'] === 'inactive') {
      throw new ActionError('CONFLICT', `Workflow '${input.id}' is already paused.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'inactive', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getWorkflowRow(ctx.db, input.id));
  }),
};

// --- A10 get_workflow_execution_history --------------------------------------------

const getWorkflowExecutionHistoryInput = z.strictObject({
  id: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
});
type GetWorkflowExecutionHistoryInput = z.infer<typeof getWorkflowExecutionHistoryInput>;
const executionLogEntrySchema = z.object({
  at: z.number(),
  step_id: z.string(),
  status: z.enum(['success', 'failed']),
});
const getWorkflowExecutionHistoryOutput = listOutputSchema(executionLogEntrySchema);
type GetWorkflowExecutionHistoryOutput = ListOrSpill<z.infer<typeof executionLogEntrySchema>>;

const getWorkflowExecutionHistory: ActionDef<
  GetWorkflowExecutionHistoryInput,
  GetWorkflowExecutionHistoryOutput
> = {
  id: 'M16.A10',
  slug: 'workflows.get_workflow_execution_history',
  module: MODULE,
  name: 'Get workflow execution history',
  description:
    'List recorded execution-log entries for a workflow (empty for workflows that have never run — there is no execution engine in this backend).',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getWorkflowExecutionHistoryInput,
  outputSchema: getWorkflowExecutionHistoryOutput,
  searchCard: {
    synonyms: ['workflow run history', 'automation execution log'],
    examplePhrasings: ['Has this workflow ever run?'],
  },
  handler: async (input, ctx) => {
    const row = getWorkflowRow(ctx.db, input.id);
    const config = readConfig(row);
    const limit = input.limit ?? 50;
    const sorted = [...config.execution_log].sort((a, b) => b.at - a.at);
    return toListOrSpill(sorted.slice(0, limit), sorted.length);
  },
};

export const m16Workflows: ActionDef[] = [
  createWorkflow as ActionDef,
  getWorkflowDefinition as ActionDef,
  listWorkflows as ActionDef,
  addWorkflowStep as ActionDef,
  updateWorkflowStep as ActionDef,
  removeWorkflowStep as ActionDef,
  validateWorkflow as ActionDef,
  publishWorkflow as ActionDef,
  pauseWorkflow as ActionDef,
  getWorkflowExecutionHistory as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (pristine: 'active' → 8, 'draft' → 5, 'inactive' → 7) — a small universe
 * (20 rows total), so every pairing has a thin margin. Deliberately avoided
 * active-vs-inactive (pristine diff only 1) in favor of active-vs-draft.
 * Empirically verified via `npm run smoke -- --module m16` (and the full
 * `--modules m11-m17` / all-module run): live value is 'active' → 8,
 * 'draft' → 6, margin 2. (`ORDER BY id` in `synthesizeInput`'s id
 * resolution is lexicographic on the TEXT `id` column, not numeric, so
 * don't trust a hand-traced "which row is offset 0" — verify empirically.)
 */
export const m16DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'workflows.list_workflows',
    paramsA: { status: 'active' },
    paramsB: { status: 'draft' },
    expectDifferentCounts: true,
  },
];

/**
 * Every action below has `entities[0] === 'structures'` with `kind =
 * 'workflow'` — the bare `id` field needs an action-scoped hint.
 */
export const m16SynthHints: SynthHints = {
  'workflows.get_workflow_definition:id': { table: 'structures', kind: KIND },
  'workflows.add_workflow_step:id': { table: 'structures', kind: KIND },
  'workflows.update_workflow_step:id': { table: 'structures', kind: KIND },
  'workflows.remove_workflow_step:id': { table: 'structures', kind: KIND },
  'workflows.validate_workflow:id': { table: 'structures', kind: KIND },
  'workflows.publish_workflow:id': { table: 'structures', kind: KIND },
  'workflows.pause_workflow:id': { table: 'structures', kind: KIND },
  'workflows.get_workflow_execution_history:id': { table: 'structures', kind: KIND },
};
