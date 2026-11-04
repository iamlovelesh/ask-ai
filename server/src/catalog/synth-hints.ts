/**
 * Kind-aware id-resolution hints for `catalog/testing.ts#synthesizeInput`
 * (task-8 fix round 1 — reviewer CRITICAL finding).
 *
 * Several shared "mega-tables" back many kinds of config/ledger rows:
 *   - `structures` (20 kinds — `STRUCTURE_KINDS` in entities/model.ts):
 *     pipelines, calendars, coupons, campaigns, workflows, forms, …
 *   - `records` (5 kinds — `RECORD_KINDS`): form_submission, survey_response,
 *     coupon_redemption, lesson_completion, team_membership.
 *   - `participations` (4 kinds): event_registration, enrollment,
 *     membership, community_member.
 *
 * Resolving an id field against one of these tables with NO `kind` filter
 * (just "the first row in the table") is kind-blind: a `coupon_id` field
 * could just as easily get handed back a `tag` or `pipeline` row, since
 * they're all physically the same table. That produces either a spurious
 * NOT_FOUND (if the handler validates kind) or a silent wrong-row false
 * positive (if it doesn't) — exactly the "accepted but wrong" failure mode
 * smoke exists to catch.
 *
 * A module declares kind context for its own id-shaped fields via a
 * `synthHints: SynthHints` export (field name → {table, kind}) alongside its
 * `ActionDef[]`/`discriminationChecks`. `module-index.ts` merges every
 * module's map into `MODULE_SYNTH_HINTS` (flat, keyed by field name — field
 * names are unique-enough-in-practice across this catalog that a flat merge
 * is simpler than per-action scoping; see the MODULE AUTHOR GUIDE for the
 * collision caveat). `eval/smoke.ts` passes `MODULE_SYNTH_HINTS` into every
 * `synthesizeInput` call so id resolution for ANY module's fields is
 * kind-aware without `testing.ts` needing to hardcode per-module knowledge.
 *
 * `testing.ts` ALSO ships a small set of hints for the common
 * `structures`-backed field names it already resolves by table name
 * (`coupon_id`, `campaign_id`, `pipeline_id`, …) — those are correct and
 * require no module-level declaration. Hints passed into `synthesizeInput`
 * take precedence over those built-in defaults, so a module can override a
 * name that collides with a different meaning in its own action.
 */
export interface SynthHint {
  /** literal table name, e.g. 'structures' */
  table: string;
  /** discriminator value to filter on, e.g. 'coupon' — omit for plain (non-kind) tables */
  kind?: string;
}

/** field name → resolution hint. */
export type SynthHints = Record<string, SynthHint>;
