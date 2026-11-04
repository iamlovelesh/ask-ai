/**
 * M39 Media Assets — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'media_asset'`
 * (`entities/model.ts#MODULE_MAP` — no dedicated typed table). `config` is
 * `{ url: string, mime_type: string, size_bytes: number, folder: string|
 * null, alt_text: string|null, version: number }`. No real files exist in
 * this simulated system — `url` is a synthetic
 * `https://assets.ourcrm.io/{id}/{slug}` string (per the brief:
 * "upload records metadata — no real files — synthetic urls").
 *
 * `list_asset_references` (A08) / `delete_unreferenced_asset` (A10) do a
 * REAL substring scan of every `content_items.body` and `structures.config`
 * row for the asset's own `url` — a genuine (if, for freshly-seeded data,
 * typically empty) answer, not a fabricated one, per the brief: "real scan
 * of content_items/structures configs".
 *
 * KIND-BLINDNESS NOTE: `entities[0]` is `'structures'` — the bare `id`
 * field needs an action-scoped synthHint.
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

const MODULE = 'media_assets';
const KIND = 'media_asset';

function slugify(name: string, id: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'asset'}-${id}`;
}

interface AssetConfig {
  url: string;
  mime_type: string;
  size_bytes: number;
  folder: string | null;
  alt_text: string | null;
  version: number;
}

function readConfig(row: Row): AssetConfig {
  const config = parseJsonObject(row['config']);
  return {
    url: typeof config['url'] === 'string' ? (config['url'] as string) : `https://assets.ourcrm.io/${row['id'] as string}`,
    mime_type: typeof config['mime_type'] === 'string' ? (config['mime_type'] as string) : 'application/octet-stream',
    size_bytes: typeof config['size_bytes'] === 'number' ? (config['size_bytes'] as number) : 0,
    folder: (config['folder'] as string | null | undefined) ?? null,
    alt_text: (config['alt_text'] as string | null | undefined) ?? null,
    version: typeof config['version'] === 'number' ? (config['version'] as number) : 1,
  };
}

function writeConfig(db: StoreTx, id: string, config: AssetConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

function getAssetRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Media asset '${id}' does not exist.`);
  return row;
}

interface AssetView {
  id: string;
  name: string;
  status: string;
  url: string;
  mime_type: string;
  size_bytes: number;
  folder: string | null;
  alt_text: string | null;
  version: number;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): AssetView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    ...config,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const assetView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  url: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  folder: z.string().nullable(),
  alt_text: z.string().nullable(),
  version: z.number(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

interface ReferenceEntry {
  table: string;
  id: string;
  kind: string;
  title: string;
}

const referenceEntry = z.object({ table: z.string(), id: z.string(), kind: z.string(), title: z.string() });

/** Real substring scan for `asset.url` across the two free-text homes that
 * could embed it (`content_items.body`, `structures.config`) — bounded by
 * `LIMIT 200` per source, same SQL-bounded-before-merge pattern as M01's
 * activity timeline. */
function findReferences(db: StoreTx, url: string): ReferenceEntry[] {
  const like = `%${url}%`;
  const contentRows = db.all(`SELECT id, kind, title FROM content_items WHERE body LIKE ? LIMIT 200`, [like]);
  const structureRows = db.all(`SELECT id, kind, name FROM structures WHERE config LIKE ? AND kind != ? LIMIT 200`, [like, KIND]);
  return [
    ...contentRows.map((r) => ({ table: 'content_items', id: r['id'] as string, kind: r['kind'] as string, title: r['title'] as string })),
    ...structureRows.map((r) => ({ table: 'structures', id: r['id'] as string, kind: r['kind'] as string, title: r['name'] as string })),
  ];
}

// --- A01 upload_media_asset -----------------------------------------------------

const uploadMediaAssetInput = z.strictObject({
  name: z.string().min(1),
  mime_type: z.string().optional(),
  size_bytes: z.number().int().min(0).optional(),
  folder: z.string().optional(),
});

