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
import { parseRefGrammar, coerceDateParams } from './validator.js';
import type { RefStore, ResolveResult } from './refs.js';
import type { Spans, SpanHandle } from '../events/trace.js';

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
  /** Engine-wave E7: total wall-clock ms spent awaiting confirmation
   * decisions — excluded from the turn deadline. */
  gateWaitMs: number;
}

export interface ExecutionResult {
  status: 'done' | 'cancelled' | 'failed' | 'halted' | 'clarify';
  /** Present only when `status === 'halted'`. */
  halted?: 'stuck';
  /** Present only when `status === 'clarify'` (an `onWriteStratum` joiner
   * decision asked a question mid-execution — LLD §5.4). */
  clarifyQuestion?: string;
  /** Present only when `status === 'failed'` via an `onWriteStratum`
   * `'abort'` decision — the human-readable reason to surface honestly
   * (LLD §5.4 "then honest partial report"). */
  abortReason?: string;
  stepStates: Record<string, StepRecord>;
  /** Step ids of successfully completed READ steps (core.* + risk:'read'). */
  completedReads: string[];
  metrics: ExecutionMetrics;
}

/** Joiner checkpoint input (LLD §5.4) — handed to `onWriteStratum` once per
 * write-bearing stratum, before its writes run. `plan` is the CURRENT
 * (possibly already-patched) plan; `completed` carries every step result
 * recorded so far (reads AND writes from earlier strata); `upcoming` is
 * this stratum's write steps (the ones `checkStratum`'s forEach-emptiness
 * check reasons about). */
export interface WriteStratumCtx {
  plan: Plan;
  completed: Record<string, { result: unknown }>;
  upcoming: readonly Step[];
}

/** The joiner's verdict on a checkpoint (LLD §5.4's `patch | proceed |
 * clarify | abort`), translated into what the executor needs to act on.
 * `'patch'` carries the NEW planRev the caller already bumped (idempotency
 * keys for steps run after the patch use it) — this module never decides
 * planRev itself, it only adopts the value it's given. */
export type WriteStratumDecision =
  | { decision: 'proceed' }
  | { decision: 'patch'; patchedSteps: Step[]; planRev: number }
  | { decision: 'clarify'; question: string }
  | { decision: 'abort'; reason: string };

/** Context for `onStepFailure` (LLD §5.4 extension / TRIAGE C1 residual): a
 * step that failed at runtime with a NOT_FOUND on an id-typed param, whose
 * downstream dependents would otherwise be skipped. The hook may route the
 * fabricated/unresolved id to a resolve step via one replan round. `plan` is
 * the CURRENT plan; `completed` carries every result recorded so far. */
export interface StepFailureCtx {
  plan: Plan;
  completed: Record<string, { result: unknown }>;
  failedStep: Step;
  error: { code: string; message: string };
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
  /** LLD §2.4 kind:'step' spans, one per dispatched step (scalar or
   * forEach). Optional — and deliberately threaded in from the caller
   * (`agent/pipeline.ts`) rather than opened here: this module stays
   * LLM/DB-handle-free by design (see the `onWriteStratum` doc comment
   * above for the same rationale). Omitted entirely (every pre-Task-19
   * test), this is a no-op — byte-identical to the pre-Task-19 executor. */
  spans?: Spans;
  /** TRANSIENT retry backoff (LLD §5.3: 250ms). Overridable for tests. */
  retryDelayMs?: number;
  /** Engine-wave E7: reports ms spent awaiting a confirmation decision, so
   * the caller (`pipeline.ts`) can exclude it from the turn deadline for its
   * OWN in-execution LLM calls (joiner replans). Optional — omitted is a
   * no-op; the executor's own deadline check already excludes gate wait. */
  onGateWait?: (ms: number) => void;
  /** LLD §5.4 joiner checkpoint hook — called once per write-bearing
   * stratum, before its writes run. Optional: omitted entirely (as every
   * Task 11 test does), this is a no-op pass-through — behavior is
   * byte-identical to the pre-Task-13 executor. The real implementation
   * (`checkStratum` + `joinerRepair`, both LLM/budget-aware) lives in
   * `agent/pipeline.ts` — this module stays LLM-free. */
  onWriteStratum?: (ctx: WriteStratumCtx) => Promise<WriteStratumDecision>;
  /** TRIAGE C1 residual — fabricated-id routing at the REPAIR boundary. Fired
   * at most ONCE per turn, when a step fails at runtime with NOT_FOUND and has
   * downstream dependents: a shape-valid fabricated id (`calendar_6`) passes
   * validation and only fails here, so this routes it to a resolve step via
   * one replan round (reusing the same `WriteStratumDecision` contract as
   * `onWriteStratum`). Optional: omitted → no-op pass-through (behavior
   * byte-identical). The LLM/budget machinery lives in the caller
   * (`agent/pipeline.ts`), same as `onWriteStratum`. */
  onStepFailure?: (ctx: StepFailureCtx) => Promise<WriteStratumDecision>;
  /** LLD §5.1/§5.3 `turnTimeoutMs` — real wall-clock (`performance.now()`)
   * deadline, checked BETWEEN strata (never mid-handler: a slow handler
   * call itself always runs to completion, the NEXT stratum just never
   * starts). Optional: omitted entirely (as every Task 11 test does), the
   * loop runs exactly as before — no timeout is ever enforced. On breach:
   * every still-`'pending'` step is marked `'skipped'`, no further steps
   * run, and the turn ends `status:'failed'` with an explicit timeout
   * `abortReason`. */
  deadlineAtMs?: number;
}

