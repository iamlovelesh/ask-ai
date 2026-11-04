/**
 * M15 Campaigns — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'campaign'`. `config` (JSON) is
 * `{ audience: {filter_rules?, smart_list_id?}, message_steps:
 * Array<{template_id?,channel,delay_hours?,order}>, schedule?:
 * {starts_at?,timezone?}, launched_at? }`.
 *
 * `set_campaign_audience` stores the SAME filter-rules shape M09 Smart
 * Lists already uses (`{lifecycle_stage,owner_id,company_id,source}`) so a
 * campaign's audience is literally "a saved `search_contacts` filter set,"
 * optionally wrapping an existing smart list instead
 * (`smart_list_id`). `launch_campaign` is `risk:'bulk'` (audience-wide, per
 * LLD §5.3) and refuses (`VALIDATION`) to launch with zero message steps —
 * a genuinely-unsendable campaign. `get_campaign_performance` computes real
 * counts from `messages WHERE campaign_id = ?`, not a canned number.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10/M14): `entities[0]` is
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

const MODULE = 'campaigns';
const KIND = 'campaign';
const STATUSES = ['draft', 'active', 'paused', 'completed'] as const;

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'campaign'}-${id}`;
}

interface MessageStep {
  order: number;
  channel: 'sms' | 'email';
  template_id?: string | null | undefined;
  delay_hours?: number | null | undefined;
}

interface CampaignAudience {
  filter_rules: Record<string, unknown>;
  smart_list_id: string | null;
}

interface CampaignSchedule {
  starts_at: number | null;
  timezone: string | null;
}

interface CampaignConfig {
  audience: CampaignAudience;
  message_steps: MessageStep[];
  schedule: CampaignSchedule;
  launched_at: number | null;
}

function readConfig(row: Row): CampaignConfig {
  const config = parseJsonObject(row['config']);
  const audienceRaw = parseJsonObject(config['audience']);
  const scheduleRaw = parseJsonObject(config['schedule']);
  return {
    audience: {
      filter_rules:
        audienceRaw['filter_rules'] && typeof audienceRaw['filter_rules'] === 'object'
          ? (audienceRaw['filter_rules'] as Record<string, unknown>)
          : {},
      smart_list_id: (audienceRaw['smart_list_id'] as string | null | undefined) ?? null,
    },
    message_steps: Array.isArray(config['message_steps']) ? (config['message_steps'] as MessageStep[]) : [],
    schedule: {
      starts_at: (scheduleRaw['starts_at'] as number | null | undefined) ?? null,
      timezone: (scheduleRaw['timezone'] as string | null | undefined) ?? null,
    },
    launched_at: (config['launched_at'] as number | null | undefined) ?? null,
  };
}

function writeConfig(db: StoreTx, id: string, config: CampaignConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(config),
    now,
    id,
  ]);
}

interface CampaignView {
  id: string;
  name: string;
  status: string;
  audience: CampaignAudience;
  message_steps: MessageStep[];
  schedule: CampaignSchedule;
  launched_at: number | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): CampaignView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    audience: config.audience,
    message_steps: config.message_steps,
    schedule: config.schedule,
    launched_at: config.launched_at,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getCampaignRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Campaign '${id}' does not exist.`);
  return row;
}

const messageStepSchema = z.object({
  order: z.number(),
  channel: z.enum(['sms', 'email']),
  template_id: z.string().nullable().optional(),
  delay_hours: z.number().nullable().optional(),
});
const campaignView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  audience: z.object({
    filter_rules: z.record(z.string(), z.unknown()),
    smart_list_id: z.string().nullable(),
  }),
  message_steps: z.array(messageStepSchema),
  schedule: z.object({ starts_at: z.number().nullable(), timezone: z.string().nullable() }),
  launched_at: z.number().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_campaign ---------------------------------------------------

const createCampaignInput = z.strictObject({ name: z.string().min(1) });

const createCampaign: ActionDef<z.infer<typeof createCampaignInput>, CampaignView> = {
  id: 'M15.A01',
  slug: 'campaigns.create_campaign',
  module: MODULE,
  name: 'Create campaign',
  description: 'Create a new draft marketing campaign.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createCampaignInput,
  outputSchema: campaignView,
  searchCard: {
    synonyms: ['add campaign', 'new marketing campaign'],
    examplePhrasings: ['Create a campaign for our fall product launch'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: CampaignConfig = {
      audience: { filter_rules: {}, smart_list_id: null },
      message_steps: [],
      schedule: { starts_at: null, timezone: null },
      launched_at: null,
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getCampaignRow(ctx.db, id));
  }),
};

// --- A02 get_campaign_details ---------------------------------------------------

const getCampaignDetailsInput = z.strictObject({ id: z.string() });

const getCampaignDetails: ActionDef<z.infer<typeof getCampaignDetailsInput>, CampaignView> = {
  id: 'M15.A02',
  slug: 'campaigns.get_campaign_details',
  module: MODULE,
  name: 'Get campaign details',
  description: 'Fetch a single campaign by id.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getCampaignDetailsInput,
  outputSchema: campaignView,
  searchCard: {
    synonyms: ['campaign details', 'look up campaign'],
    examplePhrasings: ['Show me this campaign'],
  },
  handler: async (input, ctx) => toView(getCampaignRow(ctx.db, input.id)),
};

// --- A03 list_campaigns --------------------------------------------------------

const listCampaignsInput = z.strictObject({
  status: z.enum(STATUSES).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListCampaignsInput = z.infer<typeof listCampaignsInput>;
const listCampaignsOutput = listOutputSchema(campaignView);
type ListCampaignsOutput = ListOrSpill<CampaignView>;

const listCampaigns: ActionDef<ListCampaignsInput, ListCampaignsOutput> = {
  id: 'M15.A03',
  slug: 'campaigns.list_campaigns',
  module: MODULE,
  name: 'List campaigns',
  description: 'List non-archived campaigns.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listCampaignsInput,
  outputSchema: listCampaignsOutput,
  searchCard: {
    synonyms: ['all campaigns', 'show campaigns'],
    examplePhrasings: ['List our active campaigns'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
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

// --- A04 set_campaign_audience --------------------------------------------------

const setCampaignAudienceInput = z.strictObject({
  id: z.string(),
  filter_rules: z.record(z.string(), z.unknown()).optional(),
  smart_list_id: z.string().optional(),
});

const setCampaignAudience: ActionDef<z.infer<typeof setCampaignAudienceInput>, CampaignView> = {
  id: 'M15.A04',
  slug: 'campaigns.set_campaign_audience',
  module: MODULE,
  name: 'Set campaign audience',
  description:
    'Store the audience definition for a campaign — a filter-rules set (same vocabulary as smart lists) or a reference to an existing smart list.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setCampaignAudienceInput,
  outputSchema: campaignView,
  searchCard: {
    synonyms: ['set campaign segment', 'define campaign audience'],
    examplePhrasings: ['Target this campaign at customers owned by Dana'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCampaignRow(ctx.db, input.id);
    if (input.smart_list_id) {
      const smartList = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'smart_list'`, [
        input.smart_list_id,
      ]);
      if (!smartList) {
        throw new ActionError('NOT_FOUND', `Smart list '${input.smart_list_id}' does not exist.`);
      }
    }
    const config = readConfig(row);
    writeConfig(
      ctx.db,
      input.id,
      {
        ...config,
        audience: {
          filter_rules: input.filter_rules ?? config.audience.filter_rules,
          smart_list_id: input.smart_list_id ?? config.audience.smart_list_id,
        },
      },
      ctx.clock.now(),
    );
    return toView(getCampaignRow(ctx.db, input.id));
  }),
};

// --- A05 add_campaign_message_step --------------------------------------------------

const addCampaignMessageStepInput = z.strictObject({
  id: z.string(),
  channel: z.enum(['sms', 'email']),
  template_id: z.string().optional(),
  delay_hours: z.number().int().min(0).optional(),
});

const addCampaignMessageStep: ActionDef<z.infer<typeof addCampaignMessageStepInput>, CampaignView> = {
  id: 'M15.A05',
  slug: 'campaigns.add_campaign_message_step',
  module: MODULE,
  name: 'Add campaign message step',
  description: 'Append a message step (channel + optional template + delay) to a campaign sequence.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addCampaignMessageStepInput,
  outputSchema: campaignView,
  searchCard: {
    synonyms: ['add campaign step', 'add message to campaign'],
    examplePhrasings: ['Add an email step to this campaign using the welcome template'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCampaignRow(ctx.db, input.id);
    if (input.template_id) {
      const template = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'template'`, [
        input.template_id,
      ]);
      if (!template) {
        throw new ActionError('NOT_FOUND', `Template '${input.template_id}' does not exist.`);
      }
    }
    const config = readConfig(row);
    const step: MessageStep = {
      order: config.message_steps.length + 1,
      channel: input.channel,
      template_id: input.template_id ?? null,
      delay_hours: input.delay_hours ?? null,
    };
    writeConfig(
      ctx.db,
      input.id,
      { ...config, message_steps: [...config.message_steps, step] },
      ctx.clock.now(),
    );
    return toView(getCampaignRow(ctx.db, input.id));
  }),
};

// --- A06 set_campaign_schedule --------------------------------------------------

const setCampaignScheduleInput = z.strictObject({
  id: z.string(),
  starts_at: z.number(),
  timezone: z.string().optional(),
});

const setCampaignSchedule: ActionDef<z.infer<typeof setCampaignScheduleInput>, CampaignView> = {
  id: 'M15.A06',
  slug: 'campaigns.set_campaign_schedule',
  module: MODULE,
  name: 'Set campaign schedule',
  description: "Set a campaign's start time (and optional timezone).",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setCampaignScheduleInput,
  outputSchema: campaignView,
  searchCard: {
    synonyms: ['schedule campaign', 'set campaign start time'],
    examplePhrasings: ['Schedule this campaign to start next Monday'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCampaignRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(
      ctx.db,
      input.id,
      { ...config, schedule: { starts_at: input.starts_at, timezone: input.timezone ?? config.schedule.timezone } },
      ctx.clock.now(),
    );
    return toView(getCampaignRow(ctx.db, input.id));
  }),
};

// --- A07 launch_campaign --------------------------------------------------

const launchCampaignInput = z.strictObject({ id: z.string() });

const launchCampaign: ActionDef<z.infer<typeof launchCampaignInput>, CampaignView> = {
  id: 'M15.A07',
  slug: 'campaigns.launch_campaign',
  module: MODULE,
  name: 'Launch campaign',
  description: 'Launch a campaign to its full audience (segment-wide — always gates).',
  risk: 'bulk',
  entities: ['structures'],
  inputSchema: launchCampaignInput,
  outputSchema: campaignView,
  searchCard: {
    synonyms: ['start campaign', 'send campaign'],
    examplePhrasings: ['Launch this campaign to everyone in the audience'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCampaignRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.message_steps.length === 0) {
      throw new ActionError('VALIDATION', `Campaign '${input.id}' has no message steps — add at least one before launching.`);
    }
    const now = ctx.clock.now();
    writeConfig(ctx.db, input.id, { ...config, launched_at: now }, now);
    ctx.db.run(`UPDATE structures SET status = 'active', updated_at = ? WHERE id = ?`, [now, input.id]);
    return toView(getCampaignRow(ctx.db, input.id));
  }),
};

// --- A08 pause_campaign --------------------------------------------------

const pauseCampaignInput = z.strictObject({ id: z.string() });

const pauseCampaign: ActionDef<z.infer<typeof pauseCampaignInput>, CampaignView> = {
  id: 'M15.A08',
  slug: 'campaigns.pause_campaign',
  module: MODULE,
  name: 'Pause campaign',
  description: 'Pause an active campaign.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: pauseCampaignInput,
  outputSchema: campaignView,
  searchCard: {
    synonyms: ['stop campaign temporarily', 'pause sending', 'freeze this marketing sequence'],
    examplePhrasings: ['Pause this campaign', 'Freeze this marketing sequence for now'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCampaignRow(ctx.db, input.id);
    if (row['status'] !== 'active') {
      throw new ActionError('CONFLICT', `Campaign '${input.id}' is not active (status: '${row['status'] as string}').`);
    }
    ctx.db.run(`UPDATE structures SET status = 'paused', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getCampaignRow(ctx.db, input.id));
  }),
};

// --- A09 resume_campaign --------------------------------------------------

const resumeCampaignInput = z.strictObject({ id: z.string() });

const resumeCampaign: ActionDef<z.infer<typeof resumeCampaignInput>, CampaignView> = {
  id: 'M15.A09',
  slug: 'campaigns.resume_campaign',
  module: MODULE,
  name: 'Resume campaign',
  description: 'Resume a paused campaign.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: resumeCampaignInput,
  outputSchema: campaignView,
  searchCard: {
    synonyms: ['unpause campaign', 'restart campaign'],
    examplePhrasings: ['Resume this campaign'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCampaignRow(ctx.db, input.id);
    if (row['status'] !== 'paused') {
      throw new ActionError('CONFLICT', `Campaign '${input.id}' is not paused (status: '${row['status'] as string}').`);
    }
    ctx.db.run(`UPDATE structures SET status = 'active', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getCampaignRow(ctx.db, input.id));
  }),
};

// --- A10 get_campaign_performance --------------------------------------------------

const getCampaignPerformanceInput = z.strictObject({ id: z.string() });
const getCampaignPerformanceOutput = z.object({
  id: z.string(),
  name: z.string(),
  total_messages: z.number(),
  total_sent: z.number(),
  total_delivered: z.number(),
  total_failed: z.number(),
});
type GetCampaignPerformanceOutput = z.infer<typeof getCampaignPerformanceOutput>;

const getCampaignPerformance: ActionDef<
  z.infer<typeof getCampaignPerformanceInput>,
  GetCampaignPerformanceOutput
> = {
  id: 'M15.A10',
  slug: 'campaigns.get_campaign_performance',
  module: MODULE,
  name: 'Get campaign performance',
  description: 'Compute real message counts (sent/delivered/failed) for a campaign from its messages.',
  risk: 'read',
  entities: ['structures', 'messages'],
  inputSchema: getCampaignPerformanceInput,
  outputSchema: getCampaignPerformanceOutput,
  searchCard: {
    synonyms: ['campaign results', 'how did this campaign perform'],
    examplePhrasings: ['How many messages from this campaign were delivered?'],
  },
  handler: async (input, ctx) => {
    const row = getCampaignRow(ctx.db, input.id);
    const counts = ctx.db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('sent','delivered') THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM messages WHERE campaign_id = ? AND archived = 0`,
      [input.id],
    );
    return {
      id: input.id,
      name: row['name'] as string,
      total_messages: (counts?.['total'] as number) ?? 0,
      total_sent: (counts?.['sent'] as number) ?? 0,
      total_delivered: (counts?.['delivered'] as number) ?? 0,
      total_failed: (counts?.['failed'] as number) ?? 0,
    };
  },
};

export const m15Campaigns: ActionDef[] = [
  createCampaign as ActionDef,
  getCampaignDetails as ActionDef,
  listCampaigns as ActionDef,
  setCampaignAudience as ActionDef,
  addCampaignMessageStep as ActionDef,
  setCampaignSchedule as ActionDef,
  launchCampaign as ActionDef,
  pauseCampaign as ActionDef,
  resumeCampaign as ActionDef,
  getCampaignPerformance as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (pristine: 'active' → 10, 'paused' → 6, 'completed' → 9). This module's
 * own `launch_campaign`/`pause_campaign`/`resume_campaign` actions mutate
 * `status` during the same smoke run — empirically verified via
 * `npm run smoke -- --module m15` (and the full `--modules m11-m17` /
 * all-module run): live value is 'active' → 11, 'paused' → 6, margin 5.
 * (`ORDER BY id` in `synthesizeInput`'s id resolution is lexicographic on
 * the TEXT `id` column, not numeric, so don't trust a hand-traced
 * "which row is offset 0" — verify empirically via `npm run smoke`.)
 */
