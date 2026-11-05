/**
 * Per-turn tool construction for the loop agent (plan rev 3, Task 5).
 *
 * One native Agents-SDK tool per retrieved catalog action, plus five
 * standing tools (catalog search, ref sort/aggregate, clarify/refuse
 * exits). All deterministic rails live in the `execute` wrappers:
 * date coercion -> original-schema re-validation -> pre-execution
 * confirmation gate (deny = handler NEVER invoked, DENIED observation) ->
 * handler via crm.tx with idempotency key -> spill-to-ref -> step events.
 *
 * Schema paths (spike-verified, docs/SPIKES.md 2026-11-06): strict zod via
 * `widenDateFields` when convertible; otherwise `strict:false` + stripped
 * JSON Schema (`JSON.parse(JSON.stringify(z.toJSONSchema(...)))` — the
 * stringify removes zod's hidden `~standard` marker). Either way the
 * ORIGINAL action schema re-validates after coercion, so widening and
 * non-strict args never reach a handler.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool, type Tool } from '@openai/agents';
import type { Registry } from '../catalog/registry.js';
import { ActionError, type ActionContext, type ActionDef } from '../catalog/types.js';
import type { Crm } from '../store/db.js';
import type { VirtualClock } from '../store/clock.js';
import type { RefStore } from '../agent/refs.js';
import { retrieve, renderCards, type Card, type SessionCtx } from '../agent/retrieval.js';
import { shouldGate, type ConfirmBroker } from '../agent/executor.js';
import type { ConfirmationScope, Event } from '../events/types.js';
import { coerceDateParams, widenDateFields } from './date-rail.js';

// --- stuck detection (OpenHands StuckDetector-lite) ---------------------------

export type StuckVerdict = 'ok' | 'hint' | 'stop';

/** 3rd identical action+error -> corrective hint; 4th -> stop the loop. */
export class StuckTracker {
  private readonly counts = new Map<string, number>();

