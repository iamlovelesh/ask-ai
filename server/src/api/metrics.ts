/**
 * Observability routes (LLD §6): `GET /api/traces/:turnId` (the raw span
 * waterfall, `Spans.forTurn`) and `GET /api/metrics?window` (p50/p95
 * ttfur+e2e aggregates by status/agent, plus cost totals — computed from
 * `turn.completed` events across every session, LLD §9.2's TTFUR/E2E
 * fields already live on `TurnMetrics`, so no separate span-walking is
 * needed for the percentiles; `spans` would only be consulted for a
 * per-stage cost breakdown, which this endpoint does not attempt).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { VirtualClock } from '../store/clock.js';
import type { TurnStatus } from '../events/types.js';
import type { AgentKind } from './turn-runtime.js';
import type { AppDeps } from './types.js';

interface TraceParams {
  turnId: string;
}

// --- window parsing ----------------------------------------------------------

const WINDOW_RE = /^(\d+)(m|h|d)$/;

/** `"15m" | "1h" | "24h" | "7d" | "all"` (default `"24h"`) → ms, or
 * `undefined` for `"all"`/unparseable (treated as no filter — honest degrade
 * rather than a 400 for a cosmetic query param). */
function parseWindowMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw === 'all' || raw.length === 0) return undefined;
  const m = WINDOW_RE.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

// --- percentile + bucket aggregation -----------------------------------------

interface TurnSample {
  status: TurnStatus;
  agent: AgentKind;
  ttfurMs: number;
  totalMs: number;
  costUsd: number;
}

interface MetricsBucket {
  count: number;
  p50TtfurMs: number;
  p95TtfurMs: number;
  p50E2eMs: number;
  p95E2eMs: number;
  costUsdTotal: number;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx] as number;
}

/** Every value here is guaranteed finite — `TurnMetrics` fields are always
 * finite by construction (LLD §5 budget tracker never divides, never reads
 * `NaN`-producing sources), and an empty bucket reports zeros rather than
 * `NaN`/`Infinity` (the "finite aggregates" contract this endpoint's test
 * is pinned to). */
function bucketFor(samples: readonly TurnSample[]): MetricsBucket {
  const ttfur = samples.map((s) => s.ttfurMs).sort((a, b) => a - b);
  const total = samples.map((s) => s.totalMs).sort((a, b) => a - b);
  const costUsdTotal = samples.reduce((sum, s) => sum + s.costUsd, 0);
  return {
    count: samples.length,
    p50TtfurMs: percentile(ttfur, 0.5),
    p95TtfurMs: percentile(ttfur, 0.95),
    p50E2eMs: percentile(total, 0.5),
    p95E2eMs: percentile(total, 0.95),
    costUsdTotal: Number.isFinite(costUsdTotal) ? costUsdTotal : 0,
  };
}

function groupBy<K extends string>(samples: readonly TurnSample[], keyOf: (s: TurnSample) => K): Record<K, MetricsBucket> {
  const groups = new Map<K, TurnSample[]>();
  for (const s of samples) {
    const k = keyOf(s);
    const bucket = groups.get(k);
    if (bucket) bucket.push(s);
    else groups.set(k, [s]);
  }
  const out: Record<string, MetricsBucket> = {};
  for (const [k, group] of groups) out[k] = bucketFor(group);
  return out as Record<K, MetricsBucket>;
}

/** Collects one `TurnSample` per `turn.completed` event across every
 * session, filtered to `turn.started`-timestamp >= now - windowMs (when a
 * window was given). Caps at `SESSION_SCAN_LIMIT` sessions — large enough
 * for this assignment's scope; a production deployment would paginate or
 * maintain a denormalized metrics table instead of refolding every
 * session's full event history on every request. */
const SESSION_SCAN_LIMIT = 2000;

function collectSamples(deps: AppDeps, windowMs: number | undefined): TurnSample[] {
  const { eventLog, runtime } = deps;
  // `turn.started.ts` is stamped from the pinned `VirtualClock` (LLD §10's
  // `VIRTUAL_NOW`), never real wall-clock time — the window cutoff must be
  // computed in the SAME clock domain or it would never match anything.
  const cutoff = windowMs === undefined ? undefined : new VirtualClock().now() - windowMs;
  const samples: TurnSample[] = [];

  for (const row of eventLog.listSessions(SESSION_SCAN_LIMIT)) {
    const startedAtByTurn = new Map<string, number>();
    for (const { event } of eventLog.list(row.id)) {
      if (event.t === 'turn.started') {
        startedAtByTurn.set(event.turnId, event.ts);
        continue;
      }
      if (event.t !== 'turn.completed') continue;
      const startedAt = startedAtByTurn.get(event.turnId);
      if (cutoff !== undefined && startedAt !== undefined && startedAt < cutoff) continue;
      samples.push({
        status: event.status,
        agent: runtime.agentFor(event.turnId),
        ttfurMs: event.metrics.ttfurMs,
        totalMs: event.metrics.totalMs,
        costUsd: event.metrics.costUsd,
      });
    }
  }
  return samples;
}

export function registerMetricsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { spans } = deps;

  app.get('/api/traces/:turnId', async (req: FastifyRequest<{ Params: TraceParams }>, reply) => {
    const { turnId } = req.params;
    reply.send({ spans: spans.forTurn(turnId) });
  });

  app.get('/api/metrics', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const windowRaw = typeof query['window'] === 'string' ? query['window'] : undefined;
    const windowMs = parseWindowMs(windowRaw);

    const samples = collectSamples(deps, windowMs);

    reply.send({
      window: windowRaw ?? '24h',
      overall: bucketFor(samples),
      byStatus: groupBy(samples, (s) => s.status),
      byAgent: groupBy(samples, (s) => s.agent),
    });
  });
}
