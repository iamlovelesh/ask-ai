/**
 * Per-session runtime state for Task 15's HTTP layer (LLD §6):
 *   - `HttpConfirmBroker` — the `ConfirmBroker` the executor awaits on a
 *     gated step, resolved by `POST .../confirm/:confirmId`.
 *   - `SessionRuntime` — one-turn-at-a-time enforcement, the turn-runner
 *     that drives `runTurn`/`runBaselineTurn` to completion INDEPENDENTLY
 *     of whatever SSE connection (if any) is currently attached (Task 13
 *     note: SSE only ever subscribes to `EventLog`, it never drains the
 *     generator itself — that's this module's job), cancellation (which
 *     works by denying every pending confirmation for a session — see
 *     `cancel()`'s doc comment for why that's the ONLY real interruption
 *     point this pipeline exposes), and the confirm-resolution policy
 *     (controller carry-forward: match against the pending
 *     `confirmation.required` EVENT, never `foldExecutor`'s state, which
 *     omits hash/rev on purpose).
 */

import { randomUUID } from 'node:crypto';
import type { Registry } from '../catalog/registry.js';
import type { Crm } from '../store/db.js';
import type { SessionsDb } from '../store/sessions-db.js';
import type { EventLog } from '../events/log.js';
import { createRefStore, type RefStore } from '../agent/refs.js';
import { createWorkflowEngine } from '../agent/workflow-engine.js';
import { VirtualClock } from '../store/clock.js';
import { createMemoryStore, type MemoryStore } from '../memory/store.js';
import type { ConfirmBroker, ConfirmRequest, ConfirmVerdict } from '../agent/executor.js';
import type { Playbook } from '../playbooks/loader.js';
import { runTurn, type SessionDeps } from '../agent/pipeline.js';
import { runBaselineTurn, type BaselineSessionDeps } from '../baseline/agent.js';
import { modelStreamsTools, defaultModelId } from '../llm/models.js';
import { runLoopTurn, type LoopSessionDeps } from '../loop/agent.js';
import { resolvePrincipal, type Principal } from '../agent/permissions.js';
import { openScheduledTasks, type ScheduledTaskStore } from '../agent/scheduled-tasks.js';
import type { Event } from '../events/types.js';

/** 'optimized' = the production tool-loop agent (plan rev 3 pivot);
 * 'plandsl' = the retired plan-then-execute pipeline, kept callable as the
 * benchmark comparator; 'baseline' = the full-catalog ReAct comparator. */
export type AgentKind = 'optimized' | 'baseline' | 'plandsl';

/** `sessionsDb.get('SELECT id FROM sessions WHERE id = ?', [id])` — shared
 * by every session-scoped route handler that needs a quick 404 check
 * without going through `EventLog.listSessions`' paging. */
export function sessionExists(sessionsDb: SessionsDb, sessionId: string): boolean {
  return sessionsDb.get(`SELECT id FROM sessions WHERE id = ?`, [sessionId]) !== undefined;
}

// --- confirm broker ----------------------------------------------------------

interface PendingConfirm {
  req: ConfirmRequest;
  resolve: (verdict: boolean | ConfirmVerdict) => void;
}

class HttpConfirmBroker implements ConfirmBroker {
  private readonly pending = new Map<string, PendingConfirm>();

  request(req: ConfirmRequest): Promise<boolean | ConfirmVerdict> {
    return new Promise<boolean | ConfirmVerdict>((resolve) => {
      this.pending.set(req.confirmId, { req, resolve });
    });
  }

  isPending(confirmId: string): boolean {
    return this.pending.has(confirmId);
  }

  /** Every confirmId currently awaiting a verdict (in practice at most one
   * — the executor awaits `confirm.request()` serially, one gate at a time
   * — but this doesn't assume that). Used by `SessionRuntime.cancel` to
   * deny every pending confirmation for a session. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Resolves the broker's promise for `confirmId` iff it is still
   * pending. Returns false when it was never pending (unknown, already
   * resolved, or superseded) — the caller (`SessionRuntime.resolveConfirmation`)
   * is responsible for turning that into the right HTTP status. Removing
   * the entry from `pending` BEFORE the awaiting executor's continuation
   * runs is what makes a subsequent `POST /confirm` for the same id 409
   * immediately — `resolveConfirmation` checks `isPending`, not whether
   * the `confirmation.resolved` EVENT has been appended yet (that happens
   * on a later microtask, once the executor's `await` resumes). */
  resolve(confirmId: string, approved: boolean, editedParams?: Record<string, unknown>): boolean {
    const p = this.pending.get(confirmId);
    if (!p) return false;
    this.pending.delete(confirmId);
    p.resolve(editedParams && Object.keys(editedParams).length > 0 ? { approved, editedParams } : approved);
    return true;
  }
}

// --- session runtime -----------------------------------------------------

