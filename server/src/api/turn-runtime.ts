/**
 * Per-session runtime state for Task 15's HTTP layer (LLD §6):
 *   - `HttpConfirmBroker` — the `ConfirmBroker` the executor awaits on a
 *     gated step, resolved by `POST .../confirm/:confirmId`.
 *   - `SessionRuntime` — one-turn-at-a-time enforcement, the turn-runner
 *     that drives `runTurn`/`runBaselineTurn` to completion INDEPENDENTLY
 *     of whatever SSE connection (if any) is currently attached (Task 13
 *     note: SSE only ever subscribes to `EventLog`, it never drains the
 *     generator itself — that's this module's job), best-effort
 *     cancellation, and the confirm-resolution policy (controller
 *     carry-forward: match against the pending `confirmation.required`
 *     EVENT, never `foldExecutor`'s state, which omits hash/rev on purpose).
 */

import { randomUUID } from 'node:crypto';
import type { Registry } from '../catalog/registry.js';
import type { Crm } from '../store/db.js';
import type { SessionsDb } from '../store/sessions-db.js';
import type { EventLog } from '../events/log.js';
import { createRefStore, type RefStore } from '../agent/refs.js';
import type { ConfirmBroker, ConfirmRequest } from '../agent/executor.js';
import type { Playbook } from '../playbooks/loader.js';
import { emptyWorkingState } from '../agent/memory.js';
import { runTurn, type SessionDeps } from '../agent/pipeline.js';
import { runBaselineTurn, type BaselineSessionDeps } from '../baseline/agent.js';
import type { Event, TurnMetrics } from '../events/types.js';

export type AgentKind = 'optimized' | 'baseline';

/** `sessionsDb.get('SELECT id FROM sessions WHERE id = ?', [id])` — shared
 * by every session-scoped route handler that needs a quick 404 check
 * without going through `EventLog.listSessions`' paging. */
export function sessionExists(sessionsDb: SessionsDb, sessionId: string): boolean {
  return sessionsDb.get(`SELECT id FROM sessions WHERE id = ?`, [sessionId]) !== undefined;
}

// --- confirm broker ----------------------------------------------------------

interface PendingConfirm {
  req: ConfirmRequest;
  resolve: (approved: boolean) => void;
}

class HttpConfirmBroker implements ConfirmBroker {
  private readonly pending = new Map<string, PendingConfirm>();

  request(req: ConfirmRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pending.set(req.confirmId, { req, resolve });
    });
  }

  isPending(confirmId: string): boolean {
    return this.pending.has(confirmId);
  }

  /** Resolves the broker's promise for `confirmId` iff it is still
   * pending. Returns false when it was never pending (unknown, already
   * resolved, or superseded) — the caller (`SessionRuntime.resolveConfirmation`)
   * is responsible for turning that into the right HTTP status. */
  resolve(confirmId: string, approved: boolean): boolean {
    const p = this.pending.get(confirmId);
    if (!p) return false;
    this.pending.delete(confirmId);
    p.resolve(approved);
    return true;
  }
}

// --- session runtime -----------------------------------------------------

interface RunningTurn {
  turnId: string;
  agent: AgentKind;
  cancelled: boolean;
}

export interface StartTurnInput {
  sessionId: string;
  userText: string;
  agent: AgentKind;
}

export type ConfirmResolution =
  | { outcome: 'not_found' }
  | { outcome: 'conflict' }
  | { outcome: 'ok'; resolve: (approved: boolean) => void };

export class SessionRuntime {
  private readonly refsCache = new Map<string, RefStore>();
  private readonly brokers = new Map<string, HttpConfirmBroker>();
  private readonly running = new Map<string, RunningTurn>();
  /** turnId -> which agent ran it. In-memory only (Task 15 scope) — lost on
   * restart; `/api/metrics` falls back to `'optimized'` for any turnId it
   * doesn't recognize, which is the right default since that's the primary
   * agent this server is built around. */
  private readonly turnAgent = new Map<string, AgentKind>();

  constructor(
    private readonly sessionsDb: SessionsDb,
    private readonly eventLog: EventLog,
    private readonly registry: Registry,
    private readonly playbooks: readonly Playbook[],
    private readonly getCrm: () => Crm,
  ) {}

  private refsFor(sessionId: string): RefStore {
    let r = this.refsCache.get(sessionId);
    if (!r) {
      r = createRefStore(this.sessionsDb, sessionId);
      this.refsCache.set(sessionId, r);
    }
    return r;
  }

