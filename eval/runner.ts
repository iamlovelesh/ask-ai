#!/usr/bin/env tsx
/**
 * Eval runner (Task 16, LLD §9.2) — the CLI that drives the REAL HTTP
 * server through every (scenario, trial, agent) tuple, auto-resolving
 * confirmations per each turn's `expect.behavior.confirmation`, evaluating
 * `eval/assert.ts` against the resulting transcript, and writing one JSON
 * line per completed tuple to `results/<runid>/results.jsonl` as it goes.
 *
 * Pure planning (`loadScenarios`/`planTuples`/resume/quick/shard) lives in
 * `eval/runner-tuples.ts`; SSE parsing in `eval/runner-sse.ts`; server
 * spawn/health/template-copy in `eval/runner-process.ts` — this file wires
 * them together and owns the actual HTTP calls (`/admin/reset`,
 * `/admin/inject-failure`, `POST .../messages`, `POST .../confirm/:id`,
 * `GET /api/metrics`).
 *
 * Usage:
 *   tsx eval/runner.ts [--quick] [--resume] [--shard k/m]
 *     [--agent optimized|baseline|both] [--baseline] [--trials N]
 *     [--budget USD] [--server-url URL --profile NAME] [--port N]
 *     [--run-id ID] [--scenarios DIR] [--mock-llm-script PATH]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Event, TurnMetrics } from '../server/src/events/types.js';
import { assertTurn, isComplexTurn } from './assert.js';
import { openReadOnly, type SqlDb } from './db.js';
import type { Scenario } from './types.js';
import {
  type AgentSelection,
  type ResultRow,
  type ShardSpec,
  type Tuple,
  type TurnResultRow,
  budgetExceeded,
  completedTuplesFrom,
  filterUncompleted,
  loadScenarios,
  parseShardSpec,
  planTuples,
  sumResultCost,
  tupleKey,
} from './runner-tuples.js';
import { runOneTurn } from './runner-sse.js';
import { REPO_ROOT, SERVER_DIR, spawnServer, waitForHealth, type SpawnedServer } from './runner-process.js';

// --- CLI args ----------------------------------------------------------------

export interface RunnerOptions {
  quick: boolean;
  resume: boolean;
  shard?: ShardSpec;
  agent: AgentSelection;
  trials: number;
  budgetUsd: number;
  serverUrl?: string;
  profile?: string;
  scenariosDir: string;
  runId: string;
  port: number;
  mockLlmScript?: string;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = argv[idx + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} requires a value`);
  return v;
}

function defaultRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function parseArgs(argv: readonly string[]): RunnerOptions {
  const quick = argv.includes('--quick');
  const resume = argv.includes('--resume');
  const shardRaw = flagValue(argv, '--shard');
  const agentRaw = flagValue(argv, '--agent');
  const baselineFlag = argv.includes('--baseline');
  const agent: AgentSelection = baselineFlag ? 'baseline' : ((agentRaw as AgentSelection | undefined) ?? 'optimized');
  if (!['optimized', 'baseline', 'both'].includes(agent)) {
    throw new Error(`invalid --agent '${agent}' — expected optimized|baseline|both`);
  }
  const trialsRaw = flagValue(argv, '--trials');
  const trials = trialsRaw ? Number(trialsRaw) : 3;
  if (!Number.isFinite(trials) || trials < 1) throw new Error(`invalid --trials '${trialsRaw}'`);

  const budgetRaw = flagValue(argv, '--budget');
  const budgetUsd = budgetRaw ? Number(budgetRaw) : Number(process.env['EVAL_BUDGET_USD'] ?? 25);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error(`invalid --budget '${budgetRaw}'`);

  const shard = shardRaw ? parseShardSpec(shardRaw) : undefined;
  const runId = flagValue(argv, '--run-id') ?? defaultRunId();
  const portRaw = flagValue(argv, '--port');
  const port = portRaw ? Number(portRaw) : 3100 + (shard ? shard.k : 0);

  const serverUrl = flagValue(argv, '--server-url');
  const profile = flagValue(argv, '--profile');
  // MUST be resolved to an absolute path here: the spawned server's cwd is
  // `server/` (runner-process.ts), so a relative path handed to it as-is
  // would be read relative to the WRONG directory inside the child
  // process's `installMockLlmFromEnv()` and fail with ENOENT.
  const mockLlmScriptRaw = flagValue(argv, '--mock-llm-script');
  const mockLlmScript = mockLlmScriptRaw ? resolve(REPO_ROOT, mockLlmScriptRaw) : undefined;

  // Built via conditional spreads (not `field: maybeUndefined`) because
  // `exactOptionalPropertyTypes` makes `shard?: ShardSpec` mean "present
  // with a real value, or absent" — never "present and explicitly
  // `undefined`".
  return {
    quick,
    resume,
    ...(shard ? { shard } : {}),
    agent,
    trials,
    budgetUsd,
    ...(serverUrl ? { serverUrl } : {}),
    ...(profile ? { profile } : {}),
    scenariosDir: resolve(REPO_ROOT, flagValue(argv, '--scenarios') ?? 'eval/scenarios'),
    runId,
    port,
    ...(mockLlmScript ? { mockLlmScript } : {}),
  };
}

export function shardProfileName(runId: string, shard: ShardSpec | undefined): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9-]/g, '-');
  return shard ? `evalrun-${safeRunId}-s${shard.k}` : `evalrun-${safeRunId}`;
}

// --- per-turn / per-tuple execution ------------------------------------------

function zeroMetrics(): TurnMetrics {
  return {
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
}

export interface HttpCtx {
  baseUrl: string;
  db: SqlDb;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function resetServer(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/admin/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`/admin/reset failed: ${res.status} ${await res.text()}`);
}

async function applyInjectFailures(baseUrl: string, scenario: Scenario): Promise<void> {
  for (const fail of scenario.injectFailures ?? []) {
    const res = await postJson(`${baseUrl}/admin/inject-failure`, fail);
    if (res.status !== 204) {
      throw new Error(`/admin/inject-failure failed for '${fail.action}': ${res.status} ${await res.text()}`);
    }
  }
}

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST /api/sessions failed: ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** Runs one scenario turn over the real SSE channel, auto-resolving any
 * confirmation per LLD/brief: approve iff `expect.behavior.confirmation
 * === true`, otherwise deny — and flag the mismatch explicitly (an
 * arriving confirmation when it wasn't expected `true` is ALWAYS a
 * failure, whether or not the scenario bothered to write an explicit
 * `behavior.confirmation: false`). */
