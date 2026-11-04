/**
 * M08 Tags — follows the M01 Contacts convention verbatim.
 *
 * Data home: tag DEFINITIONS live in `structures` (`kind = 'tag'`); tag
 * APPLICATION lives on the target record's own `tags` JSON column — the
 * only two tables in `entities/model.ts` that carry one are `contacts` and
 * `companies` (brief: "tag application on records via contacts.tags JSON /
 * entity tag arrays"). `target_type` is therefore restricted to
 * `'contact' | 'company'`. Applied tags are stored by NAME (matching the
 * existing `contacts.tags`/`companies.tags` convention from M01/M02) rather
 * than by structures id — renaming a tag does not retroactively relabel
 * already-applied entries (documented scope limitation, same tradeoff
 * M01's `merge_duplicate_contacts` makes for `custom_fields`).
 *
 * KIND-BLINDNESS NOTE (same as M05): `entities[0]` is `'structures'` with
 * `kind = 'tag'` — every action taking this module's own `id` declares an
 * action-scoped synthHint (`${slug}:id`). `tag_id`/`primary_tag_id`/
 * `duplicate_tag_id` are flat (non-scoped) hints since those field names
 * are unique to this module.
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
import { parseJsonArray, parseJsonObject } from './json.js';

const MODULE = 'tags';
const KIND = 'tag';
const TARGET_TABLES: Record<'contact' | 'company', string> = {
  contact: 'contacts',
  company: 'companies',
};

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'tag'}-${id}`;
}

interface TagView {
  id: string;
  name: string;
  color: string | null;
  status: string;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): TagView {
  const config = parseJsonObject(row['config']);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    color: (config['color'] as string | undefined) ?? null,
    status: row['status'] as string,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getTagRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Tag '${id}' does not exist.`);
  return row;
}

function getTargetRow(db: StoreTx, targetType: 'contact' | 'company', id: string): Row {
  const table = TARGET_TABLES[targetType];
  const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `${targetType} '${id}' does not exist.`);
  return row;
}

function usageCount(db: StoreTx, table: string, tagName: string): number {
  const row = db.get(
    `SELECT COUNT(*) AS n FROM ${table} WHERE archived = 0 AND tags LIKE ?`,
    [`%"${tagName}"%`],
  );
  return (row?.['n'] as number) ?? 0;
}

const tagView = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  status: z.string(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_tag -------------------------------------------------------------

const createTagInput = z.strictObject({ name: z.string().min(1), color: z.string().optional() });
type CreateTagInput = z.infer<typeof createTagInput>;

const createTag: ActionDef<CreateTagInput, TagView> = {
  id: 'M08.A01',
  slug: 'tags.create_tag',
  module: MODULE,
  name: 'Create tag',
  description: 'Create a new tag definition.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createTagInput,
  outputSchema: tagView,
  searchCard: {
    synonyms: ['add tag', 'new tag'],
    examplePhrasings: ['Create a tag called VIP'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify({ color: input.color ?? null })],
    );
    return toView(getTagRow(ctx.db, id));
  }),
};

// --- A02 list_tags -------------------------------------------------------------

const listTagsInput = z.strictObject({
  owner_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListTagsInput = z.infer<typeof listTagsInput>;
const listTagsOutput = listOutputSchema(tagView);
type ListTagsOutput = ListOrSpill<TagView>;

const listTags: ActionDef<ListTagsInput, ListTagsOutput> = {
  id: 'M08.A02',
  slug: 'tags.list_tags',
  module: MODULE,
  name: 'List tags',
  description: 'List non-archived tag definitions.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listTagsInput,
  outputSchema: listTagsOutput,
  searchCard: {
    synonyms: ['all tags', 'show tags'],
    examplePhrasings: ['List all our tags'],
  },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
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

// --- A03 rename_tag -------------------------------------------------------------

const renameTagInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const renameTag: ActionDef<z.infer<typeof renameTagInput>, TagView> = {
  id: 'M08.A03',
  slug: 'tags.rename_tag',
  module: MODULE,
  name: 'Rename tag',
  description: 'Rename a tag definition (does not relabel already-applied entries).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: renameTagInput,
  outputSchema: tagView,
  searchCard: {
    synonyms: ['edit tag name', 'change tag label'],
    examplePhrasings: ['Rename the VIP tag to Premium'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTagRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET name = ?, updated_at = ? WHERE id = ?`, [
      input.name,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTagRow(ctx.db, input.id));
  }),
};

// --- A04 set_tag_color -------------------------------------------------------------

const setTagColorInput = z.strictObject({ id: z.string(), color: z.string().min(1) });

const setTagColor: ActionDef<z.infer<typeof setTagColorInput>, TagView> = {
  id: 'M08.A04',
  slug: 'tags.set_tag_color',
  module: MODULE,
  name: 'Set tag color',
  description: 'Set the display color for a tag.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setTagColorInput,
  outputSchema: tagView,
  searchCard: {
    synonyms: ['change tag color', 'recolor tag'],
    examplePhrasings: ['Make the VIP tag red'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTagRow(ctx.db, input.id);
    const config = parseJsonObject(row['config']);
    ctx.db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify({ ...config, color: input.color }),
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTagRow(ctx.db, input.id));
  }),
};

// --- A05 delete_unused_tag -------------------------------------------------------------

const deleteUnusedTagInput = z.strictObject({ id: z.string() });
const deleteUnusedTagOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const deleteUnusedTag: ActionDef<z.infer<typeof deleteUnusedTagInput>, z.infer<typeof deleteUnusedTagOutput>> = {
  id: 'M08.A05',
  slug: 'tags.delete_unused_tag',
  module: MODULE,
  name: 'Delete unused tag',
  description: 'Archive a tag definition, refusing if it is still applied anywhere.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: deleteUnusedTagInput,
  outputSchema: deleteUnusedTagOutput,
  searchCard: {
    synonyms: ['remove unused tag', 'clean up tags'],
    examplePhrasings: ['Delete the Old Campaign tag, nobody uses it'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTagRow(ctx.db, input.id);
    const name = row['name'] as string;
    const total = usageCount(ctx.db, 'contacts', name) + usageCount(ctx.db, 'companies', name);
    if (total > 0) {
      throw new ActionError('CONFLICT', `Tag '${name}' is still applied to ${total} record(s).`);
    }
    ctx.db.run(`UPDATE structures SET archived = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name, archived: true as const };
  }),
};

// --- A06 apply_tag_to_record -------------------------------------------------------------

const applyTagToRecordInput = z.strictObject({
  tag_id: z.string(),
  target_type: z.enum(['contact', 'company']),
  target_id: z.string(),
});
const applyTagToRecordOutput = z.object({
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
});

const applyTagToRecord: ActionDef<
  z.infer<typeof applyTagToRecordInput>,
  z.infer<typeof applyTagToRecordOutput>
> = {
  id: 'M08.A06',
  slug: 'tags.apply_tag_to_record',
  module: MODULE,
  name: 'Apply tag to record',
  description: 'Add a tag to a contact or company.',
  risk: 'write',
  entities: ['structures', 'contacts', 'companies'],
  inputSchema: applyTagToRecordInput,
  outputSchema: applyTagToRecordOutput,
  searchCard: {
    synonyms: ['tag record', 'add tag to contact'],
    examplePhrasings: ['Tag this contact as VIP'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const tag = getTagRow(ctx.db, input.tag_id);
    const target = getTargetRow(ctx.db, input.target_type, input.target_id);
    const table = TARGET_TABLES[input.target_type];
    const tagName = tag['name'] as string;
    const tags = parseJsonArray(target['tags']);
    const nextTags = tags.includes(tagName) ? tags : [...tags, tagName];
    ctx.db.run(`UPDATE ${table} SET tags = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(nextTags),
      ctx.clock.now(),
      input.target_id,
    ]);
    return { id: input.target_id, name: target['name'] as string, tags: nextTags };
  }),
};

// --- A07 remove_tag_from_record -------------------------------------------------------------

const removeTagFromRecordInput = z.strictObject({
  tag_id: z.string(),
  target_type: z.enum(['contact', 'company']),
  target_id: z.string(),
});
const removeTagFromRecordOutput = z.object({
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
});

const removeTagFromRecord: ActionDef<
  z.infer<typeof removeTagFromRecordInput>,
  z.infer<typeof removeTagFromRecordOutput>
> = {
  id: 'M08.A07',
  slug: 'tags.remove_tag_from_record',
  module: MODULE,
  name: 'Remove tag from record',
  description: 'Remove a tag from a contact or company.',
  risk: 'write',
  entities: ['structures', 'contacts', 'companies'],
  inputSchema: removeTagFromRecordInput,
  outputSchema: removeTagFromRecordOutput,
  searchCard: {
    synonyms: ['untag record', 'remove tag from contact'],
    examplePhrasings: ['Remove the VIP tag from this contact'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const tag = getTagRow(ctx.db, input.tag_id);
    const target = getTargetRow(ctx.db, input.target_type, input.target_id);
    const table = TARGET_TABLES[input.target_type];
    const tagName = tag['name'] as string;
    const tags = parseJsonArray(target['tags']).filter((t) => t !== tagName);
    ctx.db.run(`UPDATE ${table} SET tags = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(tags),
      ctx.clock.now(),
      input.target_id,
    ]);
    return { id: input.target_id, name: target['name'] as string, tags };
  }),
};

// --- A08 list_records_with_tag -------------------------------------------------------------

const listRecordsWithTagInput = z.strictObject({
  tag_id: z.string(),
  target_type: z.enum(['contact', 'company']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const recordSummary = z.object({ id: z.string(), name: z.string(), target_type: z.string() });
const listRecordsWithTagOutput = listOutputSchema(recordSummary);
type ListRecordsWithTagOutput = ListOrSpill<z.infer<typeof recordSummary>>;

const listRecordsWithTag: ActionDef<
  z.infer<typeof listRecordsWithTagInput>,
  ListRecordsWithTagOutput
> = {
  id: 'M08.A08',
  slug: 'tags.list_records_with_tag',
  module: MODULE,
  name: 'List records with tag',
  description: 'List contacts and/or companies carrying a tag.',
  risk: 'read',
  entities: ['structures', 'contacts', 'companies'],
  inputSchema: listRecordsWithTagInput,
  outputSchema: listRecordsWithTagOutput,
  searchCard: {
    synonyms: ['who has this tag', 'records tagged VIP'],
    examplePhrasings: ['Show me every contact tagged VIP'],
  },
  handler: async (input, ctx) => {
    const tag = getTagRow(ctx.db, input.tag_id);
    const tagName = tag['name'] as string;
    const like = `%"${tagName}"%`;
    const limit = input.limit ?? 50;
    const targetTypes: Array<'contact' | 'company'> = input.target_type
      ? [input.target_type]
      : ['contact', 'company'];

    let total = 0;
    const rows: Array<{ id: string; name: string; target_type: string }> = [];
    for (const targetType of targetTypes) {
      const table = TARGET_TABLES[targetType];
      const countRow = ctx.db.get(
        `SELECT COUNT(*) AS n FROM ${table} WHERE archived = 0 AND tags LIKE ?`,
        [like],
      );
      total += (countRow?.['n'] as number) ?? 0;
      const found = ctx.db.all(
        `SELECT id, name FROM ${table} WHERE archived = 0 AND tags LIKE ? ORDER BY created_at DESC LIMIT ?`,
        [like, limit],
      );
      rows.push(...found.map((r) => ({ id: r['id'] as string, name: r['name'] as string, target_type: targetType })));
    }
    return toListOrSpill(rows.slice(0, limit), total);
  },
};

// --- A09 merge_tags -------------------------------------------------------------

const mergeTagsInput = z.strictObject({ primary_tag_id: z.string(), duplicate_tag_id: z.string() });
const mergeTagsOutput = z.object({ id: z.string(), name: z.string(), merged_from: z.string() });

const mergeTags: ActionDef<z.infer<typeof mergeTagsInput>, z.infer<typeof mergeTagsOutput>> = {
  id: 'M08.A09',
  slug: 'tags.merge_tags',
  module: MODULE,
  name: 'Merge tags',
  description: 'Fold a duplicate tag into the primary, relabeling every applied record.',
  risk: 'destructive',
  entities: ['structures', 'contacts', 'companies'],
  inputSchema: mergeTagsInput,
  outputSchema: mergeTagsOutput,
  searchCard: {
    synonyms: ['dedupe tags', 'merge duplicate tags'],
    examplePhrasings: ['These two tags are the same, merge them'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    if (input.primary_tag_id === input.duplicate_tag_id) {
      throw new ActionError('CONFLICT', 'Cannot merge a tag into itself.');
    }
    const primary = getTagRow(ctx.db, input.primary_tag_id);
    const duplicate = getTagRow(ctx.db, input.duplicate_tag_id);
    const primaryName = primary['name'] as string;
    const duplicateName = duplicate['name'] as string;
    const now = ctx.clock.now();

    for (const table of ['contacts', 'companies'] as const) {
      const rows = ctx.db.all(`SELECT id, tags FROM ${table} WHERE archived = 0 AND tags LIKE ?`, [
        `%"${duplicateName}"%`,
      ]);
      for (const r of rows) {
        const tags = parseJsonArray(r['tags']);
        const next = Array.from(new Set(tags.map((t) => (t === duplicateName ? primaryName : t))));
        ctx.db.run(`UPDATE ${table} SET tags = ?, updated_at = ? WHERE id = ?`, [
          JSON.stringify(next),
          now,
          r['id'],
        ]);
      }
    }
    ctx.db.run(`UPDATE structures SET archived = 1, updated_at = ? WHERE id = ?`, [
      now,
      input.duplicate_tag_id,
    ]);
    return { id: input.primary_tag_id, name: primaryName, merged_from: input.duplicate_tag_id };
  }),
};

// --- A10 view_tag_usage_counts -------------------------------------------------------------

const viewTagUsageCountsInput = z.strictObject({ id: z.string() });
const viewTagUsageCountsOutput = z.object({
  id: z.string(),
  name: z.string(),
  contact_count: z.number(),
  company_count: z.number(),
  total: z.number(),
});

const viewTagUsageCounts: ActionDef<
  z.infer<typeof viewTagUsageCountsInput>,
  z.infer<typeof viewTagUsageCountsOutput>
> = {
  id: 'M08.A10',
  slug: 'tags.view_tag_usage_counts',
  module: MODULE,
  name: 'View tag usage counts',
  description: 'Count how many contacts and companies carry a tag.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: viewTagUsageCountsInput,
  outputSchema: viewTagUsageCountsOutput,
  searchCard: {
    synonyms: ['tag usage', 'how many records have this tag'],
    examplePhrasings: ['How many contacts are tagged VIP?'],
  },
  handler: async (input, ctx) => {
    const row = getTagRow(ctx.db, input.id);
    const name = row['name'] as string;
    const contactCount = usageCount(ctx.db, 'contacts', name);
    const companyCount = usageCount(ctx.db, 'companies', name);
    return { id: input.id, name, contact_count: contactCount, company_count: companyCount, total: contactCount + companyCount };
  },
};

export const m08Tags: ActionDef[] = [
  createTag as ActionDef,
  listTags as ActionDef,
  renameTag as ActionDef,
  setTagColor as ActionDef,
  deleteUnusedTag as ActionDef,
  applyTagToRecord as ActionDef,
  removeTagFromRecord as ActionDef,
  listRecordsWithTag as ActionDef,
  mergeTags as ActionDef,
  viewTagUsageCounts as ActionDef,
];

/**
 * Tier-A discrimination: `owner_id` counts against the standard template
 * (verified: 'user_40' → 2, 'user_5' → 1) — `tag` kind's `status` is 100%
 * 'active' in the seed (no variation), so `owner_id` is the discriminating
 * filter for `list_tags` instead. Deliberately avoids 'user_31'/'user_6' —
 * the owners of this module's two lowest-id tag rows (struct_351/struct_352),
 * which `delete_unused_tag`/`merge_tags`'s own smoke runs archive earlier in
 * the SAME `--module m08` run (both resolve their own `id`/`duplicate_tag_id`
 * to those exact rows via offset 0/1) — using either owner here would make
 * the check flaky depending on execution order within this module.
 */
