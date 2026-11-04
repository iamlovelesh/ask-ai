/**
 * SQLite access layer for the CRM domain (LLD §3.2).
 *
 * Wraps Node's synchronous `node:sqlite` (DatabaseSync). WAL + foreign_keys
 * pragmas enabled. Schema is applied idempotently on every open via `ddl()`,
 * so a fresh DB file (no template) comes up fully structured.
 *
 * A module-level registry tracks the live handle per profile so `resetCrm`
 * (reset.ts) can close → copy template → reopen the same logical connection.
 */

import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ddl } from '../entities/model.js';

export { ddl } from '../entities/model.js';

export type Row = Record<string, unknown>;
export type Params = unknown[] | Record<string, unknown>;

export interface StoreTx {
  all(sql: string, params?: Params): Row[];
  get(sql: string, params?: Params): Row | undefined;
  run(sql: string, params?: Params): { changes: number };
}

export interface Crm {
  tx<T>(fn: (db: StoreTx) => T): T;
  close(): void;
}

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');

/** Absolute path of the DB file for a profile: `server/data/crm-{profile}.db`. */
export function crmDbPath(profile: string): string {
  return resolve(DATA_DIR, `crm-${profile}.db`);
}

const registry = new Map<string, CrmImpl>();

class CrmImpl implements Crm {
  readonly profile: string;
  private readonly db: DatabaseSync;
  private readonly stmtCache = new Map<string, StatementSync>();
  private closed = false;

  constructor(profile: string, filePath: string) {
    this.profile = profile;
    this.db = new DatabaseSync(filePath);
    // WAL for durability/perf; foreign_keys on per LLD §3.2.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const stmt of ddl()) this.db.exec(stmt);
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  private readonly storeTx: StoreTx = {
    all: (sql, params) => this.exec(sql, params, 'all') as Row[],
    get: (sql, params) => this.exec(sql, params, 'get') as Row | undefined,
    run: (sql, params) => this.exec(sql, params, 'run') as { changes: number },
  };

  private exec(sql: string, params: Params | undefined, mode: 'all' | 'get' | 'run'): unknown {
    const stmt = this.prepare(sql);
    const args: unknown[] =
      params === undefined ? [] : Array.isArray(params) ? params : [params];
    if (mode === 'all') return stmt.all(...(args as never[]));
    if (mode === 'get') return stmt.get(...(args as never[]));
    const r = stmt.run(...(args as never[]));
    return { changes: Number(r.changes) };
  }

  tx<T>(fn: (db: StoreTx) => T): T {
    if (this.closed) throw new Error(`CRM handle for '${this.profile}' is closed`);
    this.db.exec('BEGIN');
    try {
      const out = fn(this.storeTx);
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmtCache.clear();
    // Fold the WAL back into the main file so the on-disk bytes are complete
    // and deterministic (template snapshots / reset rely on this).
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // checkpoint can fail if another reader holds the WAL; close anyway.
    }
    this.db.close();
    if (registry.get(this.profile) === this) registry.delete(this.profile);
  }
}

/**
 * Open (or re-open) the CRM store for a profile. Any previously open handle for
 * the same profile is closed first, so there is exactly one live connection per
 * profile — the invariant `resetCrm` depends on.
 */
export function openCrm(profile: string = 'standard'): Crm {
  mkdirSync(DATA_DIR, { recursive: true });
  const existing = registry.get(profile);
  if (existing) existing.close();
  const crm = new CrmImpl(profile, crmDbPath(profile));
  registry.set(profile, crm);
  return crm;
}

/** Internal: close and drop the registered handle for a profile, if any. */
export function closeRegistered(profile: string): void {
  registry.get(profile)?.close();
}