export const m15DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'campaigns.list_campaigns',
    paramsA: { status: 'active' },
    paramsB: { status: 'paused' },
    expectDifferentCounts: true,
  },
];

/**
 * Every action below has `entities[0] === 'structures'` with `kind =
 * 'campaign'` — the bare `id` field needs an action-scoped hint.
 * `smart_list_id` is also declared (flat, not scoped) since its meaning is
 * unambiguous catalog-wide and not yet in `testing.ts`'s `DEFAULT_HINTS`.
 */
export const m15SynthHints: SynthHints = {
  'campaigns.get_campaign_details:id': { table: 'structures', kind: KIND },
  'campaigns.set_campaign_audience:id': { table: 'structures', kind: KIND },
  'campaigns.add_campaign_message_step:id': { table: 'structures', kind: KIND },
  'campaigns.set_campaign_schedule:id': { table: 'structures', kind: KIND },
  'campaigns.launch_campaign:id': { table: 'structures', kind: KIND },
  'campaigns.pause_campaign:id': { table: 'structures', kind: KIND },
  'campaigns.resume_campaign:id': { table: 'structures', kind: KIND },
  'campaigns.get_campaign_performance:id': { table: 'structures', kind: KIND },
  smart_list_id: { table: 'structures', kind: 'smart_list' },
};
