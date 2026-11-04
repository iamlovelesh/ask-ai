/**
 * Static index of catalog modules (LLD repo layout: `m01-contacts.ts …
 * m50-reports.ts`). `registry.ts` imports ONLY this file for module
 * ActionDefs — adding a new module requires exactly one import line + one
 * array entry here, no edits to `registry.ts` itself.
 *
 * M02-M50 land in later tasks; M01 (contacts) is the Task 7 reference
 * module that proves the loading mechanism end-to-end.
 */

import type { ActionDef } from './types.js';
import { m01Contacts } from './m01-contacts.js';

/** One entry per module file, in M01…M50 order. */
export const MODULE_ACTION_ARRAYS: readonly ActionDef[][] = [m01Contacts];