  private brokerFor(sessionId: string): HttpConfirmBroker {
    let b = this.brokers.get(sessionId);
    if (!b) {
      b = new HttpConfirmBroker();
      this.brokers.set(sessionId, b);
    }
    return b;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  agentFor(turnId: string): AgentKind {
    return this.turnAgent.get(turnId) ?? 'optimized';
  }

  /**
   * Mints a `turnId`, registers it as THE running turn for `sessionId`
   * (throws `'ALREADY_RUNNING'` if one is already in flight — the LLD/test
   * 409), and kicks off the turn-runner as a detached background task. The
   * runner drains `runTurn`/`runBaselineTurn`'s generator by itself; every
   * event it produces flows through `eventLog.append` (inside the agent
   * module itself) regardless of whether any HTTP client is currently
   * subscribed — this is what makes the confirmation-drop/reconnect flow
   * work (Review Focus 1).
   */
  startTurn(input: StartTurnInput): string {
    if (this.isRunning(input.sessionId)) {
      throw new Error('ALREADY_RUNNING');
    }
    const turnId = `t_${randomUUID()}`;
    const state: RunningTurn = { turnId, agent: input.agent, cancelled: false };
    this.running.set(input.sessionId, state);
    this.turnAgent.set(turnId, input.agent);

    void this.drive(input.sessionId, input.userText, state).finally(() => {
      if (this.running.get(input.sessionId) === state) this.running.delete(input.sessionId);
    });

    return turnId;
  }

  private async drive(sessionId: string, userText: string, state: RunningTurn): Promise<void> {
    const confirm = this.brokerFor(sessionId);
    const refs = this.refsFor(sessionId);
    const crm = this.getCrm();

    const gen =
      state.agent === 'baseline'
        ? runBaselineTurn({
            sessionId,
            turnId: state.turnId,
            userText,
            sessionDeps: {
              registry: this.registry,
              crm,
              refs,
              eventLog: this.eventLog,
              confirm,
            } satisfies BaselineSessionDeps,
          })
        : runTurn({
            sessionId,
            turnId: state.turnId,
            userText,
            sessionDeps: {
              registry: this.registry,
              crm,
              refs,
              eventLog: this.eventLog,
              confirm,
              playbooks: this.playbooks as Playbook[],
            } satisfies SessionDeps,
          });

    try {
      for (;;) {
        if (state.cancelled) {
          this.emitCancellation(sessionId, state.turnId);
          return;
        }
        const { done } = await gen.next();
        if (done) return;
      }
    } catch {
      // `runTurn`/`runBaselineTurn` already catch every internal error and
      // finalize via an honest `turn.completed{status:'failed'}` — this
      // catch exists purely as a last-resort guard so a bug in THIS loop
      // (not in the agent) can never leave a session's running-flag stuck.
    }
  }

  private emitCancellation(sessionId: string, turnId: string): void {
    const metrics: TurnMetrics = {
      ttfurMs: 0,
      totalMs: 0,
      llmCalls: 0,
      repairs: 0,
      replans: 0,
      searchRounds: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      stepsOk: 0,
      stepsFailed: 0,
    };
    this.eventLog.append(sessionId, { t: 'turn.completed', turnId, status: 'cancelled', metrics });
    this.eventLog.append(sessionId, { t: 'memory.snapshot', turnId, state: emptyWorkingState() });
  }

  /** `POST /cancel` (LLD §6) — best-effort AbortController-style flag: the
   * drive loop above checks it between every generator step. A turn
   * currently suspended awaiting a confirmation is NOT interrupted by this
   * (there is no safe way to abort mid-handler without the executor's
   * cooperation) — it only takes effect the next time the generator
   * actually yields control back. Returns whether a turn was running at
   * all (the caller always responds 204 either way, per LLD). */
  cancel(sessionId: string): boolean {
    const state = this.running.get(sessionId);
    if (!state) return false;
    state.cancelled = true;
    return true;
  }

  /**
   * `POST /confirm/:confirmId` resolution policy (controller carry-forward,
   * BINDING): rescans the session's raw persisted events for the matching
   * `confirmation.required` (never `foldExecutor`'s `ExecutorState`, which
   * deliberately omits planHash/planRev) to classify the request, THEN only
   * resolves the broker promise if that confirmation is still the one the
   * running turn is actually awaiting — which is exactly the live
   * planHash+planRev check: the broker only ever has ONE pending entry per
   * session (the executor awaits serially), so "still pending in the
   * broker" IS "still matches the currently-executing plan's planHash+planRev".
   */
  resolveConfirmation(sessionId: string, confirmId: string): ConfirmResolution {
    const events: Event[] = this.eventLog.list(sessionId).map((se) => se.event);
    const required = events.find(
      (e): e is Extract<Event, { t: 'confirmation.required' }> => e.t === 'confirmation.required' && e.confirmId === confirmId,
    );
    if (!required) return { outcome: 'not_found' };

    const alreadyResolved = events.some((e) => e.t === 'confirmation.resolved' && e.confirmId === confirmId);
    if (alreadyResolved) return { outcome: 'conflict' };

    const broker = this.brokerFor(sessionId);
    if (!broker.isPending(confirmId)) return { outcome: 'conflict' };

    return {
      outcome: 'ok',
      resolve: (approved: boolean) => {
        broker.resolve(confirmId, approved);
      },
    };
  }
}
