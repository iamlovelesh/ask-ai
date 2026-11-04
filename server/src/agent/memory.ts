/**
 * Working memory (LLD §2.5): the canonical `WorkingState`/`TaskFrame`/
 * `EntityRef`/`RefHandle` types (field names verbatim from the LLD), plus
 * the pure functions that fold a session's event stream into a
 * `WorkingState`, render it compactly for the planner prompt, mask older
 * turns, and deterministically rewrite anaphoric follow-up queries.
 *
 * `events/types.ts` imports/re-exports these types (type-only — no runtime
 * import cycle, same convergence pattern `agent/plan-schema.ts` already
 * uses for `PlanOutcome`) rather than keeping its own "minimal copy" — see
 * that file's header.
 */

import type { Event } from '../events/types.js';
import type { SeqEvent } from '../events/log.js';
import type { Plan } from './plan-schema.js';

// --- canonical types (LLD §2.5 — field names verbatim) ----------------------

export interface TaskFrame {
  intent: string;
  status: 'active' | 'completed';
  filters: Record<string, unknown>;
  missingParams: string[];
  planHash?: string;
}

export interface EntityRef {
  id: string;
  type: string;
  name: string;
  source: string;
  turn: string;
}

export interface RefHandle {
  ref: string; // "r_t3_s1" (serialized to the planner as "$r_t3_s1 (…)")
  action: string;
  turnId: string;
  entityType: string;
  total: number;
  idList: string[]; // ≤10k ids; larger sets store the query descriptor instead
  query?: object;
  sample: unknown[]; // 20 rows for display/planning
  /** Set true only after `/admin/reset` marks all session handles stale
   * (LLD §2.5). */
  stale?: boolean;
}

export interface WorkingState {
  frame: TaskFrame | null; // SINGLE active frame (LLD §2.5 — stack cut)
  entities: Record<string, EntityRef>;
  handles: RefHandle[]; // last ≤6 result handles, newest first
}

export function emptyWorkingState(): WorkingState {
  return { frame: null, entities: {}, handles: [] };
}

const MAX_HANDLES = 6;

// --- foldMemory --------------------------------------------------------------

function isSeqEvent(e: SeqEvent | Event): e is SeqEvent {
  return typeof e === 'object' && e !== null && 'event' in e;
}

/** `action` slug lives on `step.started`, not `step.finished` — tracked here
 * (scoped by `turnId:stepId`) while folding so a `resultRef`-bearing
 * `step.finished` can recover it. */
function actionKey(turnId: string, stepId: string): string {
  return `${turnId}:${stepId}`;
}

/** `entityType` has no event of its own; the module prefix of the action
 * slug (`"leads.search_leads"` → `"leads"`) is the best available proxy
 * without a registry lookup, and matches the common case where
 * `ActionDef.entities[0]` equals the module name (see `agent/executor.ts`'s
 * identical heuristic in `spillToRef`). */
function entityTypeFromAction(action: string): string {
  const dot = action.indexOf('.');
  return dot >= 0 ? action.slice(0, dot) : action;
}

/** Best-effort row count recovered from a `step.finished.summary` string.
 * `agent/executor.ts`'s `summarize()` always emits `"<action>: <count>
 * <noun>…"`; this is the ONLY place a count is observable for a
 * `resultRef`-bearing finish (the inline result itself was elided — that's
 * exactly why it spilled to a ref). Falls back to 0 on a non-matching
 * (e.g. hand-built test) summary rather than throwing — this is a display
 * aid, not an authority: the executor always re-resolves the real ref
 * against the live store via `RefStore.resolve`, never through this value. */
function parseCountFromSummary(summary: string): number {
  const m = /:\s*(\d+)\s+/.exec(summary);
  return m ? Number(m[1]) : 0;
}

/** Best-effort "active constraints" extraction from a freshly-planned
 * `Plan`: every scalar (string/number/boolean/null) literal param across
 * all steps, last-one-wins by key, ref-valued strings (`"$s1..."`) excluded.
 * The LLD does not prescribe an exact derivation for `TaskFrame.filters`;
 * this is a documented heuristic representing "what the plan pinned down
 * this turn" for anaphora rewriting (`rewriteQuery`) and display. */
function deriveFilters(plan: Plan): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  for (const step of plan.steps) {
    for (const [key, value] of Object.entries(step.params)) {
      if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        filters[key] = value;
      } else if (typeof value === 'string' && !value.startsWith('$')) {
        filters[key] = value;
      }
    }
  }
  return filters;
}

