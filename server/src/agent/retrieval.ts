/**
 * Retrieval (LLD §4): minisearch BM25 over the full catalog (`fuzzy: 0.2` +
 * `prefix: true` — typos are a named brief requirement) re-ranked by a
 * composite score that adds a session-continuity boost and a module
 * cohesion boost, then diversified so no module dominates the top 20.
 *
 *   score(a) = 0.70·bm25norm(a) + 0.20·sessionBoost(a) + 0.10·moduleCohesion(a)
 *
 * `core.*` pseudo-actions are deliberately excluded from the index — per
 * LLD §5.2 the planner prompt always lists core op signatures verbatim
 * (`planner.ts`), independent of retrieval, so they never need to compete
 * for a slot in the top 20.
 */

import MiniSearch from 'minisearch';
import { z } from 'zod';
import { registry } from '../catalog/registry.js';
import type { ActionDef } from '../catalog/types.js';

export interface SessionCtx {
  /** Action slugs used earlier in this session — direct reuse signal. */
  usedActionSlugs: string[];
  /** Modules touched earlier in this session — cohesion signal. */
  activeModules: string[];
}

export interface Card {
  slug: string;
  /** Rendered line, ~35 tokens: "slug — name: description [key params]". */
  text: string;
  score: number;
}

export interface RetrievalResult {
  cards: Card[];
  ms: number;
}

const TOP_K = 20;
const MAX_PER_MODULE = 4;
const WEIGHTS = { bm25: 0.7, sessionBoost: 0.2, moduleCohesion: 0.1 } as const;

// Resolver-slot reservation (TRIAGE rec #1, fixes C1=44 + unblocks C2): the
// planner can only resolve a name→id if the target module's list_*/search_*
// resolver is in its candidate set. Under pure BM25+diversify an "update X"
// request fills the top-20 with `update_*` verbs and crowds the resolver out,
// so the planner fabricates a shape-valid id (`calendar_6`) that passes the
// validator and dies at runtime (NOT_FOUND). After scoring we therefore
// RESERVE slots for resolvers.
const RESOLVER_SLOT_BUDGET = 4;
const MAX_CARDS = 24;
const RESOLVER_SLUG_RE = /\.(?:list|search)_/;

// --- index (built once, lazily, over the static catalog) -------------------

interface IndexedDoc {
  id: string; // slug — unique, doubles as MiniSearch id
  slug: string;
  module: string;
  name: string;
  description: string;
  synonyms: string;
  phrasings: string;
}

function toIndexedDoc(action: ActionDef): IndexedDoc {
  return {
    id: action.slug,
    slug: action.slug,
    module: action.module,
    name: action.name,
    description: action.description,
    synonyms: action.searchCard.synonyms.join(' '),
    phrasings: action.searchCard.examplePhrasings.join(' '),
  };
}

// Pure grammatical filler — articles, prepositions, pronouns, auxiliary/
// modal verbs, conversational padding ("please", "yet", "just", …).
// Deliberately does NOT include CRUD/lifecycle verbs (create/search/list/
// get/update/archive/cancel/send/publish/…) — those carry real intent
// signal (e.g. distinguishing "create a contact" from "archive a contact",
// which otherwise tie on the shared noun "contact"). Stripping these fillers
// fixes a real BM25 failure mode: short, extremely common words like "an"
// were, under minisearch's default scoring, outweighing the actual content
// words for queries like "create an appointment" (every other
// `appointments.*` action matched "an" + "appointment" while
// `create_appointment` only matched "create" + "appointment" once each —
// without stopword removal the former out-scored the latter).
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'from', 'by', 'at', 'into', 'about',
  'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'who', 'whom', 'which', 'what', 'whose',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'they', 'them', 'their',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'not', 'no', 'so', 'than', 'then', 'there', 'here', 'if', 'as',
  'please', 'thanks', 'thank', 'yet', 'still', 'just', 'now', 'already', 'like',
  'want', 'wants', 'wanted', 'need', 'needs', 'needed', 'gonna', 'gotta', 'trying', 'looking',
]);

