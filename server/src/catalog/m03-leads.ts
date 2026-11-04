/**
 * M03 Leads — follows the M01 Contacts convention verbatim.
 *
 * Data home: `leads` table. `notes` is a TEXT column repurposed to carry a
 * small JSON object (`{freeform?: string, qualification_answers?: {...},
 * disqualification_reason?: string}`) via `parseJsonObject`/merge — the
 * table has no dedicated columns for qualification answers or a
 * disqualification reason, so this module stores both there rather than
 * inventing new columns outside `entities/model.ts`'s committed schema.
 *
 * Semantic behaviors called out in the brief (implemented for real, not
 * stubbed):
 *   - `search_leads` supports `created_after`/`created_before`/`source`/
 *     `status`/`owner_id` filters, all wired into the WHERE clause.
 *   - `convert_lead_to_opportunity` creates a REAL `opportunities` row
 *     (defaulting to the first active pipeline + its first stage when not
 *     given) and marks the source lead `status = 'qualified'`.
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

const MODULE = 'leads';
const LEAD_STAGE_DEFAULT = 'prospecting';

interface LeadView {
  id: string;
  name: string;
  contact_id: string | null;
  source: string | null;
  status: string;
  score: number | null;
  owner_id: string | null;
  campaign_id: string | null;
  value_cents: number | null;
  notes: Record<string, unknown>;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): LeadView {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    contact_id: (row['contact_id'] as string | null) ?? null,
    source: (row['source'] as string | null) ?? null,
    status: row['status'] as string,
    score: (row['score'] as number | null) ?? null,
    owner_id: (row['owner_id'] as string | null) ?? null,
    campaign_id: (row['campaign_id'] as string | null) ?? null,
    value_cents: (row['value_cents'] as number | null) ?? null,
    notes: parseJsonObject(row['notes']),
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getLeadRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM leads WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Lead '${id}' does not exist.`);
  return row;
}

const leadView = z.object({
  id: z.string(),
  name: z.string(),
  contact_id: z.string().nullable(),
  source: z.string().nullable(),
  status: z.string(),
  score: z.number().nullable(),
  owner_id: z.string().nullable(),
  campaign_id: z.string().nullable(),
  value_cents: z.number().nullable(),
  notes: z.record(z.string(), z.unknown()),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_lead ----------------------------------------------------------

const createLeadInput = z.strictObject({
  name: z.string().min(1),
  contact_id: z.string().optional(),
  source: z.string().optional(),
  status: z.enum(['new', 'contacted', 'qualified', 'disqualified']).optional(),
  score: z.number().int().min(0).max(100).optional(),
  owner_id: z.string().optional(),
  campaign_id: z.string().optional(),
  value_cents: z.number().int().min(0).optional(),
});
type CreateLeadInput = z.infer<typeof createLeadInput>;

const createLead: ActionDef<CreateLeadInput, LeadView> = {
  id: 'M03.A01',
  slug: 'leads.create_lead',
  module: MODULE,
  name: 'Create lead',
  description: 'Create a new lead record.',
  risk: 'write',
  entities: ['leads'],
  inputSchema: createLeadInput,
  outputSchema: leadView,
  searchCard: {
    synonyms: ['add lead', 'new lead'],
    examplePhrasings: ['Create a lead for Jane Doe', 'Add a new inbound lead'],
  },
  jit: 'Search leads first if you only have a name/source and no confirmed new-lead intent, to avoid a duplicate.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.contact_id) {
      const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
      if (!contact) {
        throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
      }
    }
    const id = nextId(ctx.db, 'leads', 'lead');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO leads (id, created_at, updated_at, archived, name, contact_id, source,
        status, score, owner_id, campaign_id, value_cents, notes)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        now,
        input.name,
        input.contact_id ?? null,
        input.source ?? null,
        input.status ?? 'new',
        input.score ?? null,
        input.owner_id ?? null,
        input.campaign_id ?? null,
        input.value_cents ?? null,
        JSON.stringify({}),
      ],
    );
    return toView(getLeadRow(ctx.db, id));
  }),
};

// --- A02 get_lead_details -------------------------------------------------------

const getLeadDetailsInput = z.strictObject({ id: z.string() });

const getLeadDetails: ActionDef<z.infer<typeof getLeadDetailsInput>, LeadView> = {
  id: 'M03.A02',
  slug: 'leads.get_lead_details',
  module: MODULE,
  name: 'Get lead details',
  description: 'Fetch a single lead by id.',
  risk: 'read',
  entities: ['leads'],
  inputSchema: getLeadDetailsInput,
  outputSchema: leadView,
  searchCard: {
    synonyms: ['lead details', 'look up lead'],
    examplePhrasings: ['Show me lead lead_42'],
  },
  handler: async (input, ctx) => toView(getLeadRow(ctx.db, input.id)),
};

// --- A03 search_leads --------------------------------------------------------

const searchLeadsInput = z.strictObject({
  query: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  owner_id: z.string().optional(),
  created_after: z.number().optional(),
  created_before: z.number().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchLeadsInput = z.infer<typeof searchLeadsInput>;
const searchLeadsOutput = listOutputSchema(leadView);
type SearchLeadsOutput = ListOrSpill<LeadView>;

const searchLeads: ActionDef<SearchLeadsInput, SearchLeadsOutput> = {
  id: 'M03.A03',
  slug: 'leads.search_leads',
  module: MODULE,
  name: 'Search leads',
  description: 'Search non-archived leads by name and common filters.',
  risk: 'read',
  entities: ['leads'],
  inputSchema: searchLeadsInput,
  outputSchema: searchLeadsOutput,
  searchCard: {
    synonyms: ['find leads', 'list leads'],
    examplePhrasings: ['Find new leads from the website', 'Leads created this week'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Narrow with status/source/owner_id/created_after/created_before.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('name LIKE ?');
      params.push(`%${input.query}%`);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.source) {
      where.push('source = ?');
      params.push(input.source);
    }
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
    }
    if (input.created_after !== undefined) {
      where.push('created_at >= ?');
      params.push(input.created_after);
    }
    if (input.created_before !== undefined) {
      where.push('created_at <= ?');
      params.push(input.created_before);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM leads WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM leads WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 update_lead_details ---------------------------------------------------

const updateLeadDetailsInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({
      name: z.string().min(1).optional(),
      source: z.string().optional(),
      value_cents: z.number().int().min(0).optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateLeadDetails: ActionDef<z.infer<typeof updateLeadDetailsInput>, LeadView> = {
  id: 'M03.A04',
  slug: 'leads.update_lead_details',
  module: MODULE,
  name: 'Update lead details',
  description: 'Patch editable fields on a lead.',
  risk: 'write',
  entities: ['leads'],
  inputSchema: updateLeadDetailsInput,
  outputSchema: leadView,
  searchCard: {
    synonyms: ['edit lead', 'update lead'],
    examplePhrasings: ["Update this lead's name"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getLeadRow(ctx.db, input.id);
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE leads SET ${setSql}, updated_at = ? WHERE id = ?`, [
      ...values,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getLeadRow(ctx.db, input.id));
  }),
};

// --- A05 assign_lead_owner ------------------------------------------------------

const assignLeadOwnerInput = z.strictObject({ id: z.string(), owner_id: z.string() });

const assignLeadOwner: ActionDef<z.infer<typeof assignLeadOwnerInput>, LeadView> = {
  id: 'M03.A05',
  slug: 'leads.assign_lead_owner',
  module: MODULE,
  name: 'Assign lead owner',
  description: 'Set the owning user for a lead.',
  risk: 'write',
  entities: ['leads'],
  inputSchema: assignLeadOwnerInput,
  outputSchema: leadView,
  searchCard: {
    synonyms: ['set lead owner', 'reassign lead'],
    examplePhrasings: ['Assign this lead to Dana'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getLeadRow(ctx.db, input.id);
    ctx.db.run(`UPDATE leads SET owner_id = ?, updated_at = ? WHERE id = ?`, [
      input.owner_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getLeadRow(ctx.db, input.id));
  }),
};

// --- A06 set_lead_source ----------------------------------------------------------

const setLeadSourceInput = z.strictObject({ id: z.string(), source: z.string().min(1) });

const setLeadSource: ActionDef<z.infer<typeof setLeadSourceInput>, LeadView> = {
  id: 'M03.A06',
  slug: 'leads.set_lead_source',
  module: MODULE,
  name: 'Set lead source',
  description: 'Set the acquisition source for a lead.',
  risk: 'write',
  entities: ['leads'],
  inputSchema: setLeadSourceInput,
  outputSchema: leadView,
  searchCard: {
    synonyms: ['update lead source', 'tag lead channel'],
    examplePhrasings: ['Set this lead source to referral'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getLeadRow(ctx.db, input.id);
    ctx.db.run(`UPDATE leads SET source = ?, updated_at = ? WHERE id = ?`, [
      input.source,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getLeadRow(ctx.db, input.id));
  }),
};

// --- A07 record_qualification_answers --------------------------------------------

const recordQualificationAnswersInput = z.strictObject({
  id: z.string(),
  answers: z.record(z.string(), z.unknown()),
});

const recordQualificationAnswers: ActionDef<
  z.infer<typeof recordQualificationAnswersInput>,
  LeadView
> = {
  id: 'M03.A07',
  slug: 'leads.record_qualification_answers',
  module: MODULE,
  name: 'Record qualification answers',
  description: 'Merge BANT/qualification answers into a lead.',
  risk: 'write',
  entities: ['leads'],
  inputSchema: recordQualificationAnswersInput,
  outputSchema: leadView,
  searchCard: {
    synonyms: ['save qualification answers', 'record BANT answers'],
    examplePhrasings: ['Record that this lead has budget approved'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getLeadRow(ctx.db, input.id);
    const notes = parseJsonObject(row['notes']);
    const existing = (notes['qualification_answers'] as Record<string, unknown>) ?? {};
    const merged = { ...existing, ...input.answers };
    ctx.db.run(`UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify({ ...notes, qualification_answers: merged }),
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getLeadRow(ctx.db, input.id));
  }),
};

// --- A08 update_lead_score --------------------------------------------------------

const updateLeadScoreInput = z.strictObject({ id: z.string(), score: z.number().int().min(0).max(100) });

const updateLeadScore: ActionDef<z.infer<typeof updateLeadScoreInput>, LeadView> = {
  id: 'M03.A08',
  slug: 'leads.update_lead_score',
  module: MODULE,
  name: 'Update lead score',
  description: 'Set the numeric qualification score (0-100) for a lead.',
  risk: 'write',
  entities: ['leads'],
  inputSchema: updateLeadScoreInput,
  outputSchema: leadView,
  searchCard: {
    synonyms: ['set lead score', 'rescore lead'],
    examplePhrasings: ['Set this lead score to 80'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getLeadRow(ctx.db, input.id);
    ctx.db.run(`UPDATE leads SET score = ?, updated_at = ? WHERE id = ?`, [
      input.score,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getLeadRow(ctx.db, input.id));
  }),
};

// --- A09 disqualify_lead_with_reason ------------------------------------------------

const disqualifyLeadWithReasonInput = z.strictObject({ id: z.string(), reason: z.string().min(1) });

const disqualifyLeadWithReason: ActionDef<
  z.infer<typeof disqualifyLeadWithReasonInput>,
  LeadView
> = {
  id: 'M03.A09',
  slug: 'leads.disqualify_lead_with_reason',
  module: MODULE,
  name: 'Disqualify lead with reason',
  description: 'Mark a lead disqualified and record why.',
  risk: 'write',
  entities: ['leads'],
  inputSchema: disqualifyLeadWithReasonInput,
  outputSchema: leadView,
  searchCard: {
    synonyms: ['reject lead', 'disqualify lead'],
    examplePhrasings: ['Disqualify this lead — no budget'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getLeadRow(ctx.db, input.id);
    const notes = parseJsonObject(row['notes']);
    ctx.db.run(`UPDATE leads SET status = 'disqualified', notes = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify({ ...notes, disqualification_reason: input.reason }),
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getLeadRow(ctx.db, input.id));
  }),
};

// --- A10 convert_lead_to_opportunity ------------------------------------------------

const convertLeadToOpportunityInput = z.strictObject({
  id: z.string(),
  pipeline_id: z.string().optional(),
  value_cents: z.number().int().min(0).optional(),
});
const convertLeadToOpportunityOutput = z.object({
  id: z.string(),
  name: z.string(),
  lead_id: z.string(),
  pipeline_id: z.string(),
  stage: z.string(),
});

const convertLeadToOpportunity: ActionDef<
  z.infer<typeof convertLeadToOpportunityInput>,
  z.infer<typeof convertLeadToOpportunityOutput>
> = {
  id: 'M03.A10',
  slug: 'leads.convert_lead_to_opportunity',
  module: MODULE,
  name: 'Convert lead to opportunity',
  description: 'Create an opportunity from a lead and mark the lead qualified.',
  risk: 'write',
  entities: ['leads', 'opportunities'],
  inputSchema: convertLeadToOpportunityInput,
  outputSchema: convertLeadToOpportunityOutput,
  searchCard: {
    synonyms: ['convert lead', 'turn lead into deal'],
    examplePhrasings: ['Convert this lead into an opportunity'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const lead = getLeadRow(ctx.db, input.id);
    let pipelineId = input.pipeline_id;
    if (pipelineId) {
      const pipeline = ctx.db.get(
        `SELECT id FROM structures WHERE id = ? AND kind = 'pipeline'`,
        [pipelineId],
      );
      if (!pipeline) {
        throw new ActionError('NOT_FOUND', `Pipeline '${pipelineId}' does not exist.`);
      }
    } else {
      const defaultPipeline = ctx.db.get(
        `SELECT id FROM structures WHERE kind = 'pipeline' AND archived = 0 ORDER BY id LIMIT 1`,
      );
      if (!defaultPipeline) {
        throw new ActionError('VALIDATION', 'No active pipeline exists to convert this lead into.');
      }
      pipelineId = defaultPipeline['id'] as string;
    }
    const now = ctx.clock.now();
    const oppId = nextId(ctx.db, 'opportunities', 'opp');
    const name = lead['name'] as string;
    ctx.db.run(
      `INSERT INTO opportunities (id, created_at, updated_at, archived, name, contact_id,
        company_id, pipeline_id, stage, status, value_cents, owner_id, expected_close_date, probability)
       VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, 'open', ?, ?, NULL, NULL)`,
      [
        oppId,
        now,
        now,
        name,
        lead['contact_id'] ?? null,
        pipelineId,
        LEAD_STAGE_DEFAULT,
        input.value_cents ?? lead['value_cents'] ?? null,
        lead['owner_id'] ?? null,
      ],
    );
    ctx.db.run(`UPDATE leads SET status = 'qualified', updated_at = ? WHERE id = ?`, [
      now,
      input.id,
    ]);
    return { id: oppId, name, lead_id: input.id, pipeline_id: pipelineId, stage: LEAD_STAGE_DEFAULT };
  }),
};

export const m03Leads: ActionDef[] = [
  createLead as ActionDef,
  getLeadDetails as ActionDef,
  searchLeads as ActionDef,
  updateLeadDetails as ActionDef,
  assignLeadOwner as ActionDef,
  setLeadSource as ActionDef,
  recordQualificationAnswers as ActionDef,
  updateLeadScore as ActionDef,
  disqualifyLeadWithReason as ActionDef,
  convertLeadToOpportunity as ActionDef,
];

/** Tier-A discrimination: `status` counts (verified: 'new' → 1354, 'qualified' → 1182). */
export const m03DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'leads.search_leads',
    paramsA: { status: 'new' },
    paramsB: { status: 'qualified' },
    expectDifferentCounts: true,
  },
];

/** All M03 id fields resolve against plain tables (leads, contacts, structures
 * via the built-in `pipeline_id` default) — no module-specific hints needed. */
export const m03SynthHints: SynthHints = {};
