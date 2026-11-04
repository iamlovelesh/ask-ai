/**
 * Executor (LLD §5.3) — the deterministic heart of the agent. Takes a
 * VALIDATED plan (from `validate()`) and runs it: strata scheduling from
 * `dependsOn`, server-side ref resolution, the unified confirmation gate,
 * idempotent writes, TRANSIENT retry, stuck detection, and restart-safe
 * resume via `foldExecutor`.
 *
 * Normative rules implemented verbatim from LLD §5.3 / §5.1 / §2.5:
 *   - stratum = next frontier of steps whose deps are all terminal; reads in a
 *     stratum run sequentially, writes strictly sequentially after them
 *     (node:sqlite is synchronous — there is no parallelism to exploit).
 *   - GATE iff risk ∈ {destructive, bulk, external} OR affectedCount > 50,
 *     where affectedCount = resolved target count (mutations) | fan-out size
 *     (forEach creates). forEach gates ONCE with aggregate scope.
 *   - idempotencyKey = `${turnId}:${planRev}:${stepId}:${itemIndex}`.
 *   - TRANSIENT → one retry (250ms), SAME key (per-item keys make this safe).
 *   - forEach fan-out > 500 → step REFUSED (LIMIT_EXCEEDED), never chunked.
 *   - stuck: identical (action, paramsHash, errorCode) ×3 → hint; ×4 → halt.
 *   - cross-turn refs resolve by re-checking existence; drift >25% on a step
 *     forces a (re-)confirmation; the drift note rides the confirmation scope
 *     and the step summary either way.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Plan, Step } from './plan-schema.js';
import type { Event, ConfirmationScope, RefHandle } from '../events/types.js';
import type { Registry } from '../catalog/registry.js';
import type { ActionContext, ActionDef } from '../catalog/types.js';
import { ActionError } from '../catalog/types.js';
import type { Crm, StoreTx } from '../store/db.js';
import { VirtualClock } from '../store/clock.js';
import { BUDGETS } from './validator.js';
import { parseRefGrammar } from './validator.js';
import type { RefStore, ResolveResult } from './refs.js';

// --- public contract --------------------------------------------------------

/** The confirmation request handed to the broker. Carries everything the
 * HTTP layer (Task 15) needs to match an incoming approval to a paused step
 * (`planHash`+`planRev` must match on resume — LLD §5.3). */
export interface ConfirmRequest {
  turnId: string;
  confirmId: string;
  planRev: number;
  planHash: string;
  stepId: string;
  scope: ConfirmationScope;
}

/** Resolves a confirmation to approved/denied. Task 15 wires this to HTTP
 * (`POST .../confirm/:confirmId`); tests use an auto/scripted broker. */
export interface ConfirmBroker {
  request(req: ConfirmRequest): Promise<boolean>;
}

export type StepLifecycle = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface StepRecord {
  state: StepLifecycle;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ExecutionMetrics {
  handlerCalls: number;
  retries: number;
}

export interface ExecutionResult {
  status: 'done' | 'cancelled' | 'failed' | 'halted';
  /** Present only when `status === 'halted'`. */
  halted?: 'stuck';
  stepStates: Record<string, StepRecord>;
  /** Step ids of successfully completed READ steps (core.* + risk:'read'). */
  completedReads: string[];
  metrics: ExecutionMetrics;
}

export interface ExecuteInput {
  plan: Plan;
  planHash: string;
  planRev: number;
  stepOrder: string[];
  turnId: string;
  sessionId: string;
  registry: Registry;
  crm: Crm;
  refs: RefStore;
  handles: RefHandle[];
  onEvent: (e: Event) => void;
  confirm: ConfirmBroker;
  /** TRANSIENT retry backoff (LLD §5.3: 250ms). Overridable for tests. */
  retryDelayMs?: number;
}

const DRIFT_RECONFIRM_THRESHOLD = 0.25; // LLD §2.5: drift >25% forces re-confirm
const INLINE_RESULT_CAP_BYTES = 2048; // LLD §2.3: step.finished.inlineResult ≤2KB

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isReadAction(action: ActionDef): boolean {
  return action.risk === 'read';
}

function isCoreSlug(slug: string): boolean {
  return slug.startsWith('core.');
}

// --- ref / path resolution --------------------------------------------------

interface PathToken {
  field: string;
  spread: boolean;
}

function parsePathTokens(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)(\[\*\])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    tokens.push({ field: m[1] as string, spread: m[2] !== undefined });
  }
  return tokens;
}

