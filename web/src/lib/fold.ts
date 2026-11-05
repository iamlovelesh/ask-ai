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

import type { AppEvent, ConfirmationScope, TurnMetrics, TurnStatus } from './events.js';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepView {
  stepId: string;
  action: string;
  itemCount?: number;
  status: StepStatus;
  summary?: string;
  error?: { code: string; message: string };
}

export interface PendingConfirm {
  confirmId: string;
  stepId: string;
  scope: ConfirmationScope;
  resolved: boolean;
  approved?: boolean;
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
  /** True while an automatic reconnect loop is active. */
  reconnecting: boolean;
  /** User-facing banner text — set on an unexpected drop, cleared on a
   * clean reconnect/turn completion. */
  error: string | null;
}

export function emptyChatState(): SessionChatState {
  return {
    loaded: false,
    turns: [],
    turnIndex: {},
    lastSeq: 0,
    running: false,
    reconnecting: false,
    error: null,
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
      chat.running = true;
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
      return;
    }
    case 'step.failed': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      const step = findOrCreateStep(turn, ev.stepId, turn.steps[ev.stepId]?.action ?? '');
      step.status = 'failed';
      step.error = ev.error;
      return;
    }
    case 'confirmation.required': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      turn.pendingConfirm = { confirmId: ev.confirmId, stepId: ev.stepId, scope: ev.scope, resolved: false };
      return;
    }
    case 'confirmation.resolved': {
      const turn = findOrCreateTurn(chat, ev.turnId);
      if (turn.pendingConfirm?.confirmId === ev.confirmId) {
        turn.pendingConfirm.resolved = true;
        turn.pendingConfirm.approved = ev.approved;
      }
      return;
    }
    case 'answer.delta': {
      const turn = findOrCreateTurn(chat, ev.turnId);
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
      }
      chat.running = false;
      return;
    }
    case 'memory.snapshot':
      return; // fold checkpoint only — no direct render effect.
  }
}