const DRIFT_RECONFIRM_THRESHOLD = 0.25; // LLD §2.5: drift >25% forces re-confirm
const INLINE_RESULT_CAP_BYTES = 2048; // LLD §2.3: step.finished.inlineResult ≤2KB

/** Drift info for a gate decision (LLD §2.5) — structurally identical to
 * `ResolveMeta['drift']` (`{ref} & ResolveResult`); named independently here
 * so `shouldGate` has no dependency on this file's internal `ResolveMeta`
 * type (Task 14's baseline agent imports `shouldGate` directly and never
 * builds a drift value — it has no cross-turn refs to drift-check). */
export interface GateDrift {
  ref: string;
  ids: string[];
  missing: number;
  total: number;
}

/** The unified confirmation-gate rule (LLD §5.3): fire iff `risk` is
 * inherently wide (destructive/bulk/external) OR the resolved target count
 * exceeds `BUDGETS.confirmTargetThreshold`, OR cross-turn ref drift on this
 * step exceeds `DRIFT_RECONFIRM_THRESHOLD`. Extracted to module scope (no
 * closure over `execute()`'s locals) so Task 14's baseline agent can import
 * and reuse the EXACT SAME predicate rather than re-implementing it. */
export function shouldGate(risk: ActionDef['risk'], affectedCount: number, drift?: GateDrift): boolean {
  if (risk === 'destructive' || risk === 'bulk' || risk === 'external') return true;
  // Engine-wave E6 (RC5): a write applied to more than a few records (forEach
  // fan-out or a bulk array param) confirms — even a plain risk:'write'
  // action under the 50-row bulk threshold. Reads (risk:'read') never gate.
  if (risk === 'write' && affectedCount > BUDGETS.gateBulkWriteThreshold) return true;
  if (affectedCount > BUDGETS.confirmTargetThreshold) return true;
  if (drift && drift.total > 0 && drift.missing / drift.total > DRIFT_RECONFIRM_THRESHOLD) return true;
  return false;
}

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
  /** Engine-wave E5: a non-negative element index (`items[0]`). Mutually
   * exclusive with `spread` — a segment is either `[*]` (pluck all) or
   * `[K]` (select element K), never both. */
  index?: number;
}

function parsePathTokens(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)(\[\*\]|\[\d+\])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    const suffix = m[2];
    const tok: PathToken = { field: m[1] as string, spread: suffix === '[*]' };
    if (suffix !== undefined && suffix !== '[*]') tok.index = Number(suffix.slice(1, -1));
    tokens.push(tok);
  }
  return tokens;
}

function field(o: unknown, f: string): unknown {
  return o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[f] : undefined;
}

/** Traverse a dotted `path` (possibly containing `[*]` pluck markers or
 * `[K]` element indexes) over `base`. `$s1.items[*].contact_id` →
 * `base.items.map(r => r.contact_id)`; `$s1.items[0].id` → `base.items[0].id`
 * (engine-wave E5). An out-of-range `[K]` resolves to `undefined` (a clean
 * RUNTIME ref-resolution failure, per E5 — never a silent wrong element). */
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
    if (tok.index !== undefined) {
      // Select a single element — collapses a spread back to a scalar.
      cur = Array.isArray(cur) ? cur[tok.index] : undefined;
      spread = false;
    } else if (tok.spread) {
      spread = true;
    }
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
  /** Engine-wave E1: re-select the FULL set of live rows behind a spilled
   * ref (via `crm.tx(db => refs.hydrate(ref, db))`). */
  hydrateRef: (ref: string) => import('./refs.js').HydrateResult;
  /** Engine-wave E1: when true, a bulk/full-list access of a spilled result
   * hydrates the full set (or fails TRUNCATED_INPUT) rather than silently
   * using the 20-row sample. False for `when`-condition/display resolution,
   * where emptiness/counts don't need the full rows. */
  hydrateSpills: boolean;
  meta: ResolveMeta;
}