/**
 * Rebuilds a `WorkingState` from a session's event list. Per LLD §2.3,
 * folding starts from the LATEST `memory.snapshot` (not event zero — bounds
 * rebuild cost) and applies only events AFTER it:
 *   - `plan.ready` (kind `'plan'`) sets `frame.intent`/`filters` to the new
 *     plan's goal/derived filters, status `'active'`.
 *   - `step.finished` with a `resultRef` adds a handle, newest-first,
 *     capped at 6 (LLD §2.5).
 *   - `turn.completed` with `status:'done'` marks the active frame
 *     `'completed'`.
 * Accepts either raw `Event[]` or `SeqEvent[]` (the `EventLog.list` shape)
 * so callers never need to unwrap `.event` themselves.
 */
export function foldMemory(events: ReadonlyArray<SeqEvent | Event>): WorkingState {
  const plain: Event[] = events.map((e) => (isSeqEvent(e) ? e.event : e));

  let snapshotIdx = -1;
  for (let i = plain.length - 1; i >= 0; i -= 1) {
    if (plain[i]?.t === 'memory.snapshot') {
      snapshotIdx = i;
      break;
    }
  }

  let state: WorkingState =
    snapshotIdx >= 0
      ? structuredClone((plain[snapshotIdx] as Extract<Event, { t: 'memory.snapshot' }>).state)
      : emptyWorkingState();

  const actionBySKey = new Map<string, string>();

  for (const ev of plain.slice(snapshotIdx + 1)) {
    switch (ev.t) {
      case 'step.started':
        actionBySKey.set(actionKey(ev.turnId, ev.stepId), ev.action);
        break;

      case 'plan.ready':
        if (ev.outcome.kind === 'plan') {
          state = {
            ...state,
            frame: {
              intent: ev.outcome.plan.goal,
              status: 'active',
              filters: deriveFilters(ev.outcome.plan),
              missingParams: [],
              planHash: ev.planHash,
            },
          };
        }
        break;

      case 'step.finished':
        if (ev.resultRef !== undefined) {
          const action = actionBySKey.get(actionKey(ev.turnId, ev.stepId)) ?? 'unknown.action';
          const handle: RefHandle = {
            ref: ev.resultRef,
            action,
            turnId: ev.turnId,
            entityType: entityTypeFromAction(action),
            total: parseCountFromSummary(ev.summary),
            // Not recoverable from the event stream alone (the executor
            // elided the full payload precisely because it spilled); the
            // authoritative copy lives in the `refs` table, re-resolved by
            // ref id at use time (LLD §2.5) — never through this fold.
            idList: [],
            sample: [],
          };
          state = { ...state, handles: [handle, ...state.handles].slice(0, MAX_HANDLES) };
        }
        break;

      case 'turn.completed':
        if (ev.status === 'done' && state.frame !== null) {
          state = { ...state, frame: { ...state.frame, status: 'completed' } };
        }
        break;

      default:
        break;
    }
  }

  return state;
}

// --- renderWorkingState ------------------------------------------------------

function renderFilters(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return '{}';
  return `{${entries.map(([k, v]) => `${k}:${String(v)}`).join(', ')}}`;
}

function renderFrameLine(frame: TaskFrame | null): string {
  if (frame === null) return 'frame: (none)';
  const missing =
    frame.missingParams.length > 0 ? ` missingParams=[${frame.missingParams.join(', ')}]` : '';
  return `frame: ${frame.intent} [${frame.status}] filters=${renderFilters(frame.filters)}${missing}`;
}

function renderEntityLine(name: string, ref: EntityRef): string {
  return `  ${name} -> ${ref.id} (${ref.type}, from ${ref.source}, turn ${ref.turn})`;
}

/** `{total} {entityType} from {action} (turn N)` plus an explicit
 * "whole-ref list" caution — a cross-turn `$r_x.path` traversal only ever
 * sees the handle's 20-row sample (documented executor limitation), so the
 * rendered line steers the planner toward using the ref as a whole list
 * rather than plucking fields off a set it can't fully see. */
function renderHandleLine(h: RefHandle): string {
  return (
    `  $${h.ref} — ${h.total} ${h.entityType} from ${h.action} (turn ${h.turnId})` +
    ` — use $${h.ref} as a whole-ref list, not field-path access`
  );
}

/** Compact WorkingState block for the planner prompt (LLD §2.5: frame
 * intent+filters; entities name→id lines; ≤6 handles) — kept well under the
 * ~600-token guidance even for a full state (6 handles + several entities). */
export function renderWorkingState(state: WorkingState): string {
  const lines: string[] = ['WORKING_STATE:', renderFrameLine(state.frame)];

  const entityEntries = Object.entries(state.entities);
  lines.push(entityEntries.length === 0 ? 'entities: (none)' : 'entities:');
  for (const [name, ref] of entityEntries) lines.push(renderEntityLine(name, ref));

  lines.push(state.handles.length === 0 ? 'handles: (none)' : 'handles:');
  for (const h of state.handles) lines.push(renderHandleLine(h));

  return lines.join('\n');
}

