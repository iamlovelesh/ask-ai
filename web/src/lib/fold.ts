/**
 * The single event-fold renderer: turns a stream of `AppEvent`s — whether
 * replayed in bulk from `GET /api/sessions/:id/events` or delivered one at
 * a time live over SSE — into the same per-turn render state. Both
 * `stores/session.ts`'s history load and its live/reconnect loops call
 * `applyEvent` per event, so "open an old session" and "watch a live turn"
 * are provably the same code path (Task 19's replay view reuses this too).
 *
 * Mutates `chat` in place — Pinia/Vue reactive state is designed for direct
 * mutation inside store actions (the idiomatic pattern the Pinia docs show,
 * e.g. `store.count++`), which is what lets a `step.started` → `step.
 * finished` pair update a single reactive row in the DOM instead of
 * diffing a freshly-cloned tree on every one of potentially hundreds of
 * frames in a turn.
 */

import type { AppEvent, AttachmentRef, ConfirmationScope, TurnMetrics, TurnStatus } from './events.js';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepView {
  stepId: string;
  action: string;
  itemCount?: number;
  status: StepStatus;
  summary?: string;
  error?: { code: string; message: string };
  /** Wall-clock duration of the step, from the `step.finished`/`step.failed`
   * event's `ms`. Rendered right-aligned in mono by the task tracker;
   * `undefined` while still pending/running. */
  ms?: number;
  /** `seq` of the `step.finished`/`step.failed` event that last updated this
   * step — `undefined` while still `pending`/`running`. Only consumed by
   * Task 19's AuditFeed (`lib/audit.ts`) to order entries chronologically;
   * optional so hand-built fixtures/tests need not supply it. */
  seq?: number;
  /** `resultRef` of the `step.finished` event, when the step's output spilled
   * to a server-side ref handle (large result sets) rather than inlining.
   * `undefined` for steps with no ref (small/no result) or not yet finished.
   * Surfaced verbatim (mono) in the step row's expanded detail panel. */
  resultRef?: string;
}

export interface PendingConfirm {
  confirmId: string;
  stepId: string;
  scope: ConfirmationScope;
  resolved: boolean;
  approved?: boolean;
  /** `seq` of the `confirmation.required` event that created this entry —
   * same purpose/optionality as `StepView.seq` above. */
  requiredSeq?: number;
  /** `seq` of the `confirmation.resolved` event, or of `turn.completed` when
   * a pending confirm is auto-denied at turn end (no explicit `resolved`
   * event fires for that case — see the `turn.completed` branch below). */
  resolvedSeq?: number;
}

export interface TurnView {
  turnId: string;
  userText: string;
  kind?: 'plan' | 'search' | 'clarify' | 'unsupported' | 'respond';
  goal?: string;
  stepOrder: string[];
  steps: Record<string, StepView>;
  activity: string[];
  deltaText: string;
  finalText?: string;
  clarifyQuestion?: string;
  unsupportedReason?: string;
  pendingConfirm?: PendingConfirm;
  status?: TurnStatus;
  metrics?: TurnMetrics;
  /** Durable-memory operations the post-turn extractor performed for this turn
   * (ADD/UPDATE/DELETE), shown in the trace. */
  memoryOps: MemoryOpView[];
  /** Files the user attached to this message (#6), shown in the user bubble. */
  attachments?: AttachmentRef[];
}

export interface MemoryOpView {
  op: 'ADD' | 'UPDATE' | 'DELETE';
  category: string;
  key?: string;
  body: string;
}

export interface SessionChatState {
  /** True once history has been fetched at least once for this session. */
  loaded: boolean;
  turns: TurnView[];
  turnIndex: Record<string, number>;
  /** Highest `seq` applied so far — the `afterSeq` a reconnect must pass. */
  lastSeq: number;
  /** True while a turn is known to be in flight (between `turn.started`
   * and `turn.completed`/`memory.snapshot`) for this session. */
  running: boolean;
  /** `turnId` of the turn currently in flight (set on `turn.started`,
   * cleared on `turn.completed`), or `null` when nothing is live. Lets the
   * UI scope live-only affordances — notably the aria-live step-progress
   * announcement — to a genuinely running turn, so bulk-replaying a
   * historical session (or switching to a finished one) never re-announces
   * its last turn's progress to assistive tech. */
  activeTurnId: string | null;
  /** True while an automatic reconnect loop is active. */
  reconnecting: boolean;
  /** User-facing banner text for a MID-STREAM drop (≥1 frame already
   * received for the in-flight turn, so the turn genuinely started
   * server-side and GET /stream?afterSeq can resume it) — cleared on a
   * clean reconnect/turn completion. Distinct from `sendError` below: this
   * one drives the auto-reconnect path. */
  error: string | null;
  /** User-facing banner text for a message that NEVER reached the server
   * (the POST itself failed/rejected before a single frame arrived — e.g.
   * offline, or a non-409 HTTP error). No turn was ever started, so there
   * is nothing to reconnect/resume: reconnecting here would open
   * `GET /stream` against a session with no new events, which would just
   * sit on heartbeats forever. The fix is to retry the SEND itself
   * (`lastFailedText`), not to reconnect. */
  sendError: string | null;
  /** The text of the message that failed to ever reach the server — kept
   * so a "retry send" control can resubmit it without the user retyping. */
  lastFailedText: string | null;
}

export function emptyChatState(): SessionChatState {
  return {
    loaded: false,
    turns: [],
    turnIndex: {},
    lastSeq: 0,
    running: false,
    activeTurnId: null,
    reconnecting: false,
    error: null,
    sendError: null,
    lastFailedText: null,
  };
}