async function driveTurn(
  ctx: HttpCtx,
  sessionId: string,
  agent: Tuple['agent'],
  turn: Scenario['turns'][number],
): Promise<{ events: Event[]; unexpectedConfirmation: boolean }> {
  let unexpectedConfirmation = false;
  const expectConfirmation = turn.expect.behavior?.confirmation === true;

  const res = await postJson(`${ctx.baseUrl}/api/sessions/${sessionId}/messages`, { text: turn.user, agent });
  if (!res.ok) throw new Error(`POST .../messages failed: ${res.status} ${await res.text()}`);

  const events = await runOneTurn(res, {
    onConfirmation: async (confirmId) => {
      if (!expectConfirmation) unexpectedConfirmation = true;
      const approved = expectConfirmation;
      const confirmRes = await postJson(`${ctx.baseUrl}/api/sessions/${sessionId}/confirm/${confirmId}`, { approved });
      if (confirmRes.status !== 204) {
        throw new Error(`POST .../confirm/${confirmId} failed: ${confirmRes.status}`);
      }
    },
  });

  return { events, unexpectedConfirmation };
}

export async function runTuple(ctx: HttpCtx, tuple: Tuple): Promise<ResultRow> {
  await resetServer(ctx.baseUrl);
  await applyInjectFailures(ctx.baseUrl, tuple.scenario);
  const sessionId = await createSession(ctx.baseUrl);

  const turnsOut: TurnResultRow[] = [];
  for (let i = 0; i < tuple.scenario.turns.length; i += 1) {
    const turn = tuple.scenario.turns[i] as Scenario['turns'][number];
    const before = turn.expect.state
      ? turn.expect.state.map((c) =>
          c.countDelta === undefined ? undefined : Number(Object.values(ctx.db.get(c.query) ?? {})[0] ?? 0),
        )
      : [];

    const { events, unexpectedConfirmation } = await driveTurn(ctx, sessionId, tuple.agent, turn);
    const assertion = assertTurn(events, turn.expect, ctx.db, before);
    const failures = unexpectedConfirmation
      ? [
          ...assertion.failures,
          {
            kind: 'behavior' as const,
            detail: 'an unexpected confirmation.required arrived (expect.behavior.confirmation was not true) — auto-denied',
          },
        ]
      : assertion.failures;
    const pass = assertion.pass && !unexpectedConfirmation;

    const completed = events.find((e): e is Extract<Event, { t: 'turn.completed' }> => e.t === 'turn.completed');
    const metrics = completed?.metrics ?? zeroMetrics();

    turnsOut.push({
      index: i,
      pass,
      failures,
      status: completed?.status ?? 'unknown',
      complex: isComplexTurn(events),
      ttfurMs: metrics.ttfurMs,
      totalMs: metrics.totalMs,
      llmCalls: metrics.llmCalls,
      repairs: metrics.repairs,
      replans: metrics.replans,
      searchRounds: metrics.searchRounds,
      tokensIn: metrics.tokensIn,
      tokensOut: metrics.tokensOut,
      costUsd: metrics.costUsd,
    });
  }

  return {
    scenarioId: tuple.scenario.id,
    category: tuple.scenario.category,
    ...(tuple.scenario.subtype !== undefined ? { subtype: tuple.scenario.subtype } : {}),
    agent: tuple.agent,
    trial: tuple.trial,
    pass: turnsOut.every((t) => t.pass),
    turns: turnsOut,
    ts: Date.now(),
  };
}

