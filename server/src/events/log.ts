/**
 * EventLog (LLD §2.3, §3.1): append-only typed event stream per session,
 * persisted to `sessions.db`'s `events` table — EXCEPT `answer.delta`, which
 * is SSE-only and only fanned out to live subscribers, never written.
 *
 * `seq` is monotonic per session (gaps where unpersisted `answer.delta`
 * events were fanned out are expected and harmless — `list`/`afterSeq`
 * pagination only ever sees persisted rows).
 */

import { randomUUID } from 'node:crypto';
import { openSessions, sessionsDbPath, type SessionsDb } from '../store/sessions-db.js';
import { VirtualClock, wallClockNow } from '../store/clock.js';
import type { Event } from './types.js';

export interface SeqEvent {
  seq: number;
  event: Event;
}

/** Row shape of `GET /api/sessions` (LLD §6) — snake_case matches the wire contract. */
export interface SessionRow {
  id: string;
  title: string | null;
  updated_at: number;
  turns: number;
  cost_usd: number;
}

export interface TouchSessionDeltas {
  turns?: number;
  tokens?: number;
  costUsd?: number;
}

export interface EventLog {
  append(sessionId: string, ev: Event): number;
  list(sessionId: string, afterSeq?: number): SeqEvent[];
  subscribe(sessionId: string, cb: (seqEv: SeqEvent) => void): () => void;
  createSession(title?: string): string;
  listSessions(limit?: number, cursor?: string): SessionRow[];
  /** Cross-session full-text-ish search: matches sessions whose title OR whose
   * user-message / final-answer text contains `query`. Newest-first, capped at
   * `limit`. An empty/whitespace query returns `[]`. */
  searchSessions(query: string, limit?: number): SessionRow[];
  /** Hard-deletes a session and everything derived from it (events, refs,
   * spans, memory flags) — but NOT durable `memories`, which are user-scoped
   * facts the memory layer soft-invalidates, never hard-deletes. `changes` is
   * 1 when a row was removed, 0 for an unknown id (drives a 404). */
  deleteSession(sessionId: string): { changes: number };
  touchSession(sessionId: string, deltas: TouchSessionDeltas): void;
  close(): void;
}

type Subscriber = (seqEv: SeqEvent) => void;

function rowToSeqEvent(row: Record<string, unknown>): SeqEvent {
  return { seq: Number(row['seq']), event: JSON.parse(String(row['payload'])) as Event };
}

function rowToSessionRow(row: Record<string, unknown>): SessionRow {
  return {
    id: String(row['id']),
    title: row['title'] == null ? null : String(row['title']),
    updated_at: Number(row['updated_at']),
    turns: Number(row['turns']),
    cost_usd: Number(row['cost_usd']),
  };
}