function field(o: unknown, f: string): unknown {
  return o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[f] : undefined;
}

/** Traverse a dotted `path` (possibly containing `[*]` pluck markers) over
 * `base`. `$s1.items[*].contact_id` → `base.items.map(r => r.contact_id)`. */
function traverse(base: unknown, path: string): unknown {
  const tokens = parsePathTokens(path);
  let cur = base;
  let spread = false;
  for (const tok of tokens) {
    if (!spread) {
      cur = field(cur, tok.field);
    } else {
      cur = Array.isArray(cur) ? cur.map((e) => field(e, tok.field)) : undefined;
    }
    if (tok.spread) spread = true;
  }
  return cur;
}

/** Mutable bookkeeping threaded through a single step's param resolution. */
interface ResolveMeta {
  maxArrayLen: number;
  drift?: { ref: string } & ResolveResult;
}

interface ResolveCtx {
  stepResults: Map<string, unknown>;
  item: unknown;
  hasItem: boolean;
  refs: RefStore;
  resolveCrossTurn: (handleId: string) => ResolveResult;
  meta: ResolveMeta;
}

/** Whole-value ref (`$s1.path` | `$r_t3_s1.path` | `$item.path`) resolution.
 * Cross-turn refs re-check existence and record drift into `meta`. */
function resolveWholeRef(ref: string, rctx: ResolveCtx): unknown {
  const parsed = parseRefGrammar(ref);
  if (!parsed) return ref;
  if (parsed.form === 'step') {
    return traverse(rctx.stepResults.get(parsed.stepId), parsed.path);
  }
  if (parsed.form === 'item') {
    return traverse(rctx.item, parsed.path);
  }
  // crossTurn — re-check existence, record drift, return survivors.
  const result = rctx.resolveCrossTurn(parsed.handleId);
  if (result.missing > 0) {
    rctx.meta.drift = { ref: parsed.handleId, ...result };
  }
  if (parsed.path === '') return result.ids;
  const handle = rctx.refs.get(parsed.handleId);
  return traverse({ ids: result.ids, items: handle?.sample ?? [] }, parsed.path);
}

const EMBEDDED_REF_RE = /\$(?:item|s\d+|r_t\d+_s\d+)(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\*\])?)*/g;

/** Interpolate `$ref` substrings inside a larger literal string (e.g. the
 * conformance plan's `"Follow up with $item.item.name"`). */
function interpolateTemplate(str: string, rctx: ResolveCtx): string {
  return str.replace(EMBEDDED_REF_RE, (m) => {
    const resolved = resolveWholeRef(m, rctx);
    return resolved === null || resolved === undefined ? '' : String(resolved);
  });
}

function resolveValue(value: unknown, rctx: ResolveCtx): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('$') && parseRefGrammar(value) !== null) {
      const resolved = resolveWholeRef(value, rctx);
      if (Array.isArray(resolved)) {
        rctx.meta.maxArrayLen = Math.max(rctx.meta.maxArrayLen, resolved.length);
      }
      return resolved;
    }
    if (value.includes('$')) return interpolateTemplate(value, rctx);
    return value;
  }
  if (Array.isArray(value)) {
    const arr = value.map((v) => resolveValue(v, rctx));
    // A literal array param counts toward affectedCount exactly like a
    // ref-resolved array (reviewer fix: a write with a literal 60-id list must
    // gate the same way a resolved 60-id list does).
    rctx.meta.maxArrayLen = Math.max(rctx.meta.maxArrayLen, arr.length);
    return arr;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, rctx);
    }
    return out;
  }
  return value;
}

function stableHash(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const o: Record<string, unknown> = {};
      for (const [k, val] of entries) o[k] = sortKeys(val);
      return o;
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex');
}

