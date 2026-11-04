/**
 * Tier-A filter-discrimination convention (task-8 brief deviation; LLD §9.3:
 * "filter-discrimination check (two contrasting filter values must yield
 * different counts — catches accepted-but-ignored params, the #1 codegen
 * bug)").
 *
 * Module files MAY export a `discriminationChecks: DiscriminationCheck[]`
 * array alongside their `ActionDef[]`. `module-index.ts` collects every
 * module's array into the flat `MODULE_DISCRIMINATION_CHECKS` export;
 * `eval/smoke.ts` runs each one by calling `action` twice (once with
 * `paramsA`, once with `paramsB`) against the SAME store snapshot and
 * asserting the two results' `total` differ.
 *
 * Only meaningful for read actions whose output carries a `total` field
 * (e.g. the `listOutputSchema`/`toListOrSpill` convention in
 * `list-output.ts` — both the inline and spill branches carry `total`).
 */
export interface DiscriminationCheck {
  /** action slug, e.g. 'contacts.search_contacts' */
  action: string;
  paramsA: Record<string, unknown>;
  paramsB: Record<string, unknown>;
  /** Always `true` — the only supported check kind today. */
  expectDifferentCounts: true;
}