/** Lowercase, drop apostrophes (so "haven't" tokenizes as "havent" — one
 * token — rather than splitting into the junk fragment "t"), then split on
 * non-alphanumeric. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function buildIndex(): MiniSearch<IndexedDoc> {
  const index = new MiniSearch<IndexedDoc>({
    idField: 'id',
    fields: ['name', 'description', 'synonyms', 'phrasings'],
    storeFields: ['slug', 'module', 'name', 'description'],
    tokenize,
    processTerm: (term) => (STOPWORDS.has(term) ? null : term),
  });
  const docs = registry
    .all()
    .filter((action) => action.module !== 'core')
    .map(toIndexedDoc);
  index.addAll(docs);
  return index;
}

let cachedIndex: MiniSearch<IndexedDoc> | undefined;

function getIndex(): MiniSearch<IndexedDoc> {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

let cachedModules: string[] | undefined;

/** Distinct non-core module names in the catalog (cached — the registry is a
 * process-wide singleton). */
function allModules(): string[] {
  if (!cachedModules) {
    const set = new Set<string>();
    for (const a of registry.all()) if (a.module !== 'core') set.add(a.module);
    cachedModules = [...set];
  }
  return cachedModules;
}

/** Test-only: force a rebuild on the next `retrieve()` call (e.g. after
 * swapping in a different registry instance between test files). */
export function __resetIndexForTest(): void {
  cachedIndex = undefined;
  cachedModules = undefined;
}

// --- scoring helpers (exported for direct unit testing) --------------------

/** Direct-reuse signal: did the session already call this exact action? */
export function computeSessionBoost(slug: string, session: SessionCtx): number {
  return session.usedActionSlugs.includes(slug) ? 1 : 0;
}

/** Topic-continuity signal: is this action's module one the session has
 * already been working in? */
export function computeModuleCohesion(module: string, session: SessionCtx): number {
  return session.activeModules.includes(module) ? 1 : 0;
}

/** The composite score formula (LLD §4), isolated so the weights themselves
 * are unit-testable without going through MiniSearch. */
export function scoreCard(bm25norm: number, sessionBoost: number, moduleCohesion: number): number {
  return WEIGHTS.bm25 * bm25norm + WEIGHTS.sessionBoost * sessionBoost + WEIGHTS.moduleCohesion * moduleCohesion;
}

interface Scored {
  slug: string;
  module: string;
  text: string;
  score: number;
}

/** Greedily selects up to `limit` items from `sorted` (already
 * score-descending) such that no module contributes more than `cap`
 * entries. Pure + exported so the ≤4/module rule is testable against
 * synthetic data, independent of the real catalog's module distribution. */
export function diversify<T extends { module: string }>(sorted: readonly T[], cap: number, limit: number): T[] {
  const picked: T[] = [];
  const perModule = new Map<string, number>();
  for (const item of sorted) {
    if (picked.length >= limit) break;
    const count = perModule.get(item.module) ?? 0;
    if (count >= cap) continue;
    picked.push(item);
    perModule.set(item.module, count + 1);
  }
  return picked;
}

// --- schema-derived card enrichment (P0) ------------------------------------
//
// The old card was `slug — name: desc [first-6-param-NAMES]`: no types, no
// enums, params truncated at 6, and NO output fields — so the planner guessed
// field/param names blind (the wrong-field class: amount_cents vs total_cents,
// start_time vs start_at; the invoices date-param 100%-failure where the
// needed param sat past slot 6, invisible). Both the input signature and the
// output row preview below are derived PROGRAMMATICALLY from the action's zod
// schemas — no hand-written card content — so a module added later is
// described the same way without touching this file.

const DATE_FIELD_RE = /_(at|date|until|from|after|before)$/;
const MAX_OUTPUT_FIELDS = 10;

/** Strip optional/nullable/default wrappers (bounded); report whether any
 * `optional`/`default` wrapper was seen (→ the param is optional). */
function unwrapType(schema: unknown): { schema: unknown; optional: boolean } {
  let s: unknown = schema;
  let optional = false;
  for (let i = 0; i < 6 && s != null; i += 1) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodDefault) optional = true;
    if (
      (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) &&
      typeof (s as { unwrap?: () => unknown }).unwrap === 'function'
    ) {
      s = (s as { unwrap: () => unknown }).unwrap();
      continue;
    }
    break;
  }
  return { schema: s, optional };
}