// --- display helpers --------------------------------------------------------

function displayName(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if ('name' in o && o['name'] != null) return String(o['name']);
    if ('item' in o && o['item'] != null) return displayName(o['item']);
    if ('id' in o && o['id'] != null) return String(o['id']);
  }
  return String(x);
}

function sampleNames(items: readonly unknown[], max = 5): string[] {
  return items.slice(0, max).map(displayName);
}

// --- the executor -----------------------------------------------------------

export async function execute(input: ExecuteInput): Promise<ExecutionResult> {
  const { plan, planRev, turnId, registry, crm, refs, onEvent, confirm } = input;
  const retryDelayMs = input.retryDelayMs ?? 250;
  const clock = new VirtualClock();

  const states = new Map<string, StepRecord>();
  for (const step of plan.steps) states.set(step.id, { state: 'pending' });
  const stepResults = new Map<string, unknown>();
  const stepById = new Map<string, Step>(plan.steps.map((s) => [s.id, s]));

  const completedReads: string[] = [];
  const metrics: ExecutionMetrics = { handlerCalls: 0, retries: 0 };
  const stuckCounts = new Map<string, number>();

  let denied = false;
  let halted = false;

  const terminal = (s: StepLifecycle): boolean =>
    s === 'done' || s === 'failed' || s === 'skipped' || s === 'cancelled';

  const resolveCrossTurn = (handleId: string): ResolveResult =>
    crm.tx((db: StoreTx) => refs.resolve(handleId, db));

  const makeResolveCtx = (item: unknown, hasItem: boolean): ResolveCtx => ({
    stepResults,
    item,
    hasItem,
    refs,
    resolveCrossTurn,
    meta: { maxArrayLen: 0 },
  });

  const buildCtx = (idempotencyKey: string, db: StoreTx): ActionContext => ({
    db,
    clock,
    idempotencyKey,
    format: 'concise',
  });

  /** A StoreTx that throws if touched — handed to core.* ops, which run
   * in-process and must never hit the database (LLD §5.3). */
  const noDbTx: StoreTx = {
    all: () => {
      throw new Error('core op attempted a database read');
    },
    get: () => {
      throw new Error('core op attempted a database read');
    },
    run: () => {
      throw new Error('core op attempted a database write');
    },
  };

  interface InvokeResult {
    ok: boolean;
    output?: unknown;
    error?: { code: string; message: string };
  }

  const invoke = async (
    action: ActionDef,
    inputParams: unknown,
    key: string,
    isCore: boolean,
  ): Promise<InvokeResult> => {
    let lastError: { code: string; message: string } = { code: 'TRANSIENT', message: 'unknown' };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        metrics.handlerCalls += 1;
        const output = isCore
          ? await action.handler(inputParams, buildCtx(key, noDbTx))
          : await crm.tx((db) => action.handler(inputParams, buildCtx(key, db)));
        return { ok: true, output };
      } catch (err) {
        lastError =
          err instanceof ActionError
            ? { code: err.code, message: err.message }
            : { code: 'VALIDATION', message: err instanceof Error ? err.message : String(err) };
        if (lastError.code === 'TRANSIENT' && attempt === 1) {
          metrics.retries += 1;
          await sleep(retryDelayMs);
          continue;
        }
        break;
      }
    }
    return { ok: false, error: lastError };
  };

  /** Records a (action, paramsHash, errorCode) failure. Returns a hint when
   * the identical failure has now happened 3×, and sets `halted` on the 4th. */
  const recordStuck = (
    action: string,
    paramsHash: string,
    code: string,
  ): { hint?: string } => {
    const key = `${action}|${code}|${paramsHash}`;
    const count = (stuckCounts.get(key) ?? 0) + 1;
    stuckCounts.set(key, count);
    if (count >= 4) {
      halted = true;
      return {};
    }
    if (count === 3) {
      return {
        hint: 'this action has failed 3× with identical input and error — a different approach or parameters are needed',
      };
    }
    return {};
  };

  const emitFailed = (stepId: string, error: { code: string; message: string }, ms: number): void => {
    states.set(stepId, { state: 'failed', error });
    onEvent({ t: 'step.failed', turnId, stepId, error, ms });
  };

  /** Fire the confirmation gate for a write step; returns the broker verdict. */
  const gate = async (
    step: Step,
    affectedCount: number,
    targetSample: string[],
    drift: ResolveMeta['drift'],
  ): Promise<boolean> => {
    const confirmId = `cf_${randomUUID()}`;
    const driftNote =
      drift && drift.missing > 0
        ? ` ${drift.total - drift.missing} of ${drift.total} still match (${drift.missing} no longer exist)`
        : '';
    const description = `${step.action} affecting ${affectedCount} record(s).${driftNote}`;
    const scope: ConfirmationScope = {
      actions: [step.action],
      affectedCount,
      targetSample: targetSample.slice(0, 5),
      description,
    };
    onEvent({
      t: 'confirmation.required',
      turnId,
      confirmId,
      planRev,
      planHash: input.planHash,
      stepId: step.id,
      scope,
    });
    const approved = await confirm.request({
      turnId,
      confirmId,
      planRev,
      planHash: input.planHash,
      stepId: step.id,
      scope,
    });
    onEvent({ t: 'confirmation.resolved', turnId, confirmId, approved });
    return approved;
  };

  const shouldGate = (risk: ActionDef['risk'], affectedCount: number, drift: ResolveMeta['drift']): boolean => {
    if (risk === 'destructive' || risk === 'bulk' || risk === 'external') return true;
    if (affectedCount > BUDGETS.confirmTargetThreshold) return true;
    if (drift && drift.total > 0 && drift.missing / drift.total > DRIFT_RECONFIRM_THRESHOLD) return true;
    return false;
  };

  /** Build the human one-liner for step.finished (names + counts). */
  const summarize = (
    step: Step,
    action: ActionDef,
    count: number,
    drift: ResolveMeta['drift'],
    spillRef?: string,
  ): string => {
    const noun = action.entities[0] ?? 'record';
    const driftNote =
      drift && drift.missing > 0 ? ` (${drift.total - drift.missing} of ${drift.total} still match)` : '';
    const refNote = spillRef ? ` [ref ${spillRef}]` : '';
    return `${step.action}: ${count} ${noun}${driftNote}${refNote}`;
  };

  const evalCondition = (op: NonNullable<Step['when']>['op'], val: unknown, cmp: unknown): boolean => {
    switch (op) {
      case 'nonempty':
        return Array.isArray(val) ? val.length > 0 : val != null;
      case 'empty':
        return Array.isArray(val) ? val.length === 0 : val == null;
      case 'eq':
        return val === cmp;
      case 'gt':
        return typeof val === 'number' && typeof cmp === 'number' && val > cmp;
      case 'lt':
        return typeof val === 'number' && typeof cmp === 'number' && val < cmp;
      default:
        return true;
    }
  };

  /** True when `step.when.ref` is a `$item.*` ref — such a condition can only
   * be evaluated PER ITEM inside a forEach fan-out, never once-per-step. */
  const whenUsesItem = (step: Step): boolean =>
    step.when !== undefined && parseRefGrammar(step.when.ref)?.form === 'item';

  /** Once-per-step `when` (no `$item`). Returns true when there is no `when`. */
  const evalWhen = (step: Step): boolean => {
    if (!step.when) return true;
    const rctx = makeResolveCtx(undefined, false);
    return evalCondition(step.when.op, resolveWholeRef(step.when.ref, rctx), step.when.value);
  };

  /** Per-item `when` for a `$item.*` condition under forEach. */
  const evalWhenForItem = (when: NonNullable<Step['when']>, item: unknown): boolean => {
    const rctx = makeResolveCtx(item, true);
    return evalCondition(when.op, resolveWholeRef(when.ref, rctx), when.value);
  };

  /** Convert a `__spill` handler output into a RefHandle, returning the
   * downstream step result shape (`{ref,total,sample,items}`) + the ref id. */
  const spillToRef = (
    step: Step,
    action: ActionDef,
    spill: { __spill: true; total: number; sample: unknown[] },
  ): { result: unknown; ref: string } => {
    const handle = refs.put({
      action: step.action,
      turnId,
      stepId: step.id,
      entityType: action.entities[0] ?? action.module,
      total: spill.total,
      idList: spill.sample.map((row) => String(field(row, 'id'))).filter((id) => id !== 'undefined'),
      sample: spill.sample,
    });
    // Downstream intra-plan refs over a spilled read can only see the sample
    // (the full set lives behind the handle) — documented limitation.
    return {
      result: { ref: handle.ref, total: spill.total, sample: spill.sample, items: spill.sample },
      ref: handle.ref,
    };
  };

  function isSpill(x: unknown): x is { __spill: true; total: number; sample: unknown[] } {
    return (
      x !== null &&
      typeof x === 'object' &&
      (x as { __spill?: unknown }).__spill === true &&
      Array.isArray((x as { sample?: unknown }).sample)
    );
  }

  /** Run a single step through its full lifecycle. */
  const runStep = async (step: Step): Promise<void> => {
    const action = registry.get(step.action);
    const started = clock.now();
    if (!action) {
      emitFailed(step.id, { code: 'VALIDATION', message: `unknown action '${step.action}'` }, 0);
      return;
    }
    const isCore = isCoreSlug(step.action);
    const isWrite = !isReadAction(action);

    states.set(step.id, { state: 'running' });

    // `when` guard — false → skip (dependents will skip transitively).
    // A `$item.*` condition under forEach is deferred to per-item filtering
    // inside `runForEachStep` (it cannot be evaluated once-per-step).
    if (!whenUsesItem(step) && !evalWhen(step)) {
      states.set(step.id, { state: 'skipped' });
      return;
    }

    if (step.forEach !== undefined) {
      await runForEachStep(step, action, isWrite, started);
      return;
    }

    // --- scalar (non-forEach) step ---
    const rctx = makeResolveCtx(undefined, false);
    const params = resolveValue(step.params, rctx) as Record<string, unknown>;
    const drift = rctx.meta.drift;
    const affectedCount = isWrite ? Math.max(rctx.meta.maxArrayLen, 1) : rctx.meta.maxArrayLen;

    if (isWrite && shouldGate(action.risk, affectedCount, drift)) {
      const targets = collectTargetSample(params);
      const approved = await gate(step, affectedCount, targets, drift);
      if (!approved) {
        denied = true;
        states.set(step.id, { state: 'cancelled' });
        return;
      }
    }

    onEvent({ t: 'step.started', turnId, stepId: step.id, action: step.action });
    const key = `${turnId}:${planRev}:${step.id}:0`;
    const res = await invoke(action, params, key, isCore);
    const ms = clock.now() - started;

    if (!res.ok) {
      const err = res.error as { code: string; message: string };
      const { hint } = recordStuck(step.action, stableHash(params), err.code);
      const finalErr = hint ? { code: err.code, message: `${err.message} [${hint}]` } : err;
      emitFailed(step.id, finalErr, ms);
      return;
    }

    let result = res.output;
    let spillRef: string | undefined;
    let count = countRows(result);
    if (isSpill(result)) {
      const spilled = spillToRef(step, action, result);
      result = spilled.result;
      spillRef = spilled.ref;
      count = (result as { total: number }).total;
    }
    stepResults.set(step.id, result);
    states.set(step.id, { state: 'done', result });
    if (!isWrite) completedReads.push(step.id);

    const summary = summarize(step, action, isWrite ? affectedCount : count, drift, spillRef);
    emitFinished(step.id, summary, result, spillRef, ms, undefined);
  };

  const runForEachStep = async (
    step: Step,
    action: ActionDef,
    isWrite: boolean,
    started: number,
  ): Promise<void> => {
    const feCtx = makeResolveCtx(undefined, false);
    const forEachResolved = resolveWholeRef(step.forEach as string, feCtx);
    const resolvedItems = Array.isArray(forEachResolved) ? forEachResolved : [];
    // Per-item `when` (`$item.*`) filters the fan-out BEFORE the cap/gate/loop,
    // so only qualifying items are counted and invoke the handler.
    const items =
      step.when !== undefined && whenUsesItem(step)
        ? resolvedItems.filter((it) => evalWhenForItem(step.when as NonNullable<Step['when']>, it))
        : resolvedItems;
    const drift = feCtx.meta.drift;
    const fanOut = items.length;

    // forEach hard cap — REFUSE before gating or any handler call (LLD §5.1).
    if (fanOut > BUDGETS.forEachHardCap) {
      const err = {
        code: 'LIMIT_EXCEEDED',
        message: `forEach fan-out of ${fanOut} exceeds the hard cap of ${BUDGETS.forEachHardCap} — narrow the selection or use a bulk action.`,
      };
      recordStuck(step.action, stableHash({ forEach: fanOut }), err.code);
      emitFailed(step.id, err, clock.now() - started);
      return;
    }

    // Gate ONCE with aggregate scope (affectedCount = fan-out size).
    if (isWrite && shouldGate(action.risk, fanOut, drift)) {
      const approved = await gate(step, fanOut, sampleNames(items), drift);
      if (!approved) {
        denied = true;
        states.set(step.id, { state: 'cancelled' });
        return;
      }
    }

    onEvent({ t: 'step.started', turnId, stepId: step.id, action: step.action, itemCount: fanOut });

    const isCore = isCoreSlug(step.action);
    const perItemResults: unknown[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const rctx = makeResolveCtx(items[i], true);
      const params = resolveValue(step.params, rctx) as Record<string, unknown>;
      const key = `${turnId}:${planRev}:${step.id}:${i}`;
      const res = await invoke(action, params, key, isCore);
      if (!res.ok) {
        const err = res.error as { code: string; message: string };
        const { hint } = recordStuck(step.action, stableHash(params), err.code);
        const finalErr = hint ? { code: err.code, message: `${err.message} [${hint}]` } : err;
        emitFailed(step.id, finalErr, clock.now() - started);
        return;
      }
      perItemResults.push(res.output);
    }

    const result = { items: perItemResults, total: perItemResults.length };
    stepResults.set(step.id, result);
    states.set(step.id, { state: 'done', result });

    const summary = summarize(step, action, fanOut, drift, undefined);
    emitFinished(step.id, summary, result, undefined, clock.now() - started, fanOut);
  };

  const emitFinished = (
    stepId: string,
    summary: string,
    result: unknown,
    spillRef: string | undefined,
    ms: number,
    _itemCount: number | undefined,
  ): void => {
    const ev: Extract<Event, { t: 'step.finished' }> = { t: 'step.finished', turnId, stepId, summary, ms };
    if (spillRef !== undefined) {
      ev.resultRef = spillRef;
    } else {
      const serialized = JSON.stringify(result ?? null);
      if (serialized.length <= INLINE_RESULT_CAP_BYTES) {
        ev.inlineResult = result;
      }
    }
    onEvent(ev);
  };

  // --- scheduling loop ------------------------------------------------------

  for (;;) {
    if (halted) break;

    const frontier = plan.steps.filter((step) => {
      const rec = states.get(step.id);
      if (!rec || rec.state !== 'pending') return false;
      return step.dependsOn.every((dep) => {
        const dr = states.get(dep);
        return dr !== undefined && terminal(dr.state);
      });
    });
    if (frontier.length === 0) break;

    // Steps whose any dependency ended non-successfully → skip.
    const runnable: Step[] = [];
    let progressed = false;
    for (const step of frontier) {
      const blocked = step.dependsOn.some((dep) => {
        const dr = states.get(dep);
        return dr !== undefined && (dr.state === 'failed' || dr.state === 'skipped' || dr.state === 'cancelled');
      });
      if (blocked) {
        states.set(step.id, { state: 'skipped' });
        progressed = true;
      } else {
        runnable.push(step);
      }
    }
    if (runnable.length === 0) {
      if (!progressed) break;
      continue;
    }

    // reads first (sequential), then writes (strictly sequential).
    const reads = runnable.filter((s) => {
      const a = input.registry.get(s.action);
      return a !== undefined && isReadAction(a);
    });
    const writes = runnable.filter((s) => {
      const a = input.registry.get(s.action);
      return a === undefined || !isReadAction(a);
    });

    for (const step of reads) {
      await runStep(step);
      if (halted) break;
    }
    if (halted) break;
    for (const step of writes) {
      await runStep(step);
      if (halted) break;
    }
  }

  // --- final status ---------------------------------------------------------

  const stepStates: Record<string, StepRecord> = {};
  for (const [id, rec] of states) stepStates[id] = rec;

  let status: ExecutionResult['status'];
  if (halted) {
    status = 'halted';
  } else if (denied) {
    status = 'cancelled';
  } else if ([...states.values()].some((r) => r.state === 'failed')) {
    status = 'failed';
  } else {
    status = 'done';
  }

  const result: ExecutionResult = { status, stepStates, completedReads, metrics };
  if (status === 'halted') result.halted = 'stuck';
  return result;
}

