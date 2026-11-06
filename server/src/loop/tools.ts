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
import { coerceDateParams, widenForModel } from './date-rail.js';
import { DATE_FIELD_RE } from '../agent/date-expr.js';

// --- stuck detection (OpenHands StuckDetector-lite) ---------------------------

export type StuckVerdict = 'ok' | 'hint' | 'stop';

/** 3rd identical action+error+params -> corrective hint; 4th -> stop the
 * loop. Params are part of the identity (review I7): three DIFFERENT wrong
 * calls to the same action are progress, not a stuck loop. */
export class StuckTracker {
  private readonly counts = new Map<string, number>();

  record(action: string, errorCode: string, paramsKey = ''): StuckVerdict {
    const key = `${action}::${errorCode}::${paramsKey}`;
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
  /** Human-readable action name -> write count (the deterministic actions
   * ledger appended to write-turn answers; round-6 support F1). */
  writeActions: Map<string, number>;
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
  /** Optional hydration channels (engine-wave E1, `catalog/list-output.ts`):
   * a COMPLETE id enumeration and/or a re-runnable flat-equality query.
   * Persisting these is what lets `refs.hydrate` return `complete: true` —
   * dropping them was review finding C1 (sort/aggregate dead on real spills). */
  idList?: string[];
  query?: Record<string, unknown>;
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

/** Deep-copy with every date-shaped numeric field rendered as ISO — what
 * the MODEL sees (round-4: models hand-convert epoch ms in answers and get
 * it wrong by months/years; they read ISO strings fine). Events/UI keep
 * the raw values. */
function renderDatesForModel(value: unknown, keyOfParent?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => renderDatesForModel(v, keyOfParent));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'number' && DATE_FIELD_RE.test(k) && v > 10_000_000_000) {
        out[k] = new Date(v).toISOString();
      } else {
        out[k] = renderDatesForModel(v, k);
      }
    }
    return out;
  }
  return value;
}

/** Natural count phrasing: entity nouns are plural table names ("invoices"),
 * so singular counts strip the s and plural counts never double it. */
function pluralNoun(noun: string, count: number): string {
  if (count === 1) return noun.endsWith('s') ? noun.slice(0, -1) : noun;
  return noun.endsWith('s') ? noun : `${noun}s`;
}

const OBSERVATION_CAP = 2000;
const SPILL_SAMPLE_ROWS = 20;

/** Row-aware observation body (round-6 marketing R6-1 / review M5): the old
 * char-slice cut JSON mid-token, so the model saw a broken half-list,
 * treated it as complete, and declared the cut-off records nonexistent.
 * Lists now keep WHOLE rows within budget and say exactly how many more
 * exist and where the full set lives. */
function renderObservationBody(result: unknown, refNote: string, cap = OBSERVATION_CAP): string {
  const rendered = renderDatesForModel(result);
  const full = JSON.stringify(rendered ?? null);
  if (full.length <= cap) return full;
  if (rendered !== null && typeof rendered === 'object') {
    const o = rendered as Record<string, unknown>;
    const listKey = Array.isArray(o['items']) ? 'items' : Array.isArray(o['sample']) ? 'sample' : undefined;
    if (listKey) {
      const rows = o[listKey] as unknown[];
      const kept: unknown[] = [];
      let size = full.length - JSON.stringify(rows).length + 2;
      for (const row of rows) {
        const rowJson = JSON.stringify(row);
        if (size + rowJson.length > cap && kept.length > 0) break;
        kept.push(row);
        size += rowJson.length + 1;
      }
      const omitted = rows.length - kept.length;
      const trimmed = JSON.stringify({ ...o, [listKey]: kept });
      const where = refNote !== '' ? `the full set is behind ${refNote.trim()}` : 'narrow the search or fetch records by id for the rest';
      return `${trimmed} … +${omitted} more rows not shown (shown ${kept.length} of ${rows.length} returned) — ${where}.`;
    }
  }
  return `${full.slice(0, cap)} …[remainder omitted — fetch the record by id for full details]`;
}

/** Model-facing parameters for an action: strict widened zod when the SDK
 * can convert it, else non-strict stripped JSON Schema (z.record cases). */
