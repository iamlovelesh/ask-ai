/**
 * Client-side mirror of the `Event` union (server/src/events/types.ts) and
 * the `PlanOutcome`/`Plan`/`Step` shapes it carries (server/src/agent/
 * plan-schema.ts). Deliberately NOT imported from `server/src` — the web
 * workspace builds independently (Vite/vue-tsc, browser target) and has no
 * business pulling in `node:sqlite`-adjacent server code just for types.
 * Kept in sync by hand; field names/shapes here are copied verbatim from
 * the LLD §2.2/§2.3 contract this agent was briefed on.
 */

export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  latencyMs: number;
  attempt: number;
}

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
  gateWaitMs?: number;
  /** The model slug that ran this turn (model-picker), shown in the trace. */
  model?: string;
}

export type TurnStatus = 'done' | 'clarify' | 'refused' | 'failed' | 'cancelled';

export interface ConfirmationScope {
  actions: string[];
  affectedCount: number;
  targetSample: string[];
  description: string;
}

export interface PlanStep {
  id: string;
  action: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  forEach?: string;
  when?: unknown;
  expects?: unknown;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

export type PlanOutcome =
  | { kind: 'plan'; plan: Plan }
  | { kind: 'search'; queries: string[] }
  | { kind: 'clarify'; question: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'respond'; text: string };

/** One parsed SSE frame's `data` payload, narrowed by `t`. Every variant
 * also carries `seq` (added by the server — `server/src/api/sse.ts`'s
 * `{seq, ...event}` spread). */
export type AppEvent =
  | { t: 'turn.started'; seq: number; turnId: string; sessionId: string; userText: string; ts: number }
  | { t: 'retrieval.done'; seq: number; turnId: string; candidates: string[]; playbook?: string; ms: number }
  | { t: 'plan.ready'; seq: number; turnId: string; outcome: PlanOutcome; planRev: number; planHash: string; llm: LlmUsage }
  | { t: 'repair' | 'replan' | 'search'; seq: number; turnId: string; round: number; reason: string; llm: LlmUsage }
  | { t: 'step.started'; seq: number; turnId: string; stepId: string; action: string; itemCount?: number }
  | {
      t: 'step.finished';
      seq: number;
      turnId: string;
      stepId: string;
      summary: string;
      resultRef?: string;
      inlineResult?: unknown;
      ms: number;
    }
  | { t: 'step.failed'; seq: number; turnId: string; stepId: string; error: { code: string; message: string }; ms: number }
  | {
      t: 'confirmation.required';
      seq: number;
      turnId: string;
      confirmId: string;
      planRev: number;
      planHash: string;
      stepId: string;
      scope: ConfirmationScope;
    }
  | { t: 'confirmation.resolved'; seq: number; turnId: string; confirmId: string; approved: boolean }
  | { t: 'answer.delta'; seq: number; turnId: string; text: string; reset?: boolean }
  | { t: 'answer.final'; seq: number; turnId: string; text: string }
  | { t: 'turn.completed'; seq: number; turnId: string; status: TurnStatus; metrics: TurnMetrics }
  | { t: 'memory.snapshot'; seq: number; turnId: string; state: unknown };

export type AppEventType = AppEvent['t'];

/**
 * Normalizes a single item from either event source into the flat
 * `{seq, t, ...}` shape `applyEvent` folds.
 *
 * The live SSE channels (`POST .../messages`, `GET .../stream`) already
 * deliver flat frames (`sse.ts` yields `frame.data`, the server's
 * `{seq, ...event}` spread). The REST replay endpoint
 * (`GET /api/sessions/:id/events`), however, returns the raw event-log rows
 * `{ seq, event: { t, ... } }` with the payload nested under `event` — so
 * feeding those straight to `applyEvent` (which reads `ev.t`) would fold
 * nothing. This tolerant unwrap accepts both shapes so "open an old
 * session" and "watch a live turn" remain one fold path.
 */
export function normalizeEvent(raw: unknown): AppEvent {
  if (raw !== null && typeof raw === 'object' && 'event' in raw) {
    const row = raw as { seq?: number; event: Record<string, unknown> };
    return { seq: row.seq, ...row.event } as AppEvent;
  }
  return raw as AppEvent;
}