// --- small shared helpers ---------------------------------------------------

function countRows(result: unknown): number {
  if (result !== null && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o['total'] === 'number') return o['total'];
    if (Array.isArray(o['items'])) return o['items'].length;
  }
  return 1;
}

/** Best-effort target names for a confirmation scope, pulled from any
 * array-shaped resolved param (ids or row objects). */
function collectTargetSample(params: Record<string, unknown>): string[] {
  for (const v of Object.values(params)) {
    if (Array.isArray(v) && v.length > 0) return sampleNames(v);
  }
  return [];
}

// --- resume fold (LLD §5.3) -------------------------------------------------

export interface ExecutorState {
  plan?: Plan;
  planRev: number;
  /** stepId → the step's recorded result (inlineResult, or `{resultRef}`). */
  completed: Record<string, unknown>;
  /** The step currently awaiting confirmation on resume, if any. */
  pendingConfirmation?: { confirmId: string; stepId: string };
  /** Next steps runnable once the pending confirmation (if any) is resolved:
   * every not-yet-completed step whose deps are all completed. */
  frontier: string[];
}

/**
 * Reconstruct executor state from a turn's event list (LLD §5.3
 * restart-safe resume): the validated plan from `plan.ready`, the highest
 * planRev seen, completed step results from `step.finished`, and the pending
 * gate from the last unresolved `confirmation.required`. A turn with a pending
 * confirmation is resumable; without one the caller marks it failed.
 */
