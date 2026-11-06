/**
 * M36 Funnels — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'funnel'`. `config` is
 * `{ steps: FunnelStep[], conversion_goal: {name:string,target_count:number|
 * null}|null }`. Seeded funnel rows carry the generic placeholder
 * `{seeded:true,kind:'funnel'}` (`entities/seed-core.ts`), so `readConfig`
 * falls back to an empty step list — same "config absent" pattern as M05
 * pipelines.
 *
 * `get_funnel_conversion_metrics` (A10) is a REAL computation over each
 * step's linked `content_items(kind='landing_page')` row's `views` column
 * (genuine seeded/live data, not fabricated) — steps with no linked page
 * report `visits: null`.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/…): `entities[0]` is `'structures'`
 * — the bare `id` field needs an action-scoped synthHint.
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

const MODULE = 'funnels';
const KIND = 'funnel';
const LANDING_PAGE_KIND = 'landing_page';

function slugify(name: string, id: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'funnel'}-${id}`;
}

interface FunnelStep {
  id: string;
  name: string;
  type: string;
  landing_page_id: string | null;
}

interface ConversionGoal {
  name: string;
  target_count: number | null;
}

interface FunnelConfig {
  steps: FunnelStep[];
  conversion_goal: ConversionGoal | null;
}

function readConfig(row: Row): FunnelConfig {
  const config = parseJsonObject(row['config']);
  const goal = config['conversion_goal'];
  return {
    steps: Array.isArray(config['steps']) ? (config['steps'] as FunnelStep[]) : [],
    conversion_goal:
      goal && typeof goal === 'object'
        ? {
            name: ((goal as Record<string, unknown>)['name'] as string | undefined) ?? '',
            target_count: ((goal as Record<string, unknown>)['target_count'] as number | null | undefined) ?? null,
          }
        : null,
  };
}

function writeConfig(db: StoreTx, id: string, config: FunnelConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

function getFunnelRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Funnel '${id}' does not exist.`);
  return row;
}

function nextStepId(steps: readonly FunnelStep[], funnelId: string): string {
  const re = new RegExp(`^${funnelId}_step_(\\d+)$`);
  let maxN = 0;
  for (const s of steps) {
    const m = re.exec(s.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `${funnelId}_step_${maxN + 1}`;
}

interface FunnelView {
  id: string;
  name: string;
  status: string;
  steps: FunnelStep[];
  conversion_goal: ConversionGoal | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): FunnelView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    steps: config.steps,
    conversion_goal: config.conversion_goal,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const funnelStepSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), landing_page_id: z.string().nullable() });

const funnelView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  steps: z.array(funnelStepSchema),
  conversion_goal: z.object({ name: z.string(), target_count: z.number().nullable() }).nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_funnel -----------------------------------------------------

const createFunnelInput = z.strictObject({ name: z.string().min(1) });

const createFunnel: ActionDef<z.infer<typeof createFunnelInput>, FunnelView> = {
  id: 'M36.A01',
  slug: 'funnels.create_funnel',
  module: MODULE,
  name: 'Create funnel',
  description: 'Create a new marketing funnel (no steps yet — add them via add_funnel_step).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createFunnelInput,
  outputSchema: funnelView,
  searchCard: { synonyms: ['add funnel', 'new funnel'], examplePhrasings: ['Create a webinar signup funnel'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: FunnelConfig = { steps: [], conversion_goal: null };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getFunnelRow(ctx.db, id));
  }),
};

// --- A02 get_funnel_definition -----------------------------------------------

const getFunnelDefinitionInput = z.strictObject({ id: z.string() });

const getFunnelDefinition: ActionDef<z.infer<typeof getFunnelDefinitionInput>, FunnelView> = {
  id: 'M36.A02',
  slug: 'funnels.get_funnel_definition',
  module: MODULE,
  name: 'Get funnel definition',
  description: 'Fetch a funnel and its ordered steps.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getFunnelDefinitionInput,
  outputSchema: funnelView,
  searchCard: { synonyms: ['funnel details', 'funnel steps'], examplePhrasings: ['Show me this funnel'] },
  handler: async (input, ctx) => toView(getFunnelRow(ctx.db, input.id)),
};

// --- A03 list_funnels -----------------------------------------------------

const listFunnelsInput = z.strictObject({ status: z.string().optional(), limit: z.number().int().min(1).max(50).optional() });
type ListFunnelsInput = z.infer<typeof listFunnelsInput>;
const listFunnelsOutput = listOutputSchema(funnelView);
type ListFunnelsOutput = ListOrSpill<FunnelView>;

const listFunnels: ActionDef<ListFunnelsInput, ListFunnelsOutput> = {
  id: 'M36.A03',
  slug: 'funnels.list_funnels',
  module: MODULE,
  name: 'List funnels',
  description: 'List non-archived funnels.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listFunnelsInput,
  outputSchema: listFunnelsOutput,
  searchCard: { synonyms: ['all funnels', 'show funnels'], examplePhrasings: ['List our funnels'] },
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
    const rows = ctx.db.all(`SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'structures', whereSql, params },
    });
  },
};

// --- A04 add_funnel_step -----------------------------------------------------

const addFunnelStepInput = z.strictObject({ id: z.string(), name: z.string().min(1), type: z.string().optional() });

const addFunnelStep: ActionDef<z.infer<typeof addFunnelStepInput>, FunnelView> = {
  id: 'M36.A04',
  slug: 'funnels.add_funnel_step',
  module: MODULE,
  name: 'Add funnel step',
  description: 'Append a new step to a funnel.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addFunnelStepInput,
  outputSchema: funnelView,
  searchCard: { synonyms: ['add step', 'new funnel step'], examplePhrasings: ['Add a checkout step to this funnel'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFunnelRow(ctx.db, input.id);
    const config = readConfig(row);
    const step: FunnelStep = { id: nextStepId(config.steps, input.id), name: input.name, type: input.type ?? 'page', landing_page_id: null };
    writeConfig(ctx.db, input.id, { ...config, steps: [...config.steps, step] }, ctx.clock.now());
    return toView(getFunnelRow(ctx.db, input.id));
  }),
};

// --- A05 reorder_funnel_steps -----------------------------------------------------

const reorderFunnelStepsInput = z.strictObject({ id: z.string(), step_ids: z.array(z.string().min(1)).min(1) });

const reorderFunnelSteps: ActionDef<z.infer<typeof reorderFunnelStepsInput>, FunnelView> = {
  id: 'M36.A05',
  slug: 'funnels.reorder_funnel_steps',
  module: MODULE,
  name: 'Reorder funnel steps',
  description: "Replace a funnel's step order (must be exactly the same set of step ids).",
  risk: 'write',
  entities: ['structures'],
  inputSchema: reorderFunnelStepsInput,
  outputSchema: funnelView,
  searchCard: { synonyms: ['reorder steps', 'change step order'], examplePhrasings: ['Move the checkout step earlier in this funnel'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFunnelRow(ctx.db, input.id);
    const config = readConfig(row);
    const currentIds = new Set(config.steps.map((s) => s.id));
    const nextIds = new Set(input.step_ids);
    const sameSet = currentIds.size === nextIds.size && [...currentIds].every((i) => nextIds.has(i));
    if (!sameSet) {
      throw new ActionError('VALIDATION', `New step order must contain exactly the funnel's existing step ids (${[...currentIds].join(', ')}).`);
    }
    const byId = new Map(config.steps.map((s) => [s.id, s] as const));
    const steps = input.step_ids.map((i) => byId.get(i) as FunnelStep);
    writeConfig(ctx.db, input.id, { ...config, steps }, ctx.clock.now());
    return toView(getFunnelRow(ctx.db, input.id));
  }),
};

// --- A06 remove_funnel_step -----------------------------------------------------

const removeFunnelStepInput = z.strictObject({ id: z.string(), step_id: z.string().min(1) });

const removeFunnelStep: ActionDef<z.infer<typeof removeFunnelStepInput>, FunnelView> = {
  id: 'M36.A06',
  slug: 'funnels.remove_funnel_step',
  module: MODULE,
  name: 'Remove funnel step',
  description: 'Remove a step from a funnel.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: removeFunnelStepInput,
  outputSchema: funnelView,
  searchCard: { synonyms: ['delete step', 'remove funnel step'], examplePhrasings: ['Remove the upsell step from this funnel'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFunnelRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.steps.some((s) => s.id === input.step_id)) {
      throw new ActionError('NOT_FOUND', `Funnel '${input.id}' has no step '${input.step_id}'.`);
    }
    const steps = config.steps.filter((s) => s.id !== input.step_id);
    writeConfig(ctx.db, input.id, { ...config, steps }, ctx.clock.now());
    return toView(getFunnelRow(ctx.db, input.id));
  }),
};

// --- A07 link_landing_page_to_step -----------------------------------------------------

const linkLandingPageToStepInput = z.strictObject({ id: z.string(), step_id: z.string().min(1), landing_page_id: z.string() });

const linkLandingPageToStep: ActionDef<z.infer<typeof linkLandingPageToStepInput>, FunnelView> = {
  id: 'M36.A07',
  slug: 'funnels.link_landing_page_to_step',
  module: MODULE,
  name: 'Link landing page to step',
  description: "Link a funnel step to the landing page it should show (validates the page exists).",
  risk: 'write',
  entities: ['structures', 'content_items'],
  inputSchema: linkLandingPageToStepInput,
  outputSchema: funnelView,
  searchCard: { synonyms: ['connect landing page', 'link page to step'], examplePhrasings: ['Link this landing page to the signup step'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFunnelRow(ctx.db, input.id);
    const config = readConfig(row);
    const idx = config.steps.findIndex((s) => s.id === input.step_id);
    if (idx === -1) throw new ActionError('NOT_FOUND', `Funnel '${input.id}' has no step '${input.step_id}'.`);
    const page = ctx.db.get(`SELECT id FROM content_items WHERE id = ? AND kind = ?`, [input.landing_page_id, LANDING_PAGE_KIND]);
    if (!page) throw new ActionError('NOT_FOUND', `Landing page '${input.landing_page_id}' does not exist.`);
    const steps = config.steps.map((s, i) => (i === idx ? { ...s, landing_page_id: input.landing_page_id } : s));
    writeConfig(ctx.db, input.id, { ...config, steps }, ctx.clock.now());
    return toView(getFunnelRow(ctx.db, input.id));
  }),
};

// --- A08 set_funnel_conversion_goal -----------------------------------------------------

const setFunnelConversionGoalInput = z.strictObject({ id: z.string(), name: z.string().min(1), target_count: z.number().int().min(0).nullable().optional() });

const setFunnelConversionGoal: ActionDef<z.infer<typeof setFunnelConversionGoalInput>, FunnelView> = {
  id: 'M36.A08',
  slug: 'funnels.set_funnel_conversion_goal',
  module: MODULE,
  name: 'Set funnel conversion goal',
  description: "Set a funnel's target conversion goal.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setFunnelConversionGoalInput,
  outputSchema: funnelView,
  searchCard: { synonyms: ['set conversion goal', 'funnel target'], examplePhrasings: ['Set this funnel to target 500 signups'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFunnelRow(ctx.db, input.id);
    const config = readConfig(row);
    const goal: ConversionGoal = { name: input.name, target_count: input.target_count ?? null };
    writeConfig(ctx.db, input.id, { ...config, conversion_goal: goal }, ctx.clock.now());
    return toView(getFunnelRow(ctx.db, input.id));
  }),
};

// --- A09 publish_funnel -----------------------------------------------------

const publishFunnelInput = z.strictObject({ id: z.string() });
const publishFunnelOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('published') });

const publishFunnel: ActionDef<z.infer<typeof publishFunnelInput>, z.infer<typeof publishFunnelOutput>> = {
  id: 'M36.A09',
  slug: 'funnels.publish_funnel',
  module: MODULE,
  name: 'Publish funnel',
  description: 'Publish a funnel (requires at least one step).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: publishFunnelInput,
  outputSchema: publishFunnelOutput,
  searchCard: { synonyms: ['go live with funnel', 'publish funnel'], examplePhrasings: ['Publish this funnel'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFunnelRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.steps.length === 0) {
      throw new ActionError('VALIDATION', `Funnel '${input.id}' needs at least one step before it can be published.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'published', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, status: 'published' as const };
  }),
};

// --- A10 get_funnel_conversion_metrics -----------------------------------------------------

const getFunnelConversionMetricsInput = z.strictObject({ id: z.string() });
const stepMetric = z.object({ step_id: z.string(), name: z.string(), landing_page_id: z.string().nullable(), visits: z.number().nullable() });
const conversionMetricsOutput = z.object({
  id: z.string(),
  name: z.string(),
  steps: z.array(stepMetric),
  total_entries: z.number(),
  overall_conversion_rate: z.number(),
});

const getFunnelConversionMetrics: ActionDef<z.infer<typeof getFunnelConversionMetricsInput>, z.infer<typeof conversionMetricsOutput>> = {
  id: 'M36.A10',
  slug: 'funnels.get_funnel_conversion_metrics',
  module: MODULE,
  name: 'Get funnel conversion metrics',
  description:
    "Compute per-step visit counts (from each linked landing page's real view count) and the overall first-step-to-last-step conversion rate.",
  risk: 'read',
  entities: ['structures', 'content_items'],
  inputSchema: getFunnelConversionMetricsInput,
  outputSchema: conversionMetricsOutput,
  searchCard: { synonyms: ['funnel performance', 'conversion rate'], examplePhrasings: ['How is this funnel converting?'] },
  handler: async (input, ctx) => {
    const row = getFunnelRow(ctx.db, input.id);
    const config = readConfig(row);
    const steps = config.steps.map((s) => {
      let visits: number | null = null;
      if (s.landing_page_id) {
        const page = ctx.db.get(`SELECT views FROM content_items WHERE id = ?`, [s.landing_page_id]);
        visits = page ? ((page['views'] as number | null) ?? 0) : null;
      }
      return { step_id: s.id, name: s.name, landing_page_id: s.landing_page_id, visits };
    });
    const totalEntries = steps[0]?.visits ?? 0;
    const lastVisits = steps.length > 0 ? steps[steps.length - 1]?.visits ?? 0 : 0;
    const overallRate = totalEntries > 0 ? Math.round((lastVisits / totalEntries) * 10000) / 100 : 0;
    return { id: input.id, name: row['name'] as string, steps, total_entries: totalEntries, overall_conversion_rate: overallRate };
  },
};

export const m36Funnels: ActionDef[] = [
  createFunnel as ActionDef,
  getFunnelDefinition as ActionDef,
  listFunnels as ActionDef,
  addFunnelStep as ActionDef,
  reorderFunnelSteps as ActionDef,
  removeFunnelStep as ActionDef,
  linkLandingPageToStep as ActionDef,
  setFunnelConversionGoal as ActionDef,
  publishFunnel as ActionDef,
  getFunnelConversionMetrics as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'draft' → 7, 'published' → 9).
 */
export const m36DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'funnels.list_funnels',
    paramsA: { status: 'draft' },
    paramsB: { status: 'published' },
    expectDifferentCounts: true,
  },
];

export const m36SynthHints: SynthHints = {
  'funnels.get_funnel_definition:id': { table: 'structures', kind: KIND },
  'funnels.add_funnel_step:id': { table: 'structures', kind: KIND },
  'funnels.reorder_funnel_steps:id': { table: 'structures', kind: KIND },
  'funnels.remove_funnel_step:id': { table: 'structures', kind: KIND },
  'funnels.link_landing_page_to_step:id': { table: 'structures', kind: KIND },
  'funnels.set_funnel_conversion_goal:id': { table: 'structures', kind: KIND },
  'funnels.publish_funnel:id': { table: 'structures', kind: KIND },
  'funnels.get_funnel_conversion_metrics:id': { table: 'structures', kind: KIND },
};
