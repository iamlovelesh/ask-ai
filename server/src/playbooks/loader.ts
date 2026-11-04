/**
 * Playbook loader (LLD §7). A playbook is a `*.skill.md` file: YAML-ish
 * frontmatter (`name` — a lowercase-hyphen slug ≤64 chars matching the
 * filename stem, per the Agent Skills spec; `title` — human-facing display
 * text; `description` — ≤1024 chars, documents what the playbook does and
 * when/which triggers suggest it) followed by a markdown procedure body
 * whose steps each cite a `slug: module.action` from the REAL catalog.
 * `loadPlaybooks` validates every cited action slug against the registry —
 * an unknown slug throws AT BOOT (fail fast, never silently drop a step) —
 * and ALSO throws if the directory contains zero `*.skill.md` files at all
 * (a playbooks directory that silently loads nothing is a worse failure
 * mode than a loud one; `{allowEmpty:true}` is the explicit escape hatch
 * for tests that intentionally exercise an empty directory). `matchPlaybook`
 * does a cheap lexical match of a user query against `title`+`description`
 * to decide whether to surface one into the planner prompt (LLD §5.2
 * `<playbook>` block).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Registry } from '../catalog/registry.js';

export interface Playbook {
  /** Lowercase-hyphen slug, ≤64 chars, matching the filename stem
   * (`"lead-follow-up-sweep"` for `lead-follow-up-sweep.skill.md`). */
  name: string;
  /** Human-facing display text (e.g. `"Lead follow-up sweep"`). */
  title: string;
  description: string;
  body: string;
  actionSlugs: string[];
}

export interface LoadPlaybooksOptions {
  /** Skip the "zero playbooks found" fail-fast throw. Tests only — a real
   * boot with an intentionally-empty playbooks directory is still a bug. */
  allowEmpty?: boolean;
}

const DEFAULT_PLAYBOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_DESCRIPTION_CHARS = 1024;
const NAME_SLUG_RE = /^[a-z0-9-]{1,64}$/;

// --- frontmatter parsing ------------------------------------------------------

interface ParsedFile {
  name: string;
  title: string;
  description: string;
  body: string;
}

const FRONTMATTER_KEY_RE = /^([A-Za-z_]+):\s*(.*)$/;
const SKILL_MD_SUFFIX = /\.skill\.md$/;

function parseFrontmatter(content: string, filename: string): ParsedFile {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    throw new Error(`Playbook '${filename}': missing frontmatter (file must start with '---').`);
  }

  const meta: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') {
      i += 1;
      break;
    }
    const m = FRONTMATTER_KEY_RE.exec(line);
    if (m) meta[m[1] as string] = (m[2] as string).trim();
  }

  const name = meta['name'];
  const title = meta['title'];
  const description = meta['description'];
  if (!name || !title || !description) {
    throw new Error(
      `Playbook '${filename}': frontmatter must include non-empty 'name', 'title', and 'description'.`,
    );
  }
  if (!NAME_SLUG_RE.test(name)) {
    throw new Error(
      `Playbook '${filename}': 'name' ('${name}') must be a lowercase-hyphen slug matching /^[a-z0-9-]{1,64}$/.`,
    );
  }
  const stem = filename.replace(SKILL_MD_SUFFIX, '');
  if (name !== stem) {
    throw new Error(`Playbook '${filename}': 'name' ('${name}') must match the filename stem ('${stem}').`);
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(
      `Playbook '${filename}': description is ${description.length} chars, exceeds the ${MAX_DESCRIPTION_CHARS}-char cap.`,
    );
  }

  return { name, title, description, body: lines.slice(i).join('\n').trim() };
}

// --- slug extraction + registry validation -----------------------------------

const SLUG_MENTION_RE = /slug:\s*([A-Za-z0-9_]+\.[A-Za-z0-9_]+)/g;

function extractActionSlugs(body: string): string[] {
  const slugs = new Set<string>();
  for (const m of body.matchAll(SLUG_MENTION_RE)) slugs.add(m[1] as string);
  return [...slugs];
}

/**
 * Loads every `*.skill.md` file in `dir` (default: this module's own
 * directory — in a built artifact this is `dist/playbooks`, populated by
 * `scripts/copy-playbooks.mjs` as a build step since `tsc` never copies
 * non-`.ts` assets). Throws synchronously when `dir` has zero matching
 * files (unless `opts.allowEmpty`), or when any cited action slug is
 * unknown to `registry`, or when a file's frontmatter is malformed — a bad
 * or missing playbook fails the server at boot rather than surfacing a
 * dead/absent action to the planner at runtime.
 */
export function loadPlaybooks(
  registry: Registry,
  dir: string = DEFAULT_PLAYBOOKS_DIR,
  opts: LoadPlaybooksOptions = {},
): Playbook[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.skill.md'))
    .sort();

  if (files.length === 0 && opts.allowEmpty !== true) {
    throw new Error(
      `loadPlaybooks: no '*.skill.md' files found in '${dir}' — refusing to silently boot with zero ` +
        `playbooks (pass {allowEmpty:true} only in tests that intentionally exercise an empty directory).`,
    );
  }

  return files.map((file) => {
    const content = readFileSync(join(dir, file), 'utf8');
    const parsed = parseFrontmatter(content, file);
    const actionSlugs = extractActionSlugs(parsed.body);

    for (const slug of actionSlugs) {
      if (!registry.get(slug)) {
        throw new Error(
          `Playbook '${file}' references unknown action slug '${slug}' — every 'slug:' mention ` +
            `must exist in the registry (checked at boot).`,
        );
      }
    }

    return {
      name: parsed.name,
      title: parsed.title,
      description: parsed.description,
      body: parsed.body,
      actionSlugs,
    };
  });
}

// --- matchPlaybook (BM25-ish lexical over title+description) ----------------

// Small, deliberately generic stopword set (not the retrieval-tuned list in
// `agent/retrieval.ts` — with only 3 playbooks, a crude token-overlap ratio
// is plenty; a real BM25 index would be overkill here).
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'from', 'by', 'at', 'and', 'or',
  'is', 'are', 'that', 'this', 'it', 'as', 'who', 'have', 'has', 'had', 'be', 'been',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** τ: a query must share ≥34% of its (non-stopword) tokens with a
 * playbook's title+description text to count as a match — low enough to
 * tolerate a paraphrase, high enough that one incidental shared word never
 * matches on its own. Tuned against the 3 seed playbooks + obvious
 * near-miss queries; documented here per the brief's "threshold —
 * document τ". Matches against `title` (human-facing text), not the
 * `name` slug — a hyphenated slug like `lead-follow-up-sweep` still
 * tokenizes usefully, but `title` carries the natural-language phrasing a
 * user's query is actually likely to overlap with. */
const MATCH_THRESHOLD = 0.34;

/** Lexical match of `q` against every playbook's `title`+`description`;
 * returns the highest-scoring playbook at/above τ, or `undefined`. */
export function matchPlaybook(q: string, playbooks: readonly Playbook[]): Playbook | undefined {
  const queryTokens = new Set(tokenize(q));
  if (queryTokens.size === 0) return undefined;

  let best: { playbook: Playbook; score: number } | undefined;
  for (const pb of playbooks) {
    const docTokens = new Set(tokenize(`${pb.title} ${pb.description}`));
    let shared = 0;
    for (const t of queryTokens) if (docTokens.has(t)) shared += 1;
    const score = shared / queryTokens.size;
    if (score >= MATCH_THRESHOLD && (best === undefined || score > best.score)) {
      best = { playbook: pb, score };
    }
  }
  return best?.playbook;
}
