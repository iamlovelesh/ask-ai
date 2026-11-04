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
import { VirtualClock } from '../store/clock.js';
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
  touchSession(sessionId: string, deltas: TouchSessionDeltas): void;
  close(): void;
}

type Subscriber = (seqEv: SeqEvent) => void;

function rowToSeqEvent(row: Record<string, unknown>): SeqEvent {
  return { seq: Number(row['seq']), event: JSON.parse(String(row['payload'])) as Event };
}

class EventLogImpl implements EventLog {
  private readonly db: SessionsDb;
  private readonly clock = new VirtualClock();
  private readonly nextSeq = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(dbPath: string) {
    this.db = openSessions(dbPath);
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
    const now = this.clock.now();
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

    return rows.map((row) => ({
      id: String(row['id']),
      title: row['title'] == null ? null : String(row['title']),
      updated_at: Number(row['updated_at']),
      turns: Number(row['turns']),
      cost_usd: Number(row['cost_usd']),
    }));
  }

  touchSession(sessionId: string, deltas: TouchSessionDeltas): void {
    this.db.run(
      `UPDATE sessions
       SET turns = turns + ?, tokens = tokens + ?, cost_usd = cost_usd + ?, updated_at = ?
       WHERE id = ?`,
      [deltas.turns ?? 0, deltas.tokens ?? 0, deltas.costUsd ?? 0, this.clock.now(), sessionId],
    );
  }

  close(): void {
    this.db.close();
  }
}

/** Open an `EventLog` backed by `sessions.db` (or a custom path for tests). */
export function openEventLog(dbPath: string = sessionsDbPath()): EventLog {
  return new EventLogImpl(dbPath);
}
