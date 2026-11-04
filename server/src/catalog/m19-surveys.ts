/**
 * M19 Surveys — follows the M01 Contacts convention verbatim (and mirrors
 * M18 Forms' `structures` + `records` wiring).
 *
 * Data home: `structures` table, `kind = 'survey'` (definition — questions/
 * branching rules live in `config`), PLUS `records` table,
 * `kind = 'survey_response'` (`parent_id` = the survey's `structures` id,
 * `data = {answers: Record<string, unknown>}`, matching
 * `entities/seed-content.ts#generateRecords`'s own seeded shape). This
 * module owns `survey_response` end-to-end (writes via
 * `submit_simulated_survey_response`, aggregates via
 * `get_survey_response_summary`) — same pattern as M18 Forms, not the
 * M31/M41 "a different module writes this kind" exception (task-8 guide §10).
 *
 * `get_survey_response_summary` aggregates REAL per-question response
 * counts from the `records` data — it does not assume a fixed question list
 * (seeded surveys have none), so it tallies every answer key actually
 * present across the survey's responses.
 *
 * KIND-BLINDNESS NOTE (same as M18): `entities[0]` is `'structures'` for
 * every definition-level action — the bare `id` field needs an
 * action-scoped synthHint (`${slug}:id`), see `m19SynthHints`.
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

const MODULE = 'surveys';
const KIND = 'survey';
const RESPONSE_KIND = 'survey_response';
const QUESTION_TYPES = ['text', 'single_choice', 'multi_choice', 'rating'] as const;

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'survey'}-${id}`;
}

interface SurveyQuestion {
  key: string;
  text: string;
  type: (typeof QUESTION_TYPES)[number];
  options: string[];
}

interface BranchingRule {
  if_value: unknown;
  goto_question_key: string;
}

interface SurveyConfig {
  questions: SurveyQuestion[];
  branching: Record<string, BranchingRule[]>;
}

function readConfig(row: Row): SurveyConfig {
  const config = parseJsonObject(row['config']);
  return {
    questions: Array.isArray(config['questions']) ? (config['questions'] as SurveyQuestion[]) : [],
    branching:
      config['branching'] && typeof config['branching'] === 'object'
        ? (config['branching'] as Record<string, BranchingRule[]>)
        : {},
  };
}

function writeConfig(db: StoreTx, id: string, config: SurveyConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

interface SurveyView {
  id: string;
  name: string;
  status: string;
  questions: SurveyQuestion[];
  branching: Record<string, BranchingRule[]>;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): SurveyView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    questions: config.questions,
    branching: config.branching,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getSurveyRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Survey '${id}' does not exist.`);
  return row;
}

const branchingRuleSchema = z.object({ if_value: z.unknown(), goto_question_key: z.string() });
const surveyQuestionSchema = z.object({
  key: z.string(),
  text: z.string(),
  type: z.enum(QUESTION_TYPES),
  options: z.array(z.string()),
});

const surveyView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  questions: z.array(surveyQuestionSchema),
  branching: z.record(z.string(), z.array(branchingRuleSchema)),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_survey -----------------------------------------------------

const createSurveyInput = z.strictObject({ name: z.string().min(1) });

const createSurvey: ActionDef<z.infer<typeof createSurveyInput>, SurveyView> = {
  id: 'M19.A01',
  slug: 'surveys.create_survey',
  module: MODULE,
  name: 'Create survey',
  description: 'Create a new survey definition (no questions yet — add them via add_survey_question).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createSurveyInput,
  outputSchema: surveyView,
  searchCard: {
    synonyms: ['add survey', 'new survey'],
    examplePhrasings: ['Create a customer satisfaction survey'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: SurveyConfig = { questions: [], branching: {} };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getSurveyRow(ctx.db, id));
  }),
};

// --- A02 get_survey_definition -----------------------------------------------

const getSurveyDefinitionInput = z.strictObject({ id: z.string() });

const getSurveyDefinition: ActionDef<z.infer<typeof getSurveyDefinitionInput>, SurveyView> = {
  id: 'M19.A02',
  slug: 'surveys.get_survey_definition',
  module: MODULE,
  name: 'Get survey definition',
  description: 'Fetch a survey and its questions/branching rules.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getSurveyDefinitionInput,
  outputSchema: surveyView,
  searchCard: {
    synonyms: ['survey details', 'survey questions'],
    examplePhrasings: ['Show me this survey'],
  },
  handler: async (input, ctx) => toView(getSurveyRow(ctx.db, input.id)),
};

// --- A03 list_surveys --------------------------------------------------------

const listSurveysInput = z.strictObject({
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListSurveysInput = z.infer<typeof listSurveysInput>;
const listSurveysOutput = listOutputSchema(surveyView);
type ListSurveysOutput = ListOrSpill<SurveyView>;

const listSurveys: ActionDef<ListSurveysInput, ListSurveysOutput> = {
  id: 'M19.A03',
  slug: 'surveys.list_surveys',
  module: MODULE,
  name: 'List surveys',
  description: 'List non-archived surveys.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listSurveysInput,
  outputSchema: listSurveysOutput,
  searchCard: {
    synonyms: ['all surveys', 'show surveys'],
    examplePhrasings: ['List our surveys'],
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

// --- A04 add_survey_question -----------------------------------------------------

const addSurveyQuestionInput = z.strictObject({
  id: z.string(),
  key: z.string().min(1),
  text: z.string().min(1),
  type: z.enum(QUESTION_TYPES),
  options: z.array(z.string()).optional(),
});

const addSurveyQuestion: ActionDef<z.infer<typeof addSurveyQuestionInput>, SurveyView> = {
  id: 'M19.A04',
  slug: 'surveys.add_survey_question',
  module: MODULE,
  name: 'Add survey question',
  description: 'Append a new question to a survey.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addSurveyQuestionInput,
  outputSchema: surveyView,
  searchCard: {
    synonyms: ['add question', 'new survey question'],
    examplePhrasings: ['Add a rating question to this survey'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSurveyRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.questions.some((q) => q.key === input.key)) {
      throw new ActionError('CONFLICT', `Survey '${input.id}' already has a question with key '${input.key}'.`);
    }
    if ((input.type === 'single_choice' || input.type === 'multi_choice') && !(input.options && input.options.length > 0)) {
      throw new ActionError('VALIDATION', `A '${input.type}' question needs at least one option.`);
    }
    const question: SurveyQuestion = {
      key: input.key,
      text: input.text,
      type: input.type,
      options: input.options ?? [],
    };
    writeConfig(ctx.db, input.id, { ...config, questions: [...config.questions, question] }, ctx.clock.now());
    return toView(getSurveyRow(ctx.db, input.id));
  }),
};

// --- A05 update_survey_question -----------------------------------------------------

const updateSurveyQuestionInput = z.strictObject({
  id: z.string(),
  key: z.string().min(1),
  patch: z
    .strictObject({
      text: z.string().min(1).optional(),
      type: z.enum(QUESTION_TYPES).optional(),
      options: z.array(z.string()).optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateSurveyQuestion: ActionDef<z.infer<typeof updateSurveyQuestionInput>, SurveyView> = {
  id: 'M19.A05',
  slug: 'surveys.update_survey_question',
  module: MODULE,
  name: 'Update survey question',
  description: 'Patch an existing survey question by key.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateSurveyQuestionInput,
  outputSchema: surveyView,
  searchCard: {
    synonyms: ['edit survey question', 'update question'],
    examplePhrasings: ['Change the wording of this survey question'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSurveyRow(ctx.db, input.id);
    const config = readConfig(row);
    const idx = config.questions.findIndex((q) => q.key === input.key);
    if (idx === -1) {
      throw new ActionError('NOT_FOUND', `Survey '${input.id}' has no question with key '${input.key}'.`);
    }
    const existing = config.questions[idx] as SurveyQuestion;
    const updated: SurveyQuestion = {
      key: existing.key,
      text: input.patch.text ?? existing.text,
      type: input.patch.type ?? existing.type,
      options: input.patch.options ?? existing.options,
    };
    const questions = config.questions.map((q, i) => (i === idx ? updated : q));
    writeConfig(ctx.db, input.id, { ...config, questions }, ctx.clock.now());
    return toView(getSurveyRow(ctx.db, input.id));
  }),
};

// --- A06 set_question_branching_rules -----------------------------------------------------

const setQuestionBranchingRulesInput = z.strictObject({
  id: z.string(),
  key: z.string().min(1),
  rules: z.array(branchingRuleSchema),
});

const setQuestionBranchingRules: ActionDef<z.infer<typeof setQuestionBranchingRulesInput>, SurveyView> = {
  id: 'M19.A06',
  slug: 'surveys.set_question_branching_rules',
  module: MODULE,
  name: 'Set question branching rules',
  description: 'Set the conditional skip-to-question rules for a survey question.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setQuestionBranchingRulesInput,
  outputSchema: surveyView,
  searchCard: {
    synonyms: ['set branching logic', 'survey skip logic'],
    examplePhrasings: ['If they answer no, skip to the final question'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSurveyRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.questions.some((q) => q.key === input.key)) {
      throw new ActionError('NOT_FOUND', `Survey '${input.id}' has no question with key '${input.key}'.`);
    }
    for (const rule of input.rules) {
      if (!config.questions.some((q) => q.key === rule.goto_question_key)) {
        throw new ActionError(
          'NOT_FOUND',
          `Survey '${input.id}' has no question with key '${rule.goto_question_key}' (branching target).`,
        );
      }
    }
    const branching = { ...config.branching, [input.key]: input.rules };
    writeConfig(ctx.db, input.id, { ...config, branching }, ctx.clock.now());
    return toView(getSurveyRow(ctx.db, input.id));
  }),
};

// --- A07 publish_survey -----------------------------------------------------

const publishSurveyInput = z.strictObject({ id: z.string() });
const publishSurveyOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('published') });

const publishSurvey: ActionDef<z.infer<typeof publishSurveyInput>, z.infer<typeof publishSurveyOutput>> = {
  id: 'M19.A07',
  slug: 'surveys.publish_survey',
  module: MODULE,
  name: 'Publish survey',
  description: 'Publish a survey so it can accept responses.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: publishSurveyInput,
  outputSchema: publishSurveyOutput,
  searchCard: {
    synonyms: ['go live with survey', 'publish survey'],
    examplePhrasings: ['Publish this survey'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSurveyRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET status = 'published', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, status: 'published' as const };
  }),
};

// --- A08 close_survey -----------------------------------------------------

const closeSurveyInput = z.strictObject({ id: z.string() });
const closeSurveyOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('closed') });

const closeSurvey: ActionDef<z.infer<typeof closeSurveyInput>, z.infer<typeof closeSurveyOutput>> = {
  id: 'M19.A08',
  slug: 'surveys.close_survey',
  module: MODULE,
  name: 'Close survey',
  description: 'Close a survey so it no longer accepts responses.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: closeSurveyInput,
  outputSchema: closeSurveyOutput,
  searchCard: {
    synonyms: ['end survey', 'stop collecting survey responses'],
    examplePhrasings: ['Close this survey'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSurveyRow(ctx.db, input.id);
    if (row['status'] === 'closed') {
      throw new ActionError('CONFLICT', `Survey '${input.id}' is already closed.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'closed', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, status: 'closed' as const };
  }),
};

// --- A09 submit_simulated_survey_response -----------------------------------------------------

const submitSimulatedSurveyResponseInput = z.strictObject({
  id: z.string(),
  contact_id: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
});
const submitSimulatedSurveyResponseOutput = z.object({
  id: z.string(),
  name: z.string(),
  survey_id: z.string(),
  contact_id: z.string().nullable(),
  submitted_at: z.number(),
});
type SubmitSimulatedSurveyResponseOutput = z.infer<typeof submitSimulatedSurveyResponseOutput>;

const submitSimulatedSurveyResponse: ActionDef<
  z.infer<typeof submitSimulatedSurveyResponseInput>,
  SubmitSimulatedSurveyResponseOutput
> = {
  id: 'M19.A09',
  slug: 'surveys.submit_simulated_survey_response',
  module: MODULE,
  name: 'Submit simulated survey response',
  description: 'Record a simulated response against a survey (writes a `records` row).',
  risk: 'write',
  // NOTE: bare `id` here means the SURVEY's id (structures), not a
  // `records` row — safe only because `m19SynthHints` declares an
  // action-scoped `${slug}:id` hint overriding `testing.ts`'s entities[0]
  // fallback (see that hint map below). Ordering is
  // `['records', 'structures']` intentionally — `records` is this action's
  // write-target (the row it actually inserts), `structures` is just the
  // parent lookup.
  entities: ['records', 'structures'],
  inputSchema: submitSimulatedSurveyResponseInput,
  outputSchema: submitSimulatedSurveyResponseOutput,
  searchCard: {
    synonyms: ['submit survey', 'simulate survey response'],
    examplePhrasings: ['Simulate a response for this survey'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getSurveyRow(ctx.db, input.id);
    if (input.contact_id) {
      const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
      if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    }
    const id = nextId(ctx.db, 'records', 'record');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO records (id, created_at, updated_at, archived, kind, parent_id, contact_id, user_id,
        occurred_at, data)
       VALUES (?, ?, ?, 0, ?, ?, ?, NULL, ?, ?)`,
      [id, now, now, RESPONSE_KIND, input.id, input.contact_id ?? null, now, JSON.stringify({ answers: input.answers })],
    );
    return {
      id,
      name: `Response for '${row['name'] as string}'`,
      survey_id: input.id,
      contact_id: input.contact_id ?? null,
      submitted_at: now,
    };
  }),
};

// --- A10 get_survey_response_summary -----------------------------------------------------

const getSurveyResponseSummaryInput = z.strictObject({ id: z.string() });
const questionSummarySchema = z.object({
  question_key: z.string(),
  response_count: z.number(),
  value_counts: z.record(z.string(), z.number()),
});
const getSurveyResponseSummaryOutput = z.object({
  id: z.string(),
  name: z.string(),
  response_count: z.number(),
  questions: z.array(questionSummarySchema),
});
type GetSurveyResponseSummaryOutput = z.infer<typeof getSurveyResponseSummaryOutput>;

// Bound well above any single survey's realistic response volume (seed data
// tops out at 220 responses spread over 15 surveys) — protects against a
// pathological future dataset without affecting correctness of `total`
// (computed via a separate COUNT(*), not this fetch's row count).
const RESPONSE_FETCH_LIMIT = 5000;

const getSurveyResponseSummary: ActionDef<
  z.infer<typeof getSurveyResponseSummaryInput>,
  GetSurveyResponseSummaryOutput
> = {
  id: 'M19.A10',
  slug: 'surveys.get_survey_response_summary',
  module: MODULE,
  name: 'Get survey response summary',
  description: 'Aggregate real per-question response counts/value distributions from recorded responses.',
  risk: 'read',
  // NOTE: bare `id` here also means the SURVEY's id (structures) — same
  // scoped-synthHint override as `submit_simulated_survey_response` above.
  // `records` is listed first because it's this action's primary read
  // target (the responses being aggregated); `structures` is just the
  // parent existence check.
  entities: ['records', 'structures'],
  inputSchema: getSurveyResponseSummaryInput,
  outputSchema: getSurveyResponseSummaryOutput,
  searchCard: {
    synonyms: ['survey results', 'survey response breakdown'],
    examplePhrasings: ['Summarize the responses to this survey'],
  },
  handler: async (input, ctx) => {
    const row = getSurveyRow(ctx.db, input.id);
    const countRow = ctx.db.get(
      `SELECT COUNT(*) AS n FROM records WHERE kind = ? AND parent_id = ? AND archived = 0`,
      [RESPONSE_KIND, input.id],
    );
    const responseCount = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT data FROM records WHERE kind = ? AND parent_id = ? AND archived = 0 LIMIT ?`,
      [RESPONSE_KIND, input.id, RESPONSE_FETCH_LIMIT],
    );
    const perQuestion = new Map<string, { count: number; valueCounts: Map<string, number> }>();
    for (const r of rows) {
      const data = parseJsonObject(r['data']);
      const answers = data['answers'] && typeof data['answers'] === 'object' ? (data['answers'] as Record<string, unknown>) : {};
      for (const [key, value] of Object.entries(answers)) {
        const bucket = perQuestion.get(key) ?? { count: 0, valueCounts: new Map<string, number>() };
        bucket.count += 1;
        const valueKey = typeof value === 'string' ? value : JSON.stringify(value);
        bucket.valueCounts.set(valueKey, (bucket.valueCounts.get(valueKey) ?? 0) + 1);
        perQuestion.set(key, bucket);
      }
    }
    const questions = [...perQuestion.entries()].map(([key, bucket]) => ({
      question_key: key,
      response_count: bucket.count,
      value_counts: Object.fromEntries(bucket.valueCounts),
    }));
    return { id: input.id, name: row['name'] as string, response_count: responseCount, questions };
  },
};

export const m19Surveys: ActionDef[] = [
  createSurvey as ActionDef,
  getSurveyDefinition as ActionDef,
  listSurveys as ActionDef,
  addSurveyQuestion as ActionDef,
  updateSurveyQuestion as ActionDef,
  setQuestionBranchingRules as ActionDef,
  publishSurvey as ActionDef,
  closeSurvey as ActionDef,
  submitSimulatedSurveyResponse as ActionDef,
  getSurveyResponseSummary as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live: 'published' → 12, 'draft' → 3 — margin 9, comfortably
 * survives this module's own smoke writes: `publish_survey`/`close_survey`
 * each move at most one row).
 */
export const m19DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'surveys.list_surveys',
    paramsA: { status: 'published' },
    paramsB: { status: 'draft' },
    expectDifferentCounts: true,
  },
];

/**
 * Every definition-level action below has `entities[0] === 'structures'`
 * with `kind = 'survey'` — the bare `id` field needs an action-scoped hint.
 */
export const m19SynthHints: SynthHints = {
  'surveys.get_survey_definition:id': { table: 'structures', kind: KIND },
  'surveys.add_survey_question:id': { table: 'structures', kind: KIND },
  'surveys.update_survey_question:id': { table: 'structures', kind: KIND },
  'surveys.set_question_branching_rules:id': { table: 'structures', kind: KIND },
  'surveys.publish_survey:id': { table: 'structures', kind: KIND },
  'surveys.close_survey:id': { table: 'structures', kind: KIND },
  'surveys.submit_simulated_survey_response:id': { table: 'structures', kind: KIND },
  'surveys.get_survey_response_summary:id': { table: 'structures', kind: KIND },
};