export const m08DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'tags.list_tags',
    paramsA: { owner_id: 'user_40' },
    paramsB: { owner_id: 'user_5' },
    expectDifferentCounts: true,
  },
];

/**
 * `entities[0] === 'structures'` with `kind = 'tag'` — every action on this
 * module's own `id` needs an action-scoped hint (see testing.ts's
 * `${slug}:${field}` precedence). `tag_id`/`primary_tag_id`/
 * `duplicate_tag_id` are flat hints since those field names are unique to
 * this module (no cross-module collision risk). `target_id` is scoped
 * because its meaning (which table) depends on `target_type`, which this
 * module fixes at `'contact'` (the enum's first declared option, matching
 * what `synthesizeInput` picks) — a later module reusing the field name
 * `target_id` with a different first-option meaning (e.g. M45 Reviews'
 * `target_type: 'product' | …`) would otherwise collide in the flat
 * `MODULE_SYNTH_HINTS` merge.
 */
export const m08SynthHints: SynthHints = {
  'tags.rename_tag:id': { table: 'structures', kind: KIND },
  'tags.set_tag_color:id': { table: 'structures', kind: KIND },
  'tags.delete_unused_tag:id': { table: 'structures', kind: KIND },
  'tags.view_tag_usage_counts:id': { table: 'structures', kind: KIND },
  tag_id: { table: 'structures', kind: KIND },
  primary_tag_id: { table: 'structures', kind: KIND },
  duplicate_tag_id: { table: 'structures', kind: KIND },
  'tags.apply_tag_to_record:target_id': { table: 'contacts' },
  'tags.remove_tag_from_record:target_id': { table: 'contacts' },
};