const uploadMediaAsset: ActionDef<z.infer<typeof uploadMediaAssetInput>, AssetView> = {
  id: 'M39.A01',
  slug: 'media_assets.upload_media_asset',
  module: MODULE,
  name: 'Upload media asset',
  description: 'Record a new media asset (synthetic url — no real file storage in this environment).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: uploadMediaAssetInput,
  outputSchema: assetView,
  searchCard: { synonyms: ['upload file', 'add media asset'], examplePhrasings: ['Upload a new hero image'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const slug = slugify(input.name, id);
    const config: AssetConfig = {
      url: `https://assets.ourcrm.io/${id}/${slug}`,
      mime_type: input.mime_type ?? 'image/png',
      size_bytes: input.size_bytes ?? 0,
      folder: input.folder ?? null,
      alt_text: null,
      version: 1,
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slug, KIND, JSON.stringify(config)],
    );
    return toView(getAssetRow(ctx.db, id));
  }),
};

// --- A02 get_asset_metadata -----------------------------------------------------

const getAssetMetadataInput = z.strictObject({ id: z.string() });

const getAssetMetadata: ActionDef<z.infer<typeof getAssetMetadataInput>, AssetView> = {
  id: 'M39.A02',
  slug: 'media_assets.get_asset_metadata',
  module: MODULE,
  name: 'Get asset metadata',
  description: 'Fetch a media asset by id.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getAssetMetadataInput,
  outputSchema: assetView,
  searchCard: { synonyms: ['asset details', 'look up media asset'], examplePhrasings: ['Show me this media asset'] },
  handler: async (input, ctx) => toView(getAssetRow(ctx.db, input.id)),
};

// --- A03 search_media_assets -----------------------------------------------------

const searchMediaAssetsInput = z.strictObject({
  folder: z.string().optional(),
  status: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchMediaAssetsInput = z.infer<typeof searchMediaAssetsInput>;
const searchMediaAssetsOutput = listOutputSchema(assetView);
type SearchMediaAssetsOutput = ListOrSpill<AssetView>;

const searchMediaAssets: ActionDef<SearchMediaAssetsInput, SearchMediaAssetsOutput> = {
  id: 'M39.A03',
  slug: 'media_assets.search_media_assets',
  module: MODULE,
  name: 'Search media assets',
  description: 'Search non-archived media assets by folder, status, and name.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: searchMediaAssetsInput,
  outputSchema: searchMediaAssetsOutput,
  searchCard: { synonyms: ['find media assets', 'list media assets'], examplePhrasings: ['Show me assets in the marketing folder'] },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.query) {
      where.push('name LIKE ?');
      params.push(`%${input.query}%`);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM structures WHERE ${whereSql}`, params);
    // `folder` lives inside the JSON `config` column, not a real SQL column
    // — filtering it requires fetching candidate rows first. The fetch is
    // bounded at 200, comfortably above `STRUCTURE_COUNTS.media_asset` (40
    // in the committed seed), so this candidate pool always covers the
    // FULL kind='media_asset' universe for this dataset size; it is not a
    // generically safe bound for an arbitrarily larger media library.
    let rows = ctx.db.all(`SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, 200]);
    if (input.folder !== undefined) {
      rows = rows.filter((r) => readConfig(r).folder === input.folder);
    }
    const total = input.folder !== undefined ? rows.length : (countRow?.['n'] as number) ?? 0;
    return toListOrSpill(rows.slice(0, limit).map(toView), total);
  },
};

// --- A04 rename_media_asset -----------------------------------------------------

const renameMediaAssetInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const renameMediaAsset: ActionDef<z.infer<typeof renameMediaAssetInput>, AssetView> = {
  id: 'M39.A04',
  slug: 'media_assets.rename_media_asset',
  module: MODULE,
  name: 'Rename media asset',
  description: 'Rename a media asset.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: renameMediaAssetInput,
  outputSchema: assetView,
  searchCard: { synonyms: ['change asset name'], examplePhrasings: ['Rename this media asset'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getAssetRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET name = ?, updated_at = ? WHERE id = ?`, [input.name, ctx.clock.now(), input.id]);
    return toView(getAssetRow(ctx.db, input.id));
  }),
};

// --- A05 set_asset_alt_text -----------------------------------------------------

const setAssetAltTextInput = z.strictObject({ id: z.string(), alt_text: z.string() });

const setAssetAltText: ActionDef<z.infer<typeof setAssetAltTextInput>, AssetView> = {
  id: 'M39.A05',
  slug: 'media_assets.set_asset_alt_text',
  module: MODULE,
  name: 'Set asset alt text',
  description: 'Set the accessibility alt text for a media asset.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setAssetAltTextInput,
  outputSchema: assetView,
  searchCard: { synonyms: ['set alt text', 'image description'], examplePhrasings: ['Set alt text for this image'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAssetRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, alt_text: input.alt_text }, ctx.clock.now());
    return toView(getAssetRow(ctx.db, input.id));
  }),
};

// --- A06 move_asset_to_folder -----------------------------------------------------

const moveAssetToFolderInput = z.strictObject({ id: z.string(), folder: z.string().nullable() });

const moveAssetToFolder: ActionDef<z.infer<typeof moveAssetToFolderInput>, AssetView> = {
  id: 'M39.A06',
  slug: 'media_assets.move_asset_to_folder',
  module: MODULE,
  name: 'Move asset to folder',
  description: 'Move a media asset to a different folder (null = root).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: moveAssetToFolderInput,
  outputSchema: assetView,
  searchCard: { synonyms: ['organize asset', 'move to folder'], examplePhrasings: ['Move this image into the blog folder'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAssetRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, folder: input.folder }, ctx.clock.now());
    return toView(getAssetRow(ctx.db, input.id));
  }),
};

// --- A07 replace_asset_file -----------------------------------------------------

const replaceAssetFileInput = z.strictObject({ id: z.string(), mime_type: z.string().optional(), size_bytes: z.number().int().min(0).optional() });

const replaceAssetFile: ActionDef<z.infer<typeof replaceAssetFileInput>, AssetView> = {
  id: 'M39.A07',
  slug: 'media_assets.replace_asset_file',
  module: MODULE,
  name: 'Replace asset file',
  description: 'Replace the underlying file for a media asset, bumping its version (url gains a `?v=N` suffix).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: replaceAssetFileInput,
  outputSchema: assetView,
  searchCard: { synonyms: ['re-upload asset', 'replace file'], examplePhrasings: ['Replace this image with the new version'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAssetRow(ctx.db, input.id);
    const config = readConfig(row);
    const nextVersion = config.version + 1;
    const baseUrl = config.url.split('?')[0];
    const next: AssetConfig = {
      ...config,
      url: `${baseUrl}?v=${nextVersion}`,
      mime_type: input.mime_type ?? config.mime_type,
      size_bytes: input.size_bytes ?? config.size_bytes,
      version: nextVersion,
    };
    writeConfig(ctx.db, input.id, next, ctx.clock.now());
    return toView(getAssetRow(ctx.db, input.id));
  }),
};

// --- A08 list_asset_references -----------------------------------------------------

const listAssetReferencesInput = z.strictObject({ id: z.string() });
const listAssetReferencesOutput = listOutputSchema(referenceEntry);
type ListAssetReferencesOutput = ListOrSpill<ReferenceEntry>;

const listAssetReferences: ActionDef<z.infer<typeof listAssetReferencesInput>, ListAssetReferencesOutput> = {
  id: 'M39.A08',
  slug: 'media_assets.list_asset_references',
  module: MODULE,
  name: 'List asset references',
  description: 'Scan website/landing/blog content and other structures configs for real usages of this asset.',
  risk: 'read',
  entities: ['structures', 'content_items'],
  inputSchema: listAssetReferencesInput,
  outputSchema: listAssetReferencesOutput,
  searchCard: { synonyms: ['where is this used', 'asset usages'], examplePhrasings: ['Where is this image used?'] },
  handler: async (input, ctx) => {
    const row = getAssetRow(ctx.db, input.id);
    const config = readConfig(row);
    const refs = findReferences(ctx.db, config.url);
    return toListOrSpill(refs, refs.length);
  },
};

// --- A09 generate_asset_access_link -----------------------------------------------------

const generateAssetAccessLinkInput = z.strictObject({ id: z.string(), expires_in_seconds: z.number().int().min(1).optional() });
const accessLinkOutput = z.object({ id: z.string(), name: z.string(), url: z.string(), expires_at: z.number() });

const generateAssetAccessLink: ActionDef<z.infer<typeof generateAssetAccessLinkInput>, z.infer<typeof accessLinkOutput>> = {
  id: 'M39.A09',
  slug: 'media_assets.generate_asset_access_link',
  module: MODULE,
  name: 'Generate asset access link',
  description: 'Generate a time-limited (simulated) signed URL for a media asset.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: generateAssetAccessLinkInput,
  outputSchema: accessLinkOutput,
  searchCard: { synonyms: ['get signed url', 'temporary access link'], examplePhrasings: ['Give me a shareable link for this asset'] },
  handler: async (input, ctx) => {
    const row = getAssetRow(ctx.db, input.id);
    const config = readConfig(row);
    const now = ctx.clock.now();
    const expiresInMs = (input.expires_in_seconds ?? 3600) * 1000;
    const expiresAt = now + expiresInMs;
    const sep = config.url.includes('?') ? '&' : '?';
    return { id: input.id, name: row['name'] as string, url: `${config.url}${sep}expires=${expiresAt}`, expires_at: expiresAt };
  },
};

// --- A10 delete_unreferenced_asset -----------------------------------------------------

const deleteUnreferencedAssetInput = z.strictObject({ id: z.string() });

const deleteUnreferencedAsset: ActionDef<z.infer<typeof deleteUnreferencedAssetInput>, AssetView> = {
  id: 'M39.A10',
  slug: 'media_assets.delete_unreferenced_asset',
  module: MODULE,
  name: 'Delete unreferenced asset',
  description: 'Archive a media asset, refusing if it is still referenced anywhere in content.',
  risk: 'destructive',
  entities: ['structures', 'content_items'],
  inputSchema: deleteUnreferencedAssetInput,
  outputSchema: assetView,
  searchCard: { synonyms: ['delete unused asset', 'remove orphaned file'], examplePhrasings: ['Delete this asset if nothing uses it'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getAssetRow(ctx.db, input.id);
    const config = readConfig(row);
    const refs = findReferences(ctx.db, config.url);
    if (refs.length > 0) {
      throw new ActionError('CONFLICT', `Media asset '${input.id}' is still referenced by ${refs.length} item(s) — cannot delete.`);
    }
    ctx.db.run(`UPDATE structures SET archived = 1, updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getAssetRow(ctx.db, input.id));
  }),
};

