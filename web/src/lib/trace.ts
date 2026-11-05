/**
 * Client-side mirror of the `Span` row shape persisted by
 * `server/src/events/trace.ts` and returned by `GET /api/traces/:turnId` as
 * `{spans: Span[]}` (LLD §2.4/§6). Kept in sync by hand, same convention as
 * `lib/events.ts` — the web build never imports server code.
 *
 * NOTE on what this endpoint actually returns (verified by reading
 * `server/src/events/trace.ts`, `server/src/llm/client.ts`,
 * `server/src/agent/pipeline.ts`, `server/src/agent/executor.ts`, and
 * `server/src/baseline/agent.ts`, not assumed): every `SpanKind` (`llm` |
 * `retrieval` | `step` | `joiner` | `compose`) is now actually written —
 * `llmCall()` writes `kind:'llm'` (one per planner/repair/replan/search/
 * joiner LLM call, `name` set to the call's `stage`), `agent/pipeline.ts`
 * writes `kind:'retrieval'` and `kind:'compose'` around its retrieval and
 * composer calls plus `kind:'joiner'` around a checkpoint violation's
 * repair/decision (never around the free-pass case), and `agent/
 * executor.ts`/`baseline/agent.ts` write `kind:'step'` around each
 * dispatched step. There is still no `parentId` field on the row (spans
 * are flat, ordered by insertion only), no `model` column (the model name
 * lives on the `plan.ready`/`repair`/etc. *event*'s `llm.model`, never
 * written back onto the span), and no `tokensCached`. `layoutSpans` below
 * works honestly with exactly what is persisted — it does not invent
 * parent/model data the server never recorded.
 */

export type SpanKind = 'llm' | 'retrieval' | 'step' | 'joiner' | 'compose';

export interface Span {
  id: string;
  turnId: string;
  sessionId?: string;
  kind: SpanKind;
  name?: string;
  startedAt: number;
  endedAt?: number;
  ms?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  meta?: Record<string, unknown>;
}

export type SpanStatus = 'done' | 'failed' | 'running';

export interface SpanBar {
  span: Span;
  /** `span.name` (the LLM call's `stage`, e.g. `"plan"`/`"repair"`) falling
   * back to `span.kind` when no name was recorded. */
  label: string;
  status: SpanStatus;
  /** Percent offset from the turn's earliest span start, 0-100. */
  leftPct: number;
  /** Percent width relative to the turn's full span range, clamped to a
   * visible minimum so a near-zero-duration span still renders as a sliver
   * instead of vanishing, and never pushed past the right edge. */
  widthPct: number;
}

/** Visible minimum bar width, in percent of the track — purely cosmetic. */
const MIN_WIDTH_PCT = 1.5;

/**
 * Normalizes a turn's spans (already ordered by insertion, per
 * `Spans.forTurn`) into percentage-offset bars for a pure-CSS waterfall.
 * Spans with no `endedAt` (the call crashed before `Spans.end` ran, or is
 * still mid-flight) are drawn out to the track's right edge so they read as
 * visibly "open" rather than being assumed zero-width.
 */
export function layoutSpans(spans: readonly Span[]): SpanBar[] {
  if (spans.length === 0) return [];

  const starts = spans.map((s) => s.startedAt);
  const ends = spans.map((s) => s.endedAt ?? s.startedAt);
  const rangeStart = Math.min(...starts);
  const rangeEnd = Math.max(...ends);
  const totalMs = Math.max(rangeEnd - rangeStart, 1);

  return spans.map((span) => {
    const rawLeftPct = ((span.startedAt - rangeStart) / totalMs) * 100;
    const leftPct = Math.min(Math.max(rawLeftPct, 0), 100);
    const rawWidthPct =
      span.endedAt !== undefined ? ((span.endedAt - span.startedAt) / totalMs) * 100 : 100 - leftPct;
    const widthPct = Math.max(Math.min(rawWidthPct, 100 - leftPct), Math.min(MIN_WIDTH_PCT, 100 - leftPct));
    const status: SpanStatus =
      span.meta?.['error'] !== undefined ? 'failed' : span.endedAt === undefined ? 'running' : 'done';
    return { span, label: span.name ?? span.kind, status, leftPct, widthPct };
  });
}
