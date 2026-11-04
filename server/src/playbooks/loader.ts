/**
 * Playbook loader (LLD §7). A playbook is a `*.skill.md` file: YAML-ish
 * frontmatter (`name`, `description` — ≤1024 chars, documents what the
 * playbook does and when/which triggers suggest it) followed by a markdown
 * procedure body whose steps each cite a `slug: module.action` from the
 * REAL catalog. `loadPlaybooks` validates every cited slug against the
 * registry — an unknown slug throws AT BOOT (fail fast, never silently
 * drop a step) — and `matchPlaybook` does a cheap lexical match of a user
 * query against `name`+`description` to decide whether to surface one into
 * the planner prompt (LLD §5.2 `<playbook>` block).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Registry } from '../catalog/registry.js';

export interface Playbook {
  name: string;
  description: string;
  body: string;
  actionSlugs: string[];
}

const DEFAULT_PLAYBOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_DESCRIPTION_CHARS = 1024;

// --- frontmatter parsing ------------------------------------------------------

interface ParsedFile {
  name: string;
  description: string;
  body: string;
}

const FRONTMATTER_KEY_RE = /^([A-Za-z_]+):\s*(.*)$/;

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
  const description = meta['description'];
  if (!name || !description) {
    throw new Error(`Playbook '${filename}': frontmatter must include non-empty 'name' and 'description'.`);
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(
      `Playbook '${filename}': description is ${description.length} chars, exceeds the ${MAX_DESCRIPTION_CHARS}-char cap.`,
    );
  }

  return { name, description, body: lines.slice(i).join('\n').trim() };
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
 * directory) into a `Playbook`. Validates every `slug:` mention against
 * `registry` — an unknown slug throws synchronously, so a bad playbook
 * file fails the server at boot rather than surfacing a dead action to the
 * planner at runtime.
 */
export function loadPlaybooks(registry: Registry, dir: string = DEFAULT_PLAYBOOKS_DIR): Playbook[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.skill.md'))
    .sort();

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

    return { name: parsed.name, description: parsed.description, body: parsed.body, actionSlugs };
  });
}

// --- matchPlaybook (BM25-ish lexical over name+description) -----------------

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
 * playbook's name+description text to count as a match — low enough to
 * tolerate a paraphrase, high enough that one incidental shared word never
 * matches on its own. Tuned against the 3 seed playbooks + obvious
 * near-miss queries; documented here per the brief's "threshold —
 * document τ". */
const MATCH_THRESHOLD = 0.34;

/** Lexical match of `q` against every playbook's `name`+`description`;
 * returns the highest-scoring playbook at/above τ, or `undefined`. */
export function matchPlaybook(q: string, playbooks: readonly Playbook[]): Playbook | undefined {
  const queryTokens = new Set(tokenize(q));
  if (queryTokens.size === 0) return undefined;

  let best: { playbook: Playbook; score: number } | undefined;
  for (const pb of playbooks) {
    const docTokens = new Set(tokenize(`${pb.name} ${pb.description}`));
    let shared = 0;
    for (const t of queryTokens) if (docTokens.has(t)) shared += 1;
    const score = shared / queryTokens.size;
    if (score >= MATCH_THRESHOLD && (best === undefined || score > best.score)) {
      best = { playbook: pb, score };
    }
  }
  return best?.playbook;
}
