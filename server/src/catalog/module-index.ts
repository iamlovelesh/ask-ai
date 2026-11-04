/**
 * Static index of catalog modules (LLD repo layout: `m01-contacts.ts …
 * m50-reports.ts`). `registry.ts` imports ONLY this file for module
 * ActionDefs — adding a new module requires exactly one import line + one
 * array entry here, no edits to `registry.ts` itself.
 *
 * M02-M50 land in later tasks; M01 (contacts) is the Task 7/8 reference
 * module that proves the loading mechanism end-to-end.
 *
 * Every module ALSO exports a `discriminationChecks` array (empty if it has
 * no Tier-A filter-discrimination coverage yet — see discrimination.ts).
 * `MODULE_DISCRIMINATION_CHECKS` flattens all of them for `eval/smoke.ts`.
 */

import type { ActionDef } from './types.js';
import type { DiscriminationCheck } from './discrimination.js';
import { m01Contacts, m01DiscriminationChecks } from './m01-contacts.js';

/** One entry per module file, in M01…M50 order. */
export const MODULE_ACTION_ARRAYS: readonly ActionDef[][] = [m01Contacts];

/** One entry per module file's `discriminationChecks` export, flattened. */
export const MODULE_DISCRIMINATION_CHECKS: readonly DiscriminationCheck[] = [
  ...m01DiscriminationChecks,
];