/** Hydrate a spilled base to its FULL row set for a bulk/full-list access
 * (engine-wave E1). Returns the base unchanged when hydration isn't needed;
 * throws `TruncatedInputError` when the full set can't be recovered. */
function hydrateSpilled(base: unknown, path: string, rctx: ResolveCtx): unknown {
  if (!rctx.hydrateSpills) return base;
  const info = spilledInfo(base);
  if (info === undefined) return base;
  if (!accessExceedsSample(path, info.present)) return base;
  const hy = rctx.hydrateRef(info.ref);
  if (!hy.complete) {
    throw new TruncatedInputError(
      `This step needs the full set of ${info.total} record(s) behind ${info.ref}, but only a ${info.present}-row sample is available (the search result was truncated and its full set can't be recovered here). Narrow the search (add filters) so the result fits inline, then retry.`,
    );
  }
  return { ...(base as Record<string, unknown>), items: hy.rows, sample: hy.rows };
}

/** Whole-value ref (`$s1.path` | `$r_t3_s1.path` | `$item.path`) resolution.
 * Cross-turn refs re-check existence and record drift into `meta`. */
function resolveWholeRef(ref: string, rctx: ResolveCtx): unknown {
  const parsed = parseRefGrammar(ref);
  if (!parsed) return ref;
  if (parsed.form === 'step') {
    const base = hydrateSpilled(rctx.stepResults.get(parsed.stepId), parsed.path, rctx);
    return traverse(base, parsed.path);
  }
  if (parsed.form === 'item') {
    return traverse(rctx.item, parsed.path);
  }
  // crossTurn — re-check existence, record drift, return survivors.
  const result = rctx.resolveCrossTurn(parsed.handleId);
  if (result.missing > 0) {
    rctx.meta.drift = { ref: parsed.handleId, ...result };
  }
  const handle = rctx.refs.get(parsed.handleId);
  if (parsed.path === '') {
    // Bare whole-handle ref (e.g. a forEach over `$r_t2_s1`): a bulk consumer
    // over a truncated handle must fail honestly, not fan out over survivors
    // of a 20-id sample (engine-wave E1).
    if (rctx.hydrateSpills && handle !== undefined && handle.idList.length < handle.total) {
      throw new TruncatedInputError(
        `This step needs the full set of ${handle.total} record(s) behind ${parsed.handleId}, but only a ${handle.idList.length}-id sample was stored (the prior result was truncated). Narrow the search so the result fits inline, then retry.`,
      );
    }
    return result.ids;
  }
  const base = hydrateSpilled(
    { ref: parsed.handleId, total: handle?.total ?? result.ids.length, items: handle?.sample ?? [], ids: result.ids },
    parsed.path,
    rctx,
  );
  return traverse(base, parsed.path);
}

/** Thrown when a whole-value param ref parses as a legal ref but resolves to
 * `undefined` at run time (e.g. `$s1.id` where `s1`'s result is a LIST, so
 * `.id` does not exist on it). Surfaced by `runStep`/`runForEachStep` as a
 * step-level `REF_RESOLUTION` failure (repairable context, dependents
 * skipped) — the fix for the "unresolved ref string leaks into the handler"
 * defect (TRIAGE multistep-enrollments-001): an invalid ref must fail the
 * step LOUDLY, never silently pass a literal/undefined into the action. */
export class RefResolutionError extends Error {
  readonly code = 'REF_RESOLUTION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RefResolutionError';
  }
}

/** Engine-wave E1 (RC4): thrown when a bulk consumer (core op / forEach / an
 * out-of-sample index ref) tries to operate on a result that SPILLED
 * (`{__spill}` → a 20-row sample) and whose full matching set cannot be
 * hydrated from the stored ref (the producer never enumerated the complete id
 * set). Operating on the 20-row page would silently touch 20 of N records —
 * the exact silent-truncation defect this guards. Surfaced as a step-level
 * `TRUNCATED_INPUT` failure (repairable context, dependents skipped, NO
 * partial execution — it fires during param resolution, before any write). */
export class TruncatedInputError extends Error {
  readonly code = 'TRUNCATED_INPUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TruncatedInputError';
  }
}

/** Human-readable (repair-usable) description of WHY a whole-value ref did
 * not resolve: the ref itself plus the fields actually available on its
 * base, and the usual fix (pluck a field off a list with `items[*].<field>`
 * rather than indexing a scalar field off the whole list). */
