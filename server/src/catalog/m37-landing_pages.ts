/**
 * M37 Landing Pages — follows the M01 Contacts convention verbatim.
 *
 * Data home: `content_items` table, `kind = 'landing_page'`
 * (`entities/model.ts#MODULE_MAP`). `content_items` has no JSON/config
 * column — only `body` (free text). Per the task-9-b4 "reuse the one
 * available free-text column as a resilient JSON sidecar" precedent
 * (quotes.notes / payments.reference / refunds.reference), `body` is
 * upgraded to a JSON-encoded `{html, sections, form_id, seo_description}`
 * object: `html` is the freeform page copy `update_page_content` edits;
 * `sections` is the structured page-builder block list `add_page_section`/
 * `reorder_page_sections` manage; `form_id` is the attached lead-capture
 * form; `seo_description` complements the real `seo_title` column.
 * `readPageMeta` is resilient to the legacy plain-string seed shape
 * (`entities/seed-content.ts#generateContentItems` writes a bare sentence)
 * — returns `{html: <that sentence>, sections: [], form_id: null,
 * seo_description: null}` rather than crashing.
 *
 * `content_items` is NOT kind-discriminated via `entities[0]` resolution
 * concerns the way `structures`/`records`/`participations` are for OTHER
 * modules' bare `id` fields — but it IS shared with M35 (website_page) and
 * M38 (blog_post), so the same kind-blindness risk applies: every action
 * below needs an action-scoped synthHint.
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

const MODULE = 'landing_pages';
const KIND = 'landing_page';

function slugify(name: string, id: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'landing-page'}-${id}`;
}

interface SectionEntry {
  id: string;
  type: string;
  content: string;
}

interface PageMeta {
  html: string | null;
  sections: SectionEntry[];
  form_id: string | null;
  seo_description: string | null;
}

function readPageMeta(row: Row): PageMeta {
  const raw = row['body'];
  if (typeof raw !== 'string' || raw.length === 0) return { html: null, sections: [], form_id: null, seo_description: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        html: (obj['html'] as string | null | undefined) ?? null,
        sections: Array.isArray(obj['sections']) ? (obj['sections'] as SectionEntry[]) : [],
        form_id: (obj['form_id'] as string | null | undefined) ?? null,
        seo_description: (obj['seo_description'] as string | null | undefined) ?? null,
      };
    }
    // legacy: JSON.parse succeeded but produced a non-object (e.g. a number) — treat as plain text.
    return { html: raw, sections: [], form_id: null, seo_description: null };
  } catch {
    // legacy plain-string seed shape.
    return { html: raw, sections: [], form_id: null, seo_description: null };
  }
}

function writePageMeta(db: StoreTx, id: string, meta: PageMeta, now: number): void {
  db.run(`UPDATE content_items SET body = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(meta), now, id]);
}

function getPageRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM content_items WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Landing page '${id}' does not exist.`);
  return row;
}

function nextSectionId(sections: readonly SectionEntry[], pageId: string): string {
  const re = new RegExp(`^${pageId}_sec_(\\d+)$`);
  let maxN = 0;
  for (const s of sections) {
    const m = re.exec(s.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `${pageId}_sec_${maxN + 1}`;
}

interface PageView {
  id: string;
  name: string;
  status: string;
  funnel_id: string | null;
  path: string;
  html: string | null;
  sections: SectionEntry[];
  form_id: string | null;
  seo_title: string | null;
  seo_description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): PageView {
  const meta = readPageMeta(row);
  return {
    id: row['id'] as string,
    name: row['title'] as string,
    status: row['status'] as string,
    funnel_id: (row['parent_id'] as string | null) ?? null,
    path: row['path'] as string,
    html: meta.html,
    sections: meta.sections,
    form_id: meta.form_id,
    seo_title: (row['seo_title'] as string | null) ?? null,
    seo_description: meta.seo_description,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const sectionSchema = z.object({ id: z.string(), type: z.string(), content: z.string() });

const pageView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  funnel_id: z.string().nullable(),
  path: z.string(),
  html: z.string().nullable(),
  sections: z.array(sectionSchema),
  form_id: z.string().nullable(),
  seo_title: z.string().nullable(),
  seo_description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_landing_page -----------------------------------------------------

const createLandingPageInput = z.strictObject({ title: z.string().min(1), funnel_id: z.string().optional() });

const createLandingPage: ActionDef<z.infer<typeof createLandingPageInput>, PageView> = {
  id: 'M37.A01',
  slug: 'landing_pages.create_landing_page',
  module: MODULE,
  name: 'Create landing page',
  description: 'Create a new landing page, optionally under a funnel.',
  risk: 'write',
  entities: ['content_items', 'structures'],
  inputSchema: createLandingPageInput,
  outputSchema: pageView,
  searchCard: { synonyms: ['add landing page', 'new landing page'], examplePhrasings: ['Create a landing page for our spring sale'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.funnel_id) {
      const funnel = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'funnel'`, [input.funnel_id]);
      if (!funnel) throw new ActionError('NOT_FOUND', `Funnel '${input.funnel_id}' does not exist.`);
    }
    const id = nextId(ctx.db, 'content_items', 'content');
    const now = ctx.clock.now();
    const slug = slugify(input.title, id);
    const meta: PageMeta = { html: null, sections: [], form_id: null, seo_description: null };
    ctx.db.run(
      `INSERT INTO content_items (id, created_at, updated_at, archived, kind, title, slug, path, status,
        parent_id, author_id, published_at, views, seo_title, body)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'draft', ?, NULL, NULL, 0, NULL, ?)`,
      [id, now, now, KIND, input.title, slug, `/${slug}`, input.funnel_id ?? null, JSON.stringify(meta)],
    );
    return toView(getPageRow(ctx.db, id));
  }),
};

// --- A02 get_landing_page -----------------------------------------------------

const getLandingPageInput = z.strictObject({ id: z.string() });

const getLandingPage: ActionDef<z.infer<typeof getLandingPageInput>, PageView> = {
  id: 'M37.A02',
  slug: 'landing_pages.get_landing_page',
  module: MODULE,
  name: 'Get landing page',
  description: 'Fetch a single landing page by id.',
  risk: 'read',
  entities: ['content_items'],
  inputSchema: getLandingPageInput,
  outputSchema: pageView,
  searchCard: { synonyms: ['landing page details', 'look up landing page'], examplePhrasings: ['Show me this landing page'] },
  handler: async (input, ctx) => toView(getPageRow(ctx.db, input.id)),
};

// --- A03 search_landing_pages -----------------------------------------------------

const searchLandingPagesInput = z.strictObject({
  status: z.string().optional(),
  funnel_id: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchLandingPagesInput = z.infer<typeof searchLandingPagesInput>;
const searchLandingPagesOutput = listOutputSchema(pageView);
type SearchLandingPagesOutput = ListOrSpill<PageView>;

const searchLandingPages: ActionDef<SearchLandingPagesInput, SearchLandingPagesOutput> = {
  id: 'M37.A03',
  slug: 'landing_pages.search_landing_pages',
  module: MODULE,
  name: 'Search landing pages',
  description: 'Search non-archived landing pages by status, funnel, and title.',
  risk: 'read',
  entities: ['content_items'],
  inputSchema: searchLandingPagesInput,
  outputSchema: searchLandingPagesOutput,
  searchCard: { synonyms: ['find landing pages', 'list landing pages'], examplePhrasings: ['Show me our published landing pages'] },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ? COLLATE NOCASE');
      params.push(input.status);
    }
    if (input.funnel_id) {
      where.push('parent_id = ?');
      params.push(input.funnel_id);
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

// --- A04 update_page_content -----------------------------------------------------

const updatePageContentInput = z.strictObject({ id: z.string(), html: z.string() });

const updatePageContent: ActionDef<z.infer<typeof updatePageContentInput>, PageView> = {
  id: 'M37.A04',
  slug: 'landing_pages.update_page_content',
  module: MODULE,
  name: 'Update page content',
  description: "Set a landing page's freeform HTML/copy.",
  risk: 'write',
  entities: ['content_items'],
  inputSchema: updatePageContentInput,
  outputSchema: pageView,
  searchCard: { synonyms: ['edit page content', 'update page copy'], examplePhrasings: ["Change this landing page's copy"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPageRow(ctx.db, input.id);
    const meta = readPageMeta(row);
    writePageMeta(ctx.db, input.id, { ...meta, html: input.html }, ctx.clock.now());
    return toView(getPageRow(ctx.db, input.id));
  }),
};

// --- A05 add_page_section -----------------------------------------------------

const addPageSectionInput = z.strictObject({ id: z.string(), type: z.string().min(1), content: z.string() });

const addPageSection: ActionDef<z.infer<typeof addPageSectionInput>, PageView> = {
  id: 'M37.A05',
  slug: 'landing_pages.add_page_section',
  module: MODULE,
  name: 'Add page section',
  description: 'Append a structured section block to a landing page.',
  risk: 'write',
  entities: ['content_items'],
  inputSchema: addPageSectionInput,
  outputSchema: pageView,
  searchCard: { synonyms: ['add section', 'new page block'], examplePhrasings: ['Add a testimonials section to this landing page'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPageRow(ctx.db, input.id);
    const meta = readPageMeta(row);
    const section: SectionEntry = { id: nextSectionId(meta.sections, input.id), type: input.type, content: input.content };
    writePageMeta(ctx.db, input.id, { ...meta, sections: [...meta.sections, section] }, ctx.clock.now());
    return toView(getPageRow(ctx.db, input.id));
  }),
};

// --- A06 reorder_page_sections -----------------------------------------------------

const reorderPageSectionsInput = z.strictObject({ id: z.string(), section_ids: z.array(z.string().min(1)).min(1) });

const reorderPageSections: ActionDef<z.infer<typeof reorderPageSectionsInput>, PageView> = {
  id: 'M37.A06',
  slug: 'landing_pages.reorder_page_sections',
  module: MODULE,
  name: 'Reorder page sections',
  description: "Replace a landing page's section order (must be exactly the same set of section ids).",
  risk: 'write',
  entities: ['content_items'],
  inputSchema: reorderPageSectionsInput,
  outputSchema: pageView,
  searchCard: { synonyms: ['reorder sections', 'change section order'], examplePhrasings: ['Move the pricing section to the top'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPageRow(ctx.db, input.id);
    const meta = readPageMeta(row);
    const currentIds = new Set(meta.sections.map((s) => s.id));
    const nextIds = new Set(input.section_ids);
    const sameSet = currentIds.size === nextIds.size && [...currentIds].every((i) => nextIds.has(i));
    if (!sameSet) {
      throw new ActionError('VALIDATION', `New section order must contain exactly the page's existing section ids (${[...currentIds].join(', ')}).`);
    }
    const byId = new Map(meta.sections.map((s) => [s.id, s] as const));
    const sections = input.section_ids.map((i) => byId.get(i) as SectionEntry);
    writePageMeta(ctx.db, input.id, { ...meta, sections }, ctx.clock.now());
    return toView(getPageRow(ctx.db, input.id));
  }),
};

// --- A07 attach_form_to_page -----------------------------------------------------

const attachFormToPageInput = z.strictObject({ id: z.string(), form_id: z.string() });

const attachFormToPage: ActionDef<z.infer<typeof attachFormToPageInput>, PageView> = {
  id: 'M37.A07',
  slug: 'landing_pages.attach_form_to_page',
  module: MODULE,
  name: 'Attach form to page',
  description: 'Attach a lead-capture form to a landing page (validates the form exists).',
  risk: 'write',
  entities: ['content_items', 'structures'],
  inputSchema: attachFormToPageInput,
  outputSchema: pageView,
  searchCard: { synonyms: ['add form to page', 'attach signup form'], examplePhrasings: ['Attach the newsletter form to this landing page'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPageRow(ctx.db, input.id);
    const form = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'form'`, [input.form_id]);
    if (!form) throw new ActionError('NOT_FOUND', `Form '${input.form_id}' does not exist.`);
    const meta = readPageMeta(row);
    writePageMeta(ctx.db, input.id, { ...meta, form_id: input.form_id }, ctx.clock.now());
    return toView(getPageRow(ctx.db, input.id));
  }),
};

// --- A08 set_page_seo_metadata -----------------------------------------------------

const setPageSeoMetadataInput = z.strictObject({ id: z.string(), seo_title: z.string().optional(), seo_description: z.string().optional() });

const setPageSeoMetadata: ActionDef<z.infer<typeof setPageSeoMetadataInput>, PageView> = {
  id: 'M37.A08',
  slug: 'landing_pages.set_page_seo_metadata',
  module: MODULE,
  name: 'Set page SEO metadata',
  description: "Set a landing page's SEO title/description.",
  risk: 'write',
  entities: ['content_items'],
  inputSchema: setPageSeoMetadataInput,
  outputSchema: pageView,
  searchCard: { synonyms: ['set seo title', 'page meta description'], examplePhrasings: ["Update this landing page's SEO title"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPageRow(ctx.db, input.id);
    const meta = readPageMeta(row);
    const now = ctx.clock.now();
    if (input.seo_title !== undefined) {
      ctx.db.run(`UPDATE content_items SET seo_title = ? WHERE id = ?`, [input.seo_title, input.id]);
    }
    writePageMeta(ctx.db, input.id, { ...meta, seo_description: input.seo_description ?? meta.seo_description }, now);
    return toView(getPageRow(ctx.db, input.id));
  }),
};

// --- A09 publish_landing_page -----------------------------------------------------

const publishLandingPageInput = z.strictObject({ id: z.string() });
const publishLandingPageOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('published') });

const publishLandingPage: ActionDef<z.infer<typeof publishLandingPageInput>, z.infer<typeof publishLandingPageOutput>> = {
  id: 'M37.A09',
  slug: 'landing_pages.publish_landing_page',
  module: MODULE,
  name: 'Publish landing page',
  description: 'Publish a landing page (requires content: either HTML copy or at least one section).',
  risk: 'write',
  entities: ['content_items'],
  inputSchema: publishLandingPageInput,
  outputSchema: publishLandingPageOutput,
  searchCard: { synonyms: ['go live with page', 'publish landing page'], examplePhrasings: ['Publish this landing page'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPageRow(ctx.db, input.id);
    const meta = readPageMeta(row);
    if (!meta.html && meta.sections.length === 0) {
      throw new ActionError('VALIDATION', `Landing page '${input.id}' has no content — add copy or a section before publishing.`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE content_items SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`, [now, now, input.id]);
    return { id: input.id, name: row['title'] as string, status: 'published' as const };
  }),
};

// --- A10 unpublish_landing_page -----------------------------------------------------

const unpublishLandingPageInput = z.strictObject({ id: z.string() });
const unpublishLandingPageOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('draft') });

const unpublishLandingPage: ActionDef<z.infer<typeof unpublishLandingPageInput>, z.infer<typeof unpublishLandingPageOutput>> = {
  id: 'M37.A10',
  slug: 'landing_pages.unpublish_landing_page',
  module: MODULE,
  name: 'Unpublish landing page',
  description: 'Take a landing page offline (back to draft).',
  risk: 'write',
  entities: ['content_items'],
  inputSchema: unpublishLandingPageInput,
  outputSchema: unpublishLandingPageOutput,
  searchCard: { synonyms: ['take page offline', 'unpublish landing page'], examplePhrasings: ['Unpublish this landing page'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPageRow(ctx.db, input.id);
    ctx.db.run(`UPDATE content_items SET status = 'draft', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['title'] as string, status: 'draft' as const };
  }),
};

export const m37LandingPages: ActionDef[] = [
  createLandingPage as ActionDef,
  getLandingPage as ActionDef,
  searchLandingPages as ActionDef,
  updatePageContent as ActionDef,
  addPageSection as ActionDef,
  reorderPageSections as ActionDef,
  attachFormToPage as ActionDef,
  setPageSeoMetadata as ActionDef,
  publishLandingPage as ActionDef,
  unpublishLandingPage as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'published' → 35, 'draft' → 11, out of
 * ~53 landing_page rows within the shared 160-row `content_items` seed
 * pool).
 */
export const m37DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'landing_pages.search_landing_pages',
    paramsA: { status: 'published' },
    paramsB: { status: 'draft' },
    expectDifferentCounts: true,
  },
];

/**
 * `content_items` is shared with M35 (website_page) and M38 (blog_post) —
 * every action on this module's own `id` needs an action-scoped hint.
 */
export const m37SynthHints: SynthHints = {
  'landing_pages.get_landing_page:id': { table: 'content_items', kind: KIND },
  'landing_pages.update_page_content:id': { table: 'content_items', kind: KIND },
  'landing_pages.add_page_section:id': { table: 'content_items', kind: KIND },
  'landing_pages.reorder_page_sections:id': { table: 'content_items', kind: KIND },
  'landing_pages.attach_form_to_page:id': { table: 'content_items', kind: KIND },
  'landing_pages.set_page_seo_metadata:id': { table: 'content_items', kind: KIND },
  'landing_pages.publish_landing_page:id': { table: 'content_items', kind: KIND },
  'landing_pages.unpublish_landing_page:id': { table: 'content_items', kind: KIND },
};