interface RunningTurn {
  turnId: string;
  agent: AgentKind;
  /** Validated model id for this turn (user model-picker), or undefined for
   * the deployed default. */
  model?: string;
  /** Loop turns only (review I4): aborted by cancel() so the tool loop
   * stops promptly and finalizes 'cancelled' instead of looping on. */
  cancel: AbortController;
  /** Principal this turn runs as (#1); undefined = admin default. */
  principal?: Principal;
}

export interface StartTurnInput {
  sessionId: string;
  userText: string;
  agent: AgentKind;
  /** Validated (allowlisted) OpenRouter model id for this turn, or undefined
   * for the deployed default. */
  model?: string;
  /** Principal this turn runs as (#1); undefined = admin default. */
  principal?: Principal;
}

export type ConfirmResolution =
  | { outcome: 'not_found' }
  | { outcome: 'conflict' }
  | { outcome: 'ok'; resolve: (approved: boolean, editedParams?: Record<string, unknown>) => void };

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
    /** Master gate for live answer-token streaming (Live+correct). DEFAULT
     * true in production; the PER-MODEL `modelStreamsTools` check narrows it
     * so only models whose tool calls assemble correctly under stream:true
     * actually stream (OpenAI yes; Anthropic-via-OpenRouter no — tools would
     * stop executing, live repro 2026-11-07). Tests pass false to force the
     * proven non-streaming path regardless of model. */
    private readonly streamAnswers: boolean = true,
  ) {}

  private refsFor(sessionId: string): RefStore {
    let r = this.refsCache.get(sessionId);
    if (!r) {
      r = createRefStore(this.sessionsDb, sessionId);
      this.refsCache.set(sessionId, r);
    }
    return r;
  }

  /** One user-scoped MemoryStore over the shared sessions.db handle (keyed by
   * user_id at query time, so a single instance serves every session). */
  private memoryStore?: MemoryStore;
  private memoryFor(): MemoryStore {
    if (!this.memoryStore) this.memoryStore = createMemoryStore(this.sessionsDb);
    return this.memoryStore;
  }

  private brokerFor(sessionId: string): HttpConfirmBroker {
    let b = this.brokers.get(sessionId);
    if (!b) {
      b = new HttpConfirmBroker();
      this.brokers.set(sessionId, b);
    }
    return b;
  }

  /** Durable scheduled-follow-up store (#8), opened once over the sessions DB. */
  private schedulerStore?: ScheduledTaskStore;
  scheduler(): ScheduledTaskStore {
    if (!this.schedulerStore) this.schedulerStore = openScheduledTasks(this.sessionsDb);
    return this.schedulerStore;
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
    const state: RunningTurn = {
      turnId,
      agent: input.agent,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.principal !== undefined ? { principal: input.principal } : {}),
      cancel: new AbortController(),
    };
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
    // Memory (design §4): recall is on unless globally off; writes additionally
    // require not-incognito. `memoryWritable = enabled && !incognito`.
    const memoryUserId = process.env['DEMO_USER_ID'] || 'user_1';
    const memory = this.memoryFor();
    const memoryEnabled = memory.isEnabled(memoryUserId);
    const memoryWritable = memoryEnabled && !memory.isIncognito(sessionId);

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
        : state.agent === 'plandsl'
          ? runTurn({
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
            })
          : runLoopTurn({
              sessionId,
              turnId: state.turnId,
              userText,
              sessionDeps: {
                registry: this.registry,
                crm,
                refs,
                eventLog: this.eventLog,
                confirm,
                cancelSignal: state.cancel.signal,
                scheduler: this.scheduler(),
                ...(state.model !== undefined ? { model: state.model } : {}),
                ...(state.principal !== undefined ? { principal: state.principal } : {}),
                // Live answer-token streaming — only for models whose tool
                // calls assemble correctly under stream:true (OpenAI yes,
                // Anthropic-via-OpenRouter no). `streamAnswers` is the
                // master test/prod gate; the model capability narrows it.
                stream: this.streamAnswers && modelStreamsTools(state.model ?? defaultModelId()),
                // Durable user memory (design §4): recall + tools + post-turn
                // extraction. extractModel is a cheap default tier.
                memory,
                memoryEnabled,
                memoryWritable,
                extractModel: defaultModelId(),
              } satisfies LoopSessionDeps,
            });

    // NOTE on why there is no "check a cancelled flag between steps" here
    // (a prior revision had one, and it was dead code at best, actively
    // harmful at worst): `runTurn`/`runBaselineTurn` are async GENERATORS
    // that only ever `yield` from inside `finalize()` — there is no yield
    // point anywhere during retrieval/planning/execution. That means the
    // FIRST `gen.next()` call below does not resolve until the turn has
    // ALREADY run to completion (including any `await confirm.request()`
    // suspension) and started finalizing. A flag checked only between
    // `gen.next()` calls therefore never gets a chance to interrupt
    // anything meaningful — by the time it could fire, the turn's outcome
    // is already decided, and injecting a SECOND synthetic
    // `turn.completed`/`memory.snapshot` on top of the ones `finalize()` is
    // already in the middle of yielding would corrupt the event stream
    // with duplicate terminal events for the same turnId. The only point
    // this module can genuinely reach INTO a suspended turn is the
    // confirmation broker — see `cancel()` below — so this loop just drains
    // the generator to whatever its natural outcome is.
    try {
      for (;;) {
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

  /**
   * `POST /cancel` (LLD §6). The ONLY point a turn is ever genuinely
   * interruptible from outside is while `agent/executor.ts`'s `gate()` is
   * suspended in `await confirm.request(...)` — so `cancel()` denies EVERY
   * currently-pending confirmation for `sessionId` as an implicit "no":
   * the executor's gate unwinds through its normal denied-path (the
   * handler is NEVER invoked, downstream steps are skipped, the turn
   * finalizes `status:'cancelled'`), and `startTurn`'s `.finally()` clears
   * `running` once the generator drains to completion — all through the
   * EXISTING pipeline/executor machinery, no synthetic events needed.
   * `HttpConfirmBroker.resolve` removes the entry from `pending`
   * synchronously (before the executor's `await` continuation even runs),
   * so a `POST /confirm` for that SAME confirmId arriving immediately after
   * this call already sees `isPending() === false` → 409, even though the
   * `confirmation.resolved` EVENT may not be appended to the log for
   * another microtask yet.
   *
   * A turn with NO pending confirmation at the moment of cancellation
   * (still planning, mid-handler, etc.) has no safe interruption point
   * today — `execute()`/`runTurn()` accept no `AbortSignal` — so this is a
   * documented no-op for that case: the turn simply runs to its natural
   * conclusion. Returns whether a turn was running at all; the caller
   * always responds 204 either way, per LLD.
   */
  cancel(sessionId: string): boolean {
    const state = this.running.get(sessionId);
    if (!state) return false;
    // Loop turns: abort first, so the turn finalizes 'cancelled' and never
    // makes another model call or re-gates after the denial below (I4).
    state.cancel.abort();
    const broker = this.brokers.get(sessionId);
    if (broker) {
      for (const confirmId of broker.pendingIds()) {
        broker.resolve(confirmId, false);
      }
    }
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
      resolve: (approved: boolean, editedParams?: Record<string, unknown>) => {
        broker.resolve(confirmId, approved, editedParams);
      },
    };
  }

  /**
   * Auto-resume due scheduled follow-ups (#8): for each pending task whose
   * dueAt has passed, start a system-initiated turn that runs the stored
   * instruction, then mark it fired. A session with a turn already in flight
   * is skipped and retried next tick (never two concurrent turns). A task is
   * marked fired ONLY after its turn starts, so a failed start leaves it
   * pending to retry. Returns how many fired. `start` is injectable for tests.
   */
  fireDueScheduledTasks(
    nowMs: number,
    start: (task: { sessionId: string; instruction: string; principal: Principal }) => void = ({ sessionId, instruction, principal }) =>
      void this.startTurn({ sessionId, userText: instruction, agent: 'optimized', principal }),
    runWorkflow: (workflowId: string, nowMs: number) => void = (workflowId, now) => {
      // CRON firing (#flagship L3): run the workflow via the engine, pinned to
      // the fire time. Fire-and-forget — never block the poller tick.
      const engine = createWorkflowEngine({ registry: this.registry, crm: this.getCrm(), clock: new VirtualClock(now) });
      void engine.runWorkflow(workflowId, { trigger: 'cron' });
    },
  ): number {
    let fired = 0;
    for (const task of this.scheduler().due(nowMs)) {
      if (this.isRunning(task.sessionId)) continue; // retry next tick
      try {
        if (task.workflowId !== undefined) {
          // A scheduled WORKFLOW run (cron automation) — run it, not the agent.
          runWorkflow(task.workflowId, nowMs);
          this.scheduler().markFired(task.id);
          if (task.intervalMs !== undefined && task.intervalMs > 0) {
            // Recurring: schedule the next occurrence from now (avoids catch-up
            // storms if the poller was late).
            this.scheduler().schedule({
              id: `task_${randomUUID()}`,
              sessionId: task.sessionId,
              dueAt: nowMs + task.intervalMs,
              instruction: task.instruction,
              createdAt: nowMs,
              role: task.role,
              userId: task.userId,
              workflowId: task.workflowId,
              intervalMs: task.intervalMs,
            });
          }
          fired += 1;
          continue;
        }
        // Resume as the principal that SCHEDULED it (review CRITICAL) — never
        // escalate an unattended turn to admin. An unrecognized stored role
        // resolves back to a safe concrete principal.
        const principal = resolvePrincipal({ role: task.role, userId: task.userId });
        start({ sessionId: task.sessionId, instruction: task.instruction, principal });
        this.scheduler().markFired(task.id);
        fired += 1;
      } catch (err) {
        // Leave pending to retry next tick — but surface it, so a task that
        // always throws is observable instead of silently looping forever.
        console.error(`[scheduler] failed to fire task ${task.id} (session ${task.sessionId}):`, err);
      }
    }
    return fired;
  }
}
