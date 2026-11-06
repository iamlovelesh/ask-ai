/**
 * MemoryStore (design §4.2) — CRUD + settings over the durable session-domain
 * `memories` / `memory_settings` / `session_memory_flags` tables
 * (`store/sessions-db.ts`). Modeled on `agent/refs.ts`'s `RefStoreImpl`:
 * a thin accessor over one `SessionsDb` handle.
 *
 * Timestamps are WALL-CLOCK (`wallClockNow`), not the pinned VirtualClock —
 * the VirtualClock never ticks, so every memory would share one timestamp
 * and ordering would be meaningless. `now` is injectable for deterministic
 * tests.
 *
 * Soft-invalidate (`invalid_at` + `superseded_by`), never a pipeline hard
 * delete; `remove`/`update` exist only for the user-facing management panel.
 */

import { randomUUID } from 'node:crypto';
import { wallClockNow } from '../store/clock.js';
import type { SessionsDb } from '../store/sessions-db.js';
import type { Memory, MemoryCategory, MemoryKind, MemoryPatch, MemorySource, NewMemory } from './types.js';

export interface MemoryStore {
  listLive(userId: string): Memory[];
  get(id: string): Memory | undefined;
  add(input: NewMemory): Memory;
  supersede(oldId: string, input: NewMemory): Memory;
  invalidate(id: string): void;
  remove(id: string): void;
  update(id: string, patch: MemoryPatch): Memory | undefined;
  isEnabled(userId: string): boolean;
  setEnabled(userId: string, enabled: boolean): void;
  isIncognito(sessionId: string): boolean;
  setIncognito(sessionId: string, incognito: boolean): void;
}

interface MemoryRow {
  id: string;
  user_id: string;
  scope_ref: string | null;
  category: string;
  kind: string;
  key: string | null;
  body: string;
  source: string;
  source_session: string | null;
  source_seq: number | null;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
  invalid_at: number | null;
}

function rowToMemory(row: MemoryRow): Memory {
  const m: Memory = {
    id: row.id,
    userId: row.user_id,
    category: row.category as MemoryCategory,
    kind: row.kind as MemoryKind,
    body: row.body,
    source: row.source as MemorySource,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.scope_ref != null) m.scopeRef = row.scope_ref;
  if (row.key != null) m.key = row.key;
  if (row.source_session != null) m.sourceSession = row.source_session;
  if (row.source_seq != null) m.sourceSeq = Number(row.source_seq);
  if (row.superseded_by != null) m.supersededBy = row.superseded_by;
  if (row.invalid_at != null) m.invalidAt = Number(row.invalid_at);
  return m;
}

const COLUMNS =
  'id, user_id, scope_ref, category, kind, key, body, source, source_session, source_seq, created_at, updated_at, superseded_by, invalid_at';

class MemoryStoreImpl implements MemoryStore {
  constructor(
    private readonly db: SessionsDb,
    private readonly now: () => number,
  ) {}

  listLive(userId: string): Memory[] {
    const rows = this.db.all(
      `SELECT ${COLUMNS} FROM memories
         WHERE user_id = ? AND invalid_at IS NULL
         ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((r) => rowToMemory(r as unknown as MemoryRow));
  }

  get(id: string): Memory | undefined {
    const row = this.db.get(`SELECT ${COLUMNS} FROM memories WHERE id = ?`, [id]);
    return row ? rowToMemory(row as unknown as MemoryRow) : undefined;
  }

  add(input: NewMemory): Memory {
    const ts = this.now();
    const id = `mem_${randomUUID()}`;
    this.insert(id, input, ts);
    return this.get(id) as Memory;
  }

  supersede(oldId: string, input: NewMemory): Memory {
    const ts = this.now();
    const id = `mem_${randomUUID()}`;
    // Order matters: the partial unique index on live profile keys means the
    // old live row must be invalidated BEFORE the new one is inserted, or the
    // INSERT collides. One manual transaction so a crash rolls back rather
    // than leaving a fact invalidated with no replacement.
    this.db.run('BEGIN');
    try {
      this.db.run(`UPDATE memories SET invalid_at = ?, superseded_by = ? WHERE id = ?`, [ts, id, oldId]);
      this.insert(id, input, ts);
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    return this.get(id) as Memory;
  }

  private insert(id: string, input: NewMemory, ts: number): void {
    this.db.run(
      `INSERT INTO memories (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.scopeRef ?? null,
        input.category,
        input.kind,
        input.key ?? null,
        input.body,
        input.source,
        input.sourceSession ?? null,
        input.sourceSeq ?? null,
        ts,
        ts,
        null,
        null,
      ],
    );
  }

  invalidate(id: string): void {
    this.db.run(`UPDATE memories SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL`, [this.now(), id]);
  }

  remove(id: string): void {
    this.db.run(`DELETE FROM memories WHERE id = ?`, [id]);
  }

  update(id: string, patch: MemoryPatch): Memory | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const body = patch.body ?? existing.body;
    const category = patch.category ?? existing.category;
    this.db.run(`UPDATE memories SET body = ?, category = ?, updated_at = ? WHERE id = ?`, [
      body,
      category,
      this.now(),
      id,
    ]);
    return this.get(id);
  }

  isEnabled(userId: string): boolean {
    const row = this.db.get(`SELECT enabled FROM memory_settings WHERE user_id = ?`, [userId]);
    if (row === undefined) return true;
    return Number((row as { enabled: number }).enabled) === 1;
  }

  setEnabled(userId: string, enabled: boolean): void {
    this.db.run(
      `INSERT INTO memory_settings (user_id, enabled, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      [userId, enabled ? 1 : 0, this.now()],
    );
  }

  isIncognito(sessionId: string): boolean {
    const row = this.db.get(`SELECT incognito FROM session_memory_flags WHERE session_id = ?`, [sessionId]);
    if (row === undefined) return false;
    return Number((row as { incognito: number }).incognito) === 1;
  }

  setIncognito(sessionId: string, incognito: boolean): void {
    this.db.run(
      `INSERT INTO session_memory_flags (session_id, incognito) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET incognito = excluded.incognito`,
      [sessionId, incognito ? 1 : 0],
    );
  }
}

/** Create a MemoryStore over a `sessions.db` handle. `now` defaults to the
 * wall clock; inject a monotonic counter in tests for deterministic ordering. */
export function createMemoryStore(db: SessionsDb, now: () => number = wallClockNow): MemoryStore {
  return new MemoryStoreImpl(db, now);
}