export function foldExecutor(events: readonly Event[]): ExecutorState {
  let plan: Plan | undefined;
  let planRev = 0;
  const completed: Record<string, unknown> = {};
  const required: { confirmId: string; stepId: string }[] = [];
  const resolved = new Set<string>();

  for (const ev of events) {
    switch (ev.t) {
      case 'plan.ready':
        if (ev.outcome.kind === 'plan') plan = ev.outcome.plan;
        planRev = Math.max(planRev, ev.planRev);
        break;
      case 'step.finished':
        completed[ev.stepId] =
          ev.inlineResult !== undefined
            ? ev.inlineResult
            : ev.resultRef !== undefined
              ? { resultRef: ev.resultRef }
              : null;
        break;
      case 'confirmation.required':
        required.push({ confirmId: ev.confirmId, stepId: ev.stepId });
        break;
      case 'confirmation.resolved':
        resolved.add(ev.confirmId);
        break;
      default:
        break;
    }
  }

  let pending: { confirmId: string; stepId: string } | undefined;
  for (let i = required.length - 1; i >= 0; i -= 1) {
    const r = required[i] as { confirmId: string; stepId: string };
    if (!resolved.has(r.confirmId)) {
      pending = r;
      break;
    }
  }

  const frontier = plan
    ? plan.steps
        .filter(
          (s) => completed[s.id] === undefined && s.dependsOn.every((d) => completed[d] !== undefined),
        )
        .map((s) => s.id)
    : [];

  const state: ExecutorState = { planRev, completed, frontier };
  if (plan !== undefined) state.plan = plan;
  if (pending !== undefined) state.pendingConfirmation = pending;
  return state;
}
