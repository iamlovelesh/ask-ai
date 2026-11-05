/**
 * Spans (LLD §2.4): llm | retrieval | step | joiner | compose, carrying
 * tokens/cost/ms, persisted to the `spans` table in the session domain DB
 * (`sessions.db`, opened via `store/sessions-db.ts`).
 */

import { randomUUID } from 'node:crypto';
import { openSessions, sessionsDbPath, type SessionsDb } from '../store/sessions-db.js';
import { VirtualClock } from '../store/clock.js';

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

/** Input to `Spans.start` — everything except the generated id. */
export interface SpanStart {
  turnId: string;
  sessionId?: string;
  kind: SpanKind;
  name?: string;
  startedAt?: number;
  meta?: Record<string, unknown>;
}

/** Fields `Spans.end` may update when a span completes. */
export interface SpanEndPatch {
  endedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  meta?: Record<string, unknown>;
}

/** Opaque handle returned by `start`, passed back into `end`. */
export interface SpanHandle {
  id: string;
  turnId: string;
  startedAt: number;
}

export interface Spans {
  start(partial: SpanStart): SpanHandle;
  end(handle: SpanHandle, patch?: SpanEndPatch): void;
  forTurn(turnId: string): Span[];
  close(): void;
}

function rowToSpan(row: Record<string, unknown>): Span {
  const span: Span = {
    id: String(row['id']),
    turnId: String(row['turn_id']),
    kind: row['kind'] as SpanKind,
    startedAt: Number(row['started_at']),
  };
  if (row['session_id'] != null) span.sessionId = String(row['session_id']);
  if (row['name'] != null) span.name = String(row['name']);
  if (row['ended_at'] != null) span.endedAt = Number(row['ended_at']);
  if (row['ms'] != null) span.ms = Number(row['ms']);
  if (row['tokens_in'] != null) span.tokensIn = Number(row['tokens_in']);
  if (row['tokens_out'] != null) span.tokensOut = Number(row['tokens_out']);
  if (row['cost_usd'] != null) span.costUsd = Number(row['cost_usd']);
  if (row['meta'] != null) span.meta = JSON.parse(String(row['meta'])) as Record<string, unknown>;
  return span;
}

class SpansImpl implements Spans {
  private readonly db: SessionsDb;
  private readonly clock = new VirtualClock();

  constructor(dbPath: string) {
    this.db = openSessions(dbPath);
  }

  start(partial: SpanStart): SpanHandle {
    const id = `span_${randomUUID()}`;
    const startedAt = partial.startedAt ?? this.clock.now();
    this.db.run(
      `INSERT INTO spans (id, turn_id, session_id, kind, name, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        partial.turnId,
        partial.sessionId ?? null,
        partial.kind,
        partial.name ?? null,
        startedAt,
      ],
    );
    return { id, turnId: partial.turnId, startedAt };
  }

  end(handle: SpanHandle, patch: SpanEndPatch = {}): void {
    const endedAt = patch.endedAt ?? this.clock.now();
    const ms = endedAt - handle.startedAt;
    const meta = patch.meta !== undefined ? JSON.stringify(patch.meta) : null;
    this.db.run(
      `UPDATE spans
       SET ended_at = ?, ms = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, meta = ?
       WHERE id = ?`,
      [
        endedAt,
        ms,
        patch.tokensIn ?? null,
        patch.tokensOut ?? null,
        patch.costUsd ?? null,
        meta,
        handle.id,
      ],
    );
  }

  forTurn(turnId: string): Span[] {
    // Order by sqlite's implicit rowid (insertion order) rather than
    // `started_at` — the virtual clock can return the same pinned value for
    // multiple spans started within the same tick, which would make
    // `started_at`-based ordering unstable.
    const rows = this.db.all(
      `SELECT rowid, * FROM spans WHERE turn_id = ? ORDER BY rowid ASC`,
      [turnId],
    );
    return rows.map(rowToSpan);
  }

  close(): void {
    this.db.close();
  }
}

/** Open a `Spans` instance backed by `sessions.db` (or a custom path for tests). */
export function openSpans(dbPath: string = sessionsDbPath()): Spans {
  return new SpansImpl(dbPath);
}

// --- shared default sink -----------------------------------------------
//
// Every span-writing call site in the process — `llm/client.ts`'s
// `llmCall` (kind:'llm'), `agent/pipeline.ts`'s retrieval/compose/joiner
// spans, `agent/executor.ts`'s step spans (threaded in via
// `ExecuteInput.spans`, since the executor itself stays LLM/DB-handle-free
// by design), and `baseline/agent.ts`'s step spans — shares ONE lazily
// opened `Spans` instance rather than each module opening its own
// connection onto the same `sessions.db` file. This keeps a single
// `__setTestSpans` override (already used by existing tests, e.g.
// `api.test.ts`) redirecting every one of them at once, rather than needing
// a per-module test seam.

let defaultSpans: Spans | undefined;

/** The process-wide default `Spans` sink, opened on first use against
 * `sessionsDbPath()` unless `__setTestSpans` has swapped it for a test
 * instance. */
export function getDefaultSpans(): Spans {
  if (!defaultSpans) defaultSpans = openSpans();
  return defaultSpans;
}

/** Test-only: override (or clear, passing `undefined`) the shared default
 * `Spans` sink between test files. Re-exported verbatim from
 * `llm/client.ts` for existing call sites that import it from there. */
export function __setTestSpans(spans: Spans | undefined): void {
  defaultSpans = spans;
}
