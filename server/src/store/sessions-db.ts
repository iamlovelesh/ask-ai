/**
 * Lightweight sqlite opener for the SESSION domain (LLD §3.1): sessions live
 * in their OWN file, `server/data/sessions.db`, separate from the CRM domain
 * (`db.ts`'s `Crm`/registry machinery, which is specific to the resettable
 * CRM profiles). Schema: `sessions`, `events`, `refs`, `spans`.
 *
 * Deliberately simpler than `db.ts`: no reset/registry semantics are needed
 * here (sessions are durable, never template-reset). `events/log.ts` and
 * `events/trace.ts` each open their own `DatabaseSync` handle onto the same
 * file via `openSessions()` — node:sqlite + WAL tolerates multiple
 * same-process handles onto one file, and DDL is idempotent
 * (`CREATE TABLE/INDEX IF NOT EXISTS`).
 */

import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Row = Record<string, unknown>;
export type Params = unknown[] | Record<string, unknown>;

export interface SessionsDb {
  all(sql: string, params?: Params): Row[];
  get(sql: string, params?: Params): Row | undefined;
  run(sql: string, params?: Params): { changes: number };
  close(): void;
}

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');

/** Absolute path of the default sessions DB file: `server/data/sessions.db`. */
export function sessionsDbPath(): string {
  return resolve(DATA_DIR, 'sessions.db');
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     title TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     turns INTEGER NOT NULL DEFAULT 0,
     tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at)`,
  // `events` excludes `answer.delta` (LLD §3.1) — enforced by log.ts, not here.
  `CREATE TABLE IF NOT EXISTS events (
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     ts INTEGER NOT NULL,
     type TEXT NOT NULL,
     payload TEXT NOT NULL,
     PRIMARY KEY (session_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq)`,
  // id_list/query/sample only — NOT full row payloads (LLD §3.1).
  `CREATE TABLE IF NOT EXISTS refs (
     session_id TEXT NOT NULL,
     ref TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     action TEXT NOT NULL,
     entity_type TEXT NOT NULL,
     total INTEGER NOT NULL,
     id_list TEXT NOT NULL,
     query TEXT,
     sample TEXT NOT NULL,
     stale INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, ref)
   )`,
  `CREATE TABLE IF NOT EXISTS spans (
     id TEXT PRIMARY KEY,
     turn_id TEXT NOT NULL,
     session_id TEXT,
     kind TEXT NOT NULL,
     name TEXT,
     started_at INTEGER NOT NULL,
     ended_at INTEGER,
     ms REAL,
     tokens_in INTEGER,
     tokens_out INTEGER,
     cost_usd REAL,
     meta TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_spans_turn ON spans (turn_id)`,
];

class SessionsDbImpl implements SessionsDb {
  private readonly db: DatabaseSync;
  private readonly stmtCache = new Map<string, StatementSync>();
  private closed = false;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const stmt of SCHEMA) this.db.exec(stmt);
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  private exec(sql: string, params: Params | undefined, mode: 'all' | 'get' | 'run'): unknown {
    const stmt = this.prepare(sql);
    const args: unknown[] =
      params === undefined ? [] : Array.isArray(params) ? params : [params];
    if (mode === 'all') return stmt.all(...(args as never[]));
    if (mode === 'get') return stmt.get(...(args as never[]));
    const r = stmt.run(...(args as never[]));
    return { changes: Number(r.changes) };
  }

  all(sql: string, params?: Params): Row[] {
    return this.exec(sql, params, 'all') as Row[];
  }

  get(sql: string, params?: Params): Row | undefined {
    return this.exec(sql, params, 'get') as Row | undefined;
  }

  run(sql: string, params?: Params): { changes: number } {
    return this.exec(sql, params, 'run') as { changes: number };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmtCache.clear();
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // checkpoint can fail if another reader holds the WAL; close anyway.
    }
    this.db.close();
  }
}

/** Open a fresh handle onto the sessions DB file (defaults to `sessions.db`). */
export function openSessions(dbPath: string = sessionsDbPath()): SessionsDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  return new SessionsDbImpl(dbPath);
}