function describeUnresolvedRef(ref: string, rctx: ResolveCtx): string {
  const parsed = parseRefGrammar(ref);
  let base: unknown;
  let label = 'the referenced result';
  if (parsed?.form === 'step') {
    base = rctx.stepResults.get(parsed.stepId);
    label = `step ${parsed.stepId}'s result`;
  } else if (parsed?.form === 'item') {
    base = rctx.item;
    label = 'the current $item';
  }
  let hint: string;
  if (Array.isArray(base)) {
    hint = `${label} is an array of ${base.length} item(s) — a scalar field cannot be read off a list directly; pluck it with 'items[*].<field>' instead`;
  } else if (base !== null && typeof base === 'object') {
    const keys = Object.keys(base as Record<string, unknown>);
    hint = `available fields on ${label}: ${keys.length > 0 ? keys.join(', ') : '(none)'}`;
  } else {
    hint = `${label} is ${base === undefined ? 'absent' : JSON.stringify(base)}`;
  }
  return `Ref '${ref}' did not resolve (${hint}). A search/list result exposes rows under '.items[*]' — reference a per-row field as '…items[*].<field>', and never type in or infer a literal id.`;
}

const EMBEDDED_REF_RE = /\$(?:item|s\d+|r_t\d+_s\d+)(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\*\]|\[\d+\])?)*/g;

/** A spilled step/handle result as the executor stores it downstream
 * (`spillToRef`'s `{ref,total,sample,items}`) — truncated when `total`
 * exceeds the rows actually present. Engine-wave E1. */
function spilledInfo(base: unknown): { ref: string; total: number; present: number } | undefined {
  if (base === null || typeof base !== 'object') return undefined;
  const o = base as Record<string, unknown>;
  if (typeof o['ref'] !== 'string' || typeof o['total'] !== 'number') return undefined;
  const rows = Array.isArray(o['items']) ? (o['items'] as unknown[]) : Array.isArray(o['sample']) ? (o['sample'] as unknown[]) : undefined;
  if (rows === undefined) return undefined;
  if (o['total'] <= rows.length) return undefined; // not truncated — full set already inline
  return { ref: o['ref'] as string, total: o['total'] as number, present: rows.length };
}

/** Does traversing `path` over the row list of a spilled result need MORE
 * rows than the `present` sample holds? True for a whole-list read
 * (`.items`), a pluck (`.items[*]`), or an index `[K]` with `K >= present`.
 * False for `.total`/`.ref` or an in-sample index (`.items[0]`). */