function arrayElementSchema(schema: unknown): unknown | undefined {
  const s = schema as { element?: unknown; def?: { element?: unknown } };
  return s.element ?? s.def?.element;
}

/** Compact, generic type label for a param/field schema. `fieldName` (when
 * given) upgrades a bare number following the catalog's timestamp-suffix
 * convention to `date-ms`, the single most useful hint for the planner. */
function compactType(schema: unknown, fieldName?: string): string {
  const { schema: s } = unwrapType(schema);
  if (s instanceof z.ZodString) return 'str';
  if (s instanceof z.ZodNumber) return fieldName !== undefined && DATE_FIELD_RE.test(fieldName) ? 'date-ms' : 'num';
  if (s instanceof z.ZodBoolean) return 'bool';
  if (s instanceof z.ZodEnum) {
    const opts = (s as { options?: readonly string[] }).options ?? [];
    return opts.length > 0 ? `(${opts.join('|')})` : 'enum';
  }
  if (s instanceof z.ZodArray) return `${compactType(arrayElementSchema(s))}[]`;
  if (s instanceof z.ZodObject) return 'obj';
  return 'any';
}

function objectShape(schema: unknown): Record<string, unknown> | undefined {
  const s = schema;
  if (s instanceof z.ZodObject) return (s as unknown as { shape: Record<string, unknown> }).shape;
  return undefined;
}

/** The row/item field shape an action's output exposes, and whether that
 * result is a list (→ fields live under `items`). Mirrors the shapes
 * `catalog/list-output.ts` and the module views produce: a list-or-spill
 * union, a bare `{items,total}`, a bare array, or a single record/wrapper
 * object. `undefined` for a non-introspectable (scalar/opaque) output. */
function outputRowShape(outputSchema: unknown): { fields: Record<string, unknown>; list: boolean } | undefined {
  const { schema: s } = unwrapType(outputSchema);

  if (s instanceof z.ZodUnion) {
    const opts = (s as unknown as { options?: readonly unknown[]; def?: { options?: readonly unknown[] } });
    for (const opt of opts.options ?? opts.def?.options ?? []) {
      const { schema: o } = unwrapType(opt);
      const shape = objectShape(o);
      const itemsSchema = shape?.['items'];
      if (itemsSchema !== undefined) {
        const { schema: arr } = unwrapType(itemsSchema);
        const el = objectShape(unwrapType(arrayElementSchema(arr)).schema);
        if (el) return { fields: el, list: true };
      }
    }
    return undefined;
  }
  if (s instanceof z.ZodArray) {
    const el = objectShape(unwrapType(arrayElementSchema(s)).schema);
    if (el) return { fields: el, list: true };
  }
  const shape = objectShape(s);
  if (shape) {
    const itemsSchema = shape['items'];
    if (itemsSchema !== undefined) {
      const { schema: arr } = unwrapType(itemsSchema);
      const el = objectShape(unwrapType(arrayElementSchema(arr)).schema);
      if (el) return { fields: el, list: true };
    }
    return { fields: shape, list: false };
  }
  return undefined;
}

/** Deterministic, information-dense field order: id first, then human
 * labels, then dates, then money/score, then status, then the rest
 * (alphabetical within each tier) — so the ~10-field cap keeps the fields a
 * planner most needs. */