/** Escapes the LIKE metacharacters (`%`, `_`, and the escape char itself) so a
 * query is matched literally — critical for CRM ids like `con_12018`, where a
 * raw `_` would otherwise act as a single-char wildcard. Pairs with
 * `ESCAPE '\'` in the query. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

class EventLogImpl implements EventLog {
  private readonly db: SessionsDb;
  private readonly clock = new VirtualClock();
  /** REAL wall-clock for session bookkeeping (created_at/updated_at). The
   * VirtualClock is pinned (VIRTUAL_NOW) for the agent's CRM reasoning;
   * using it for session rows collapsed every session to one date and broke
   * the sidebar's date + newest-first ordering. Injectable for tests. */
  private readonly wallNow: () => number;
  private readonly nextSeq = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(dbPath: string, wallNow: () => number = wallClockNow) {
    this.db = openSessions(dbPath);
    this.wallNow = wallNow;
  }

  private peekNextSeq(sessionId: string): number {
    const cached = this.nextSeq.get(sessionId);
    if (cached !== undefined) return cached;
    const row = this.db.get(
      `SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events WHERE session_id = ?`,
      [sessionId],
    );
    const maxSeq = row ? Number(row['maxSeq']) : 0;
    return maxSeq + 1;
  }

  append(sessionId: string, ev: Event): number {
    const seq = this.peekNextSeq(sessionId);
    this.nextSeq.set(sessionId, seq + 1);

    if (ev.t !== 'answer.delta') {
      this.db.run(
        `INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)`,
        [sessionId, seq, this.clock.now(), ev.t, JSON.stringify(ev)],
      );
    }

    const seqEv: SeqEvent = { seq, event: ev };
    for (const cb of this.subscribers.get(sessionId) ?? []) cb(seqEv);
    return seq;
  }

  list(sessionId: string, afterSeq = 0): SeqEvent[] {
    const rows = this.db.all(
      `SELECT seq, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
      [sessionId, afterSeq],
    );
    return rows.map(rowToSeqEvent);
  }

  subscribe(sessionId: string, cb: Subscriber): () => void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  createSession(title?: string): string {
    const id = `sess_${randomUUID()}`;
    const now = this.wallNow();
    this.db.run(
      `INSERT INTO sessions (id, title, created_at, updated_at, turns, tokens, cost_usd)
       VALUES (?, ?, ?, ?, 0, 0, 0)`,
      [id, title ?? null, now, now],
    );
    return id;
  }

  listSessions(limit = 50, cursor?: string): SessionRow[] {
    let anchor: { updated_at: number; id: string } | undefined;
    if (cursor !== undefined) {
      const row = this.db.get(`SELECT updated_at, id FROM sessions WHERE id = ?`, [cursor]);
      if (row) anchor = { updated_at: Number(row['updated_at']), id: String(row['id']) };
    }

    const rows = anchor
      ? this.db.all(
          `SELECT id, title, updated_at, turns, cost_usd FROM sessions
           WHERE (updated_at < ?) OR (updated_at = ? AND id < ?)
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
          [anchor.updated_at, anchor.updated_at, anchor.id, limit],
        )
      : this.db.all(
          `SELECT id, title, updated_at, turns, cost_usd FROM sessions
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
          [limit],
        );

    return rows.map(rowToSessionRow);
  }

  searchSessions(query: string, limit = 50): SessionRow[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const pattern = `%${escapeLike(trimmed)}%`;
    const rows = this.db.all(
      `SELECT s.id, s.title, s.updated_at, s.turns, s.cost_usd FROM sessions s
       WHERE s.title LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM events e
            WHERE e.session_id = s.id
              AND e.type IN ('turn.started', 'answer.final')
              AND e.payload LIKE ? ESCAPE '\\'
          )
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT ?`,
      [pattern, pattern, limit],
    );
    return rows.map(rowToSessionRow);
  }

  deleteSession(sessionId: string): { changes: number } {
    // Clear the per-session seq cache so a future append to a (re-created) id
    // doesn't resume from a stale counter.
    this.nextSeq.delete(sessionId);
    // Drop everything derived from the session first, then the row itself.
    // Durable `memories` are intentionally untouched (soft-invalidate design).
    this.db.run(`DELETE FROM events WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM refs WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM spans WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM session_memory_flags WHERE session_id = ?`, [sessionId]);
    return this.db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
  }

  touchSession(sessionId: string, deltas: TouchSessionDeltas): void {
    this.db.run(
      `UPDATE sessions
       SET turns = turns + ?, tokens = tokens + ?, cost_usd = cost_usd + ?, updated_at = ?
       WHERE id = ?`,
      [deltas.turns ?? 0, deltas.tokens ?? 0, deltas.costUsd ?? 0, this.wallNow(), sessionId],
    );
  }

  close(): void {
    this.db.close();
  }
}

/** Open an `EventLog` backed by `sessions.db` (or a custom path for tests). */
export function openEventLog(
  dbPath: string = sessionsDbPath(),
  wallNow?: () => number,
): EventLog {
  return new EventLogImpl(dbPath, wallNow);
}
