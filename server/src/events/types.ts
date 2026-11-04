/**
 * Event log types (LLD §2.3) + the LLM usage/metrics shapes referenced by
 * events and by `llm/client.ts`.
 *
 * `PlanOutcome`/`Plan`/`Step` (LLD §2.2) are owned by `agent/plan-schema.ts`
 * — re-exported below so this file's `Event` union can reference them
 * without a second definition to drift out of sync. `WorkingState` (LLD
 * §2.5) is owned by `agent/memory.ts` (later task); that file does not exist
 * yet, so a minimal verbatim-field copy lives here ONLY so the `Event` union
 * below type-checks today. When `agent/memory.ts` lands it should either
 * re-export these names or this file should be updated to import from it —
 * do not let the two definitions drift.
 */

// --- agent/plan-schema.ts (LLD §2.2) — re-exported, not re-defined --------

import type { PlanOutcome } from '../agent/plan-schema.js';
export type { Value, Step, Plan, PlanOutcome } from '../agent/plan-schema.js';

// --- agent/memory.ts (LLD §2.5) — minimal copy, field names verbatim -------

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
  ref: string;
  action: string;
  turnId: string;
  entityType: string;
  total: number;
  idList: string[];
  query?: object;
  sample: unknown[];
}

export interface WorkingState {
  frame: TaskFrame | null;
  entities: Record<string, EntityRef>;
  handles: RefHandle[];
}

// --- llm/client.ts ----------------------------------------------------------

/** Per-call LLM usage/cost accounting (LLD §2.3 `llm: LlmUsage` field). */
export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  latencyMs: number;
  /** 1-based attempt number the backoff loop succeeded on. */
  attempt: number;
}

// --- turn-level metrics (LLD §2.3 `turn.completed.metrics`) -----------------

export interface TurnMetrics {
  ttfurMs: number;
  totalMs: number;
  llmCalls: number;
  repairs: number;
  replans: number;
  searchRounds: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  stepsOk: number;
  stepsFailed: number;
}

// --- events/types.ts (LLD §2.3) ---------------------------------------------

export type TurnStatus = 'done' | 'clarify' | 'refused' | 'failed' | 'cancelled';

export interface ConfirmationScope {
  actions: string[];
  affectedCount: number;
  targetSample: string[];
  description: string;
}

export type Event =
  | { t: 'turn.started'; turnId: string; sessionId: string; userText: string; ts: number }
  | { t: 'retrieval.done'; turnId: string; candidates: string[]; playbook?: string; ms: number }
  | {
      t: 'plan.ready';
      turnId: string;
      outcome: PlanOutcome;
      planRev: number;
      planHash: string;
      llm: LlmUsage;
    }
  | {
      t: 'repair' | 'replan' | 'search';
      turnId: string;
      round: number;
      reason: string;
      llm: LlmUsage;
    }
  | { t: 'step.started'; turnId: string; stepId: string; action: string; itemCount?: number }
  | {
      t: 'step.finished';
      turnId: string;
      stepId: string;
      summary: string;
      resultRef?: string;
      /** ≤2KB inline, else a ref is used instead. */
      inlineResult?: unknown;
      ms: number;
    }
  | {
      t: 'step.failed';
      turnId: string;
      stepId: string;
      error: { code: string; message: string };
      ms: number;
    }
  | {
      t: 'confirmation.required';
      turnId: string;
      confirmId: string;
      planRev: number;
      planHash: string;
      stepId: string;
      scope: ConfirmationScope;
    }
  | { t: 'confirmation.resolved'; turnId: string; confirmId: string; approved: boolean }
  /** SSE-only — NOT persisted by EventLog.append (still fanned out live). */
  | { t: 'answer.delta'; turnId: string; text: string }
  /** persisted — replay reads this. */
  | { t: 'answer.final'; turnId: string; text: string }
  | { t: 'turn.completed'; turnId: string; status: TurnStatus; metrics: TurnMetrics }
  /** fold checkpoint, written every turn end. */
  | { t: 'memory.snapshot'; turnId: string; state: WorkingState };

export type EventType = Event['t'];