function orderOutputFields(keys: readonly string[]): string[] {
  const tier = (k: string): number => {
    if (k === 'id') return 0;
    if (['name', 'title', 'subject', 'label', 'number'].includes(k)) return 1;
    // Universal audit timestamps are rarely what a planner filters on — demote
    // them below money/status so the ~10-field cap keeps the domain fields.
    if (k === 'created_at' || k === 'updated_at') return 5;
    if (DATE_FIELD_RE.test(k)) return 2;
    if (/_cents$/.test(k) || ['amount', 'total', 'value', 'score', 'quantity'].includes(k)) return 3;
    if (k === 'status') return 4;
    return 5;
  };
  return [...keys].sort((a, b) => tier(a) - tier(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** `name?:type` per param, ALL params (no 6-cap), enums inlined. */
export function inputSignature(inputSchema: unknown): string {
  const shape = objectShape(inputSchema);
  if (!shape) return '';
  const parts = Object.entries(shape).map(([k, v]) => {
    const { optional } = unwrapType(v);
    return `${k}${optional ? '?' : ''}:${compactType(v, k)}`;
  });
  return parts.length > 0 ? `[${parts.join(', ')}]` : '';
}

/** `→ items: {id, name, status, total_cents:date?...}` (or `→ {…}` for a
 * single-record output), schema-derived, capped at `MAX_OUTPUT_FIELDS`. A
 * str field renders bare (just its name); non-str fields carry their compact
 * type so the planner knows e.g. `total_cents:num`, `created_at:date-ms`,
 * `status:(open|closed|…)`. */
export function outputPreview(outputSchema: unknown): string {
  const info = outputRowShape(outputSchema);
  if (!info) return '';
  const ordered = orderOutputFields(Object.keys(info.fields));
  if (ordered.length === 0) return '';
  const shown = ordered.slice(0, MAX_OUTPUT_FIELDS);
  const rendered = shown.map((k) => {
    const t = compactType(info.fields[k], k);
    return t === 'str' ? k : `${k}:${t}`;
  });
  const more = ordered.length > shown.length ? ', …' : '';
  const body = `{${rendered.join(', ')}${more}}`;
  return info.list ? ` → items: ${body}` : ` → ${body}`;
}

export function renderCard(action: ActionDef): string {
  const sig = inputSignature(action.inputSchema);
  const out = outputPreview(action.outputSchema);
  return `${action.slug} — ${action.name}: ${action.description}${sig ? ` ${sig}` : ''}${out}`;
}

// --- resolver-slot reservation (TRIAGE rec #1) ------------------------------

/** A module's "primary resolver" actions — read-risk `list_*`/`search_*`
 * actions, identified purely from the registry by slug prefix + risk (per the
 * triage recommendation). These are the actions the planner uses to turn a
 * name/label into an entity id. */
export function isResolverAction(action: ActionDef): boolean {
  return action.risk === 'read' && RESOLVER_SLUG_RE.test(action.slug);
}

/** Singular/plural stems of a module name, for matching a name-like entity
 * reference in the query ("calendar" → module "calendars"). Also derives the
 * last underscore-segment so a multi-word module ("support_tickets") still
 * matches a bare "ticket(s)". */
function moduleStems(module: string): string[] {
  const stems = new Set<string>();
  const add = (w: string): void => {
    if (!w) return;
    stems.add(w);
    if (w.endsWith('ies')) stems.add(`${w.slice(0, -3)}y`);
    else if (w.endsWith('ses')) stems.add(w.slice(0, -2));
    else if (w.endsWith('s')) stems.add(w.slice(0, -1));
    else stems.add(`${w}s`);
  };
  add(module);
  if (module.includes('_')) add(module.slice(module.lastIndexOf('_') + 1));
  return [...stems];
}

/** Modules whose name-like entity reference appears in the rewritten query. */
function queryNamedModules(q: string): Set<string> {
  const tokens = new Set(tokenize(q));
  const matched = new Set<string>();
  for (const module of allModules()) {
    for (const stem of moduleStems(module)) {
      if (tokens.has(stem)) {
        matched.add(module);
        break;
      }
    }
  }
  return matched;
}

function resolversForModule(module: string): ActionDef[] {
  return registry.byModule(module).filter(isResolverAction);
}

/**
 * Guarantees resolver coverage in the shortlist (TRIAGE rec #1):
 *   (b) a module NAMED in the query → its resolvers are ALWAYS included.
 *   (a) a module already REPRESENTED in the shortlist → its resolvers get up
 *       to `RESOLVER_SLOT_BUDGET` reserved slots (skipping modules already at
 *       the ≤`MAX_PER_MODULE` diversify cap, so that invariant still holds).
 * Added resolvers displace the lowest-scored NON-resolver cards to keep the
 * total ≤ `MAX_CARDS`; every resolver card is protected from displacement.
 */
function reserveResolverSlots(
  picked: readonly Scored[],
  q: string,
  scoreBySlug: ReadonlyMap<string, number>,
): Scored[] {
  const present = new Set(picked.map((p) => p.slug));
  const represented = new Set(picked.map((p) => p.module));
  const named = queryNamedModules(q);
  const perModule = new Map<string, number>();
  for (const p of picked) perModule.set(p.module, (perModule.get(p.module) ?? 0) + 1);

  const toScored = (action: ActionDef): Scored => ({
    slug: action.slug,
    module: action.module,
    text: renderCard(action),
    score: scoreBySlug.get(action.slug) ?? 0,
  });

  // (b) query-named modules — always include every missing resolver.
  const forced: Scored[] = [];
  for (const module of named) {
    for (const action of resolversForModule(module)) {
      if (present.has(action.slug)) continue;
      forced.push(toScored(action));
      present.add(action.slug);
    }
  }

  // (a) represented (non-named) modules — up to RESOLVER_SLOT_BUDGET total.
  const reserved: Scored[] = [];
  for (const module of represented) {
    if (reserved.length >= RESOLVER_SLOT_BUDGET) break;
    if (named.has(module)) continue;
    if ((perModule.get(module) ?? 0) >= MAX_PER_MODULE) continue; // keep ≤4/module
    for (const action of resolversForModule(module)) {
      if (reserved.length >= RESOLVER_SLOT_BUDGET) break;
      if ((perModule.get(module) ?? 0) >= MAX_PER_MODULE) break;
      if (present.has(action.slug)) continue;
      reserved.push(toScored(action));
      present.add(action.slug);
      perModule.set(module, (perModule.get(module) ?? 0) + 1);
    }
  }

  const combined = [...picked, ...forced, ...reserved];
  if (combined.length <= MAX_CARDS) return combined;

  // Trim to MAX_CARDS by dropping the lowest-scored NON-resolver cards.
  const isRes = (s: Scored): boolean => {
    const a = registry.get(s.slug);
    return a ? isResolverAction(a) : false;
  };
  const resolverCards = combined.filter(isRes);
  const keep = MAX_CARDS - resolverCards.length;
  if (keep <= 0) return resolverCards; // pathological: resolvers alone exceed the cap
  const keptSlugs = new Set(
    combined
      .filter((s) => !isRes(s))
      .sort((a, b) => b.score - a.score)
      .slice(0, keep)
      .map((s) => s.slug),
  );
  return combined.filter((s) => isRes(s) || keptSlugs.has(s.slug));
}

// --- retrieve ----------------------------------------------------------------

export function retrieve(q: string, session: SessionCtx): RetrievalResult {
  const startedAtMs = performance.now();
  const index = getIndex();

  const hits = index.search(q, { fuzzy: 0.2, prefix: true });
  const maxRawScore = hits.reduce((max, h) => Math.max(max, h.score), 0);

  const scored: Scored[] = hits.map((hit) => {
    const bm25norm = maxRawScore > 0 ? hit.score / maxRawScore : 0;
    const module = hit.module as string;
    const slug = hit.slug as string;
    const sessionBoost = computeSessionBoost(slug, session);
    const moduleCohesion = computeModuleCohesion(module, session);
    const action = registry.get(slug);
    return {
      slug,
      module,
      text: action ? renderCard(action) : `${slug} — (unknown action)`,
      score: scoreCard(bm25norm, sessionBoost, moduleCohesion),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const diversified = diversify(scored, MAX_PER_MODULE, TOP_K);
  const scoreBySlug = new Map(scored.map((s) => [s.slug, s.score]));
  const withResolvers = reserveResolverSlots(diversified, q, scoreBySlug);

  const cards: Card[] = withResolvers.map(({ slug, text, score }) => ({ slug, text, score }));
  return { cards, ms: performance.now() - startedAtMs };
}

/** Joins rendered card lines, one per line — the `<actions>` candidate list
 * for the planner prompt (LLD §5.2). */
export function renderCards(cards: readonly Card[]): string {
  return cards.map((c) => c.text).join('\n');
}
