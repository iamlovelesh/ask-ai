/**
 * M17 Event Triggers — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'trigger'`. `config` (JSON) is
 * `{ event_type: string|null, conditions: Record<string,unknown>,
 * workflow_id: string|null, firing_log: Array<{at,matched}> }`.
 *
 * `test_trigger_with_sample_event` does a REAL (if simple) evaluation: AND
 * every declared `conditions` key against the sample payload's own value
 * for that key (missing payload key ⇒ no match) — an empty `conditions`
 * map trivially matches everything (same "unconstrained segment" semantics
 * M09 Smart Lists / M15 Campaigns already use for empty filter rules).
 * `bind_trigger_to_workflow` validates BOTH the trigger (existence check)
 * AND the target workflow exist before storing the link. There is no
 * firing ENGINE in this task — `get_trigger_firing_history` is a
 * documented degenerate (always empty), the same category as M16's
 * `get_workflow_execution_history`.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10/M14/M15/M16): `entities[0]`
 * is `'structures'` — every action on this module's own `id` needs an
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

const MODULE = 'event_triggers';
const KIND = 'trigger';
const STATUSES = ['active', 'inactive'] as const;

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'trigger'}-${id}`;
}

interface FiringLogEntry {
  at: number;
  matched: boolean;
}

interface TriggerConfig {
  event_type: string | null;
  conditions: Record<string, unknown>;
  workflow_id: string | null;
  firing_log: FiringLogEntry[];
}

function readConfig(row: Row): TriggerConfig {
  const config = parseJsonObject(row['config']);
  return {
    event_type: (config['event_type'] as string | null | undefined) ?? null,
    conditions:
      config['conditions'] && typeof config['conditions'] === 'object'
        ? (config['conditions'] as Record<string, unknown>)
        : {},
    workflow_id: (config['workflow_id'] as string | null | undefined) ?? null,
    firing_log: Array.isArray(config['firing_log']) ? (config['firing_log'] as FiringLogEntry[]) : [],
  };
}

function writeConfig(db: StoreTx, id: string, config: TriggerConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(config),
    now,
    id,
  ]);
}

interface TriggerView {
  id: string;
  name: string;
  status: string;
  event_type: string | null;
  conditions: Record<string, unknown>;
  workflow_id: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): TriggerView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    event_type: config.event_type,
    conditions: config.conditions,
    workflow_id: config.workflow_id,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getTriggerRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Event trigger '${id}' does not exist.`);
  return row;
}

const triggerView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  event_type: z.string().nullable(),
  conditions: z.record(z.string(), z.unknown()),
  workflow_id: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_event_trigger ---------------------------------------------------

const createEventTriggerInput = z.strictObject({
  name: z.string().min(1),
  event_type: z.string().optional(),
});

const createEventTrigger: ActionDef<z.infer<typeof createEventTriggerInput>, TriggerView> = {
  id: 'M17.A01',
  slug: 'event_triggers.create_event_trigger',
  module: MODULE,
  name: 'Create event trigger',
  description: 'Create a new event trigger (starts inactive — use enable_trigger to turn it on).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createEventTriggerInput,
  outputSchema: triggerView,
  searchCard: {
    synonyms: ['add trigger', 'new automation trigger'],
    examplePhrasings: ['Create a trigger that fires when a contact is created'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: TriggerConfig = {
      event_type: input.event_type ?? null,
      conditions: {},
      workflow_id: null,
      firing_log: [],
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'inactive', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getTriggerRow(ctx.db, id));
  }),
};

// --- A02 get_trigger_configuration ---------------------------------------------------

const getTriggerConfigurationInput = z.strictObject({ id: z.string() });

const getTriggerConfiguration: ActionDef<z.infer<typeof getTriggerConfigurationInput>, TriggerView> = {
  id: 'M17.A02',
  slug: 'event_triggers.get_trigger_configuration',
  module: MODULE,
  name: 'Get trigger configuration',
  description: 'Fetch a single event trigger by id.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getTriggerConfigurationInput,
  outputSchema: triggerView,
  searchCard: {
    synonyms: ['trigger details', 'look up trigger'],
    examplePhrasings: ['Show me this event trigger'],
  },
  handler: async (input, ctx) => toView(getTriggerRow(ctx.db, input.id)),
};

// --- A03 list_event_triggers --------------------------------------------------------

const listEventTriggersInput = z.strictObject({
  status: z.enum(STATUSES).optional(),
  event_type: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListEventTriggersInput = z.infer<typeof listEventTriggersInput>;
const listEventTriggersOutput = listOutputSchema(triggerView);
type ListEventTriggersOutput = ListOrSpill<TriggerView>;

const listEventTriggers: ActionDef<ListEventTriggersInput, ListEventTriggersOutput> = {
  id: 'M17.A03',
  slug: 'event_triggers.list_event_triggers',
  module: MODULE,
  name: 'List event triggers',
  description: 'List non-archived event triggers.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listEventTriggersInput,
  outputSchema: listEventTriggersOutput,
  searchCard: {
    synonyms: ['all triggers', 'show automation triggers'],
    examplePhrasings: ['List our active event triggers'],
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
    const rowsAll = ctx.db.all(`SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC`, params);
    const filtered = input.event_type
      ? rowsAll.filter((r) => readConfig(r).event_type === input.event_type)
      : rowsAll;
    return toListOrSpill(filtered.slice(0, limit).map(toView), filtered.length);
  },
};

// --- A04 set_trigger_event_type --------------------------------------------------

const setTriggerEventTypeInput = z.strictObject({ id: z.string(), event_type: z.string().min(1) });

const setTriggerEventType: ActionDef<z.infer<typeof setTriggerEventTypeInput>, TriggerView> = {
  id: 'M17.A04',
  slug: 'event_triggers.set_trigger_event_type',
  module: MODULE,
  name: 'Set trigger event type',
  description: 'Set the catalog event type (e.g. contact.created) a trigger listens for.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setTriggerEventTypeInput,
  outputSchema: triggerView,
  searchCard: {
    synonyms: ['set trigger event', 'change trigger event type'],
    examplePhrasings: ['Make this trigger fire on opportunity.won events'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTriggerRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, event_type: input.event_type }, ctx.clock.now());
    return toView(getTriggerRow(ctx.db, input.id));
  }),
};

// --- A05 update_trigger_conditions --------------------------------------------------

const updateTriggerConditionsInput = z.strictObject({
  id: z.string(),
  conditions: z.record(z.string(), z.unknown()),
});

const updateTriggerConditions: ActionDef<z.infer<typeof updateTriggerConditionsInput>, TriggerView> = {
  id: 'M17.A05',
  slug: 'event_triggers.update_trigger_conditions',
  module: MODULE,
  name: 'Update trigger conditions',
  description: 'Replace the condition map a trigger evaluates against incoming event payloads.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateTriggerConditionsInput,
  outputSchema: triggerView,
  searchCard: {
    synonyms: ['edit trigger conditions', 'set trigger filters'],
    examplePhrasings: ['Only fire this trigger when lifecycle_stage is customer'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTriggerRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, conditions: input.conditions }, ctx.clock.now());
    return toView(getTriggerRow(ctx.db, input.id));
  }),
};

// --- A06 bind_trigger_to_workflow --------------------------------------------------

const bindTriggerToWorkflowInput = z.strictObject({ id: z.string(), workflow_id: z.string() });

const bindTriggerToWorkflow: ActionDef<z.infer<typeof bindTriggerToWorkflowInput>, TriggerView> = {
  id: 'M17.A06',
  slug: 'event_triggers.bind_trigger_to_workflow',
  module: MODULE,
  name: 'Bind trigger to workflow',
  description: 'Link a trigger to the workflow it should run when it fires (validates both exist).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: bindTriggerToWorkflowInput,
  outputSchema: triggerView,
  searchCard: {
    synonyms: ['connect trigger to workflow', 'link trigger and automation'],
    examplePhrasings: ['Connect this trigger to the new-lead-followup workflow'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTriggerRow(ctx.db, input.id);
    const workflow = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'workflow'`, [
      input.workflow_id,
    ]);
    if (!workflow) {
      throw new ActionError('NOT_FOUND', `Workflow '${input.workflow_id}' does not exist.`);
    }
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, workflow_id: input.workflow_id }, ctx.clock.now());
    return toView(getTriggerRow(ctx.db, input.id));
  }),
};

// --- A07 enable_trigger --------------------------------------------------

const enableTriggerInput = z.strictObject({ id: z.string() });

const enableTrigger: ActionDef<z.infer<typeof enableTriggerInput>, TriggerView> = {
  id: 'M17.A07',
  slug: 'event_triggers.enable_trigger',
  module: MODULE,
  name: 'Enable trigger',
  description: 'Activate an inactive event trigger.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: enableTriggerInput,
  outputSchema: triggerView,
  searchCard: {
    synonyms: ['turn on trigger', 'activate trigger'],
    examplePhrasings: ['Enable this trigger'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTriggerRow(ctx.db, input.id);
    if (row['status'] === 'active') {
      throw new ActionError('CONFLICT', `Event trigger '${input.id}' is already enabled.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'active', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTriggerRow(ctx.db, input.id));
  }),
};

// --- A08 disable_trigger --------------------------------------------------

const disableTriggerInput = z.strictObject({ id: z.string() });

const disableTrigger: ActionDef<z.infer<typeof disableTriggerInput>, TriggerView> = {
  id: 'M17.A08',
  slug: 'event_triggers.disable_trigger',
  module: MODULE,
  name: 'Disable trigger',
  description: 'Deactivate an active event trigger.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: disableTriggerInput,
  outputSchema: triggerView,
  searchCard: {
    synonyms: ['turn off trigger', 'deactivate trigger'],
    examplePhrasings: ['Disable this trigger'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTriggerRow(ctx.db, input.id);
    if (row['status'] === 'inactive') {
      throw new ActionError('CONFLICT', `Event trigger '${input.id}' is already disabled.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'inactive', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTriggerRow(ctx.db, input.id));
  }),
};

// --- A09 test_trigger_with_sample_event --------------------------------------------

const testTriggerWithSampleEventInput = z.strictObject({
  id: z.string(),
  sample_event: z.record(z.string(), z.unknown()),
});
const conditionEvalSchema = z.object({ expected: z.unknown(), actual: z.unknown(), match: z.boolean() });
const testTriggerWithSampleEventOutput = z.object({
  id: z.string(),
  name: z.string(),
  matched: z.boolean(),
  evaluated_conditions: z.record(z.string(), conditionEvalSchema),
});
type TestTriggerWithSampleEventOutput = z.infer<typeof testTriggerWithSampleEventOutput>;

const testTriggerWithSampleEvent: ActionDef<
  z.infer<typeof testTriggerWithSampleEventInput>,
  TestTriggerWithSampleEventOutput
> = {
  id: 'M17.A09',
  slug: 'event_triggers.test_trigger_with_sample_event',
  module: MODULE,
  name: 'Test trigger with sample event',
  description:
    "Dry-run a trigger's condition map against a sample event payload (real AND evaluation, boolean result). Does not fire the trigger or write anything.",
  risk: 'read',
  entities: ['structures'],
  inputSchema: testTriggerWithSampleEventInput,
  outputSchema: testTriggerWithSampleEventOutput,
  searchCard: {
    synonyms: ['test trigger', 'would this trigger fire'],
    examplePhrasings: ['Would this trigger fire for this sample event?'],
  },
  handler: async (input, ctx) => {
    const row = getTriggerRow(ctx.db, input.id);
    const config = readConfig(row);
    const evaluated: Record<string, { expected: unknown; actual: unknown; match: boolean }> = {};
    let matched = true;
    for (const [key, expected] of Object.entries(config.conditions)) {
      const actual = input.sample_event[key];
      const match = actual === expected;
      evaluated[key] = { expected, actual, match };
      if (!match) matched = false;
    }
    return { id: input.id, name: row['name'] as string, matched, evaluated_conditions: evaluated };
  },
};

// --- A10 get_trigger_firing_history --------------------------------------------

const getTriggerFiringHistoryInput = z.strictObject({
  id: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
});
type GetTriggerFiringHistoryInput = z.infer<typeof getTriggerFiringHistoryInput>;
const firingLogEntrySchema = z.object({ at: z.number(), matched: z.boolean() });
const getTriggerFiringHistoryOutput = listOutputSchema(firingLogEntrySchema);
type GetTriggerFiringHistoryOutput = ListOrSpill<z.infer<typeof firingLogEntrySchema>>;

const getTriggerFiringHistory: ActionDef<GetTriggerFiringHistoryInput, GetTriggerFiringHistoryOutput> = {
  id: 'M17.A10',
  slug: 'event_triggers.get_trigger_firing_history',
  module: MODULE,
  name: 'Get trigger firing history',
  description:
    'List recorded firing-log entries for a trigger (empty for triggers that have never fired — there is no firing engine in this backend).',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getTriggerFiringHistoryInput,
  outputSchema: getTriggerFiringHistoryOutput,
  searchCard: {
    synonyms: ['trigger firing log', 'has this trigger ever fired'],
    examplePhrasings: ['Show me when this trigger has fired'],
  },
  handler: async (input, ctx) => {
    const row = getTriggerRow(ctx.db, input.id);
    const config = readConfig(row);
    const limit = input.limit ?? 50;
    const sorted = [...config.firing_log].sort((a, b) => b.at - a.at);
    return toListOrSpill(sorted.slice(0, limit), sorted.length);
  },
};

export const m17EventTriggers: ActionDef[] = [
  createEventTrigger as ActionDef,
  getTriggerConfiguration as ActionDef,
  listEventTriggers as ActionDef,
  setTriggerEventType as ActionDef,
  updateTriggerConditions as ActionDef,
  bindTriggerToWorkflow as ActionDef,
  enableTrigger as ActionDef,
  disableTrigger as ActionDef,
  testTriggerWithSampleEvent as ActionDef,
  getTriggerFiringHistory as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (pristine: 'active' → 8, 'inactive' → 12). Empirically verified via
 * `npm run smoke -- --module m17` (and the full `--modules m11-m17` /
 * all-module run): live value is 'active' → 8, 'inactive' → 13, margin 5.
 * (`ORDER BY id` in `synthesizeInput`'s id resolution is lexicographic on
 * the TEXT `id` column, not numeric, so don't trust a hand-traced "which
 * row is offset 0" — verify empirically via `npm run smoke`.)
 */
