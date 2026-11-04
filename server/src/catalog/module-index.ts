/**
 * Static index of catalog modules (LLD repo layout: `m01-contacts.ts …
 * m50-reports.ts`). `registry.ts` imports ONLY this file for module
 * ActionDefs — adding a new module requires exactly one import line + one
 * array entry here, no edits to `registry.ts` itself.
 *
 * M02-M50 land in later tasks; M01 (contacts) is the Task 7/8 reference
 * module that proves the loading mechanism end-to-end.
 *
 * Every module ALSO exports (required, not optional — keeps this file's
 * import list uniform):
 *   - `discriminationChecks` (empty `[]` if it has no Tier-A
 *     filter-discrimination coverage yet — see discrimination.ts).
 *     `MODULE_DISCRIMINATION_CHECKS` flattens all of them for
 *     `eval/smoke.ts`.
 *   - `synthHints` (empty `{}` if its id-shaped fields all resolve against
 *     plain, non-kind-discriminated tables — see synth-hints.ts).
 *     `MODULE_SYNTH_HINTS` merges all of them (flat, keyed by field name)
 *     for `eval/smoke.ts`'s `synthesizeInput` calls.
 */

import type { ActionDef } from './types.js';
import type { DiscriminationCheck } from './discrimination.js';
import type { SynthHints } from './synth-hints.js';
import { m01Contacts, m01DiscriminationChecks, m01SynthHints } from './m01-contacts.js';

/** One entry per module file, in M01…M50 order. */
export const MODULE_ACTION_ARRAYS: readonly ActionDef[][] = [m01Contacts];

/** One entry per module file's `discriminationChecks` export, flattened. */
export const MODULE_DISCRIMINATION_CHECKS: readonly DiscriminationCheck[] = [
  ...m01DiscriminationChecks,
];

/**
 * Every module file's `synthHints` export, merged flat (keyed by field
 * name). Later modules in `MODULE_ACTION_ARRAYS` order win on a field-name
 * collision — in practice field names are consistent catalog-wide (a
 * `coupon_id` means the same thing everywhere), so a collision signals two
 * modules disagreeing about a shared field's meaning and is worth a second
 * look, not something to silently paper over.
 */
export const MODULE_SYNTH_HINTS: Readonly<SynthHints> = {
  ...m01SynthHints,
};
