/**
 * M05 Pipelines — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'pipeline'`. `config` (JSON) is
 * `{ stages: string[], stage_probabilities?: Record<string, number> }` —
 * this module is the ONLY writer of a pipeline's `config.stages`, which
 * M04 Opportunities' `move_opportunity_to_stage` reads back to validate
 * stage names for real.
 *
 * KIND-BLINDNESS NOTE (task-8 carry-forward watch item): `entities[0]` for
 * every action here is `'structures'`, a table shared by 20 different
 * `kind`s. `catalog/testing.ts`'s bare-`id` resolution is kind-blind unless
 * given an action-scoped hint (`${slug}:id`) — see `m05SynthHints` below,
 * which is REQUIRED for every action that takes this module's own `id`
 * (get/rename/archive/add-stage/rename-stage/reorder-stages/remove-stage/
 * set-probability). Without it, smoke could silently resolve `id` to e.g. a
 * `tag` or `coupon` row instead of a pipeline.
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

const MODULE = 'pipelines';
const KIND = 'pipeline';
const DEFAULT_STAGES = [
  'prospecting',
  'qualification',
  'proposal',
  'negotiation',
  'closed_won',
  'closed_lost',
];

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'pipeline'}-${id}`;
}

interface PipelineConfig {
  stages: string[];
  stage_probabilities?: Record<string, number> | undefined;
}

function readConfig(row: Row): PipelineConfig {
  const config = parseJsonObject(row['config']);
  const stages = Array.isArray(config['stages']) ? (config['stages'] as string[]) : [...DEFAULT_STAGES];
  const stageProbabilities =
    config['stage_probabilities'] && typeof config['stage_probabilities'] === 'object'
      ? (config['stage_probabilities'] as Record<string, number>)
      : undefined;
  return { stages, stage_probabilities: stageProbabilities };
}

interface PipelineView {
  id: string;
  name: string;
  status: string;
  stages: string[];
  stage_probabilities: Record<string, number>;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): PipelineView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    stages: config.stages,
    stage_probabilities: config.stage_probabilities ?? {},
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getPipelineRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Pipeline '${id}' does not exist.`);
  return row;
}

function writeConfig(db: StoreTx, id: string, config: PipelineConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(config),
    now,
    id,
  ]);
}

const pipelineView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  stages: z.array(z.string()),
  stage_probabilities: z.record(z.string(), z.number()),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_pipeline -------------------------------------------------------

const createPipelineInput = z.strictObject({
  name: z.string().min(1),
  stages: z.array(z.string().min(1)).optional(),
});
type CreatePipelineInput = z.infer<typeof createPipelineInput>;

const createPipeline: ActionDef<CreatePipelineInput, PipelineView> = {
  id: 'M05.A01',
  slug: 'pipelines.create_pipeline',
  module: MODULE,
  name: 'Create pipeline',
  description: 'Create a new sales pipeline with an ordered stage list.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createPipelineInput,
  outputSchema: pipelineView,
  searchCard: {
    synonyms: ['add pipeline', 'new sales pipeline'],
    examplePhrasings: ['Create a pipeline called Enterprise Sales'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const stages = input.stages && input.stages.length > 0 ? input.stages : [...DEFAULT_STAGES];
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify({ stages })],
    );
    return toView(getPipelineRow(ctx.db, id));
  }),
};

// --- A02 get_pipeline_configuration ---------------------------------------------

const getPipelineConfigurationInput = z.strictObject({ id: z.string() });

const getPipelineConfiguration: ActionDef<z.infer<typeof getPipelineConfigurationInput>, PipelineView> = {
  id: 'M05.A02',
  slug: 'pipelines.get_pipeline_configuration',
  module: MODULE,
  name: 'Get pipeline configuration',
  description: 'Fetch a pipeline and its ordered stage list.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getPipelineConfigurationInput,
  outputSchema: pipelineView,
  searchCard: {
    synonyms: ['pipeline details', 'pipeline stages'],
    examplePhrasings: ['Show me the stages in this pipeline'],
  },
  handler: async (input, ctx) => toView(getPipelineRow(ctx.db, input.id)),
};

// --- A03 list_pipelines --------------------------------------------------------

const listPipelinesInput = z.strictObject({
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListPipelinesInput = z.infer<typeof listPipelinesInput>;
const listPipelinesOutput = listOutputSchema(pipelineView);
type ListPipelinesOutput = ListOrSpill<PipelineView>;

const listPipelines: ActionDef<ListPipelinesInput, ListPipelinesOutput> = {
  id: 'M05.A03',
  slug: 'pipelines.list_pipelines',
  module: MODULE,
  name: 'List pipelines',
  description: 'List non-archived pipelines.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listPipelinesInput,
  outputSchema: listPipelinesOutput,
  searchCard: {
    synonyms: ['all pipelines', 'show pipelines'],
    examplePhrasings: ['List our sales pipelines'],
  },
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

// --- A04 rename_pipeline -------------------------------------------------------

const renamePipelineInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const renamePipeline: ActionDef<z.infer<typeof renamePipelineInput>, PipelineView> = {
  id: 'M05.A04',
  slug: 'pipelines.rename_pipeline',
  module: MODULE,
  name: 'Rename pipeline',
  description: 'Rename a pipeline.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: renamePipelineInput,
  outputSchema: pipelineView,
  searchCard: {
    synonyms: ['change pipeline name'],
    examplePhrasings: ['Rename this pipeline to Enterprise Sales'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getPipelineRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET name = ?, updated_at = ? WHERE id = ?`, [
      input.name,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getPipelineRow(ctx.db, input.id));
  }),
};

// --- A05 archive_pipeline -------------------------------------------------------

const archivePipelineInput = z.strictObject({ id: z.string() });
const archivePipelineOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const archivePipeline: ActionDef<z.infer<typeof archivePipelineInput>, z.infer<typeof archivePipelineOutput>> = {
  id: 'M05.A05',
  slug: 'pipelines.archive_pipeline',
  module: MODULE,
  name: 'Archive pipeline',
  description: 'Soft-delete a pipeline.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: archivePipelineInput,
  outputSchema: archivePipelineOutput,
  searchCard: {
    synonyms: ['delete pipeline', 'remove pipeline'],
    examplePhrasings: ['Archive this pipeline'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPipelineRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET archived = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, archived: true as const };
  }),
};

// --- A06 add_pipeline_stage -----------------------------------------------------

const addPipelineStageInput = z.strictObject({ id: z.string(), stage: z.string().min(1) });

const addPipelineStage: ActionDef<z.infer<typeof addPipelineStageInput>, PipelineView> = {
  id: 'M05.A06',
  slug: 'pipelines.add_pipeline_stage',
  module: MODULE,
  name: 'Add pipeline stage',
  description: 'Append a new stage to a pipeline.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addPipelineStageInput,
  outputSchema: pipelineView,
  searchCard: {
    synonyms: ['add stage', 'new pipeline stage'],
    examplePhrasings: ['Add a "contract sent" stage to this pipeline'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPipelineRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.stages.includes(input.stage)) {
      throw new ActionError('CONFLICT', `Pipeline '${input.id}' already has a stage named '${input.stage}'.`);
    }
    const next = { ...config, stages: [...config.stages, input.stage] };
    writeConfig(ctx.db, input.id, next, ctx.clock.now());
    return toView(getPipelineRow(ctx.db, input.id));
  }),
};

// --- A07 rename_pipeline_stage ----------------------------------------------------

const renamePipelineStageInput = z.strictObject({
  id: z.string(),
  old_name: z.string().min(1),
  new_name: z.string().min(1),
});

const renamePipelineStage: ActionDef<z.infer<typeof renamePipelineStageInput>, PipelineView> = {
  id: 'M05.A07',
  slug: 'pipelines.rename_pipeline_stage',
  module: MODULE,
  name: 'Rename pipeline stage',
  description: 'Rename a stage in place, re-pointing opportunities currently in it.',
  risk: 'write',
  entities: ['structures', 'opportunities'],
  inputSchema: renamePipelineStageInput,
  outputSchema: pipelineView,
  searchCard: {
    synonyms: ['rename stage'],
    examplePhrasings: ["Rename this pipeline's negotiation stage to final review"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPipelineRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.stages.includes(input.old_name)) {
      throw new ActionError('NOT_FOUND', `Pipeline '${input.id}' has no stage named '${input.old_name}'.`);
    }
    if (input.old_name !== input.new_name && config.stages.includes(input.new_name)) {
      throw new ActionError('CONFLICT', `Pipeline '${input.id}' already has a stage named '${input.new_name}'.`);
    }
    const now = ctx.clock.now();
    const stages = config.stages.map((s) => (s === input.old_name ? input.new_name : s));
    const stageProbabilities = config.stage_probabilities ? { ...config.stage_probabilities } : undefined;
    if (stageProbabilities && input.old_name in stageProbabilities) {
      stageProbabilities[input.new_name] = stageProbabilities[input.old_name] as number;
      delete stageProbabilities[input.old_name];
    }
    writeConfig(ctx.db, input.id, { stages, stage_probabilities: stageProbabilities }, now);
    ctx.db.run(`UPDATE opportunities SET stage = ?, updated_at = ? WHERE pipeline_id = ? AND stage = ?`, [
      input.new_name,
      now,
      input.id,
      input.old_name,
    ]);
    return toView(getPipelineRow(ctx.db, input.id));
  }),
};

// --- A08 reorder_pipeline_stages ----------------------------------------------------

const reorderPipelineStagesInput = z.strictObject({ id: z.string(), stages: z.array(z.string().min(1)).min(1) });

const reorderPipelineStages: ActionDef<z.infer<typeof reorderPipelineStagesInput>, PipelineView> = {
  id: 'M05.A08',
  slug: 'pipelines.reorder_pipeline_stages',
  module: MODULE,
  name: 'Reorder pipeline stages',
  description: 'Replace a pipeline\'s stage order (must be the same set of stages).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: reorderPipelineStagesInput,
  outputSchema: pipelineView,
  searchCard: {
    synonyms: ['reorder stages', 'change stage order'],
    examplePhrasings: ['Move negotiation before proposal in this pipeline'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPipelineRow(ctx.db, input.id);
    const config = readConfig(row);
    const currentSet = new Set(config.stages);
    const nextSet = new Set(input.stages);
    const sameSet =
      currentSet.size === nextSet.size && [...currentSet].every((s) => nextSet.has(s));
    if (!sameSet) {
      throw new ActionError(
        'VALIDATION',
        `New stage order must contain exactly the pipeline's existing stages (${config.stages.join(', ')}).`,
      );
    }
    writeConfig(ctx.db, input.id, { ...config, stages: input.stages }, ctx.clock.now());
    return toView(getPipelineRow(ctx.db, input.id));
  }),
};

// --- A09 remove_empty_pipeline_stage ----------------------------------------------------

const removeEmptyPipelineStageInput = z.strictObject({ id: z.string(), stage: z.string().min(1) });

const removeEmptyPipelineStage: ActionDef<z.infer<typeof removeEmptyPipelineStageInput>, PipelineView> = {
  id: 'M05.A09',
  slug: 'pipelines.remove_empty_pipeline_stage',
  module: MODULE,
  name: 'Remove empty pipeline stage',
  description: 'Remove a stage, refusing if any opportunity currently occupies it.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: removeEmptyPipelineStageInput,
  outputSchema: pipelineView,
  searchCard: {
    synonyms: ['delete stage', 'remove unused stage'],
    examplePhrasings: ['Remove the unused "cold" stage from this pipeline'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPipelineRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.stages.includes(input.stage)) {
      throw new ActionError('NOT_FOUND', `Pipeline '${input.id}' has no stage named '${input.stage}'.`);
    }
    const inUse = ctx.db.get(
      `SELECT COUNT(*) AS n FROM opportunities WHERE pipeline_id = ? AND stage = ? AND archived = 0`,
      [input.id, input.stage],
    );
    const n = (inUse?.['n'] as number) ?? 0;
    if (n > 0) {
      throw new ActionError(
        'CONFLICT',
        `Cannot remove stage '${input.stage}' — ${n} opportunit${n === 1 ? 'y' : 'ies'} currently occupy it.`,
      );
    }
    const stages = config.stages.filter((s) => s !== input.stage);
    const stageProbabilities = config.stage_probabilities ? { ...config.stage_probabilities } : undefined;
    if (stageProbabilities) delete stageProbabilities[input.stage];
    writeConfig(ctx.db, input.id, { stages, stage_probabilities: stageProbabilities }, ctx.clock.now());
    return toView(getPipelineRow(ctx.db, input.id));
  }),
};

// --- A10 set_stage_win_probability ----------------------------------------------------

const setStageWinProbabilityInput = z.strictObject({
  id: z.string(),
  stage: z.string().min(1),
  probability: z.number().int().min(0).max(100),
});

const setStageWinProbability: ActionDef<z.infer<typeof setStageWinProbabilityInput>, PipelineView> = {
  id: 'M05.A10',
  slug: 'pipelines.set_stage_win_probability',
  module: MODULE,
  name: 'Set stage win probability',
  description:
    'Set the default win probability for a stage and apply it to opportunities currently in that stage.',
  risk: 'write',
  entities: ['structures', 'opportunities'],
  inputSchema: setStageWinProbabilityInput,
  outputSchema: pipelineView,
  searchCard: {
    synonyms: ['set stage probability', 'update win probability'],
    examplePhrasings: ['Set the negotiation stage to 70% win probability'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPipelineRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.stages.includes(input.stage)) {
      throw new ActionError('NOT_FOUND', `Pipeline '${input.id}' has no stage named '${input.stage}'.`);
    }
    const now = ctx.clock.now();
    const stageProbabilities = { ...(config.stage_probabilities ?? {}), [input.stage]: input.probability };
    writeConfig(ctx.db, input.id, { ...config, stage_probabilities: stageProbabilities }, now);
    ctx.db.run(`UPDATE opportunities SET probability = ?, updated_at = ? WHERE pipeline_id = ? AND stage = ?`, [
      input.probability,
      now,
      input.id,
      input.stage,
    ]);
    return toView(getPipelineRow(ctx.db, input.id));
  }),
};

export const m05Pipelines: ActionDef[] = [
  createPipeline as ActionDef,
  getPipelineConfiguration as ActionDef,
  listPipelines as ActionDef,
  renamePipeline as ActionDef,
  archivePipeline as ActionDef,
  addPipelineStage as ActionDef,
  renamePipelineStage as ActionDef,
  reorderPipelineStages as ActionDef,
  removeEmptyPipelineStage as ActionDef,
  setStageWinProbability as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified: 'archived' → 6, 'active' → 4 — the `status` business field,
 * independent of the `archived` soft-delete flag).
 */
export const m05DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'pipelines.list_pipelines',
    paramsA: { status: 'archived' },
    paramsB: { status: 'active' },
    expectDifferentCounts: true,
  },
];

/**
 * Every action below has `entities[0] === 'structures'` with `kind =
 * 'pipeline'` — the bare `id` field needs an action-scoped hint (see
 * `testing.ts`'s `${slug}:${field}` precedence tier) so smoke resolves it
 * to an actual pipeline row, not an arbitrary `structures` row of some
 * other kind.
 */
export const m05SynthHints: SynthHints = {
  'pipelines.get_pipeline_configuration:id': { table: 'structures', kind: KIND },
  'pipelines.rename_pipeline:id': { table: 'structures', kind: KIND },
  'pipelines.archive_pipeline:id': { table: 'structures', kind: KIND },
  'pipelines.add_pipeline_stage:id': { table: 'structures', kind: KIND },
  'pipelines.rename_pipeline_stage:id': { table: 'structures', kind: KIND },
  'pipelines.reorder_pipeline_stages:id': { table: 'structures', kind: KIND },
  'pipelines.remove_empty_pipeline_stage:id': { table: 'structures', kind: KIND },
  'pipelines.set_stage_win_probability:id': { table: 'structures', kind: KIND },
};
