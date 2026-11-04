/**
 * M04 Opportunities — follows the M01 Contacts convention verbatim.
 *
 * Data home: `opportunities` table. `pipeline_id` points at a `structures`
 * row with `kind = 'pipeline'`; that row's `config.stages` (JSON array of
 * stage names, maintained by M05 Pipelines) is the source of truth for
 * which stage names are valid — `move_opportunity_to_stage` validates
 * against it for real (brief-mandated semantic behavior), falling back to
 * the opportunity schema's own default stage set when a pipeline has no
 * `config.stages` yet (freshly-seeded pipelines ship with a placeholder
 * config and no stages array).
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

const MODULE = 'opportunities';

/** Fallback stage set used when a pipeline's `config.stages` is absent. */
const DEFAULT_STAGES = [
  'prospecting',
  'qualification',
  'proposal',
  'negotiation',
  'closed_won',
  'closed_lost',
] as const;

interface OpportunityView {
  id: string;
  name: string;
  contact_id: string | null;
  company_id: string | null;
  pipeline_id: string | null;
  stage: string | null;
  status: string;
  value_cents: number | null;
  owner_id: string | null;
  expected_close_date: number | null;
  probability: number | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): OpportunityView {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    contact_id: (row['contact_id'] as string | null) ?? null,
    company_id: (row['company_id'] as string | null) ?? null,
    pipeline_id: (row['pipeline_id'] as string | null) ?? null,
    stage: (row['stage'] as string | null) ?? null,
    status: row['status'] as string,
    value_cents: (row['value_cents'] as number | null) ?? null,
    owner_id: (row['owner_id'] as string | null) ?? null,
    expected_close_date: (row['expected_close_date'] as number | null) ?? null,
    probability: (row['probability'] as number | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getOpportunityRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM opportunities WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Opportunity '${id}' does not exist.`);
  return row;
}

function pipelineStages(db: StoreTx, pipelineId: string): string[] {
  const pipeline = db.get(`SELECT config FROM structures WHERE id = ? AND kind = 'pipeline'`, [
    pipelineId,
  ]);
  if (!pipeline) throw new ActionError('NOT_FOUND', `Pipeline '${pipelineId}' does not exist.`);
  const config = parseJsonObject(pipeline['config']);
  const stages = Array.isArray(config['stages']) ? (config['stages'] as string[]) : undefined;
  return stages && stages.length > 0 ? stages : [...DEFAULT_STAGES];
}

const opportunityView = z.object({
  id: z.string(),
  name: z.string(),
  contact_id: z.string().nullable(),
  company_id: z.string().nullable(),
  pipeline_id: z.string().nullable(),
  stage: z.string().nullable(),
  status: z.string(),
  value_cents: z.number().nullable(),
  owner_id: z.string().nullable(),
  expected_close_date: z.number().nullable(),
  probability: z.number().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_opportunity ---------------------------------------------------

const createOpportunityInput = z.strictObject({
  name: z.string().min(1),
  contact_id: z.string().optional(),
  company_id: z.string().optional(),
  pipeline_id: z.string().optional(),
  stage: z.string().optional(),
  value_cents: z.number().int().min(0).optional(),
  owner_id: z.string().optional(),
  expected_close_date: z.number().optional(),
});
type CreateOpportunityInput = z.infer<typeof createOpportunityInput>;

const createOpportunity: ActionDef<CreateOpportunityInput, OpportunityView> = {
  id: 'M04.A01',
  slug: 'opportunities.create_opportunity',
  module: MODULE,
  name: 'Create opportunity',
  description: 'Create a new sales opportunity.',
  risk: 'write',
  entities: ['opportunities'],
  inputSchema: createOpportunityInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['add opportunity', 'new deal'],
    examplePhrasings: ['Create an opportunity for Acme Inc', 'Add a new deal'],
  },
  jit: 'A pipeline + stage default to the first active pipeline and prospecting when omitted.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.contact_id) {
      const c = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
      if (!c) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    }
    if (input.company_id) {
      const c = ctx.db.get(`SELECT id FROM companies WHERE id = ?`, [input.company_id]);
      if (!c) throw new ActionError('NOT_FOUND', `Company '${input.company_id}' does not exist.`);
    }
    let pipelineId = input.pipeline_id;
    if (pipelineId) {
      pipelineStages(ctx.db, pipelineId); // existence check
    } else {
      const defaultPipeline = ctx.db.get(
        `SELECT id FROM structures WHERE kind = 'pipeline' AND archived = 0 ORDER BY id LIMIT 1`,
      );
      pipelineId = defaultPipeline?.['id'] as string | undefined;
    }
    const stage = input.stage ?? DEFAULT_STAGES[0];
    const id = nextId(ctx.db, 'opportunities', 'opp');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO opportunities (id, created_at, updated_at, archived, name, contact_id,
        company_id, pipeline_id, stage, status, value_cents, owner_id, expected_close_date, probability)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`,
      [
        id,
        now,
        now,
        input.name,
        input.contact_id ?? null,
        input.company_id ?? null,
        pipelineId ?? null,
        stage,
        input.value_cents ?? null,
        input.owner_id ?? null,
        input.expected_close_date ?? null,
      ],
    );
    return toView(getOpportunityRow(ctx.db, id));
  }),
};