// --- metrics-endpoint cumulative cost (defense in depth alongside JSONL) ----

async function metricsCostTotal(baseUrl: string): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/api/metrics?window=all`);
    if (!res.ok) return 0;
    const body = (await res.json()) as { overall?: { costUsdTotal?: number } };
    return body.overall?.costUsdTotal ?? 0;
  } catch {
    return 0;
  }
}

// --- main ---------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);
  const scenarios = loadScenarios(opts.scenariosDir);
  let tuples = planTuples(scenarios, {
    agent: opts.agent,
    trials: opts.trials,
    quick: opts.quick,
    ...(opts.shard ? { shard: opts.shard } : {}),
  });

  const resultsDir = resolve(REPO_ROOT, 'results', opts.runId);
  mkdirSync(resultsDir, { recursive: true });
  const resultsPath = resolve(resultsDir, 'results.jsonl');

  let previousRows: ResultRow[] = [];
  if (opts.resume && existsSync(resultsPath)) {
    const text = readFileSync(resultsPath, 'utf-8');
    const completed = completedTuplesFrom(text);
    tuples = filterUncompleted(tuples, completed);
    previousRows = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as ResultRow;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is ResultRow => r !== undefined);
  }

  console.log(`[eval] run '${opts.runId}': ${tuples.length} tuple(s) to run, writing to ${resultsPath}`);

  const profile = opts.profile ?? shardProfileName(opts.runId, opts.shard);
  let spawned: SpawnedServer | undefined;
  let baseUrl = opts.serverUrl;

  if (!baseUrl) {
    spawned = spawnServer({ port: opts.port, profile, ...(opts.mockLlmScript ? { mockLlmScript: opts.mockLlmScript } : {}) });
    baseUrl = spawned.baseUrl;
    await waitForHealth(baseUrl);
    console.log(`[eval] spawned server for profile '${profile}' at ${baseUrl}`);
  } else if (!opts.profile) {
    throw new Error('--server-url requires --profile (so /admin/reset targets the right CRM db)');
  }

  const crmPath = resolve(SERVER_DIR, `data/crm-${profile}.db`);
  let cumulativeUsd = sumResultCost(previousRows);
  let completedCount = 0;
  let passCount = 0;

  try {
    for (const tuple of tuples) {
      const metricsTotal = await metricsCostTotal(baseUrl);
      const effectiveUsd = Math.max(cumulativeUsd, sumResultCost(previousRows) + metricsTotal);
      if (budgetExceeded(effectiveUsd, opts.budgetUsd)) {
        console.warn(
          `[eval] budget guard tripped ($${effectiveUsd.toFixed(4)} >= $${opts.budgetUsd}) — aborting with ${tuples.length - completedCount} tuple(s) unrun. Partial results are already on disk at ${resultsPath}.`,
        );
        break;
      }

      const db = openReadOnly(crmPath);
      let row: ResultRow;
      try {
        row = await runTuple({ baseUrl, db }, tuple);
      } finally {
        db.close();
      }

      appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
      cumulativeUsd += row.turns.reduce((sum, t) => sum + t.costUsd, 0);
      completedCount += 1;
      if (row.pass) passCount += 1;
      console.log(
        `[eval] ${tupleKey(row.scenarioId, row.agent, row.trial)} -> ${row.pass ? 'PASS' : 'FAIL'} ` +
          `(${completedCount}/${tuples.length}, cumulative $${cumulativeUsd.toFixed(4)})`,
      );
    }
  } finally {
    if (spawned) await spawned.stop();
  }

  console.log(`[eval] done: ${passCount}/${completedCount} passed. Results: ${resultsPath}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