export const m17DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'event_triggers.list_event_triggers',
    paramsA: { status: 'active' },
    paramsB: { status: 'inactive' },
    expectDifferentCounts: true,
  },
];

/**
 * Every action below has `entities[0] === 'structures'` with `kind =
 * 'trigger'` — the bare `id` field needs an action-scoped hint.
 * `workflow_id` (A06) is already covered by `testing.ts`'s built-in
 * `DEFAULT_HINTS` (`{table:'structures', kind:'workflow'}`) — no
 * module-level declaration needed.
 */
export const m17SynthHints: SynthHints = {
  'event_triggers.get_trigger_configuration:id': { table: 'structures', kind: KIND },
  'event_triggers.set_trigger_event_type:id': { table: 'structures', kind: KIND },
  'event_triggers.update_trigger_conditions:id': { table: 'structures', kind: KIND },
  'event_triggers.bind_trigger_to_workflow:id': { table: 'structures', kind: KIND },
  'event_triggers.enable_trigger:id': { table: 'structures', kind: KIND },
  'event_triggers.disable_trigger:id': { table: 'structures', kind: KIND },
  'event_triggers.test_trigger_with_sample_event:id': { table: 'structures', kind: KIND },
  'event_triggers.get_trigger_firing_history:id': { table: 'structures', kind: KIND },
};