// --- A02 get_opportunity_details -----------------------------------------------

const getOpportunityDetailsInput = z.strictObject({ id: z.string() });

const getOpportunityDetails: ActionDef<z.infer<typeof getOpportunityDetailsInput>, OpportunityView> = {
  id: 'M04.A02',
  slug: 'opportunities.get_opportunity_details',
  module: MODULE,
  name: 'Get opportunity details',
  description: 'Fetch a single opportunity by id.',
  risk: 'read',
  entities: ['opportunities'],
  inputSchema: getOpportunityDetailsInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['opportunity details', 'look up deal'],
    examplePhrasings: ['Show me opportunity opp_7'],
  },
  handler: async (input, ctx) => toView(getOpportunityRow(ctx.db, input.id)),
};

// --- A03 search_opportunities --------------------------------------------------

const searchOpportunitiesInput = z.strictObject({
  query: z.string().optional(),
  stage: z.string().optional(),
  status: z.string().optional(),
  owner_id: z.string().optional(),
  pipeline_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchOpportunitiesInput = z.infer<typeof searchOpportunitiesInput>;
const searchOpportunitiesOutput = listOutputSchema(opportunityView);
type SearchOpportunitiesOutput = ListOrSpill<OpportunityView>;

const searchOpportunities: ActionDef<SearchOpportunitiesInput, SearchOpportunitiesOutput> = {
  id: 'M04.A03',
  slug: 'opportunities.search_opportunities',
  module: MODULE,
  name: 'Search opportunities',
  description: 'Search non-archived opportunities by name and common filters.',
  risk: 'read',
  entities: ['opportunities'],
  inputSchema: searchOpportunitiesInput,
  outputSchema: searchOpportunitiesOutput,
  searchCard: {
    synonyms: ['find opportunities', 'list deals'],
    examplePhrasings: ['Find open opportunities', 'Deals in the negotiation stage'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Narrow with stage/status/owner_id/pipeline_id.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('name LIKE ?');
      params.push(`%${input.query}%`);
    }
    if (input.stage) {
      where.push('stage = ?');
      params.push(input.stage);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
    }
    if (input.pipeline_id) {
      where.push('pipeline_id = ?');
      params.push(input.pipeline_id);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM opportunities WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM opportunities WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 update_opportunity_value -----------------------------------------------

const updateOpportunityValueInput = z.strictObject({ id: z.string(), value_cents: z.number().int().min(0) });

const updateOpportunityValue: ActionDef<z.infer<typeof updateOpportunityValueInput>, OpportunityView> = {
  id: 'M04.A04',
  slug: 'opportunities.update_opportunity_value',
  module: MODULE,
  name: 'Update opportunity value',
  description: 'Set the deal value (in cents) on an opportunity.',
  risk: 'write',
  entities: ['opportunities'],
  inputSchema: updateOpportunityValueInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['set deal value', 'update opportunity amount'],
    examplePhrasings: ['Set this deal to $5,000'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getOpportunityRow(ctx.db, input.id);
    ctx.db.run(`UPDATE opportunities SET value_cents = ?, updated_at = ? WHERE id = ?`, [
      input.value_cents,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getOpportunityRow(ctx.db, input.id));
  }),
};

// --- A05 move_opportunity_to_stage -----------------------------------------------

const moveOpportunityToStageInput = z.strictObject({ id: z.string(), stage: z.string().min(1) });

const moveOpportunityToStage: ActionDef<z.infer<typeof moveOpportunityToStageInput>, OpportunityView> = {
  id: 'M04.A05',
  slug: 'opportunities.move_opportunity_to_stage',
  module: MODULE,
  name: 'Move opportunity to stage',
  description: "Move an opportunity to a stage that exists in its pipeline's configuration.",
  risk: 'write',
  entities: ['opportunities', 'structures'],
  inputSchema: moveOpportunityToStageInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['advance deal stage', 'change opportunity stage'],
    examplePhrasings: ['Move this deal to negotiation'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getOpportunityRow(ctx.db, input.id);
    const pipelineId = row['pipeline_id'] as string | null;
    if (!pipelineId) {
      throw new ActionError('VALIDATION', `Opportunity '${input.id}' has no pipeline assigned.`);
    }
    const stages = pipelineStages(ctx.db, pipelineId);
    if (!stages.includes(input.stage)) {
      throw new ActionError(
        'VALIDATION',
        `Stage '${input.stage}' is not configured on pipeline '${pipelineId}' (known stages: ${stages.join(', ')}).`,
      );
    }
    ctx.db.run(`UPDATE opportunities SET stage = ?, updated_at = ? WHERE id = ?`, [
      input.stage,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getOpportunityRow(ctx.db, input.id));
  }),
};

// --- A06 assign_opportunity_owner -----------------------------------------------

const assignOpportunityOwnerInput = z.strictObject({ id: z.string(), owner_id: z.string() });

const assignOpportunityOwner: ActionDef<z.infer<typeof assignOpportunityOwnerInput>, OpportunityView> = {
  id: 'M04.A06',
  slug: 'opportunities.assign_opportunity_owner',
  module: MODULE,
  name: 'Assign opportunity owner',
  description: 'Set the owning user for an opportunity.',
  risk: 'write',
  entities: ['opportunities'],
  inputSchema: assignOpportunityOwnerInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['set deal owner', 'reassign opportunity'],
    examplePhrasings: ['Assign this deal to Dana'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getOpportunityRow(ctx.db, input.id);
    ctx.db.run(`UPDATE opportunities SET owner_id = ?, updated_at = ? WHERE id = ?`, [
      input.owner_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getOpportunityRow(ctx.db, input.id));
  }),
};

// --- A07 set_expected_close_date -----------------------------------------------

const setExpectedCloseDateInput = z.strictObject({ id: z.string(), expected_close_date: z.number() });

const setExpectedCloseDate: ActionDef<z.infer<typeof setExpectedCloseDateInput>, OpportunityView> = {
  id: 'M04.A07',
  slug: 'opportunities.set_expected_close_date',
  module: MODULE,
  name: 'Set expected close date',
  description: 'Set the expected close date (epoch ms) on an opportunity.',
  risk: 'write',
  entities: ['opportunities'],
  inputSchema: setExpectedCloseDateInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['set close date', 'update expected close'],
    examplePhrasings: ['Set the expected close date to next Friday'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getOpportunityRow(ctx.db, input.id);
    ctx.db.run(`UPDATE opportunities SET expected_close_date = ?, updated_at = ? WHERE id = ?`, [
      input.expected_close_date,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getOpportunityRow(ctx.db, input.id));
  }),
};

// --- A08 mark_opportunity_won -----------------------------------------------------

const markOpportunityWonInput = z.strictObject({ id: z.string() });

const markOpportunityWon: ActionDef<z.infer<typeof markOpportunityWonInput>, OpportunityView> = {
  id: 'M04.A08',
  slug: 'opportunities.mark_opportunity_won',
  module: MODULE,
  name: 'Mark opportunity won',
  description: 'Close an opportunity as won.',
  risk: 'write',
  entities: ['opportunities'],
  inputSchema: markOpportunityWonInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['close deal as won', 'mark deal won'],
    examplePhrasings: ['Mark this deal as won'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getOpportunityRow(ctx.db, input.id); // existence check
    // Unconditional UPDATE (even if already 'won') — idempotent in EFFECT,
    // and keeps the write observably a write rather than a silent no-op
    // when called twice on an already-won deal.
    ctx.db.run(
      `UPDATE opportunities SET status = 'won', stage = 'closed_won', probability = 100, updated_at = ? WHERE id = ?`,
      [ctx.clock.now(), input.id],
    );
    return toView(getOpportunityRow(ctx.db, input.id));
  }),
};

// --- A09 mark_opportunity_lost -----------------------------------------------------

const markOpportunityLostInput = z.strictObject({ id: z.string() });

const markOpportunityLost: ActionDef<z.infer<typeof markOpportunityLostInput>, OpportunityView> = {
  id: 'M04.A09',
  slug: 'opportunities.mark_opportunity_lost',
  module: MODULE,
  name: 'Mark opportunity lost',
  description: 'Close an opportunity as lost.',
  risk: 'write',
  entities: ['opportunities'],
  inputSchema: markOpportunityLostInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['close deal as lost', 'mark deal lost'],
    examplePhrasings: ['Mark this deal as lost'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getOpportunityRow(ctx.db, input.id); // existence check
    ctx.db.run(
      `UPDATE opportunities SET status = 'lost', stage = 'closed_lost', probability = 0, updated_at = ? WHERE id = ?`,
      [ctx.clock.now(), input.id],
    );
    return toView(getOpportunityRow(ctx.db, input.id));
  }),
};

// --- A10 reopen_closed_opportunity -----------------------------------------------

const reopenClosedOpportunityInput = z.strictObject({ id: z.string() });

const reopenClosedOpportunity: ActionDef<z.infer<typeof reopenClosedOpportunityInput>, OpportunityView> = {
  id: 'M04.A10',
  slug: 'opportunities.reopen_closed_opportunity',
  module: MODULE,
  name: 'Reopen closed opportunity',
  description: 'Reopen a previously won/lost opportunity.',
  risk: 'write',
  entities: ['opportunities'],
  inputSchema: reopenClosedOpportunityInput,
  outputSchema: opportunityView,
  searchCard: {
    synonyms: ['reopen deal', 'undo close'],
    examplePhrasings: ['Reopen this closed opportunity'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getOpportunityRow(ctx.db, input.id);
    if (row['status'] === 'open') {
      throw new ActionError('CONFLICT', `Opportunity '${input.id}' is already open.`);
    }
    ctx.db.run(
      `UPDATE opportunities SET status = 'open', probability = NULL, updated_at = ? WHERE id = ?`,
      [ctx.clock.now(), input.id],
    );
    return toView(getOpportunityRow(ctx.db, input.id));
  }),
};

export const m04Opportunities: ActionDef[] = [
  createOpportunity as ActionDef,
  getOpportunityDetails as ActionDef,
  searchOpportunities as ActionDef,
  updateOpportunityValue as ActionDef,
  moveOpportunityToStage as ActionDef,
  assignOpportunityOwner as ActionDef,
  setExpectedCloseDate as ActionDef,
  markOpportunityWon as ActionDef,
  markOpportunityLost as ActionDef,
  reopenClosedOpportunity as ActionDef,
];

/** Tier-A discrimination: `status` counts (verified: 'open' → 713, 'won' → 188). */
export const m04DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'opportunities.search_opportunities',
    paramsA: { status: 'open' },
    paramsB: { status: 'won' },
    expectDifferentCounts: true,
  },
];

/** All M04 id fields resolve against plain tables or the built-in
 * `pipeline_id → structures(kind:pipeline)` default — no module-specific
 * hints needed. */
export const m04SynthHints: SynthHints = {};