function findOrCreateTurn(chat: SessionChatState, turnId: string, userText = ''): TurnView {
  const existingIndex = chat.turnIndex[turnId];
  if (existingIndex !== undefined) return chat.turns[existingIndex];
  const turn: TurnView = {
    turnId,
    userText,
    stepOrder: [],
    steps: {},
    activity: [],
    deltaText: '',
    memoryOps: [],
  };
  chat.turnIndex[turnId] = chat.turns.length;
  chat.turns.push(turn);
  return turn;
}

function findOrCreateStep(turn: TurnView, stepId: string, action: string): StepView {
  let step = turn.steps[stepId];
  if (!step) {
    step = { stepId, action, status: 'pending' };
    turn.steps[stepId] = step;
  }
  if (!turn.stepOrder.includes(stepId)) turn.stepOrder.push(stepId);
  return step;
}

/** Applies one event to `chat`, mutating it in place. Safe to call for
 * every event in a full-history replay (in order) or for a single live
 * event as it arrives — both use the exact same branches below. */
export function applyEvent(chat: SessionChatState, ev: AppEvent): void {
  chat.lastSeq = Math.max(chat.lastSeq, ev.seq);

  switch (ev.t) {
    case 'turn.started': {
      const turn = findOrCreateTurn(chat, ev.turnId, ev.userText);
      turn.userText = ev.userText;
      if (ev.attachments && ev.attachments.length > 0) turn.attachments = ev.attachments;
      chat.running = true;
      chat.activeTurnId = ev.turnId;
      chat.error = null;
      return;
    }
    case 'retrieval.done':
      return; // not surfaced in the UI — retained in the fold only for seq bookkeeping.
    case 'plan.ready': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      turn.kind = ev.outcome.kind;
      if (ev.outcome.kind === 'plan') {
        turn.goal = ev.outcome.plan.goal;
        for (const step of ev.outcome.plan.steps) {
          findOrCreateStep(turn, step.id, step.action);
        }
      } else if (ev.outcome.kind === 'clarify') {
        turn.clarifyQuestion = ev.outcome.question;
      } else if (ev.outcome.kind === 'unsupported') {
        turn.unsupportedReason = ev.outcome.reason;
      }
      return;
    }
    case 'repair':
    case 'replan':
    case 'search': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      turn.activity.push(`${ev.t} (round ${ev.round}): ${ev.reason}`);
      return;
    }
    case 'step.started': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      const step = findOrCreateStep(turn, ev.stepId, ev.action);
      step.action = ev.action;
      step.itemCount = ev.itemCount;
      step.status = 'running';
      return;
    }
    case 'step.finished': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      const step = findOrCreateStep(turn, ev.stepId, turn.steps[ev.stepId]?.action ?? '');
      step.status = 'done';
      step.summary = ev.summary;
      step.ms = ev.ms;
      step.seq = ev.seq;
      step.resultRef = ev.resultRef;
      return;
    }
    case 'step.failed': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      const step = findOrCreateStep(turn, ev.stepId, turn.steps[ev.stepId]?.action ?? '');
      step.status = 'failed';
      step.error = ev.error;
      step.ms = ev.ms;
      step.seq = ev.seq;
      return;
    }
    case 'confirmation.required': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      turn.pendingConfirm = {
        confirmId: ev.confirmId,
        stepId: ev.stepId,
        scope: ev.scope,
        resolved: false,
        requiredSeq: ev.seq,
      };
      return;
    }
    case 'confirmation.resolved': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      if (turn.pendingConfirm?.confirmId === ev.confirmId) {
        turn.pendingConfirm.resolved = true;
        turn.pendingConfirm.approved = ev.approved;
        turn.pendingConfirm.resolvedSeq = ev.seq;
      }
      return;
    }
    case 'answer.delta': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      // A reset marker (emitted at the start of each answer attempt during
      // Live+correct streaming) clears the prior draft so a verification
      // re-run replaces it rather than appending.
      if (ev.reset) turn.deltaText = '';
      turn.deltaText += ev.text;
      return;
    }
    case 'answer.final': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      turn.finalText = ev.text;
      return;
    }
    case 'turn.completed': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      turn.status = ev.status;
      turn.metrics = ev.metrics;
      // Any step that never started by the time the turn ends was skipped
      // (e.g. a denied confirmation's dependents, or steps after a halt) —
      // the Event union has no explicit `step.skipped`, so this is derived.
      for (const stepId of turn.stepOrder) {
        const step = turn.steps[stepId];
        if (step && step.status === 'pending') step.status = 'skipped';
      }
      if (turn.pendingConfirm && !turn.pendingConfirm.resolved) {
        turn.pendingConfirm.resolved = true;
        turn.pendingConfirm.approved = false;
        turn.pendingConfirm.resolvedSeq = ev.seq;
      }
      chat.running = false;
      if (chat.activeTurnId === ev.turnId) chat.activeTurnId = null;
      return;
    }
    case 'memory.snapshot':
      return; // fold checkpoint only — no direct render effect.
    case 'memory.op': {
      // Appended after turn.completed (extraction is detached) — attach to the
      // turn so the trace shows which message produced which memory change.
      const turn = findOrCreateTurn(chat, ev.turnId);
      const view: MemoryOpView = { op: ev.op, category: ev.category, body: ev.body };
      if (ev.key !== undefined) view.key = ev.key;
      turn.memoryOps.push(view);
      return;
    }
  }
}
