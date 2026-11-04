/**
 * Model router (LLD §5.5 / design spec "Router and direct path"): a cheap,
 * zero-LLM-call pre-classifier that decides which model PLANS this turn.
 * There is ONE pipeline (retrieval → planner → validator → executor →
 * composer) — the router never forks a separate code path, it only picks a
 * model string. Misrouting is SAFE by construction: a complex query routed
 * to the small model either plans badly (caught by `agent/validator.ts` and
 * repaired — LLD §5.5 "misroute escalates via validator failure") or simply
 * produces a worse plan, never a crash.
 */

const FAST_MODEL_ENV = 'FAST_MODEL';
const PLANNER_MODEL_ENV = 'PLANNER_MODEL';

/** Defaults mirror `.env.example` (LLD §10). */
const DEFAULT_FAST_MODEL = 'google/gemini-2.5-flash-lite';
const DEFAULT_PLANNER_MODEL = 'anthropic/claude-haiku-4.5';

export function fastModel(): string {
  return process.env[FAST_MODEL_ENV] || DEFAULT_FAST_MODEL;
}

export function plannerModel(): string {
  return process.env[PLANNER_MODEL_ENV] || DEFAULT_PLANNER_MODEL;
}

export interface RouteInput {
  /** The query AFTER `agent/memory.ts`'s `rewriteQuery` — never the raw
   * user text (a rewritten anaphoric follow-up is intentionally longer than
   * what the user typed, and that length is real complexity signal). */
  rewrittenQuery: string;
  /** `retrieval.ts`'s top card's composite score (0 if no candidates). */
  topCardScore: number;
  /** How many candidates retrieval surfaced at all. */
  cardCount: number;
}

/**
 * τ — retrieval-confidence threshold (LLD §5.5 / spec: "short single-intent
 * queries with a high-confidence retrieval hit go to flash-lite"). The
 * composite score (`0.70·bm25norm + 0.20·sessionBoost + 0.10·moduleCohesion`,
 * `agent/retrieval.ts`) tops out at 1.0 only for an exact bm25 match with
 * both boosts active; a clean top-1 bm25 hit with no boosts alone lands
 * around 0.70. 0.5 is low enough to admit that common case, high enough to
 * exclude a muddy multi-candidate tie (several cards within a few points of
 * each other, bm25norm ≈ 0.3–0.4) — tuned against the direct-query subset of
 * the probe set (`eval/probes/retrieval.yaml`); documented here per the
 * brief's "threshold — document τ".
 */
export const SIMPLE_SCORE_THRESHOLD = 0.5;

/** A query longer than this is assumed to carry more than one constraint
 * even without an explicit conjunction (LLD §5.5 "short single-intent"). */
const SIMPLE_WORD_LIMIT = 12;

/** Multi-intent markers (brief: "and/then/,/;" — conjunctions and clause
 * separators that usually signal more than one step). */
const MULTI_INTENT_RE = /\b(?:and|then)\b|[,;]/i;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/** Pure predicate, exported for direct unit testing independent of the
 * model-name resolution. */
export function isSimpleQuery(input: RouteInput): boolean {
  if (input.cardCount === 0) return false; // nothing confident to route fast on
  const words = wordCount(input.rewrittenQuery);
  if (words === 0 || words > SIMPLE_WORD_LIMIT) return false;
  if (input.topCardScore <= SIMPLE_SCORE_THRESHOLD) return false;
  if (MULTI_INTENT_RE.test(input.rewrittenQuery)) return false;
  return true;
}

/**
 * Picks the planner model for this turn (LLD §5.5): `FAST_MODEL` for a
 * short, single-intent, high-confidence-retrieval query; `PLANNER_MODEL`
 * (the default) for everything else.
 */
export function pickPlannerModel(input: RouteInput): string {
  return isSimpleQuery(input) ? fastModel() : plannerModel();
}

/**
 * Escalation target for any recovery path (plan repair, joiner repair) —
 * always the full planner model, regardless of what was routed initially
 * (LLD §5.5 "misroute escalates via validator failure"). Takes the
 * previous model only so call sites read naturally as "escalate FROM X";
 * the return value does not depend on it.
 */
export function escalate(_previousModel: string): string {
  return plannerModel();
}

/** GPT-5-family models always get minimal reasoning effort (LLD §5.5) —
 * `llm/client.ts` calls this to decide whether to inject the OpenRouter
 * `reasoning.effort` provider option automatically. */
export function isGpt5Family(model: string): boolean {
  return /\bgpt-5\b/i.test(model);
}