  record(action: string, errorCode: string): StuckVerdict {
    const key = `${action}::${errorCode}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n >= 4) return 'stop';
    if (n === 3) return 'hint';
    return 'ok';
  }
}

// --- exits --------------------------------------------------------------------

/** Set by the session__ask_user / session__refuse tools (and the stuck
 * stop); the loop driver reads these after the run ends to pick the
 * honest TurnStatus. */
export interface LoopExits {
  clarify?: string;
  refused?: string;
  stuck?: string;
  denied: boolean;
  writesLanded: number;
  /** Aborts the in-flight run immediately (exit tools, stuck-stop). */
  stop: () => void;
}

// --- small helpers (baseline conventions) -------------------------------------

function toolName(slug: string): string {
  return slug.replace(/\./g, '__');
}

function maxArrayLength(value: unknown): number {
  if (Array.isArray(value)) {
    let max = value.length;
    for (const v of value) max = Math.max(max, maxArrayLength(v));
    return max;
  }
  if (value !== null && typeof value === 'object') {
    let max = 0;
    for (const v of Object.values(value as Record<string, unknown>)) max = Math.max(max, maxArrayLength(v));
    return max;
  }
  return 0;
}

function countRows(result: unknown): number {
  if (result !== null && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o['total'] === 'number') return o['total'];
    if (Array.isArray(o['items'])) return o['items'].length;
  }
  return 1;
}

interface SpillMarker {
  __spill: true;
  total: number;
  sample: unknown[];
}

function isSpill(x: unknown): x is SpillMarker {
  return (
    x !== null && typeof x === 'object' &&
    (x as { __spill?: unknown }).__spill === true &&
    Array.isArray((x as { sample?: unknown }).sample)
  );
}

function rowId(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const id = (row as Record<string, unknown>)['id'];
  return id === undefined || id === null ? undefined : String(id);
}

function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof ActionError) return { code: err.code, message: err.message };
  return { code: 'VALIDATION', message: err instanceof Error ? err.message : String(err) };
}

/** Pluralize an entity noun without double-s ("tasks" stays "tasks"). */
function pluralNoun(noun: string, count: number): string {
  if (count === 1) return noun;
  return noun.endsWith('s') ? noun : `${noun}s`;
}

const OBSERVATION_CAP = 2000;
const SPILL_SAMPLE_ROWS = 20;

/** Model-facing parameters for an action: strict widened zod when the SDK
 * can convert it, else non-strict stripped JSON Schema (z.record cases). */
function toolParameters(action: ActionDef): { parameters: unknown; strict: boolean } {
  const schema = action.inputSchema;
  if (schema instanceof z.ZodObject) {
    const widened = widenDateFields(schema as z.ZodObject<z.ZodRawShape>);
    try {
      // Probe strict conversion the same way tool() will.
      tool({ name: 'probe', description: 'p', parameters: widened, execute: async () => '' });
      return { parameters: widened, strict: true };
    } catch {
      /* fall through to JSON-schema path */
    }
  }
  const jsonSchema: unknown = JSON.parse(JSON.stringify(z.toJSONSchema(schema as z.ZodType, { io: 'input', target: 'draft-7' })));
  return { parameters: jsonSchema, strict: false };
}

// --- buildTurnTools -----------------------------------------------------------

export interface BuildTurnToolsInput {
  registry: Registry;
  cards: readonly Card[];
  crm: Crm;
  refs: RefStore;
  confirm: ConfirmBroker;
  clock: VirtualClock;
  turnId: string;
  emit: (e: Event) => void;
  sessionCtx: SessionCtx;
  exits: LoopExits;
  stuck: StuckTracker;
  markTtfur: () => void;
  counters: { stepsOk: number; stepsFailed: number; step: number };
  planHash: string;
}

export function buildTurnTools(input: BuildTurnToolsInput): Tool[] {
  const { registry, crm, refs, confirm, clock, turnId, emit, exits, stuck, markTtfur, counters } = input;

  const actionTools: Tool[] = [];
  const seenSlugs = new Set<string>();
  for (const card of input.cards) {
    const action = registry.get(card.slug);
    if (!action || seenSlugs.has(action.slug)) continue;
    seenSlugs.add(action.slug);
    actionTools.push(buildActionTool(action));
  }

  function buildActionTool(action: ActionDef): Tool {
    const { parameters, strict } = toolParameters(action);
    return tool({
      name: toolName(action.slug),
      description: action.description.slice(0, 1024),
      strict: strict as false,
      parameters: parameters as never,
      execute: async (rawArgs: unknown): Promise<string> => {
        counters.step += 1;
        const stepId = `s${counters.step}`;
        const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};

        // 1. deterministic date rail, then re-validate against the ORIGINAL schema
        const { params: coerced, resolved } = coerceDateParams(args, clock.now());
        const parsed = action.inputSchema.safeParse(coerced);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          counters.stepsFailed += 1;
          emit({ t: 'step.failed', turnId, stepId, error: { code: 'PARAM_SCHEMA', message: detail }, ms: 0 });
          return applyStuck(action.slug, 'PARAM_SCHEMA', `VALIDATION ERROR for ${action.name}: ${detail}. Correct the arguments and try again.`);
        }
        const params = parsed.data as Record<string, unknown>;

        // 2. pre-execution confirmation gate — deny means the handler is NEVER invoked
        const isWrite = action.risk !== 'read';
        const affectedCount = isWrite ? Math.max(maxArrayLength(params), 1) : maxArrayLength(params);
        if (isWrite && shouldGate(action.risk, affectedCount)) {
          const confirmId = `cf_${randomUUID()}`;
          const noun = action.entities[0] ?? 'record';
          const scope: ConfirmationScope = {
            actions: [action.slug],
            affectedCount,
            targetSample: [],
            description: `${action.name} — ${affectedCount} ${pluralNoun(noun, affectedCount)}.`,
          };
          markTtfur();
          emit({ t: 'confirmation.required', turnId, confirmId, planRev: 0, planHash: input.planHash, stepId, scope });
          const approved = await confirm.request({ turnId, confirmId, planRev: 0, planHash: input.planHash, stepId, scope });
          emit({ t: 'confirmation.resolved', turnId, confirmId, approved });
          if (!approved) {
            exits.denied = true;
            return `DENIED by the user — "${action.name}" was NOT executed. Do not claim it happened; tell the user plainly that nothing was changed, or ask how to narrow the request.`;
          }
        }

        // 3. dispatch
        markTtfur();
        emit({ t: 'step.started', turnId, stepId, action: action.slug, resolvedParams: [params] });
        const key = `${turnId}:0:${stepId}:0`;
        const startedAt = performance.now();
        try {
          // TRANSIENT errors get ONE deterministic in-place retry (old
          // executor parity, LLD §5.3) before the model ever sees them.
          const dispatch = (): Promise<unknown> =>
            crm.tx((db) => action.handler(params, { db, clock, idempotencyKey: key, format: 'concise' } satisfies ActionContext));
          let output: unknown;
          try {
            output = await dispatch();
          } catch (firstErr) {
            if (firstErr instanceof ActionError && firstErr.code === 'TRANSIENT') {
              output = await dispatch();
            } else {
              throw firstErr;
            }
          }
          const ms = performance.now() - startedAt;

          let finalResult: unknown = output;
          let spillRef: string | undefined;
          let count = countRows(output);
          if (isSpill(output)) {
            const handle = refs.put({
              action: action.slug,
              turnId,
              stepId,
              entityType: action.entities[0] ?? action.module,
              total: output.total,
              idList: output.sample.map(rowId).filter((id): id is string => id !== undefined),
              sample: output.sample,
            });
            spillRef = handle.ref;
            finalResult = { ref: handle.ref, total: output.total, sample: output.sample.slice(0, SPILL_SAMPLE_ROWS) };
            count = output.total;
          }

          const noun = action.entities[0] ?? 'record';
          const refNote = spillRef ? ` [ref ${spillRef}]` : '';
          const summary = `${action.name}: ${isWrite ? affectedCount : count} ${pluralNoun(noun, isWrite ? affectedCount : count)}${refNote}`;
          const finishedEv: Extract<Event, { t: 'step.finished' }> = { t: 'step.finished', turnId, stepId, summary, ms };
          if (spillRef !== undefined) {
            finishedEv.resultRef = spillRef;
          } else {
            const serialized = JSON.stringify(finalResult ?? null);
            if (serialized.length <= 2048) finishedEv.inlineResult = finalResult;
          }
          emit(finishedEv);
          counters.stepsOk += 1;
          if (isWrite) exits.writesLanded += 1;

          const echo = resolved.length > 0 ? ` [resolved dates: ${resolved.join('; ')}]` : '';
          const body = JSON.stringify(finalResult ?? null).slice(0, OBSERVATION_CAP);
          return `${summary}.${echo} result=${body}`;
        } catch (err) {
          const ms = performance.now() - startedAt;
          const error = describeError(err);
          counters.stepsFailed += 1;
          emit({ t: 'step.failed', turnId, stepId, error, ms });
          return applyStuck(action.slug, error.code, `ERROR[${error.code}] from ${action.name}: ${error.message}`);
        }
      },
    });
  }

  /** Feed stuck tracking on every failure observation; hint on the 3rd
   * identical failure, hard-stop the run on the 4th. */
  function applyStuck(slug: string, code: string, observation: string): string {
    const verdict = stuck.record(slug, code);
    if (verdict === 'stop') {
      exits.stuck = `I kept hitting the same error (${code} from ${slug}) and stopped rather than repeat it again.`;
      exits.stop();
      return observation;
    }
    if (verdict === 'hint') {
      return `${observation}\nHINT: this exact call has now failed ${3} times with the same error. Do NOT repeat it unchanged — change the arguments, pick a different action (try catalog__search_actions), or explain the problem to the user.`;
    }
    return observation;
  }

  // --- standing tools ----------------------------------------------------------

  const searchActions = tool({
    name: 'catalog__search_actions',
    description:
      'Search the full action catalog for more available actions when none of your current tools fit. Returns action cards (slug — description).',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }): Promise<string> => {
      const found = retrieve(query, input.sessionCtx).cards;
      if (found.length === 0) return 'No matching actions found in the catalog.';
      return `Available actions (these are informational — call the matching tool if it is bound, otherwise refuse honestly):\n${renderCards(found)}`;
    },
  });

  const hydrateRows = (ref: string): { rows: Record<string, unknown>[]; complete: boolean; total: number } =>
    crm.tx((db) => refs.hydrate(ref, db));

  const sortRef = tool({
    name: 'data__sort_ref',
    description:
      'Sort the COMPLETE result set behind a ref (from an earlier search result) by a field, server-side, and return the top rows. Use for biggest/smallest/oldest/newest questions when the set is larger than the sample shown.',
    parameters: z.object({
      ref: z.string(),
      field: z.string(),
      direction: z.enum(['asc', 'desc']),
      limit: z.number().int().min(1).max(50).default(5),
    }),
    execute: async ({ ref, field, direction, limit }): Promise<string> => {
      const { rows, complete, total } = hydrateRows(ref);
      if (!complete) {
        return `The set behind ${ref} is incomplete on the server (only a sample was captured), so an exact sort is not possible. Say so honestly or narrow the search with filters.`;
      }
      const sorted = [...rows].sort((a, b) => {
        const av = Number(a[field] ?? Number.NEGATIVE_INFINITY);
        const bv = Number(b[field] ?? Number.NEGATIVE_INFINITY);
        return direction === 'asc' ? av - bv : bv - av;
      });
      const top = sorted.slice(0, limit);
      return `Sorted ${total} records by ${field} ${direction}; top ${top.length}: ${JSON.stringify(top).slice(0, OBSERVATION_CAP)}`;
    },
  });

  const aggregateRef = tool({
    name: 'data__aggregate_ref',
    description:
      'Compute an exact aggregate (sum, avg, min, max, count) of a numeric field over the COMPLETE result set behind a ref. Use for totals and averages instead of adding up samples.',
    parameters: z.object({
      ref: z.string(),
      field: z.string(),
      op: z.enum(['sum', 'avg', 'min', 'max', 'count']),
    }),
    execute: async ({ ref, field, op }): Promise<string> => {
      const { rows, complete, total } = hydrateRows(ref);
      if (!complete) {
        return `The set behind ${ref} is incomplete on the server, so an exact ${op} is not possible. Say so honestly or narrow the search with filters.`;
      }
      if (op === 'count') return `count over ${ref}: ${total} records.`;
      const values = rows.map((r) => Number(r[field])).filter((v) => Number.isFinite(v));
      if (values.length === 0) return `No numeric values found for field "${field}" across ${total} records.`;
      const sum = values.reduce((a, b) => a + b, 0);
      const value = op === 'sum' ? sum : op === 'avg' ? sum / values.length : op === 'min' ? Math.min(...values) : Math.max(...values);
      return `${op} of ${field} over ${values.length} records: ${value}`;
    },
  });

  const askUser = tool({
    name: 'session__ask_user',
    description: 'Ask the user ONE specific question when you need their decision to proceed (ambiguity, missing required detail). This ends your turn.',
    parameters: z.object({ question: z.string() }),
    execute: async ({ question }): Promise<string> => {
      exits.clarify = question;
      exits.stop();
      return 'Question sent to the user. The turn is over.';
    },
  });

  const refuse = tool({
    name: 'session__refuse',
    description: 'Decline the request when it cannot be done with the available actions. Give the SPECIFIC reason. This ends your turn.',
    parameters: z.object({ reason: z.string() }),
    execute: async ({ reason }): Promise<string> => {
      exits.refused = reason;
      exits.stop();
      return 'Refusal sent to the user. The turn is over.';
    },
  });

  return [...actionTools, searchActions, sortRef, aggregateRef, askUser, refuse];
}
