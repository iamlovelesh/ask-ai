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

/** Test-only: force a rebuild on the next `retrieve()` call (e.g. after
 * swapping in a different registry instance between test files). */
export function __resetIndexForTest(): void {
  cachedIndex = undefined;
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

function renderCard(action: ActionDef): string {
  const shape =
    action.inputSchema !== null &&
    typeof action.inputSchema === 'object' &&
    'shape' in action.inputSchema &&
    typeof (action.inputSchema as { shape?: unknown }).shape === 'object'
      ? ((action.inputSchema as { shape: Record<string, unknown> }).shape)
      : undefined;
  const keyParams = shape ? Object.keys(shape).slice(0, 6).join(', ') : '';
  return `${action.slug} — ${action.name}: ${action.description}${keyParams ? ` [${keyParams}]` : ''}`;
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

  const cards: Card[] = diversified.map(({ slug, text, score }) => ({ slug, text, score }));
  return { cards, ms: performance.now() - startedAtMs };
}

/** Joins rendered card lines, one per line — the `<actions>` candidate list
 * for the planner prompt (LLD §5.2). */
export function renderCards(cards: readonly Card[]): string {
  return cards.map((c) => c.text).join('\n');
}
