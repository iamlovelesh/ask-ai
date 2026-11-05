/**
 * M38 Blogs — follows the M01 Contacts convention verbatim.
 *
 * Data home: `content_items` table, `kind = 'blog_post'`
 * (`entities/model.ts#MODULE_MAP`). Same "no JSON column, reuse `body` as
 * a resilient sidecar" situation as M37 Landing Pages — but blog posts'
 * `body` is ALSO the actual article text, so the sidecar wraps it:
 * `{text: string|null, categories: string[], scheduled_for: number|null,
 * seo_description: string|null}`. `readBlogMeta` normalizes the legacy
 * seed's plain-string `body` (`entities/seed-content.ts
 * #generateContentItems`) into `{text: <that string>, categories: [],
 * scheduled_for: null, seo_description: null}`.
 *
 * `schedule_post_publication` only records an intent (`scheduled_for`) —
 * per this task's scope there is no background scheduler actually firing
 * it; `publish_post` is the action that takes a post live (immediately).
 *
 * KIND-BLINDNESS NOTE: `content_items` is shared with M35/M37 — every
 * action needs an action-scoped synthHint.
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

const MODULE = 'blogs';
const KIND = 'blog_post';

function slugify(name: string, id: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'post'}-${id}`;
}

interface BlogMeta {
  text: string | null;
  categories: string[];
  scheduled_for: number | null;
  seo_description: string | null;
}

function readBlogMeta(row: Row): BlogMeta {
  const raw = row['body'];
  if (typeof raw !== 'string' || raw.length === 0) return { text: null, categories: [], scheduled_for: null, seo_description: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        text: (obj['text'] as string | null | undefined) ?? null,
        categories: Array.isArray(obj['categories']) ? (obj['categories'] as string[]) : [],
        scheduled_for: (obj['scheduled_for'] as number | null | undefined) ?? null,
        seo_description: (obj['seo_description'] as string | null | undefined) ?? null,
      };
    }
    return { text: raw, categories: [], scheduled_for: null, seo_description: null };
  } catch {
    return { text: raw, categories: [], scheduled_for: null, seo_description: null };
  }
}

function writeBlogMeta(db: StoreTx, id: string, meta: BlogMeta, now: number): void {
  db.run(`UPDATE content_items SET body = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(meta), now, id]);
}

function getPostRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM content_items WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Blog post '${id}' does not exist.`);
  return row;
}

interface PostView {
  id: string;
  name: string;
  status: string;
  website_id: string | null;
  author_id: string | null;
  text: string | null;
  categories: string[];
  scheduled_for: number | null;
  seo_title: string | null;
  seo_description: string | null;
  published_at: number | null;
  views: number;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): PostView {
  const meta = readBlogMeta(row);
  return {
    id: row['id'] as string,
    name: row['title'] as string,
    status: row['status'] as string,
    website_id: (row['parent_id'] as string | null) ?? null,
    author_id: (row['author_id'] as string | null) ?? null,
    text: meta.text,
    categories: meta.categories,
    scheduled_for: meta.scheduled_for,
    seo_title: (row['seo_title'] as string | null) ?? null,
    seo_description: meta.seo_description,
    published_at: (row['published_at'] as number | null) ?? null,
    views: (row['views'] as number | null) ?? 0,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const postView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  website_id: z.string().nullable(),
  author_id: z.string().nullable(),
  text: z.string().nullable(),
  categories: z.array(z.string()),
  scheduled_for: z.number().nullable(),
  seo_title: z.string().nullable(),
  seo_description: z.string().nullable(),
  published_at: z.number().nullable(),
  views: z.number(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_blog_post -----------------------------------------------------

const createBlogPostInput = z.strictObject({ title: z.string().min(1), website_id: z.string().optional() });

const createBlogPost: ActionDef<z.infer<typeof createBlogPostInput>, PostView> = {
  id: 'M38.A01',
  slug: 'blogs.create_blog_post',
  module: MODULE,
  name: 'Create blog post',
  description: 'Create a new blog post, optionally under a website.',
  risk: 'write',
  entities: ['content_items', 'structures'],
  inputSchema: createBlogPostInput,
  outputSchema: postView,
  searchCard: { synonyms: ['add blog post', 'new blog post'], examplePhrasings: ['Write a new blog post about our Q3 launch'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.website_id) {
      const website = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'website'`, [input.website_id]);
      if (!website) throw new ActionError('NOT_FOUND', `Website '${input.website_id}' does not exist.`);
    }
    const id = nextId(ctx.db, 'content_items', 'content');
    const now = ctx.clock.now();
    const slug = slugify(input.title, id);
    const meta: BlogMeta = { text: null, categories: [], scheduled_for: null, seo_description: null };
    ctx.db.run(
      `INSERT INTO content_items (id, created_at, updated_at, archived, kind, title, slug, path, status,
        parent_id, author_id, published_at, views, seo_title, body)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'draft', ?, NULL, NULL, 0, NULL, ?)`,
      [id, now, now, KIND, input.title, slug, `/${slug}`, input.website_id ?? null, JSON.stringify(meta)],
    );
    return toView(getPostRow(ctx.db, id));
  }),
};

// --- A02 get_blog_post -----------------------------------------------------

const getBlogPostInput = z.strictObject({ id: z.string() });

const getBlogPost: ActionDef<z.infer<typeof getBlogPostInput>, PostView> = {
  id: 'M38.A02',
  slug: 'blogs.get_blog_post',
  module: MODULE,
  name: 'Get blog post',
  description: 'Fetch a single blog post by id.',
  risk: 'read',
  entities: ['content_items'],
  inputSchema: getBlogPostInput,
  outputSchema: postView,
  searchCard: { synonyms: ['blog post details', 'look up blog post'], examplePhrasings: ['Show me this blog post'] },
  handler: async (input, ctx) => toView(getPostRow(ctx.db, input.id)),
};

// --- A03 search_blog_posts -----------------------------------------------------

const searchBlogPostsInput = z.strictObject({
  status: z.string().optional(),
  author_id: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchBlogPostsInput = z.infer<typeof searchBlogPostsInput>;
const searchBlogPostsOutput = listOutputSchema(postView);
type SearchBlogPostsOutput = ListOrSpill<PostView>;

const searchBlogPosts: ActionDef<SearchBlogPostsInput, SearchBlogPostsOutput> = {
  id: 'M38.A03',
  slug: 'blogs.search_blog_posts',
  module: MODULE,
  name: 'Search blog posts',
  description: 'Search non-archived blog posts by status, author, and title.',
  risk: 'read',
  entities: ['content_items'],
  inputSchema: searchBlogPostsInput,
  outputSchema: searchBlogPostsOutput,
  searchCard: { synonyms: ['find blog posts', 'list blog posts'], examplePhrasings: ['Show me our published blog posts'] },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.author_id) {
      where.push('author_id = ?');
      params.push(input.author_id);
    }
    if (input.query) {
      where.push('title LIKE ?');
      params.push(`%${input.query}%`);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM content_items WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM content_items WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'content_items', whereSql, params },
    });
  },
};

// --- A04 update_blog_post -----------------------------------------------------

const updateBlogPostInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({ title: z.string().min(1).optional(), text: z.string().optional() })
    .refine((p) => Object.keys(p).length > 0, { message: 'patch must not be empty' }),
});

const updateBlogPost: ActionDef<z.infer<typeof updateBlogPostInput>, PostView> = {
  id: 'M38.A04',
  slug: 'blogs.update_blog_post',
  module: MODULE,
  name: 'Update blog post',
  description: "Patch a blog post's title and/or body text.",
  risk: 'write',
  entities: ['content_items'],
  inputSchema: updateBlogPostInput,
  outputSchema: postView,
  searchCard: { synonyms: ['edit blog post', 'update blog post'], examplePhrasings: ['Fix a typo in this blog post'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPostRow(ctx.db, input.id);
    const meta = readBlogMeta(row);
    const now = ctx.clock.now();
    if (input.patch.title !== undefined) {
      ctx.db.run(`UPDATE content_items SET title = ? WHERE id = ?`, [input.patch.title, input.id]);
    }
    writeBlogMeta(ctx.db, input.id, { ...meta, text: input.patch.text ?? meta.text }, now);
    return toView(getPostRow(ctx.db, input.id));
  }),
};

// --- A05 assign_post_author -----------------------------------------------------

const assignPostAuthorInput = z.strictObject({ id: z.string(), author_id: z.string() });

const assignPostAuthor: ActionDef<z.infer<typeof assignPostAuthorInput>, PostView> = {
  id: 'M38.A05',
  slug: 'blogs.assign_post_author',
  module: MODULE,
  name: 'Assign post author',
  description: 'Assign the author of a blog post (validates the user exists).',
  risk: 'write',
  entities: ['content_items', 'users'],
  inputSchema: assignPostAuthorInput,
  outputSchema: postView,
  searchCard: { synonyms: ['set author', 'change blog author'], examplePhrasings: ['Assign this blog post to Priya'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getPostRow(ctx.db, input.id);
    const user = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.author_id]);
    if (!user) throw new ActionError('NOT_FOUND', `User '${input.author_id}' does not exist.`);
    ctx.db.run(`UPDATE content_items SET author_id = ?, updated_at = ? WHERE id = ?`, [input.author_id, ctx.clock.now(), input.id]);
    return toView(getPostRow(ctx.db, input.id));
  }),
};

// --- A06 set_post_categories -----------------------------------------------------

const setPostCategoriesInput = z.strictObject({ id: z.string(), categories: z.array(z.string().min(1)) });

const setPostCategories: ActionDef<z.infer<typeof setPostCategoriesInput>, PostView> = {
  id: 'M38.A06',
  slug: 'blogs.set_post_categories',
  module: MODULE,
  name: 'Set post categories',
  description: 'Replace the category tags on a blog post.',
  risk: 'write',
  entities: ['content_items'],
  inputSchema: setPostCategoriesInput,
  outputSchema: postView,
  searchCard: { synonyms: ['tag blog post', 'set categories'], examplePhrasings: ['File this post under Product Updates'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPostRow(ctx.db, input.id);
    const meta = readBlogMeta(row);
    writeBlogMeta(ctx.db, input.id, { ...meta, categories: input.categories }, ctx.clock.now());
    return toView(getPostRow(ctx.db, input.id));
  }),
};

// --- A07 set_post_seo_metadata -----------------------------------------------------

const setPostSeoMetadataInput = z.strictObject({ id: z.string(), seo_title: z.string().optional(), seo_description: z.string().optional() });

const setPostSeoMetadata: ActionDef<z.infer<typeof setPostSeoMetadataInput>, PostView> = {
  id: 'M38.A07',
  slug: 'blogs.set_post_seo_metadata',
  module: MODULE,
  name: 'Set post SEO metadata',
  description: "Set a blog post's SEO title/description.",
  risk: 'write',
  entities: ['content_items'],
  inputSchema: setPostSeoMetadataInput,
  outputSchema: postView,
  searchCard: { synonyms: ['set seo title', 'post meta description'], examplePhrasings: ["Update this blog post's SEO title"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPostRow(ctx.db, input.id);
    const meta = readBlogMeta(row);
    const now = ctx.clock.now();
    if (input.seo_title !== undefined) {
      ctx.db.run(`UPDATE content_items SET seo_title = ? WHERE id = ?`, [input.seo_title, input.id]);
    }
    writeBlogMeta(ctx.db, input.id, { ...meta, seo_description: input.seo_description ?? meta.seo_description }, now);
    return toView(getPostRow(ctx.db, input.id));
  }),
};

// --- A08 schedule_post_publication -----------------------------------------------------

const schedulePostPublicationInput = z.strictObject({ id: z.string(), publish_at: z.number().int().min(0) });

const schedulePostPublication: ActionDef<z.infer<typeof schedulePostPublicationInput>, PostView> = {
  id: 'M38.A08',
  slug: 'blogs.schedule_post_publication',
  module: MODULE,
  name: 'Schedule post publication',
  description: 'Record a future publish time for a draft post (does not publish it — call publish_post when ready).',
  risk: 'write',
  entities: ['content_items'],
  inputSchema: schedulePostPublicationInput,
  outputSchema: postView,
  searchCard: { synonyms: ['schedule blog post', 'publish later'], examplePhrasings: ['Schedule this post for next Monday'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPostRow(ctx.db, input.id);
    if (row['status'] !== 'draft') {
      throw new ActionError('CONFLICT', `Blog post '${input.id}' is not a draft — unpublish it before scheduling.`);
    }
    const meta = readBlogMeta(row);
    writeBlogMeta(ctx.db, input.id, { ...meta, scheduled_for: input.publish_at }, ctx.clock.now());
    return toView(getPostRow(ctx.db, input.id));
  }),
};

// --- A09 publish_post -----------------------------------------------------

const publishPostInput = z.strictObject({ id: z.string() });
const publishPostOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('published') });

const publishPost: ActionDef<z.infer<typeof publishPostInput>, z.infer<typeof publishPostOutput>> = {
  id: 'M38.A09',
  slug: 'blogs.publish_post',
  module: MODULE,
  name: 'Publish post',
  description: 'Publish a blog post immediately.',
  risk: 'write',
  entities: ['content_items'],
  inputSchema: publishPostInput,
  outputSchema: publishPostOutput,
  searchCard: { synonyms: ['go live with post', 'publish blog post'], examplePhrasings: ['Publish this blog post now'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPostRow(ctx.db, input.id);
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE content_items SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`, [now, now, input.id]);
    return { id: input.id, name: row['title'] as string, status: 'published' as const };
  }),
};

// --- A10 unpublish_post -----------------------------------------------------

const unpublishPostInput = z.strictObject({ id: z.string() });
const unpublishPostOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('draft') });

const unpublishPost: ActionDef<z.infer<typeof unpublishPostInput>, z.infer<typeof unpublishPostOutput>> = {
  id: 'M38.A10',
  slug: 'blogs.unpublish_post',
  module: MODULE,
  name: 'Unpublish post',
  description: 'Take a blog post offline (back to draft).',
  risk: 'write',
  entities: ['content_items'],
  inputSchema: unpublishPostInput,
  outputSchema: unpublishPostOutput,
  searchCard: { synonyms: ['take post offline', 'unpublish blog post'], examplePhrasings: ['Unpublish this blog post'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPostRow(ctx.db, input.id);
    ctx.db.run(`UPDATE content_items SET status = 'draft', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['title'] as string, status: 'draft' as const };
  }),
};

export const m38Blogs: ActionDef[] = [
  createBlogPost as ActionDef,
  getBlogPost as ActionDef,
  searchBlogPosts as ActionDef,
  updateBlogPost as ActionDef,
  assignPostAuthor as ActionDef,
  setPostCategories as ActionDef,
  setPostSeoMetadata as ActionDef,
  schedulePostPublication as ActionDef,
  publishPost as ActionDef,
  unpublishPost as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'published' → 33, 'draft' → 13 out of
 * ~53 blog_post rows within the shared 160-row `content_items` seed pool).
 */
export const m38DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'blogs.search_blog_posts',
    paramsA: { status: 'published' },
    paramsB: { status: 'draft' },
    expectDifferentCounts: true,
  },
];

/** `content_items` is shared with M35/M37 — every action needs a scoped hint. */
export const m38SynthHints: SynthHints = {
  'blogs.get_blog_post:id': { table: 'content_items', kind: KIND },
  'blogs.update_blog_post:id': { table: 'content_items', kind: KIND },
  'blogs.assign_post_author:id': { table: 'content_items', kind: KIND },
  'blogs.set_post_categories:id': { table: 'content_items', kind: KIND },
  'blogs.set_post_seo_metadata:id': { table: 'content_items', kind: KIND },
  'blogs.schedule_post_publication:id': { table: 'content_items', kind: KIND },
  'blogs.publish_post:id': { table: 'content_items', kind: KIND },
  'blogs.unpublish_post:id': { table: 'content_items', kind: KIND },
};
