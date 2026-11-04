/**
 * M18 Forms — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'form'` (the form DEFINITION —
 * fields/validation rules live in `config`), PLUS `records` table,
 * `kind = 'form_submission'` (one row per real submission — `parent_id` =
 * the form's `structures` id, `data = {fields: Record<string, unknown>}`,
 * matching `entities/seed-content.ts#generateRecords`'s own seeded shape).
 * This module is the module that OWNS `form_submission` end-to-end (both
 * writes it via `submit_simulated_form_response` AND reads it back via
 * `list_form_submissions`) — unlike `coupon_redemption`/`lesson_completion`,
 * which a DIFFERENT module writes (task-8 guide §10).
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10/M14): `entities[0]` is
 * `'structures'` for every definition-level action — the bare `id` field
 * needs an action-scoped synthHint (`${slug}:id`), see `m18SynthHints`.
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

const MODULE = 'forms';
const KIND = 'form';
const SUBMISSION_KIND = 'form_submission';
const FIELD_TYPES = ['text', 'email', 'phone', 'number', 'select', 'checkbox', 'textarea'] as const;

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'form'}-${id}`;
}

interface FormField {
  key: string;
  label: string;
  type: (typeof FIELD_TYPES)[number];
  required: boolean;
  options: string[];
}

interface FormConfig {
  fields: FormField[];
  validation: Record<string, Record<string, unknown>>;
}

function readConfig(row: Row): FormConfig {
  const config = parseJsonObject(row['config']);
  return {
    fields: Array.isArray(config['fields']) ? (config['fields'] as FormField[]) : [],
    validation:
      config['validation'] && typeof config['validation'] === 'object'
        ? (config['validation'] as Record<string, Record<string, unknown>>)
        : {},
  };
}

function writeConfig(db: StoreTx, id: string, config: FormConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

interface FormView {
  id: string;
  name: string;
  status: string;
  fields: FormField[];
  validation: Record<string, Record<string, unknown>>;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): FormView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    fields: config.fields,
    validation: config.validation,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getFormRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Form '${id}' does not exist.`);
  return row;
}

const formFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string()),
});

const formView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  fields: z.array(formFieldSchema),
  validation: z.record(z.string(), z.record(z.string(), z.unknown())),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_form -----------------------------------------------------

const createFormInput = z.strictObject({ name: z.string().min(1) });
type CreateFormInput = z.infer<typeof createFormInput>;

const createForm: ActionDef<CreateFormInput, FormView> = {
  id: 'M18.A01',
  slug: 'forms.create_form',
  module: MODULE,
  name: 'Create form',
  description: 'Create a new form definition (no fields yet — add them via add_form_field).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createFormInput,
  outputSchema: formView,
  searchCard: {
    synonyms: ['add form', 'new form'],
    examplePhrasings: ['Create a contact-us form'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: FormConfig = { fields: [], validation: {} };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getFormRow(ctx.db, id));
  }),
};

// --- A02 get_form_definition -----------------------------------------------

const getFormDefinitionInput = z.strictObject({ id: z.string() });

const getFormDefinition: ActionDef<z.infer<typeof getFormDefinitionInput>, FormView> = {
  id: 'M18.A02',
  slug: 'forms.get_form_definition',
  module: MODULE,
  name: 'Get form definition',
  description: 'Fetch a form and its fields/validation rules.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getFormDefinitionInput,
  outputSchema: formView,
  searchCard: {
    synonyms: ['form details', 'form fields'],
    examplePhrasings: ['Show me this form'],
  },
  handler: async (input, ctx) => toView(getFormRow(ctx.db, input.id)),
};

// --- A03 list_forms --------------------------------------------------------

const listFormsInput = z.strictObject({
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListFormsInput = z.infer<typeof listFormsInput>;
const listFormsOutput = listOutputSchema(formView);
type ListFormsOutput = ListOrSpill<FormView>;

const listForms: ActionDef<ListFormsInput, ListFormsOutput> = {
  id: 'M18.A03',
  slug: 'forms.list_forms',
  module: MODULE,
  name: 'List forms',
  description: 'List non-archived forms.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listFormsInput,
  outputSchema: listFormsOutput,
  searchCard: {
    synonyms: ['all forms', 'show forms'],
    examplePhrasings: ['List our forms'],
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

// --- A04 add_form_field -----------------------------------------------------

const addFormFieldInput = z.strictObject({
  id: z.string(),
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const addFormField: ActionDef<z.infer<typeof addFormFieldInput>, FormView> = {
  id: 'M18.A04',
  slug: 'forms.add_form_field',
  module: MODULE,
  name: 'Add form field',
  description: 'Append a new field to a form.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addFormFieldInput,
  outputSchema: formView,
  searchCard: {
    synonyms: ['add field', 'new form field'],
    examplePhrasings: ['Add an email field to this form'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFormRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.fields.some((f) => f.key === input.key)) {
      throw new ActionError('CONFLICT', `Form '${input.id}' already has a field with key '${input.key}'.`);
    }
    if (input.type === 'select' && !(input.options && input.options.length > 0)) {
      throw new ActionError('VALIDATION', "A 'select' field needs at least one option.");
    }
    const field: FormField = {
      key: input.key,
      label: input.label,
      type: input.type,
      required: input.required ?? false,
      options: input.options ?? [],
    };
    writeConfig(ctx.db, input.id, { ...config, fields: [...config.fields, field] }, ctx.clock.now());
    return toView(getFormRow(ctx.db, input.id));
  }),
};

// --- A05 update_form_field -----------------------------------------------------

const updateFormFieldInput = z.strictObject({
  id: z.string(),
  key: z.string().min(1),
  patch: z
    .strictObject({
      label: z.string().min(1).optional(),
      type: z.enum(FIELD_TYPES).optional(),
      required: z.boolean().optional(),
      options: z.array(z.string()).optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateFormField: ActionDef<z.infer<typeof updateFormFieldInput>, FormView> = {
  id: 'M18.A05',
  slug: 'forms.update_form_field',
  module: MODULE,
  name: 'Update form field',
  description: 'Patch an existing form field by key.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateFormFieldInput,
  outputSchema: formView,
  searchCard: {
    synonyms: ['edit form field', 'update form field'],
    examplePhrasings: ["Make this form's email field required"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFormRow(ctx.db, input.id);
    const config = readConfig(row);
    const idx = config.fields.findIndex((f) => f.key === input.key);
    if (idx === -1) {
      throw new ActionError('NOT_FOUND', `Form '${input.id}' has no field with key '${input.key}'.`);
    }
    const existing = config.fields[idx] as FormField;
    const updated: FormField = {
      key: existing.key,
      label: input.patch.label ?? existing.label,
      type: input.patch.type ?? existing.type,
      required: input.patch.required ?? existing.required,
      options: input.patch.options ?? existing.options,
    };
    const fields = config.fields.map((f, i) => (i === idx ? updated : f));
    writeConfig(ctx.db, input.id, { ...config, fields }, ctx.clock.now());
    return toView(getFormRow(ctx.db, input.id));
  }),
};

// --- A06 reorder_form_fields -----------------------------------------------------

const reorderFormFieldsInput = z.strictObject({ id: z.string(), field_keys: z.array(z.string().min(1)).min(1) });

const reorderFormFields: ActionDef<z.infer<typeof reorderFormFieldsInput>, FormView> = {
  id: 'M18.A06',
  slug: 'forms.reorder_form_fields',
  module: MODULE,
  name: 'Reorder form fields',
  description: "Replace a form's field order (must be exactly the same set of field keys).",
  risk: 'write',
  entities: ['structures'],
  inputSchema: reorderFormFieldsInput,
  outputSchema: formView,
  searchCard: {
    synonyms: ['reorder fields', 'change field order'],
    examplePhrasings: ['Move the email field to the top of this form'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFormRow(ctx.db, input.id);
    const config = readConfig(row);
    const currentKeys = new Set(config.fields.map((f) => f.key));
    const nextKeys = new Set(input.field_keys);
    const sameSet = currentKeys.size === nextKeys.size && [...currentKeys].every((k) => nextKeys.has(k));
    if (!sameSet) {
      throw new ActionError(
        'VALIDATION',
        `New field order must contain exactly the form's existing field keys (${[...currentKeys].join(', ')}).`,
      );
    }
    const byKey = new Map(config.fields.map((f) => [f.key, f] as const));
    const fields = input.field_keys.map((k) => byKey.get(k) as FormField);
    writeConfig(ctx.db, input.id, { ...config, fields }, ctx.clock.now());
    return toView(getFormRow(ctx.db, input.id));
  }),
};

// --- A07 set_form_validation_rules -----------------------------------------------------

const setFormValidationRulesInput = z.strictObject({
  id: z.string(),
  key: z.string().min(1),
  rules: z.record(z.string(), z.unknown()),
});

const setFormValidationRules: ActionDef<z.infer<typeof setFormValidationRulesInput>, FormView> = {
  id: 'M18.A07',
  slug: 'forms.set_form_validation_rules',
  module: MODULE,
  name: 'Set form validation rules',
  description: 'Set the validation rules object for one of a form\'s fields.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setFormValidationRulesInput,
  outputSchema: formView,
  searchCard: {
    synonyms: ['set field validation', 'form field rules'],
    examplePhrasings: ['Make the phone field require a minimum length of 10'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFormRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.fields.some((f) => f.key === input.key)) {
      throw new ActionError('NOT_FOUND', `Form '${input.id}' has no field with key '${input.key}'.`);
    }
    const validation = { ...config.validation, [input.key]: input.rules };
    writeConfig(ctx.db, input.id, { ...config, validation }, ctx.clock.now());
    return toView(getFormRow(ctx.db, input.id));
  }),
};

// --- A08 publish_form -----------------------------------------------------

const publishFormInput = z.strictObject({ id: z.string() });
const publishFormOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('published') });

const publishForm: ActionDef<z.infer<typeof publishFormInput>, z.infer<typeof publishFormOutput>> = {
  id: 'M18.A08',
  slug: 'forms.publish_form',
  module: MODULE,
  name: 'Publish form',
  description: 'Publish a form so it can accept submissions.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: publishFormInput,
  outputSchema: publishFormOutput,
  searchCard: {
    synonyms: ['go live with form', 'publish form'],
    examplePhrasings: ['Publish this form'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFormRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET status = 'published', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, status: 'published' as const };
  }),
};

// --- A09 submit_simulated_form_response -----------------------------------------------------

const submitSimulatedFormResponseInput = z.strictObject({
  id: z.string(),
  contact_id: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});
const submitSimulatedFormResponseOutput = z.object({
  id: z.string(),
  name: z.string(),
  form_id: z.string(),
  contact_id: z.string().nullable(),
  submitted_at: z.number(),
});
type SubmitSimulatedFormResponseOutput = z.infer<typeof submitSimulatedFormResponseOutput>;

const submitSimulatedFormResponse: ActionDef<
  z.infer<typeof submitSimulatedFormResponseInput>,
  SubmitSimulatedFormResponseOutput
> = {
  id: 'M18.A09',
  slug: 'forms.submit_simulated_form_response',
  module: MODULE,
  name: 'Submit simulated form response',
  description: 'Record a simulated submission against a form (writes a `records` row).',
  risk: 'write',
  // NOTE: bare `id` here means the FORM's id (structures), not a `records`
  // row — safe only because `m18SynthHints` declares an action-scoped
  // `${slug}:id` hint overriding `testing.ts`'s entities[0] fallback (see
  // that hint map below). Ordering is `['records', 'structures']`
  // intentionally — `records` is this action's write-target (the row it
  // actually inserts), `structures` is just the parent lookup.
  entities: ['records', 'structures'],
  inputSchema: submitSimulatedFormResponseInput,
  outputSchema: submitSimulatedFormResponseOutput,
  searchCard: {
    synonyms: ['submit form', 'simulate form submission'],
    examplePhrasings: ['Simulate a submission for this form'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFormRow(ctx.db, input.id);
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
      [id, now, now, SUBMISSION_KIND, input.id, input.contact_id ?? null, now, JSON.stringify({ fields: input.data })],
    );
    return {
      id,
      name: `Submission for '${row['name'] as string}'`,
      form_id: input.id,
      contact_id: input.contact_id ?? null,
      submitted_at: now,
    };
  }),
};

// --- A10 list_form_submissions -----------------------------------------------------

const listFormSubmissionsInput = z.strictObject({
  id: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
});
const formSubmissionEntry = z.object({
  id: z.string(),
  name: z.string(),
  form_id: z.string(),
  contact_id: z.string().nullable(),
  submitted_at: z.number(),
  data: z.record(z.string(), z.unknown()),
});
const listFormSubmissionsOutput = listOutputSchema(formSubmissionEntry);
type ListFormSubmissionsOutput = ListOrSpill<z.infer<typeof formSubmissionEntry>>;

const listFormSubmissions: ActionDef<z.infer<typeof listFormSubmissionsInput>, ListFormSubmissionsOutput> = {
  id: 'M18.A10',
  slug: 'forms.list_form_submissions',
  module: MODULE,
  name: 'List form submissions',
  description: 'List real submissions recorded against a form.',
  risk: 'read',
  // NOTE: bare `id` here also means the FORM's id (structures) — same
  // scoped-synthHint override as `submit_simulated_form_response` above.
  // `records` is listed first because it's this action's primary read
  // target (the submissions themselves); `structures` is just the parent
  // existence check.
  entities: ['records', 'structures'],
  inputSchema: listFormSubmissionsInput,
  outputSchema: listFormSubmissionsOutput,
  searchCard: {
    synonyms: ['form responses', 'form submissions'],
    examplePhrasings: ['Show me the submissions for this form'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const formRow = getFormRow(ctx.db, input.id);
    const limit = input.limit ?? 50;
    const countRow = ctx.db.get(
      `SELECT COUNT(*) AS n FROM records WHERE kind = ? AND parent_id = ? AND archived = 0`,
      [SUBMISSION_KIND, input.id],
    );
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM records WHERE kind = ? AND parent_id = ? AND archived = 0
       ORDER BY occurred_at DESC LIMIT ?`,
      [SUBMISSION_KIND, input.id, limit],
    );
    const formName = formRow['name'] as string;
    const items = rows.map((r) => ({
      id: r['id'] as string,
      name: `Submission for '${formName}'`,
      form_id: r['parent_id'] as string,
      contact_id: (r['contact_id'] as string | null) ?? null,
      submitted_at: r['occurred_at'] as number,
      data: parseJsonObject(r['data']),
    }));
    return toListOrSpill(items, total);
  },
};

export const m18Forms: ActionDef[] = [
  createForm as ActionDef,
  getFormDefinition as ActionDef,
  listForms as ActionDef,
  addFormField as ActionDef,
  updateFormField as ActionDef,
  reorderFormFields as ActionDef,
  setFormValidationRules as ActionDef,
  publishForm as ActionDef,
  submitSimulatedFormResponse as ActionDef,
  listFormSubmissions as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live: 'draft' → 12, 'published' → 3 — margin 9, comfortably
 * survives this module's own smoke writes: `publish_form` moves at most one
 * row draft→published).
 */
export const m18DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'forms.list_forms',
    paramsA: { status: 'draft' },
    paramsB: { status: 'published' },
    expectDifferentCounts: true,
  },
];

/**
 * Every definition-level action below has `entities[0] === 'structures'`
 * with `kind = 'form'` — the bare `id` field needs an action-scoped hint.
 * `submit_simulated_form_response`/`list_form_submissions` also take `id`
 * meaning "the form's id" (not a `records` row), so they need it too.
 */
export const m18SynthHints: SynthHints = {
  'forms.get_form_definition:id': { table: 'structures', kind: KIND },
  'forms.add_form_field:id': { table: 'structures', kind: KIND },
  'forms.update_form_field:id': { table: 'structures', kind: KIND },
  'forms.reorder_form_fields:id': { table: 'structures', kind: KIND },
  'forms.set_form_validation_rules:id': { table: 'structures', kind: KIND },
  'forms.publish_form:id': { table: 'structures', kind: KIND },
  'forms.submit_simulated_form_response:id': { table: 'structures', kind: KIND },
  'forms.list_form_submissions:id': { table: 'structures', kind: KIND },
};