function accessExceedsSample(path: string, present: number): boolean {
  const tokens = parsePathTokens(path);
  const first = tokens[0];
  if (first === undefined) return false; // bare whole-object ref — handled separately
  if (first.field !== 'items' && first.field !== 'sample') return false;
  if (first.index !== undefined) return first.index >= present;
  return true; // whole-list or `[*]` pluck over the row list
}

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
      // A legal ref that resolves to `undefined` is a HARD step failure, not
      // a literal to pass through: `$s1.id` on a list result, a typo'd path,
      // etc. (TRIAGE multistep-enrollments-001). Fail loudly with a
      // repairable hint rather than silently feeding undefined/the template
      // string into the handler.
      if (resolved === undefined) {
        throw new RefResolutionError(describeUnresolvedRef(value, rctx));
      }
      if (Array.isArray(resolved)) {
        // A pluck (`items[*].field`) over opaque rows that yields an
        // ALL-undefined, non-empty array means the field is absent on every
        // row — it would otherwise feed `[undefined, undefined, …]` silently
        // into a write handler. Fail loudly. A MIXED array (some defined) is
        // deliberately allowed through — ambiguous, so we stay defensive.
        if (resolved.length > 0 && resolved.every((e) => e === undefined)) {
          throw new RefResolutionError(
            `Ref '${value}' plucked a field that is absent on all ${resolved.length} row(s) of the result — the field does not exist on these rows. Check the field name against the producing action's row shape.`,
          );
        }
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
  const { turnId, registry, crm, refs, onEvent, confirm, spans } = input;
  // Mutable: a `'patch'` joiner decision (LLD §5.4) replaces the remaining
  // step array and bumps planRev — every other reference in this function
  // reads these two via closure, so reassigning here is all a patch needs.
  let plan = input.plan;
  let planRev = input.planRev;
  const retryDelayMs = input.retryDelayMs ?? 250;
  const clock = new VirtualClock();

  const states = new Map<string, StepRecord>();
  for (const step of plan.steps) states.set(step.id, { state: 'pending' });
  const stepResults = new Map<string, unknown>();
  const stepById = new Map<string, Step>(plan.steps.map((s) => [s.id, s]));

  const completedReads: string[] = [];
  const metrics: ExecutionMetrics = { handlerCalls: 0, retries: 0, gateWaitMs: 0 };
  const stuckCounts = new Map<string, number>();

  let denied = false;
  let halted = false;
  let clarifyQuestion: string | undefined;
  let aborted = false;
  let abortReason: string | undefined;
  let timedOut = false;
  // TRIAGE C1 residual: a NOT_FOUND replan fires at most once per turn.
  let notFoundReplanUsed = false;
  const notFoundConsidered = new Set<string>();

  const terminal = (s: StepLifecycle): boolean =>
    s === 'done' || s === 'failed' || s === 'skipped' || s === 'cancelled';

  const resolveCrossTurn = (handleId: string): ResolveResult =>
    crm.tx((db: StoreTx) => refs.resolve(handleId, db));

  const hydrateRef = (ref: string) => crm.tx((db: StoreTx) => refs.hydrate(ref, db));

  const makeResolveCtx = (item: unknown, hasItem: boolean, hydrateSpills = false): ResolveCtx => ({
    stepResults,
    item,
    hasItem,
    refs,
    resolveCrossTurn,
    hydrateRef,
    hydrateSpills,
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

  const emitFailed = (
    stepId: string,
    error: { code: string; message: string },
    ms: number,
    spanHandle?: SpanHandle,
  ): void => {
    states.set(stepId, { state: 'failed', error });
    onEvent({ t: 'step.failed', turnId, stepId, error, ms });
    // `spanHandle` is only ever set once `step.started` has already fired
    // (see `runStep`/`runForEachStep`) — every early-exit failure path
    // above that point (unknown action, unresolved ref, forEach hard cap,
    // forEach per-item resolution errors) never started a span, so there
    // is nothing to end here.
    if (spanHandle) spans?.end(spanHandle, { meta: { stepId, status: 'failed', errorCode: error.code } });
  };

  /** Fire the confirmation gate for a write step; returns the broker verdict. */
  const gate = async (
    step: Step,
    action: ActionDef,
    affectedCount: number,
    targetSample: string[],
    drift: ResolveMeta['drift'],
  ): Promise<boolean> => {
    const confirmId = `cf_${randomUUID()}`;
    const driftNote =
      drift && drift.missing > 0
        ? ` (${drift.total - drift.missing} of ${drift.total} still match — ${drift.missing} no longer exist)`
        : '';
    // Engine-wave E6 (composer handoff): the gate description bypasses
    // compose(), so build it human-readable AT THE SOURCE — the action's
    // display name, the TRUE full-set count (E1), and a few record NAMES
    // (never tool slugs / ref grammar / step ids). e.g. "Send SMS — 165
    // contacts: Jane Cooper, R. Patel, and 163 more".
    const noun = action.entities[0] ?? 'record';
    const names = targetSample.slice(0, 3).filter((n) => n && n.length > 0);
    const more = affectedCount - names.length;
    const nameList =
      names.length > 0 ? `: ${names.join(', ')}${more > 0 ? `, and ${more} more` : ''}` : '';
    const countLabel = `${affectedCount} ${noun}${affectedCount === 1 ? '' : 's'}`;
    const description = `${action.name} — ${countLabel}${nameList}.${driftNote}`;
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
    // Engine-wave E7 (RC8): the wall-clock a human spends deciding is NOT
    // the agent's compute budget — measure it and exclude it from the turn
    // deadline (both the executor's own check below and, via `onGateWait`,
    // the caller's in-execution LLM-call budget).
    const waitStart = performance.now();
    const approved = await confirm.request({
      turnId,
      confirmId,
      planRev,
      planHash: input.planHash,
      stepId: step.id,
      scope,
    });
    const waited = performance.now() - waitStart;
    metrics.gateWaitMs += waited;
    input.onGateWait?.(waited);
    onEvent({ t: 'confirmation.resolved', turnId, confirmId, approved });
    return approved;
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
    spill: { __spill: true; total: number; sample: unknown[]; idList?: string[]; query?: object },
  ): { result: unknown; ref: string } => {
    // Engine-wave E1: when the producer enumerated its COMPLETE id set (or a
    // re-runnable `query`), persist THAT so a later bulk consumer can hydrate
    // the full set — not just the 20 sample ids. Absent, we fall back to the
    // sample ids (a truncated set the hydrate path will honestly reject).
    const sampleIds = spill.sample.map((row) => String(field(row, 'id'))).filter((id) => id !== 'undefined');
    const put: Parameters<RefStore['put']>[0] = {
      action: step.action,
      turnId,
      stepId: step.id,
      entityType: action.entities[0] ?? action.module,
      total: spill.total,
      idList: spill.idList ?? sampleIds,
      sample: spill.sample,
    };
    if (spill.query !== undefined) put.query = spill.query;
    const handle = refs.put(put);
    // Downstream intra-plan refs over a spilled read can only see the sample
    // (the full set lives behind the handle) — documented limitation.
    return {
      result: { ref: handle.ref, total: spill.total, sample: spill.sample, items: spill.sample },
      ref: handle.ref,
    };
  };

  function isSpill(x: unknown): x is { __spill: true; total: number; sample: unknown[]; idList?: string[]; query?: object } {
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
    // Step-duration measurement is instrumentation, not domain time — use a
    // real monotonic timer (`performance.now()`) rather than `clock`, which
    // stays the pinned `VirtualClock` for domain timestamps handed to action
    // handlers via `buildCtx`. See `events/trace.ts` for the matching fix on
    // span start/end stamps.
    const started = performance.now();
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
    const rctx = makeResolveCtx(undefined, false, true);
    let params: Record<string, unknown>;
    try {
      params = resolveValue(step.params, rctx) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof RefResolutionError || err instanceof TruncatedInputError) {
        const ms = performance.now() - started;
        const error = { code: err.code, message: err.message };
        const { hint } = recordStuck(step.action, stableHash(step.params), err.code);
        emitFailed(step.id, hint ? { ...error, message: `${error.message} [${hint}]` } : error, ms);
        return;
      }
      throw err;
    }
    // TRIAGE fix #6: ISO-8601 date strings → epoch-ms for date-named numeric
    // params, so the typed handler receives the ms number it expects.
    params = coerceDateParams(params, action.inputSchema);
    const drift = rctx.meta.drift;
    const affectedCount = isWrite ? Math.max(rctx.meta.maxArrayLen, 1) : rctx.meta.maxArrayLen;

    if (isWrite && shouldGate(action.risk, affectedCount, drift)) {
      const targets = collectTargetSample(params);
      const approved = await gate(step, action, affectedCount, targets, drift);
      if (!approved) {
        denied = true;
        states.set(step.id, { state: 'cancelled' });
        return;
      }
    }

    onEvent({ t: 'step.started', turnId, stepId: step.id, action: step.action });
    const stepSpan = spans?.start({ turnId, kind: 'step', name: step.action, meta: { stepId: step.id } });
    const key = `${turnId}:${planRev}:${step.id}:0`;
    const res = await invoke(action, params, key, isCore);
    const ms = performance.now() - started;

    if (!res.ok) {
      const err = res.error as { code: string; message: string };
      const { hint } = recordStuck(step.action, stableHash(params), err.code);
      const finalErr = hint ? { code: err.code, message: `${err.message} [${hint}]` } : err;
      emitFailed(step.id, finalErr, ms, stepSpan);
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
    emitFinished(step.id, summary, result, spillRef, ms, undefined, stepSpan);
  };

  const runForEachStep = async (
    step: Step,
    action: ActionDef,
    isWrite: boolean,
    started: number,
  ): Promise<void> => {
    const feCtx = makeResolveCtx(undefined, false, true);
    let forEachResolved: unknown;
    try {
      // Engine-wave E1: a forEach over a spilled list hydrates the FULL set
      // here (fanOut/gate count = true total), or fails TRUNCATED_INPUT —
      // never fans out over the 20-row sample.
      forEachResolved = resolveWholeRef(step.forEach as string, feCtx);
    } catch (err) {
      if (err instanceof RefResolutionError || err instanceof TruncatedInputError) {
        const error = { code: err.code, message: err.message };
        const { hint } = recordStuck(step.action, stableHash(step.params), err.code);
        emitFailed(step.id, hint ? { ...error, message: `${error.message} [${hint}]` } : error, performance.now() - started);
        return;
      }
      throw err;
    }
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
      emitFailed(step.id, err, performance.now() - started);
      return;
    }

    // Resolve EVERY item's params FIRST — before the gate or any handler
    // call. An unresolvable ref on ANY item must fail the whole step with
    // REF_RESOLUTION (listing the failing indices) BEFORE a confirmation
    // ever fires: approving a bulk write and only THEN discovering item N's
    // ref is broken (executing items 0..N-1, aborting at N with no
    // partial-success record, gate already spent) is the defect this guards.
    const resolvedParams: Record<string, unknown>[] = [];
    const resolutionErrors: { index: number; message: string }[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const rctx = makeResolveCtx(items[i], true, true);
      try {
        resolvedParams.push(
          coerceDateParams(resolveValue(step.params, rctx) as Record<string, unknown>, action.inputSchema),
        );
      } catch (err) {
        if (err instanceof RefResolutionError || err instanceof TruncatedInputError) {
          resolutionErrors.push({ index: i, message: err.message });
          continue;
        }
        throw err;
      }
    }
    if (resolutionErrors.length > 0) {
      const idxs = resolutionErrors.map((e) => e.index).join(', ');
      const first = resolutionErrors[0] as { index: number; message: string };
      const error = {
        code: 'REF_RESOLUTION',
        message: `forEach item(s) [${idxs}] of ${items.length} could not resolve their params — no write ran (the fan-out is aborted before the confirmation gate). First failure (item ${first.index}): ${first.message}`,
      };
      const { hint } = recordStuck(step.action, stableHash(step.params), error.code);
      emitFailed(step.id, hint ? { ...error, message: `${error.message} [${hint}]` } : error, performance.now() - started);
      return;
    }

    // Only a FULLY-resolvable fan-out reaches the gate. Gate ONCE with
    // aggregate scope (affectedCount = fan-out size).
    if (isWrite && shouldGate(action.risk, fanOut, drift)) {
      const approved = await gate(step, action, fanOut, sampleNames(items), drift);
      if (!approved) {
        denied = true;
        states.set(step.id, { state: 'cancelled' });
        return;
      }
    }

    onEvent({ t: 'step.started', turnId, stepId: step.id, action: step.action, itemCount: fanOut });
    const stepSpan = spans?.start({
      turnId,
      kind: 'step',
      name: step.action,
      meta: { stepId: step.id, itemCount: fanOut },
    });

    const isCore = isCoreSlug(step.action);
    const perItemResults: unknown[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const params = resolvedParams[i] as Record<string, unknown>;
      const key = `${turnId}:${planRev}:${step.id}:${i}`;
      const res = await invoke(action, params, key, isCore);
      if (!res.ok) {
        const err = res.error as { code: string; message: string };
        const { hint } = recordStuck(step.action, stableHash(params), err.code);
        // Honest partial-success note: a mid-fan-out handler failure means
        // items 0..i-1 already executed (and committed) — surface that in
        // the failure message rather than pretending nothing happened.
        const partial = i > 0 ? ` (items 0-${i - 1} of ${items.length} completed before this failure)` : '';
        const finalErr = {
          code: err.code,
          message: `${err.message}${partial}${hint ? ` [${hint}]` : ''}`,
        };
        emitFailed(step.id, finalErr, performance.now() - started, stepSpan);
        return;
      }
      perItemResults.push(res.output);
    }

    const result = { items: perItemResults, total: perItemResults.length };
    stepResults.set(step.id, result);
    states.set(step.id, { state: 'done', result });

    const summary = summarize(step, action, fanOut, drift, undefined);
    emitFinished(step.id, summary, result, undefined, performance.now() - started, fanOut, stepSpan);
  };

  const emitFinished = (
    stepId: string,
    summary: string,
    result: unknown,
    spillRef: string | undefined,
    ms: number,
    _itemCount: number | undefined,
    spanHandle?: SpanHandle,
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
    if (spanHandle) spans?.end(spanHandle, { meta: { stepId, status: 'done' } });
  };

  /**
   * TRIAGE C1 residual — route a runtime NOT_FOUND on a step with downstream
   * dependents to ONE replan round (via the `onStepFailure` hook) BEFORE its
   * dependents are skipped. Runs at the top of the scheduling loop so the
   * just-failed step's dependents are still `pending`. Returns how the loop
   * should proceed; mutates `plan`/`states`/`planRev` in place on a patch.
   */
  const handleNotFoundFailure = async (): Promise<'patched' | 'abort' | 'clarify' | 'none'> => {
    if (notFoundReplanUsed || input.onStepFailure === undefined) return 'none';
    for (const step of plan.steps) {
      if (notFoundConsidered.has(step.id)) continue;
      const rec = states.get(step.id);
      if (!rec || rec.state !== 'failed' || rec.error?.code !== 'NOT_FOUND') continue;
      notFoundConsidered.add(step.id);
      // Only worth a replan when something downstream depends on this step —
      // a single-step fabrication has no cascade to repair here (it is the
      // retrieval fix's job to stop it being fabricated in the first place).
      const hasDependents = plan.steps.some((s) => s.dependsOn.includes(step.id));
      if (!hasDependents) continue;

      const completed: Record<string, { result: unknown }> = {};
      for (const [id, result] of stepResults) completed[id] = { result };
      const decision = await input.onStepFailure({ plan, completed, failedStep: step, error: rec.error });
      notFoundReplanUsed = true;

      if (decision.decision === 'clarify') {
        clarifyQuestion = decision.question;
        return 'clarify';
      }
      if (decision.decision === 'abort') {
        aborted = true;
        abortReason = decision.reason;
        return 'abort';
      }
      if (decision.decision === 'patch') {
        // Discard the NOT_FOUND step and every step that (transitively)
        // depended on it — those were going to be skipped anyway — keep every
        // other step's record, and splice in the corrected steps (which
        // resolve the entity by name and redo the downstream work).
        const dropped = new Set<string>([step.id]);
        for (let changed = true; changed; ) {
          changed = false;
          for (const s of plan.steps) {
            if (!dropped.has(s.id) && s.dependsOn.some((d) => dropped.has(d))) {
              dropped.add(s.id);
              changed = true;
            }
          }
        }
        const keptSteps = plan.steps.filter((s) => !dropped.has(s.id));
        plan = { ...plan, steps: [...keptSteps, ...decision.patchedSteps] };
        for (const id of dropped) {
          states.delete(id);
          stepResults.delete(id);
        }
        for (const s of plan.steps) if (!states.has(s.id)) states.set(s.id, { state: 'pending' });
        planRev = decision.planRev;
        return 'patched';
      }
      return 'none'; // 'proceed' — leave the failure as-is
    }
    return 'none';
  };

  // --- scheduling loop ------------------------------------------------------

  for (;;) {
    if (halted || aborted || clarifyQuestion !== undefined) break;

    // TRIAGE C1 residual: attempt a NOT_FOUND replan before the next frontier
    // skips the failed step's dependents.
    const nf = await handleNotFoundFailure();
    if (nf === 'abort' || nf === 'clarify') break;
    if (nf === 'patched') continue;

    // LLD §5.3 "loop until all terminal or TIMEOUT" — checked BETWEEN
    // strata (i.e. at the top of every loop iteration, before computing
    // the next stratum's frontier), never mid-handler. Engine-wave E7: the
    // deadline is measured in ACTIVE ms (elapsed − time spent awaiting
    // confirmation decisions), so a slow human approver never trips it.
    if (
      input.deadlineAtMs !== undefined &&
      performance.now() - metrics.gateWaitMs >= input.deadlineAtMs
    ) {
      timedOut = true;
      break;
    }

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

    // JOINER CHECKPOINT (LLD §5.4): fires once per write-bearing stratum,
    // before its writes run — never for a reads-only stratum. `undefined`
    // (no hook supplied) is a no-op pass-through, byte-identical to the
    // pre-Task-13 executor (every Task 11 test omits it).
    if (writes.length > 0 && input.onWriteStratum) {
      const completedForCheckpoint: Record<string, { result: unknown }> = {};
      for (const [id, result] of stepResults) completedForCheckpoint[id] = { result };

      const decision = await input.onWriteStratum({ plan, completed: completedForCheckpoint, upcoming: writes });

      if (decision.decision === 'clarify') {
        clarifyQuestion = decision.question;
        break;
      }
      if (decision.decision === 'abort') {
        aborted = true;
        abortReason = decision.reason;
        break;
      }
      if (decision.decision === 'patch') {
        // "Replace the FULL remaining step array" (LLD §5.4): keep every
        // step already terminal, discard every other pending/not-yet-run
        // step, splice in the corrected array, adopt the bumped planRev
        // the caller already computed (idempotency keys for steps run
        // from here on use it).
        const terminalIds = new Set([...states.keys()].filter((id) => terminal(states.get(id)!.state)));
        const keptSteps = plan.steps.filter((s) => terminalIds.has(s.id));
        plan = { ...plan, steps: [...keptSteps, ...decision.patchedSteps] };
        for (const s of decision.patchedSteps) {
          if (!states.has(s.id)) states.set(s.id, { state: 'pending' });
        }
        planRev = decision.planRev;
        continue; // re-enter the scheduling loop against the patched plan
      }
      // decision === 'proceed' → fall through and run `writes` as scheduled.
    }

    for (const step of writes) {
      await runStep(step);
      if (halted) break;
    }
  }

  // --- final status ---------------------------------------------------------

  // Timeout breach: every not-yet-started step is explicitly marked
  // 'skipped' (never silently left 'pending') — the reviewer's ask, and
  // the honest signal that nothing further was even attempted.
  if (timedOut) {
    for (const [id, rec] of states) {
      if (rec.state === 'pending') states.set(id, { state: 'skipped' });
    }
    aborted = true;
    abortReason = 'Turn exceeded its wall-clock deadline (turnTimeoutMs) — stopped before scheduling further work.';
  }

  const stepStates: Record<string, StepRecord> = {};
  for (const [id, rec] of states) stepStates[id] = rec;

  let status: ExecutionResult['status'];
  if (clarifyQuestion !== undefined) {
    status = 'clarify';
  } else if (aborted) {
    status = 'failed';
  } else if (halted) {
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
  if (status === 'clarify' && clarifyQuestion !== undefined) result.clarifyQuestion = clarifyQuestion;
  if (aborted && abortReason !== undefined) result.abortReason = abortReason;
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
