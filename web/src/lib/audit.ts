/**
 * Builds the AuditFeed's chronological entry list from the already-FOLDED
 * state (`TurnView[]`, `lib/fold.ts`) rather than a raw event log — the web
 * store never keeps one (see `fold.ts`'s header: components only ever see
 * the derived render state). Per Task 19's brief, this is a deliberately
 * NARROW, honest slice: confirmation checkpoints (`confirmation.required`/
 * `resolved`) plus steps that actually finished or failed. It does NOT
 * attempt to detect "write risk" from a step's summary text (the `Event`
 * union carries no risk/write flag on `step.finished` — see
 * `server/src/events/types.ts`), and it is NOT a full replay of every event
 * (no `plan.ready`/`repair`/`replan`/`search`/`answer.*` rows). The panel
 * itself repeats this caveat in its empty/header copy so it never reads as
 * more complete than it is.
 */

import type { StepStatus, TurnView } from './fold.js';
import type { ConfirmationScope } from './events.js';

export type AuditEntryKind = 'confirmation.required' | 'confirmation.resolved' | 'step.finished' | 'step.failed';

export interface AuditEntry {
  /** Sort key — the originating event's `seq`, or `0` for the rare
   * hand-built fixture that never set one (sorts first, never throws). */
  seq: number;
  turnId: string;
  kind: AuditEntryKind;
  label: string;
  detail: string;
}

const RELEVANT_STEP_STATUSES: ReadonlySet<StepStatus> = new Set(['done', 'failed']);

function describeScope(scope: ConfirmationScope): string {
  const affected = `Affects ${scope.affectedCount} item${scope.affectedCount === 1 ? '' : 's'}`;
  const actions = scope.actions.length > 0 ? ` · ${scope.actions.join(', ')}` : '';
  return `${affected}${actions}`;
}

export function buildAuditEntries(turns: readonly TurnView[]): AuditEntry[] {
  const out: AuditEntry[] = [];

  for (const turn of turns) {
    const confirm = turn.pendingConfirm;
    if (confirm) {
      out.push({
        seq: confirm.requiredSeq ?? 0,
        turnId: turn.turnId,
        kind: 'confirmation.required',
        label: `Confirmation requested — ${confirm.scope.description}`,
        detail: describeScope(confirm.scope),
      });
      if (confirm.resolved) {
        out.push({
          seq: confirm.resolvedSeq ?? confirm.requiredSeq ?? 0,
          turnId: turn.turnId,
          kind: 'confirmation.resolved',
          label: confirm.approved ? 'Confirmation approved' : 'Confirmation denied',
          detail: confirm.scope.description,
        });
      }
    }

    for (const stepId of turn.stepOrder) {
      const step = turn.steps[stepId];
      if (!step || !RELEVANT_STEP_STATUSES.has(step.status)) continue;
      out.push({
        seq: step.seq ?? 0,
        turnId: turn.turnId,
        kind: step.status === 'done' ? 'step.finished' : 'step.failed',
        label: step.action,
        detail: step.status === 'done' ? step.summary ?? '' : step.error?.message ?? '',
      });
    }
  }

  return out.sort((a, b) => a.seq - b.seq);
}