// --- maskTurns ----------------------------------------------------------------

export interface TurnTranscript {
  turnId: string;
  userText: string;
  /** Step summaries produced during this turn, in order. */
  steps: { summary: string }[];
  /** The turn's final answer text, if it completed. */
  answer?: string;
}

const OLDER_SUMMARY_MAX_CHARS = 200;

/** Masks tool results in turns older than `keepLastN`: those collapse to a
 * single one-liner ("TURN N (result): k step(s) — …", truncated); the most
 * recent `keepLastN` turns render every step summary verbatim (LLD §2.5
 * "Writer rule" — "last 6 turns, older tool results masked to one-liners";
 * this function implements the masking, the caller picks how many turns of
 * event history to hand in). */
export function maskTurns(turnEvents: readonly TurnTranscript[], keepLastN = 3): string {
  const splitAt = Math.max(0, turnEvents.length - keepLastN);
  const older = turnEvents.slice(0, splitAt);
  const recent = turnEvents.slice(splitAt);

  const lines: string[] = [];

  for (const turn of older) {
    lines.push(`TURN ${turn.turnId} (user): ${turn.userText}`);
    const oneLiner = `TURN ${turn.turnId} (result): ${turn.steps.length} step(s) — ${turn.steps
      .map((s) => s.summary)
      .join('; ')}`;
    lines.push(
      oneLiner.length > OLDER_SUMMARY_MAX_CHARS ? `${oneLiner.slice(0, OLDER_SUMMARY_MAX_CHARS)}…` : oneLiner,
    );
  }

  for (const turn of recent) {
    lines.push(`TURN ${turn.turnId} (user): ${turn.userText}`);
    for (const step of turn.steps) {
      lines.push(`TURN ${turn.turnId} (step): ${step.summary}`);
    }
    if (turn.answer !== undefined) lines.push(`TURN ${turn.turnId} (answer): ${turn.answer}`);
  }

  return lines.join('\n');
}

// --- rewriteQuery --------------------------------------------------------------

// Pronoun/anaphora cues (LLD §2.5 brief: "those/them/these/it/same/only/
// also/instead") — deliberately NOT a broader stopword list; these are the
// specific words that signal "this request depends on what we were just
// talking about".
const ANAPHORA_SIGNALS = ['those', 'them', 'these', 'it', 'same', 'only', 'also', 'instead'];

function hasAnaphoraSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return ANAPHORA_SIGNALS.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

/** DETERMINISTIC (no LLM): if `userText` carries an anaphora signal AND an
 * active `TaskFrame` exists, prefix the standalone query with the frame's
 * intent, its non-null filters, and a mention of the most recent handle;
 * otherwise return `userText` unchanged. This feeds retrieval + the
 * planner's `<request>` block — the planner ALSO sees the full
 * `renderWorkingState` block, so this function only needs to be "good
 * enough to retrieve the right actions", not exhaustive.
 *
 * CONTRACT: call this exactly ONCE per turn, pre-retrieval, on the raw user
 * message — never re-apply it to its own output. It IS idempotent against
 * that misuse (a second call against the same `state` returns the input
 * unchanged, since the output always starts with `frame.intent`), but a
 * rewritten string is no longer "the user's message" and re-rewriting it
 * against a DIFFERENT frame on a later turn is not something this guard can
 * detect or fix — one call site, one time, is the only correct usage. */
export function rewriteQuery(userText: string, state: WorkingState): string {
  if (!hasAnaphoraSignal(userText) || state.frame === null || state.frame.status !== 'active') {
    return userText;
  }
  const frame = state.frame;

  // Idempotence guard: `userText` is already this frame's own rewritten
  // output (it starts with the exact prefix a rewrite would produce) — the
  // anaphora cues still present in the tail (e.g. "only"/"it") must NOT
  // trigger a second, duplicated prefix.
  if (userText.startsWith(frame.intent)) {
    return userText;
  }

  const filterParts = Object.entries(frame.filters)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}:${String(v)}`);
  const newestHandle = state.handles[0];
  const handleMention =
    newestHandle !== undefined
      ? `$${newestHandle.ref} (${newestHandle.total} ${newestHandle.entityType})`
      : undefined;

  const prefix = [frame.intent, ...filterParts, ...(handleMention !== undefined ? [handleMention] : [])].join(
    ' — ',
  );

  return `${prefix} — ${userText}`;
}