export const m39MediaAssets: ActionDef[] = [
  uploadMediaAsset as ActionDef,
  getAssetMetadata as ActionDef,
  searchMediaAssets as ActionDef,
  renameMediaAsset as ActionDef,
  setAssetAltText as ActionDef,
  moveAssetToFolder as ActionDef,
  replaceAssetFile as ActionDef,
  listAssetReferences as ActionDef,
  generateAssetAccessLink as ActionDef,
  deleteUnreferencedAsset as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'active' → 23, 'archived' → 17 out of
 * 40 seeded media assets).
 */
export const m39DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'media_assets.search_media_assets',
    paramsA: { status: 'active' },
    paramsB: { status: 'archived' },
    expectDifferentCounts: true,
  },
];

export const m39SynthHints: SynthHints = {
  'media_assets.get_asset_metadata:id': { table: 'structures', kind: KIND },
  'media_assets.rename_media_asset:id': { table: 'structures', kind: KIND },
  'media_assets.set_asset_alt_text:id': { table: 'structures', kind: KIND },
  'media_assets.move_asset_to_folder:id': { table: 'structures', kind: KIND },
  'media_assets.replace_asset_file:id': { table: 'structures', kind: KIND },
  'media_assets.list_asset_references:id': { table: 'structures', kind: KIND },
  'media_assets.generate_asset_access_link:id': { table: 'structures', kind: KIND },
  'media_assets.delete_unreferenced_asset:id': { table: 'structures', kind: KIND },
};
