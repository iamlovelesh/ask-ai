/**
 * Derives a short, plain-sentence-case reason label for a confirmation
 * gate's scope — rendered under the gate's description in `ConfirmCard`.
 * Client-side heuristic over the action slugs (`ConfirmationScope.actions`,
 * e.g. `'contacts.archive_contact'`) — the server's `ConfirmationScope` has
 * no explicit "why" field, so this infers one from the same signal LLD §5.3
 * actually gates on: destructive/external risk, or a bare affected-count
 * breach of the 50-record threshold.
 */

import type { ConfirmationScope } from './events.js';

const DESTRUCTIVE_RE = /archive|delete|void|remove/i;
/** An "un"-prefixed external verb — `unpublish`, `unsend`, `unlaunch`,
 * `unschedule` — is a RETRACTION of a previously-external action, not a new
 * outgoing send. It must be matched BEFORE `EXTERNAL_RE` (whose bare
 * `publish`/`send` substrings would otherwise mis-label `unpublish` as an
 * "External send") and treated as destructive-ish: retracting something
 * already live is closer to a takedown than to a send. */
const RETRACTION_RE = /\bun(?:publish|send|launch|schedule)/i;
const EXTERNAL_RE = /send|launch|publish/i;

export function deriveGateReason(scope: ConfirmationScope): string {
  const slugs = scope.actions.join(' ');
  if (DESTRUCTIVE_RE.test(slugs) || RETRACTION_RE.test(slugs)) return 'Destructive action';
  if (EXTERNAL_RE.test(slugs)) return 'External send';
  const count = scope.affectedCount;
  return `Affects ${count} record${count === 1 ? '' : 's'} (over the 50-record threshold)`;
}