function toolParameters(action: ActionDef): { parameters: unknown; strict: boolean } {
  const schema = action.inputSchema;
  if (schema instanceof z.ZodObject) {
    const widened = widenForModel(schema as z.ZodObject<z.ZodRawShape>);
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
  counters: { stepsOk: number; stepsFailed: number; step: number; gateWaitMs: number };
  planHash: string;
  /** Resolved acting user id — literal "me"/"current_user" param values in
   * identity-shaped fields are substituted with this (round-4 billing C1:
   * host_user_id:"me" went to SQL literally). */
  actingUserId: string;
  /** Provenance firewall (round-5 support CRITICAL: a hallucinated-but-real
   * task id was written to): record ids a WRITE may target — seeded from
   * the user's own text + prior turns, grown with every observation. */
  knownIds: Set<string>;
}

export const RECORD_ID_RE = /\b[a-z][a-z]*(?:_[a-z]+)*_\d+\b/g;

/** Add every record-id-shaped token in `text` to `ids`. */
export function harvestIds(text: string, ids: Set<string>): void {
  for (const m of text.matchAll(RECORD_ID_RE)) ids.add(m[0]);
}

const IDENTITY_FIELD_RE = /(user|assignee|owner|host|creator)_id$/;
const IDENTITY_PLACEHOLDER_RE = /^(me|myself|current[ _]?user)$/i;
/** Bulk-apply honest-refusal ceiling (same as the old executor's narrow-it-down rule). */
const APPLY_MAX_RECORDS = 1000;

/** Hard ceiling on tools bound to one turn (initial shortlist + dynamic
 * additions) — selection accuracy degrades past ~40 tools in context. */
const MAX_BOUND_TOOLS = 40;
const MAX_BIND_PER_SEARCH = 8;

export function buildTurnTools(input: BuildTurnToolsInput): Tool[] {
  const { registry, crm, refs, confirm, clock, turnId, emit, exits, stuck, markTtfur, counters } = input;

  // The SAME array instance is handed to the Agent, whose getAllTools()
  // re-reads it before every model call — so catalog__search_actions can
  // BIND discovered actions mid-run (langgraph-bigtool / Anthropic Tool
  // Search pattern: discovery leads to invocation, never a dead end).
  const tools: Tool[] = [];
  const seenSlugs = new Set<string>();
  const bindAction = (action: ActionDef): boolean => {
    if (seenSlugs.has(action.slug)) return false;
    seenSlugs.add(action.slug);
    tools.push(buildActionTool(action));
    return true;
  };
  for (const card of input.cards) {
    const action = registry.get(card.slug);
    if (action) bindAction(action);
  }

  function buildActionTool(action: ActionDef): Tool {
    const { parameters, strict } = toolParameters(action);
    return tool({
      name: toolName(action.slug),
      description: action.description.slice(0, 1024),
      strict: strict as false,
      parameters: parameters as never,
      // Pre-execution failures (SDK arg validation) used to be INVISIBLE —
      // no event, no stuck-tracking, model flailing silently until it
      // apologized about a fake "system issue" (round-5b N1). Surface them.
      errorFunction: (_ctx: unknown, err: unknown): string => {
        const message = err instanceof Error ? err.message : String(err);
        counters.stepsFailed += 1;
        counters.step += 1;
        emit({ t: 'step.failed', turnId, stepId: `s${counters.step}`, error: { code: 'ARG_SCHEMA', message: message.slice(0, 300) }, ms: 0 });
        return applyStuck(action.slug, 'ARG_SCHEMA', '', `INVALID ARGUMENTS for ${action.name}: ${message.slice(0, 300)}. Fix the arguments and retry — do not repeat the same call unchanged.`);
      },
      execute: async (rawArgs: unknown): Promise<string> => {
        counters.step += 1;
        const stepId = `s${counters.step}`;
        const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};

        // 0. wildcard scrub (round-4 F24): models fill unused optional
        // filters with placeholder values ('*', 'all', 'any', '') that
        // handlers bind LITERALLY (WHERE status = '*') — producing
        // confident wrong zeros. "Match everything" is expressed by
        // OMITTING the param, so placeholders are dropped, never passed.
        const scrubbed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
          if (v === null) continue; // strict-mode "not specified"
          if (typeof v === 'string' && /^(\*+|all|any)?$/i.test(v.trim())) continue;
          if (typeof v === 'string' && IDENTITY_FIELD_RE.test(k) && IDENTITY_PLACEHOLDER_RE.test(v.trim())) {
            scrubbed[k] = input.actingUserId;
            continue;
          }
          scrubbed[k] = v;
        }

        // 1. deterministic date rail, then re-validate against the ORIGINAL schema
        const { params: coerced, resolved } = coerceDateParams(scrubbed, clock.now());
        const parsed = action.inputSchema.safeParse(coerced);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          counters.stepsFailed += 1;
          emit({ t: 'step.failed', turnId, stepId, error: { code: 'PARAM_SCHEMA', message: detail }, ms: 0 });
          return applyStuck(action.slug, 'PARAM_SCHEMA', JSON.stringify(args), `VALIDATION ERROR for ${action.name}: ${detail}. Correct the arguments and try again.`);
        }
        const params = parsed.data as Record<string, unknown>;

        // 1b. provenance firewall: a WRITE may only target ids the model has
        // actually SEEN (user text, prior results) — a plausible-but-invented
        // id must be looked up first, never written to.
        const isWrite = action.risk !== 'read';
        if (isWrite) {
          for (const [k, v] of Object.entries(params)) {
            if (typeof v !== 'string' || !/id(s)?$/.test(k)) continue;
            const idLike = v.match(RECORD_ID_RE);
            if (idLike && idLike[0] === v && !input.knownIds.has(v)) {
              counters.stepsFailed += 1;
              counters.step += 1;
              emit({ t: 'step.failed', turnId, stepId: `s${counters.step}`, error: { code: 'UNKNOWN_ID', message: `${k}=${v} not seen in any result` }, ms: 0 });
              return `BLOCKED: the id ${v} never appeared in any search result or the user's message this conversation — do not guess record ids. Search for the record first, then use the id from the result.`;
            }
          }
        }

        const affectedCount = isWrite ? Math.max(maxArrayLength(params), 1) : maxArrayLength(params);
        if (isWrite && shouldGate(action.risk, affectedCount)) {
          const confirmId = `cf_${randomUUID()}`;
          const noun = action.entities[0] ?? 'record';
          const targetSample: string[] = [];
          for (const v of Object.values(params)) {
            const vals = Array.isArray(v) ? v : [v];
            for (const x of vals) {
              if (typeof x === 'string' && /^[a-z][a-z_]*_\d+$/.test(x) && targetSample.length < 5) targetSample.push(x);
            }
          }
          const scope: ConfirmationScope = {
            actions: [action.slug],
            affectedCount,
            targetSample,
            description: `${action.name} — ${affectedCount} ${pluralNoun(noun, affectedCount)}.`,
          };
          markTtfur();
          emit({ t: 'confirmation.required', turnId, confirmId, planRev: 0, planHash: input.planHash, stepId, scope });
          const gateStartedAt = performance.now();
          const approved = await confirm.request({ turnId, confirmId, planRev: 0, planHash: input.planHash, stepId, scope });
          counters.gateWaitMs += performance.now() - gateStartedAt;
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
          let inlineRef: string | undefined;
          let count = countRows(output);
          if (!isSpill(output) && output !== null && typeof output === 'object') {
            // Round-4 support finding: small inline lists never got a ref,
            // so aggregate/sort/filter were unusable and the model summed by
            // hand (fabricating totals). Mint a handle for any complete
            // inline list of 2+ identifiable rows.
            const items = (output as Record<string, unknown>)['items'];
            if (Array.isArray(items) && items.length >= 2 && items.length >= count) {
              const ids = items.map(rowId).filter((id): id is string => id !== undefined);
              if (ids.length === items.length) {
                const handle = refs.put({
                  action: action.slug,
                  turnId,
                  stepId,
                  entityType: action.entities[0] ?? action.module,
                  total: items.length,
                  idList: ids,
                  sample: items.slice(0, SPILL_SAMPLE_ROWS),
                });
                inlineRef = handle.ref;
              }
            }
          }
          if (isSpill(output)) {
            // Executor parity (executor.ts spillToRef): prefer the producer's
            // COMPLETE idList; fall back to sample ids (hydrate then honestly
            // reports the set incomplete). Carry the re-runnable query too.
            const sampleIds = output.sample.map(rowId).filter((id): id is string => id !== undefined);
            const put: Parameters<RefStore['put']>[0] = {
              action: action.slug,
              turnId,
              stepId,
              entityType: action.entities[0] ?? action.module,
              total: output.total,
              idList: output.idList ?? sampleIds,
              sample: output.sample,
            };
            if (output.query !== undefined) put.query = output.query;
            const handle = refs.put(put);
            spillRef = handle.ref;
            finalResult = { ref: handle.ref, total: output.total, sample: output.sample.slice(0, SPILL_SAMPLE_ROWS) };
            count = output.total;
          }

          const noun = action.entities[0] ?? 'record';
          const refForModel = spillRef ?? inlineRef;
          const refNote = refForModel ? ` [ref ${refForModel}]` : '';
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
          if (isWrite) {
            exits.writesLanded += 1;
            exits.writeActions.set(action.name, (exits.writeActions.get(action.name) ?? 0) + 1);
          }

          const echo = resolved.length > 0 ? ` [resolved dates: ${resolved.join('; ')}]` : '';
          // Round-6 sales F38: an equal _after/_before pair is a zero-width
          // window — it matches nothing and reads as a confident wrong zero.
          let windowNote = '';
          for (const [k, v] of Object.entries(params)) {
            if (!k.endsWith('_after')) continue;
            const sibling = `${k.slice(0, -6)}_before`;
            if (params[sibling] !== undefined && params[sibling] === v) {
              windowNote = ` WARNING: ${k} equals ${sibling} — that zero-width window matches nothing; use the full-day bounds from the date anchors (e.g. 00:00:00 to 23:59:59).`;
            }
          }
          const body = renderObservationBody(finalResult, refNote);
          harvestIds(JSON.stringify(finalResult ?? ''), input.knownIds);
          return `${summary}.${echo}${windowNote} result=${body}`;
        } catch (err) {
          const ms = performance.now() - startedAt;
          const error = describeError(err);
          counters.stepsFailed += 1;
          emit({ t: 'step.failed', turnId, stepId, error, ms });
          return applyStuck(action.slug, error.code, JSON.stringify(params), `ERROR[${error.code}] from ${action.name}: ${error.message}`);
        }
      },
    });
  }

  /** Feed stuck tracking on every failure observation; hint on the 3rd
   * identical failure, hard-stop the run on the 4th. */
  function applyStuck(slug: string, code: string, paramsKey: string, observation: string): string {
    const verdict = stuck.record(slug, code, paramsKey);
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
      'Search the full action catalog when none of your current tools fit. Matching actions become CALLABLE TOOLS on your next step.',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }): Promise<string> => {
      // Retrieval over the indexed catalog, plus a direct registry scan so
      // token matches on slug/name/description are never missed.
      const fromRetrieval = retrieve(query, input.sessionCtx)
        .cards.map((c) => registry.get(c.slug))
        .filter((a): a is ActionDef => a !== undefined);
      const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
      const fromScan = registry
        .all()
        .filter((a) => tokens.some((t) => a.slug.includes(t) || a.name.toLowerCase().includes(t) || a.description.toLowerCase().includes(t)));
      const found = [...new Map([...fromRetrieval, ...fromScan].map((a) => [a.slug, a])).values()];
      if (found.length === 0) return 'No matching actions found in the catalog.';
      const bound: string[] = [];
      for (const a of found) {
        if (bound.length >= MAX_BIND_PER_SEARCH || tools.length >= MAX_BOUND_TOOLS) break;
        if (bindAction(a)) bound.push(a.slug);
      }
      const already = found.filter((a) => !bound.includes(a.slug)).map((a) => a.slug);
      const lines = [
        bound.length > 0 ? `These actions are NOW AVAILABLE as tools (call them as ${bound.map((s) => s.replace(/\./g, '__')).join(', ')}):` : '',
        renderCards(found.slice(0, 12).map((a) => ({ slug: a.slug, text: `${a.slug} — ${a.name}: ${a.description.slice(0, 120)}`, score: 1 }))),
        already.length > 0 && bound.length === 0 ? 'These were already among your tools.' : '',
      ].filter((l) => l !== '');
      return lines.join('\n');
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
      // Typed ordering (review I8): Number() over string fields yields NaN
      // and an arbitrary "sorted" order the model would trust. Sort
      // numerically only when every present value is numeric; otherwise
      // compare as strings; a field absent everywhere is an honest error.
      const present = rows.map((r) => r[field]).filter((v) => v !== undefined && v !== null);
      if (present.length === 0) {
        return `Field "${field}" is not present on any of the ${total} records — it cannot be sorted. Check the field name against the sample rows.`;
      }
      const numeric = present.every((v) => typeof v === 'number' || (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))));
      const sorted = [...rows].sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        const cmp = numeric
          ? Number(av ?? Number.NEGATIVE_INFINITY) - Number(bv ?? Number.NEGATIVE_INFINITY)
          : String(av ?? '').localeCompare(String(bv ?? ''));
        return direction === 'asc' ? cmp : -cmp;
      });
      const top = sorted.slice(0, limit);
      return `Sorted ${total} records by ${field} ${direction} (${numeric ? 'numeric' : 'text'} order); top ${top.length}: ${JSON.stringify(renderDatesForModel(top)).slice(0, OBSERVATION_CAP)}`;
    },
  });

  const filterRef = tool({
    name: 'data__filter_ref',
    description:
      'Filter the COMPLETE result set behind a ref by a field condition, server-side. Use for conditions over large sets ("inactive since June", "status is open") instead of judging from samples. Returns a NEW ref for the matching subset plus the exact count and a sample.',
    parameters: z.object({
      ref: z.string(),
      field: z.string(),
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'not_empty']),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    }),
    execute: async ({ ref, field, op, value }): Promise<string> => {
      const { rows, complete, total } = hydrateRows(ref);
      if (!complete) {
        return `The set behind ${ref} is incomplete on the server, so an exact filter is not possible. Narrow the original search with filters instead.`;
      }
      // Date-shaped comparison values arrive as ISO/@-relative strings.
      const cmpValue = typeof value === 'string' && DATE_FIELD_RE.test(field) ? coerceDateParams({ [field]: value }, clock.now()).params[field] : value;
      const matches = rows.filter((row) => {
        const v = row[field];
        switch (op) {
          case 'eq': return v === cmpValue;
          case 'neq': return v !== cmpValue;
          case 'gt': return Number(v) > Number(cmpValue);
          case 'gte': return Number(v) >= Number(cmpValue);
          case 'lt': return Number(v) < Number(cmpValue);
          case 'lte': return Number(v) <= Number(cmpValue);
          case 'contains': return String(v ?? '').toLowerCase().includes(String(cmpValue ?? '').toLowerCase());
          case 'empty': return v === null || v === undefined || v === '';
          case 'not_empty': return !(v === null || v === undefined || v === '');
        }
      });
      const ids = matches.map(rowId).filter((id): id is string => id !== undefined);
      const source = refs.get(ref);
      const handle = refs.put({
        action: 'data.filter_ref',
        turnId,
        stepId: `f${counters.step += 1}`,
        entityType: source?.entityType ?? 'record',
        total: matches.length,
        idList: ids,
        sample: matches.slice(0, SPILL_SAMPLE_ROWS),
      });
      return `Filter ${field} ${op} ${JSON.stringify(value ?? null)} over ${total} records: ${matches.length} matched [ref ${handle.ref}]. Sample: ${JSON.stringify(renderDatesForModel(matches.slice(0, 5))).slice(0, OBSERVATION_CAP)}`;
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
      subtract_field: z.string().nullable().optional().describe('optional second numeric field subtracted per record BEFORE aggregating — e.g. field=total_cents, subtract_field=amount_paid_cents for amounts OWED'),
    }),
    execute: async ({ ref, field, op, subtract_field }): Promise<string> => {
      const { rows, complete, total } = hydrateRows(ref);
      if (!complete) {
        return `The set behind ${ref} is incomplete on the server, so an exact ${op} is not possible. Say so honestly or narrow the search with filters.`;
      }
      if (op === 'count') return `count over ${ref}: ${total} records.`;
      const values = rows
        .map((r) => Number(r[field]) - (subtract_field ? Number(r[subtract_field] ?? 0) : 0))
        .filter((v) => Number.isFinite(v));
      if (values.length === 0) return `No numeric values found for field "${field}" across ${total} records.`;
      const sum = values.reduce((a, b) => a + b, 0);
      const value = op === 'sum' ? sum : op === 'avg' ? sum / values.length : op === 'min' ? Math.min(...values) : Math.max(...values);
      const label = subtract_field ? `${field} - ${subtract_field}` : field;
      return `${op} of ${label} over ${values.length} records: ${value}`;
    },
  });

  const applyToRef = tool({
    name: 'data__apply_to_ref',
    description:
      'Apply ONE write action to EVERY record behind a ref (e.g. send a reminder for each overdue invoice found earlier). One confirmation covers the whole set. Provide the tool name of the write action and which of its params receives each record id. Use this for bulk writes instead of calling the action record-by-record.',
    parameters: z.object({
      ref: z.string(),
      action: z.string().describe('tool name of the write action, e.g. invoices__send_invoice_reminder'),
      id_param: z.string().describe('the action param that takes each record id, e.g. "id"'),
      params_json: z.string().optional().describe('JSON object of extra params shared by every call'),
    }),
    execute: async ({ ref, action: actionName, id_param, params_json }): Promise<string> => {
      const slug = actionName.replace('__', '.');
      const target = registry.get(slug);
      if (!target) return `Unknown action "${actionName}" — check the tool name.`;
      if (target.risk === 'read') return `"${actionName}" is a read action — call it directly, apply_to_ref is for writes.`;
      let extra: Record<string, unknown> = {};
      if (params_json !== undefined && params_json !== '') {
        try {
          const parsed: unknown = JSON.parse(params_json);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed as Record<string, unknown>;
        } catch {
          return 'params_json is not valid JSON — fix it and retry.';
        }
      }
      const { rows, complete, total } = hydrateRows(ref);
      if (!complete) {
        return `The set behind ${ref} is incomplete on the server — a bulk write over it would miss records. Narrow the original search instead.`;
      }
      if (total > APPLY_MAX_RECORDS) {
        return `That would affect ${total} records — more than the ${APPLY_MAX_RECORDS}-record limit for one bulk action. Ask the user to narrow the set.`;
      }
      const ids = rows.map(rowId).filter((id): id is string => id !== undefined);

      counters.step += 1;
      const stepId = `s${counters.step}`;
      const noun = target.entities[0] ?? 'record';
      const confirmId = `cf_${randomUUID()}`;
      const scope: ConfirmationScope = {
        actions: [target.slug],
        affectedCount: ids.length,
        targetSample: ids.slice(0, 5),
        description: `${target.name} — ${ids.length} ${pluralNoun(noun, ids.length)}.`,
      };
      markTtfur();
      emit({ t: 'confirmation.required', turnId, confirmId, planRev: 0, planHash: input.planHash, stepId, scope });
      const gateStartedAt = performance.now();
      const approved = await confirm.request({ turnId, confirmId, planRev: 0, planHash: input.planHash, stepId, scope });
      counters.gateWaitMs += performance.now() - gateStartedAt;
      emit({ t: 'confirmation.resolved', turnId, confirmId, approved });
      if (!approved) {
        exits.denied = true;
        return `DENIED by the user — "${target.name}" was NOT executed for any of the ${ids.length} records. Nothing was changed; say so plainly.`;
      }

      emit({ t: 'step.started', turnId, stepId, action: target.slug, resolvedParams: [{ ref, id_param, count: ids.length }] });
      const startedAt = performance.now();
      let ok = 0;
      const errors: string[] = [];
      for (const [i, id] of ids.entries()) {
        const params = { ...extra, [id_param]: id };
        const parsed = target.inputSchema.safeParse(coerceDateParams(params, clock.now()).params);
        if (!parsed.success) {
          errors.push(`${id}: invalid params`);
          continue;
        }
        try {
          await crm.tx((db) =>
            target.handler(parsed.data as Record<string, unknown>, { db, clock, idempotencyKey: `${turnId}:0:${stepId}:${i}`, format: 'concise' } satisfies ActionContext),
          );
          ok += 1;
        } catch (err) {
          const e = describeError(err);
          if (errors.length < 5) errors.push(`${id}: ${e.code}`);
        }
      }
      const ms = performance.now() - startedAt;
      const failed = ids.length - ok;
      if (ok > 0) {
        counters.stepsOk += 1;
        exits.writesLanded += ok;
        exits.writeActions.set(target.name, (exits.writeActions.get(target.name) ?? 0) + ok);
      }
      if (failed > 0 && ok === 0) counters.stepsFailed += 1;
      emit({ t: 'step.finished', turnId, stepId, summary: `${target.name}: ${ok}/${ids.length} ${pluralNoun(noun, ids.length)} processed`, ms });
      return `Applied "${target.name}" to ${ids.length} ${pluralNoun(noun, ids.length)}: ${ok} succeeded, ${failed} failed${errors.length > 0 ? ` (examples: ${errors.join('; ')})` : ''}.`;
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

  tools.push(searchActions, sortRef, filterRef, aggregateRef, applyToRef, askUser, refuse);
  return tools;
}
