/**
 * M35 Websites — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'website'` (the site container —
 * nav/home-page/SEO-defaults config) PLUS `content_items` table,
 * `kind = 'website_page'` (`parent_id` = the website's `structures` id).
 * This module is the sole writer of `content_items(kind='website_page')`
 * rows (M37/M38 each own their own `content_items` kind — task-8 guide §10
 * redirect pattern, just generalized to a third kind sharing the table).
 *
 * `config` is `{ home_page_id: string|null, nav: NavItem[], seo_defaults:
 * {title:string|null, description:string|null} }`. Seeded website rows
 * carry the generic placeholder `{seeded:true,kind:'website'}`
 * (`entities/seed-core.ts`), so `readConfig` falls back to an empty
 * nav/no-home-page default — same "config absent" pattern as M05 pipelines.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10/M14/M18/…): `entities[0]`
 * for every definition-level action is `'structures'` — the bare `id`
 * field needs an action-scoped synthHint (`${slug}:id`), see
 * `m35SynthHints`.
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

const MODULE = 'websites';
const KIND = 'website';
const PAGE_KIND = 'website_page';

function slugify(name: string, id: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${base || 'website'}-${id}`;
}

interface NavItem {
  label: string;
  url: string | null;
  page_id: string | null;
}

interface WebsiteConfig {
  home_page_id: string | null;
  nav: NavItem[];
  seo_defaults: { title: string | null; description: string | null };
}

function readConfig(row: Row): WebsiteConfig {
  const config = parseJsonObject(row['config']);
  const seo = config['seo_defaults'] && typeof config['seo_defaults'] === 'object' ? (config['seo_defaults'] as Record<string, unknown>) : {};
  return {
    home_page_id: (config['home_page_id'] as string | null | undefined) ?? null,
    nav: Array.isArray(config['nav']) ? (config['nav'] as NavItem[]) : [],
    seo_defaults: {
      title: (seo['title'] as string | null | undefined) ?? null,
      description: (seo['description'] as string | null | undefined) ?? null,
    },
  };
}

function writeConfig(db: StoreTx, id: string, config: WebsiteConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

function getWebsiteRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Website '${id}' does not exist.`);
  return row;
}

function countPages(db: StoreTx, websiteId: string): number {
  const row = db.get(`SELECT COUNT(*) AS n FROM content_items WHERE kind = ? AND parent_id = ? AND archived = 0`, [
    PAGE_KIND,
    websiteId,
  ]);
  return (row?.['n'] as number) ?? 0;
}

interface WebsiteView {
  id: string;
  name: string;
  status: string;
  home_page_id: string | null;
  nav: NavItem[];
  seo_defaults: { title: string | null; description: string | null };
  page_count: number;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(db: StoreTx, row: Row): WebsiteView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    home_page_id: config.home_page_id,
    nav: config.nav,
    seo_defaults: config.seo_defaults,
    page_count: countPages(db, row['id'] as string),
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const navItemSchema = z.object({ label: z.string(), url: z.string().nullable(), page_id: z.string().nullable() });

const websiteView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  home_page_id: z.string().nullable(),
  nav: z.array(navItemSchema),
  seo_defaults: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
  page_count: z.number(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

interface PageView {
  id: string;
  name: string;
  website_id: string;
  path: string;
  status: string;
}

const pageView = z.object({
  id: z.string(),
  name: z.string(),
  website_id: z.string(),
  path: z.string(),
  status: z.string(),
});

function toPageView(row: Row): PageView {
  return {
    id: row['id'] as string,
    name: row['title'] as string,
    website_id: row['parent_id'] as string,
    path: row['path'] as string,
    status: row['status'] as string,
  };
}

// --- A01 create_website -----------------------------------------------------

const createWebsiteInput = z.strictObject({ name: z.string().min(1) });

const createWebsite: ActionDef<z.infer<typeof createWebsiteInput>, WebsiteView> = {
  id: 'M35.A01',
  slug: 'websites.create_website',
  module: MODULE,
  name: 'Create website',
  description: 'Create a new website container.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createWebsiteInput,
  outputSchema: websiteView,
  searchCard: {
    synonyms: ['add website', 'new site'],
    examplePhrasings: ['Create a new marketing website'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: WebsiteConfig = { home_page_id: null, nav: [], seo_defaults: { title: null, description: null } };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(ctx.db, getWebsiteRow(ctx.db, id));
  }),
};

// --- A02 get_website_settings -----------------------------------------------

const getWebsiteSettingsInput = z.strictObject({ id: z.string() });

const getWebsiteSettings: ActionDef<z.infer<typeof getWebsiteSettingsInput>, WebsiteView> = {
  id: 'M35.A02',
  slug: 'websites.get_website_settings',
  module: MODULE,
  name: 'Get website settings',
  description: 'Fetch a website and its navigation/SEO defaults.',
  risk: 'read',
  entities: ['structures', 'content_items'],
  inputSchema: getWebsiteSettingsInput,
  outputSchema: websiteView,
  searchCard: {
    synonyms: ['website details', 'website settings'],
    examplePhrasings: ['Show me this website'],
  },
  handler: async (input, ctx) => toView(ctx.db, getWebsiteRow(ctx.db, input.id)),
};

// --- A03 list_websites -----------------------------------------------------

const listWebsitesInput = z.strictObject({ status: z.string().optional(), limit: z.number().int().min(1).max(50).optional() });
type ListWebsitesInput = z.infer<typeof listWebsitesInput>;
const listWebsitesOutput = listOutputSchema(websiteView);
type ListWebsitesOutput = ListOrSpill<WebsiteView>;

const listWebsites: ActionDef<ListWebsitesInput, ListWebsitesOutput> = {
  id: 'M35.A03',
  slug: 'websites.list_websites',
  module: MODULE,
  name: 'List websites',
  description: 'List non-archived websites.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listWebsitesInput,
  outputSchema: listWebsitesOutput,
  searchCard: {
    synonyms: ['all websites', 'show websites'],
    examplePhrasings: ['List our websites'],
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
    const rows = ctx.db.all(`SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map((r) => toView(ctx.db, r)), total, {
      idCapture: { db: ctx.db, table: 'structures', whereSql, params },
    });
  },
};

// --- A04 rename_website -----------------------------------------------------

const renameWebsiteInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const renameWebsite: ActionDef<z.infer<typeof renameWebsiteInput>, WebsiteView> = {
  id: 'M35.A04',
  slug: 'websites.rename_website',
  module: MODULE,
  name: 'Rename website',
  description: 'Rename a website.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: renameWebsiteInput,
  outputSchema: websiteView,
  searchCard: { synonyms: ['change website name'], examplePhrasings: ['Rename this website'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getWebsiteRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET name = ?, updated_at = ? WHERE id = ?`, [input.name, ctx.clock.now(), input.id]);
    return toView(ctx.db, getWebsiteRow(ctx.db, input.id));
  }),
};

// --- A05 add_website_page -----------------------------------------------------

const addWebsitePageInput = z.strictObject({ id: z.string(), title: z.string().min(1), path: z.string().optional() });

const addWebsitePage: ActionDef<z.infer<typeof addWebsitePageInput>, PageView> = {
  id: 'M35.A05',
  slug: 'websites.add_website_page',
  module: MODULE,
  name: 'Add website page',
  description: 'Create a new page under this website.',
  risk: 'write',
  entities: ['content_items', 'structures'],
  inputSchema: addWebsitePageInput,
  outputSchema: pageView,
  searchCard: { synonyms: ['add page', 'new website page'], examplePhrasings: ['Add an about page to this website'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getWebsiteRow(ctx.db, input.id);
    const id = nextId(ctx.db, 'content_items', 'content');
    const now = ctx.clock.now();
    const slug = slugify(input.title, id);
    const path = input.path ?? `/${slug}`;
    ctx.db.run(
      `INSERT INTO content_items (id, created_at, updated_at, archived, kind, title, slug, path, status,
        parent_id, author_id, published_at, views, seo_title, body)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'draft', ?, NULL, NULL, 0, ?, NULL)`,
      [id, now, now, PAGE_KIND, input.title, slug, path, input.id, input.title],
    );
    return toPageView(ctx.db.get(`SELECT * FROM content_items WHERE id = ?`, [id]) as Row);
  }),
};

// --- A06 set_website_home_page -----------------------------------------------------

const setWebsiteHomePageInput = z.strictObject({ id: z.string(), page_id: z.string() });

const setWebsiteHomePage: ActionDef<z.infer<typeof setWebsiteHomePageInput>, WebsiteView> = {
  id: 'M35.A06',
  slug: 'websites.set_website_home_page',
  module: MODULE,
  name: 'Set website home page',
  description: "Set which of a website's pages is the home page (validates the page belongs to this website).",
  risk: 'write',
  entities: ['structures', 'content_items'],
  inputSchema: setWebsiteHomePageInput,
  outputSchema: websiteView,
  searchCard: { synonyms: ['set home page', 'make default page'], examplePhrasings: ['Make this page the homepage'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWebsiteRow(ctx.db, input.id);
    const page = ctx.db.get(`SELECT id FROM content_items WHERE id = ? AND kind = ? AND parent_id = ?`, [
      input.page_id,
      PAGE_KIND,
      input.id,
    ]);
    if (!page) throw new ActionError('NOT_FOUND', `Page '${input.page_id}' does not belong to website '${input.id}'.`);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, home_page_id: input.page_id }, ctx.clock.now());
    return toView(ctx.db, getWebsiteRow(ctx.db, input.id));
  }),
};

// --- A07 update_site_navigation -----------------------------------------------------

const updateSiteNavigationInput = z.strictObject({ id: z.string(), nav: z.array(navItemSchema) });

const updateSiteNavigation: ActionDef<z.infer<typeof updateSiteNavigationInput>, WebsiteView> = {
  id: 'M35.A07',
  slug: 'websites.update_site_navigation',
  module: MODULE,
  name: 'Update site navigation',
  description: "Replace a website's navigation menu.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateSiteNavigationInput,
  outputSchema: websiteView,
  searchCard: { synonyms: ['edit nav menu', 'update navigation'], examplePhrasings: ["Change this website's nav menu"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWebsiteRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, nav: input.nav }, ctx.clock.now());
    return toView(ctx.db, getWebsiteRow(ctx.db, input.id));
  }),
};

// --- A08 set_site_seo_defaults -----------------------------------------------------

const setSiteSeoDefaultsInput = z.strictObject({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const setSiteSeoDefaults: ActionDef<z.infer<typeof setSiteSeoDefaultsInput>, WebsiteView> = {
  id: 'M35.A08',
  slug: 'websites.set_site_seo_defaults',
  module: MODULE,
  name: 'Set site SEO defaults',
  description: "Set a website's default SEO title/description (used by pages without their own).",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setSiteSeoDefaultsInput,
  outputSchema: websiteView,
  searchCard: { synonyms: ['set seo defaults', 'default meta tags'], examplePhrasings: ["Set this website's default SEO title"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWebsiteRow(ctx.db, input.id);
    const config = readConfig(row);
    const seo_defaults = {
      title: input.title ?? config.seo_defaults.title,
      description: input.description ?? config.seo_defaults.description,
    };
    writeConfig(ctx.db, input.id, { ...config, seo_defaults }, ctx.clock.now());
    return toView(ctx.db, getWebsiteRow(ctx.db, input.id));
  }),
};

// --- A09 publish_website -----------------------------------------------------

const publishWebsiteInput = z.strictObject({ id: z.string() });
const publishWebsiteOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('published') });

const publishWebsite: ActionDef<z.infer<typeof publishWebsiteInput>, z.infer<typeof publishWebsiteOutput>> = {
  id: 'M35.A09',
  slug: 'websites.publish_website',
  module: MODULE,
  name: 'Publish website',
  description: 'Publish a website (requires at least one page).',
  risk: 'write',
  entities: ['structures', 'content_items'],
  inputSchema: publishWebsiteInput,
  outputSchema: publishWebsiteOutput,
  searchCard: { synonyms: ['go live with website', 'publish site'], examplePhrasings: ['Publish this website'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWebsiteRow(ctx.db, input.id);
    if (countPages(ctx.db, input.id) === 0) {
      throw new ActionError('VALIDATION', `Website '${input.id}' needs at least one page before it can be published.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'published', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, status: 'published' as const };
  }),
};

// --- A10 unpublish_website -----------------------------------------------------

const unpublishWebsiteInput = z.strictObject({ id: z.string() });
const unpublishWebsiteOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('draft') });

const unpublishWebsite: ActionDef<z.infer<typeof unpublishWebsiteInput>, z.infer<typeof unpublishWebsiteOutput>> = {
  id: 'M35.A10',
  slug: 'websites.unpublish_website',
  module: MODULE,
  name: 'Unpublish website',
  description: 'Take a website offline (back to draft).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: unpublishWebsiteInput,
  outputSchema: unpublishWebsiteOutput,
  searchCard: { synonyms: ['take website offline', 'unpublish site'], examplePhrasings: ['Unpublish this website'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getWebsiteRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET status = 'draft', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, status: 'draft' as const };
  }),
};

export const m35Websites: ActionDef[] = [
  createWebsite as ActionDef,
  getWebsiteSettings as ActionDef,
  listWebsites as ActionDef,
  renameWebsite as ActionDef,
  addWebsitePage as ActionDef,
  setWebsiteHomePage as ActionDef,
  updateSiteNavigation as ActionDef,
  setSiteSeoDefaults as ActionDef,
  publishWebsite as ActionDef,
  unpublishWebsite as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'published' → 5, 'draft' → 6 — thin
 * universe, same category as M23 booking pages; re-verify if the seed's
 * website count or status distribution ever changes).
 */
export const m35DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'websites.list_websites',
    paramsA: { status: 'published' },
    paramsB: { status: 'draft' },
    expectDifferentCounts: true,
  },
];

/**
 * Every definition-level action below has `entities[0] === 'structures'`
 * with `kind = 'website'` — the bare `id` field needs an action-scoped
 * hint.
 */
export const m35SynthHints: SynthHints = {
  'websites.get_website_settings:id': { table: 'structures', kind: KIND },
  'websites.rename_website:id': { table: 'structures', kind: KIND },
  'websites.add_website_page:id': { table: 'structures', kind: KIND },
  'websites.set_website_home_page:id': { table: 'structures', kind: KIND },
  'websites.update_site_navigation:id': { table: 'structures', kind: KIND },
  'websites.set_site_seo_defaults:id': { table: 'structures', kind: KIND },
  'websites.publish_website:id': { table: 'structures', kind: KIND },
  'websites.unpublish_website:id': { table: 'structures', kind: KIND },
};
