/**
 * Event log types (LLD §2.3) + the LLM usage/metrics shapes referenced by
 * events and by `llm/client.ts`.
 *
 * `PlanOutcome`/`Plan`/`Step` (LLD §2.2) are owned by `agent/plan-schema.ts`;
 * `WorkingState`/`TaskFrame`/`EntityRef`/`RefHandle` (LLD §2.5) are owned by
 * `agent/memory.ts`. Both are re-exported below (type-only — erased at
 * compile time by `verbatimModuleSyntax`, so `agent/memory.ts` importing
 * `Event` from THIS file back creates no runtime import cycle) so the
 * `Event` union can reference them without a second definition to drift out
 * of sync.
 */

// --- agent/plan-schema.ts (LLD §2.2) — re-exported, not re-defined --------

import type { PlanOutcome } from '../agent/plan-schema.js';
export type { Value, Step, Plan, PlanOutcome } from '../agent/plan-schema.js';

// --- agent/validator.ts (task-refconverge Fix A) — re-exported ------------

import type { RefAutofix } from '../agent/validator.js';
export type { RefAutofix } from '../agent/validator.js';

// --- agent/memory.ts (LLD §2.5) — re-exported, not re-defined --------------

import type { WorkingState } from '../agent/memory.js';
export type { TaskFrame, EntityRef, RefHandle, WorkingState } from '../agent/memory.js';

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
  /** Engine-wave E7 (RC8): wall-clock ms spent waiting on human confirmation
   * decisions this turn. Recorded separately and SUBTRACTED from the turn
   * deadline, so a slow approver never turns an approved+executed turn into a
   * spurious 'failed'. Omitted (undefined) when no gate waited. */
  gateWaitMs?: number;
  /** The OpenRouter model slug that ran this turn (model-picker). Persisted
   * so the trace/footer can show which model produced the answer. */
  model?: string;
}

// --- events/types.ts (LLD §2.3) ---------------------------------------------

export type TurnStatus = 'done' | 'clarify' | 'refused' | 'failed' | 'cancelled';

/** A file the user attached to a message (#6) — shown in history and offered
 * to the agent as context. */
export interface AttachmentRef {
  filename: string;
  mime: string;
  size: number;
  url: string;
  /** For TEXT files, the readable content (capped) given to the agent so it can
   * parse/summarize/import it. Omitted for binary files, and stripped from the
   * turn.started history event (history keeps only the metadata). */
  content?: string;
}

export interface ConfirmationScope {
  actions: string[];
  affectedCount: number;
  targetSample: string[];
  description: string;
  /** The proposed arguments for the gated action (#6). Surfaced so the client
   * can show — and let the user EDIT — them before approving; the edited
   * values flow back via the confirm verdict and are re-validated server-side
   * before the handler runs. Absent for multi-action/legacy scopes. */
  params?: Record<string, unknown>;
  /** Approval card kind (per-tool approval templates) so the client
   * renders an action-specific card — delete vs update vs send-email vs merge —
   * instead of a generic line. Absent for form/legacy scopes. */
  template?: 'recordCreate' | 'recordUpdate' | 'recordDelete' | 'email' | 'merge';
  /** A structured input FORM the agent is requesting (session__request_form,
   * request_form). When present the client renders input fields
   * instead of an approval card; submitted values flow back as the verdict's
   * editedParams. */
  form?: {
    title: string;
    fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'date'; required: boolean }>;
  };
}

export type Event =
  | { t: 'turn.started'; turnId: string; sessionId: string; userText: string; ts: number; attachments?: AttachmentRef[] }
  | { t: 'retrieval.done'; turnId: string; candidates: string[]; playbook?: string; ms: number }
  | {
      t: 'plan.ready';
      turnId: string;
      outcome: PlanOutcome;
      planRev: number;
      planHash: string;
      llm: LlmUsage;
      /** Deterministic ref rewrites applied by `agent/validator.ts`'s
       * `autoFixRefs` before this plan validated (task-refconverge Fix A) —
       * omitted when none were applied. */
      refAutofixes?: RefAutofix[];
    }
  | {
      t: 'repair' | 'replan' | 'search';
      turnId: string;
      round: number;
      reason: string;
      llm: LlmUsage;
    }
  | {
      t: 'step.started';
      turnId: string;
      stepId: string;
      action: string;
      itemCount?: number;
      /** task-harness-fairness: the step's FULLY RESOLVED params (refs like
       * "$s1.items[0].id" already substituted with their runtime value) —
       * one entry per dispatch (length 1 for a scalar step, length
       * `itemCount` for a forEach fan-out). Additive/optional so every
       * existing reader of `step.started` (which only ever destructured
       * `action`/`itemCount`/`stepId`) keeps working unchanged; consumed by
       * `eval/assert.ts`'s `paramChecks` so a scenario can assert against
       * the RESOLVED runtime value instead of only the plan's literal
       * (possibly ref-string) param text. */
      resolvedParams?: Record<string, unknown>[];
    }
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
  | { t: 'answer.delta'; turnId: string; text: string; reset?: boolean }
  /** persisted — replay reads this. */
  | { t: 'answer.final'; turnId: string; text: string }
  | { t: 'turn.completed'; turnId: string; status: TurnStatus; metrics: TurnMetrics }
  /** fold checkpoint, written every turn end. */
  | { t: 'memory.snapshot'; turnId: string; state: WorkingState }
  /** A durable-memory operation the post-turn extractor performed for THIS
   * turn (ADD/UPDATE/DELETE). Persisted and tagged with the turnId so the
   * trace can show which message produced which memory change. Appended after
   * `turn.completed` (extraction is fire-and-forget), so a live SSE may miss
   * it — it surfaces on trace replay. */
  | {
      t: 'memory.op';
      turnId: string;
      op: 'ADD' | 'UPDATE' | 'DELETE';
      category: string;
      key?: string;
      body: string;
      memoryId?: string;
      targetId?: string;
    };

export type EventType = Event['t'];
