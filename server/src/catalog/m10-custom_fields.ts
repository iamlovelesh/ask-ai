/**
 * M10 Custom Fields — follows the M01 Contacts convention verbatim.
 *
 * Data home: field DEFINITIONS live in `structures` (`kind =
 * 'custom_field'`); `category` carries the target module name (e.g.
 * `'contacts'`) so `list_fields_for_module` can filter by it; `config`
 * (JSON) is `{ field_type, options: string[], retired_options: string[],
 * validation: Record<string, unknown> }`; `description` carries the
 * field's help text.
 *
 * `set_record_field_value` (A09) writes the VALUE onto a target record.
 * Only `contacts` has a `custom_fields` JSON column in `entities/model.ts`
 * (`companies` does not) — `target_type` is therefore fixed to
 * `'contact'`, stored under the field's own `id` as the key so values
 * survive a field rename.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09): every action on this module's
 * own `id` needs an action-scoped synthHint (`${slug}:id`).
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

const MODULE = 'custom_fields';
const KIND = 'custom_field';
const FIELD_TYPES = ['text', 'number', 'date', 'dropdown', 'boolean'] as const;

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'field'}-${id}`;
}

interface FieldConfig {
  field_type: (typeof FIELD_TYPES)[number];
  options: string[];
  retired_options: string[];
  validation: Record<string, unknown>;
}

function readConfig(row: Row): FieldConfig {
  const config = parseJsonObject(row['config']);
  return {
    field_type: (config['field_type'] as FieldConfig['field_type'] | undefined) ?? 'text',
    options: Array.isArray(config['options']) ? (config['options'] as string[]) : [],
    retired_options: Array.isArray(config['retired_options']) ? (config['retired_options'] as string[]) : [],
    validation:
      config['validation'] && typeof config['validation'] === 'object'
        ? (config['validation'] as Record<string, unknown>)
        : {},
  };
}

interface FieldView {
  id: string;
  name: string;
  module: string;
  status: string;
  help_text: string | null;
  field_type: string;
  options: string[];
  retired_options: string[];
  validation: Record<string, unknown>;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): FieldView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    module: row['category'] as string,
    status: row['status'] as string,
    help_text: (row['description'] as string | null) ?? null,
    field_type: config.field_type,
    options: config.options,
    retired_options: config.retired_options,
    validation: config.validation,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getFieldRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Custom field '${id}' does not exist.`);
  return row;
}

function writeConfig(db: StoreTx, id: string, config: FieldConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(config),
    now,
    id,
  ]);
}

const fieldView = z.object({
  id: z.string(),
  name: z.string(),
  module: z.string(),
  status: z.string(),
  help_text: z.string().nullable(),
  field_type: z.string(),
  options: z.array(z.string()),
  retired_options: z.array(z.string()),
  validation: z.record(z.string(), z.unknown()),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_custom_field -------------------------------------------------------

const createCustomFieldInput = z.strictObject({
  name: z.string().min(1),
  module: z.string().min(1),
  field_type: z.enum(FIELD_TYPES),
  help_text: z.string().optional(),
  options: z.array(z.string().min(1)).optional(),
});
type CreateCustomFieldInput = z.infer<typeof createCustomFieldInput>;

const createCustomField: ActionDef<CreateCustomFieldInput, FieldView> = {
  id: 'M10.A01',
  slug: 'custom_fields.create_custom_field',
  module: MODULE,
  name: 'Create custom field',
  description: 'Define a new custom field for a module.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createCustomFieldInput,
  outputSchema: fieldView,
  searchCard: {
    synonyms: ['add custom field', 'new field'],
    examplePhrasings: ['Create a dropdown field called Industry Segment on contacts'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.field_type !== 'dropdown' && input.options && input.options.length > 0) {
      throw new ActionError('VALIDATION', 'Only dropdown fields may declare options.');
    }
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: FieldConfig = {
      field_type: input.field_type,
      options: input.options ?? [],
      retired_options: [],
      validation: {},
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), input.module, JSON.stringify(config), input.help_text ?? null],
    );
    return toView(getFieldRow(ctx.db, id));
  }),
};

// --- A02 get_field_definition ---------------------------------------------------

const getFieldDefinitionInput = z.strictObject({ id: z.string() });

const getFieldDefinition: ActionDef<z.infer<typeof getFieldDefinitionInput>, FieldView> = {
  id: 'M10.A02',
  slug: 'custom_fields.get_field_definition',
  module: MODULE,
  name: 'Get field definition',
  description: 'Fetch a single custom field definition.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getFieldDefinitionInput,
  outputSchema: fieldView,
  searchCard: {
    synonyms: ['field details', 'look up custom field'],
    examplePhrasings: ['Show me the Industry Segment field definition'],
  },
  handler: async (input, ctx) => toView(getFieldRow(ctx.db, input.id)),
};

// --- A03 list_fields_for_module -----------------------------------------------

const listFieldsForModuleInput = z.strictObject({
  module: z.string().min(1),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListFieldsForModuleInput = z.infer<typeof listFieldsForModuleInput>;
const listFieldsForModuleOutput = listOutputSchema(fieldView);
type ListFieldsForModuleOutput = ListOrSpill<FieldView>;

const listFieldsForModule: ActionDef<ListFieldsForModuleInput, ListFieldsForModuleOutput> = {
  id: 'M10.A03',
  slug: 'custom_fields.list_fields_for_module',
  module: MODULE,
  name: 'List fields for module',
  description: 'List non-archived custom fields defined on a given module.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listFieldsForModuleInput,
  outputSchema: listFieldsForModuleOutput,
  searchCard: {
    synonyms: ['custom fields on contacts', 'module field list'],
    examplePhrasings: ['What custom fields exist on contacts?'],
  },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?', 'category = ?'];
    const params: unknown[] = [KIND, input.module];
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

// --- A04 rename_field_label -----------------------------------------------------

const renameFieldLabelInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const renameFieldLabel: ActionDef<z.infer<typeof renameFieldLabelInput>, FieldView> = {
  id: 'M10.A04',
  slug: 'custom_fields.rename_field_label',
  module: MODULE,
  name: 'Rename field label',
  description: "Rename a custom field's display label.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: renameFieldLabelInput,
  outputSchema: fieldView,
  searchCard: {
    synonyms: ['edit field label', 'rename field'],
    examplePhrasings: ['Rename this field to Industry Segment'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getFieldRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET name = ?, updated_at = ? WHERE id = ?`, [
      input.name,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getFieldRow(ctx.db, input.id));
  }),
};

// --- A05 update_field_help_text -----------------------------------------------------

const updateFieldHelpTextInput = z.strictObject({ id: z.string(), help_text: z.string() });

const updateFieldHelpText: ActionDef<z.infer<typeof updateFieldHelpTextInput>, FieldView> = {
  id: 'M10.A05',
  slug: 'custom_fields.update_field_help_text',
  module: MODULE,
  name: 'Update field help text',
  description: "Set a custom field's help text.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateFieldHelpTextInput,
  outputSchema: fieldView,
  searchCard: {
    synonyms: ['edit field description', 'update help text'],
    examplePhrasings: ['Add help text explaining this field'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getFieldRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET description = ?, updated_at = ? WHERE id = ?`, [
      input.help_text,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getFieldRow(ctx.db, input.id));
  }),
};

// --- A06 set_field_validation_rules -----------------------------------------------------

const setFieldValidationRulesInput = z.strictObject({
  id: z.string(),
  validation: z.record(z.string(), z.unknown()),
});

const setFieldValidationRules: ActionDef<z.infer<typeof setFieldValidationRulesInput>, FieldView> = {
  id: 'M10.A06',
  slug: 'custom_fields.set_field_validation_rules',
  module: MODULE,
  name: 'Set field validation rules',
  description: 'Set the validation rules (e.g. required, max length) for a custom field.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setFieldValidationRulesInput,
  outputSchema: fieldView,
  searchCard: {
    synonyms: ['edit field validation', 'make field required'],
    examplePhrasings: ['Make this field required'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFieldRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, validation: input.validation }, ctx.clock.now());
    return toView(getFieldRow(ctx.db, input.id));
  }),
};

// --- A07 add_dropdown_option -----------------------------------------------------

const addDropdownOptionInput = z.strictObject({ id: z.string(), option: z.string().min(1) });

const addDropdownOption: ActionDef<z.infer<typeof addDropdownOptionInput>, FieldView> = {
  id: 'M10.A07',
  slug: 'custom_fields.add_dropdown_option',
  module: MODULE,
  name: 'Add dropdown option',
  description: 'Add a selectable option to a dropdown-type custom field.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addDropdownOptionInput,
  outputSchema: fieldView,
  searchCard: {
    synonyms: ['add field option', 'new dropdown choice'],
    examplePhrasings: ['Add "Enterprise" as an option on this dropdown field'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFieldRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.field_type !== 'dropdown') {
      throw new ActionError('VALIDATION', `Field '${input.id}' is not a dropdown field.`);
    }
    if (config.options.includes(input.option)) {
      throw new ActionError('CONFLICT', `Field '${input.id}' already has the option '${input.option}'.`);
    }
    writeConfig(ctx.db, input.id, { ...config, options: [...config.options, input.option] }, ctx.clock.now());
    return toView(getFieldRow(ctx.db, input.id));
  }),
};

// --- A08 retire_dropdown_option -----------------------------------------------------

const retireDropdownOptionInput = z.strictObject({ id: z.string(), option: z.string().min(1) });

const retireDropdownOption: ActionDef<z.infer<typeof retireDropdownOptionInput>, FieldView> = {
  id: 'M10.A08',
  slug: 'custom_fields.retire_dropdown_option',
  module: MODULE,
  name: 'Retire dropdown option',
  description: 'Move a dropdown option to the retired list (kept for historical values, hidden going forward).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: retireDropdownOptionInput,
  outputSchema: fieldView,
  searchCard: {
    synonyms: ['remove dropdown option', 'retire field choice'],
    examplePhrasings: ['Retire the "Legacy" option on this dropdown field'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFieldRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.field_type !== 'dropdown') {
      throw new ActionError('VALIDATION', `Field '${input.id}' is not a dropdown field.`);
    }
    if (!config.options.includes(input.option)) {
      throw new ActionError('NOT_FOUND', `Field '${input.id}' has no option '${input.option}'.`);
    }
    const options = config.options.filter((o) => o !== input.option);
    const retiredOptions = config.retired_options.includes(input.option)
      ? config.retired_options
      : [...config.retired_options, input.option];
    writeConfig(ctx.db, input.id, { ...config, options, retired_options: retiredOptions }, ctx.clock.now());
    return toView(getFieldRow(ctx.db, input.id));
  }),
};

// --- A09 set_record_field_value -----------------------------------------------------

const setRecordFieldValueInput = z.strictObject({
  id: z.string(),
  target_id: z.string(),
  value: z.unknown(),
});
const setRecordFieldValueOutput = z.object({
  id: z.string(),
  name: z.string(),
  field_id: z.string(),
  value: z.unknown(),
});

const setRecordFieldValue: ActionDef<
  z.infer<typeof setRecordFieldValueInput>,
  z.infer<typeof setRecordFieldValueOutput>
> = {
  id: 'M10.A09',
  slug: 'custom_fields.set_record_field_value',
  module: MODULE,
  name: 'Set record field value',
  description: 'Set a custom field value on a contact (the only entity with a custom_fields column).',
  risk: 'write',
  entities: ['structures', 'contacts'],
  inputSchema: setRecordFieldValueInput,
  outputSchema: setRecordFieldValueOutput,
  searchCard: {
    synonyms: ['set custom field value', 'fill in custom field'],
    examplePhrasings: ['Set the Industry Segment field to Enterprise for this contact'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getFieldRow(ctx.db, input.id); // existence check
    const contact = ctx.db.get(`SELECT * FROM contacts WHERE id = ?`, [input.target_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.target_id}' does not exist.`);
    const customFields = parseJsonObject(contact['custom_fields']);
    ctx.db.run(`UPDATE contacts SET custom_fields = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify({ ...customFields, [input.id]: input.value }),
      ctx.clock.now(),
      input.target_id,
    ]);
    return { id: input.target_id, name: contact['name'] as string, field_id: input.id, value: input.value };
  }),
};

// --- A10 archive_custom_field -----------------------------------------------------

const archiveCustomFieldInput = z.strictObject({ id: z.string() });
const archiveCustomFieldOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const archiveCustomField: ActionDef<
  z.infer<typeof archiveCustomFieldInput>,
  z.infer<typeof archiveCustomFieldOutput>
> = {
  id: 'M10.A10',
  slug: 'custom_fields.archive_custom_field',
  module: MODULE,
  name: 'Archive custom field',
  description: 'Soft-delete a custom field definition.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: archiveCustomFieldInput,
  outputSchema: archiveCustomFieldOutput,
  searchCard: {
    synonyms: ['delete custom field', 'remove field'],
    examplePhrasings: ['Archive the old Industry Segment field'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getFieldRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET archived = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, archived: true as const };
  }),
};

export const m10CustomFields: ActionDef[] = [
  createCustomField as ActionDef,
  getFieldDefinition as ActionDef,
  listFieldsForModule as ActionDef,
  renameFieldLabel as ActionDef,
  updateFieldHelpText as ActionDef,
  setFieldValidationRules as ActionDef,
  addDropdownOption as ActionDef,
  retireDropdownOption as ActionDef,
  setRecordFieldValue as ActionDef,
  archiveCustomField as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified: 'inactive' → 13, 'active' → 7). `module`/`category` is
 * required on every call (not a useful discriminator against seed data,
 * whose `category` is uniformly `'custom_field'`, not a target module
 * name) — `status` is the discriminating filter instead. Both calls pass
 * the same (seed) `module` value; `status` is what differs.
 */
export const m10DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'custom_fields.list_fields_for_module',
    paramsA: { module: 'custom_field', status: 'inactive' },
    paramsB: { module: 'custom_field', status: 'active' },
    expectDifferentCounts: true,
  },
];

/**
 * `entities[0] === 'structures'` with `kind = 'custom_field'` — every
 * action on this module's own `id` needs an action-scoped hint.
 */
export const m10SynthHints: SynthHints = {
  'custom_fields.get_field_definition:id': { table: 'structures', kind: KIND },
  'custom_fields.rename_field_label:id': { table: 'structures', kind: KIND },
  'custom_fields.update_field_help_text:id': { table: 'structures', kind: KIND },
  'custom_fields.set_field_validation_rules:id': { table: 'structures', kind: KIND },
  'custom_fields.add_dropdown_option:id': { table: 'structures', kind: KIND },
  'custom_fields.retire_dropdown_option:id': { table: 'structures', kind: KIND },
  'custom_fields.set_record_field_value:id': { table: 'structures', kind: KIND },
  'custom_fields.set_record_field_value:target_id': { table: 'contacts' },
  'custom_fields.archive_custom_field:id': { table: 'structures', kind: KIND },
};
