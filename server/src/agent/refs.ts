/**
 * RefStore (LLD §2.5, §3.1) — storage + resolution for `RefHandle`s, the
 * durable cross-turn/cross-step pointers the executor hands back whenever a
 * result set is too large to inline into planner context (a `__spill`
 * marker) or must survive into a later turn (WorkingState handles).
 *
 * Storage: the session-domain `refs` table (`sessions.db`), scoped to one
 * session. Only `id_list` / `query` / `sample` are persisted — NEVER full row
 * payloads (LLD §3.1: full-row storage contradicts the
 * data-volume-independence claim).
 *
 * Resolution semantics are NORMATIVE (LLD §2.5): a ref resolves by
 * RE-CHECKING EXISTENCE of its `idList` against the CRM store AT USE TIME
 * (`SELECT id FROM <table for entityType> WHERE id IN (...)`), never from a
 * frozen snapshot. Drift (ids that no longer exist) is reported, not hidden —
 * the executor surfaces "170 of 200 still match" into the confirmation scope
 * / step summary, and drift on a gated step carries a note into the
 * confirmation description.
 */

import type { StoreTx } from '../store/db.js';
import type { SessionsDb } from '../store/sessions-db.js';
import type { RefHandle } from '../events/types.js';
import { VirtualClock } from '../store/clock.js';
import { ENTITY_MODEL } from '../entities/model.js';

export type { RefHandle } from '../events/types.js';

/** Max number of ids stored inline in a handle; larger sets elide `idList`
 * and store the `query` descriptor instead (LLD §2.5). */
export const REF_IDLIST_CAP = 10_000;

/** The input to `put` — everything a `RefHandle` carries except the `ref`
 * id (the store mints `r_t<T>_s<N>` from `turnId`+`stepId`) and `stale`
 * (storage concern). `stepId` is consumed to compute the ref id and is NOT a
 * `RefHandle` field itself (LLD §2.5). */
export interface NewRefHandle {
  action: string;
  turnId: string;
  stepId: string;
  entityType: string;
  total: number;
  idList: string[];
  query?: object;
  sample: unknown[];
}

/** Drift-aware resolution result (LLD §2.5). `ids` = survivors still present
 * in the store; `missing` = how many checked ids no longer exist; `total` =
 * the handle's original true total. */
export interface ResolveResult {
  ids: string[];
  missing: number;
  total: number;
}

export interface RefStore {
  put(h: NewRefHandle): RefHandle;
  get(ref: string): RefHandle | undefined;
  resolve(ref: string, tx: StoreTx): ResolveResult;
  /** Mark every ref for a session stale (the `/admin/reset` path — LLD §3.2).
   * Defaults to this store's own session when `sessionId` is omitted. */
  markAllStale(sessionId?: string): void;
}

// --- entityType → physical table mapping (for the existence re-check) -------

const TABLE_NAMES: ReadonlySet<string> = new Set(ENTITY_MODEL.map((t) => t.name));

/**
 * Map a handle's `entityType` to the physical table whose `id` column the
 * existence re-check queries. Handlers set `entityType` from their
 * `ActionDef.entities[0]` (plural table names, e.g. `'leads'`), so the common
 * case is an exact hit. Tolerates a singular form (`'lead'` → `'leads'`).
 * Returns `undefined` when no table can be identified — in that case
 * existence cannot be verified and the caller treats every id as surviving.
 */
function tableForEntityType(entityType: string): string | undefined {
  if (TABLE_NAMES.has(entityType)) return entityType;
  if (TABLE_NAMES.has(`${entityType}s`)) return `${entityType}s`;
  return undefined;
}

// --- ref id minting ---------------------------------------------------------

/** First run of digits in `s`, or `'0'` when there are none (keeps the ref
 * id grammar `r_t<T>_s<N>` well-formed even for non-numeric ids). */
function digits(s: string): string {
  return s.match(/\d+/)?.[0] ?? '0';
}

function mintRef(turnId: string, stepId: string): string {
  return `r_t${digits(turnId)}_s${digits(stepId)}`;
}

// --- implementation ---------------------------------------------------------

interface RefRow {
  ref: string;
  turn_id: string;
  action: string;
  entity_type: string;
  total: number;
  id_list: string;
  query: string | null;
  sample: string;
  stale: number;
}

function rowToHandle(row: RefRow): RefHandle {
  const handle: RefHandle = {
    ref: row.ref,
    action: row.action,
    turnId: row.turn_id,
    entityType: row.entity_type,
    total: Number(row.total),
    idList: JSON.parse(row.id_list) as string[],
    sample: JSON.parse(row.sample) as unknown[],
  };
  if (row.query != null) handle.query = JSON.parse(row.query) as object;
  if (Number(row.stale) === 1) handle.stale = true;
  return handle;
}

class RefStoreImpl implements RefStore {
  private readonly clock = new VirtualClock();

  constructor(
    private readonly db: SessionsDb,
    private readonly sessionId: string,
  ) {}

  put(h: NewRefHandle): RefHandle {
    const ref = mintRef(h.turnId, h.stepId);
    // Sets over the cap elide the id list (store the query descriptor
    // instead); resolution then re-runs `query` rather than re-checking ids.
    const idList = h.idList.length > REF_IDLIST_CAP ? [] : h.idList;
    const handle: RefHandle = {
      ref,
      action: h.action,
      turnId: h.turnId,
      entityType: h.entityType,
      total: h.total,
      idList,
      sample: h.sample,
    };
    if (h.query !== undefined) handle.query = h.query;

    this.db.run(
      `INSERT OR REPLACE INTO refs
         (session_id, ref, turn_id, action, entity_type, total, id_list, query, sample, stale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        this.sessionId,
        ref,
        h.turnId,
        h.action,
        h.entityType,
        h.total,
        JSON.stringify(idList),
        h.query === undefined ? null : JSON.stringify(h.query),
        JSON.stringify(h.sample),
        this.clock.now(),
      ],
    );
    return handle;
  }

  get(ref: string): RefHandle | undefined {
    const row = this.db.get(
      `SELECT ref, turn_id, action, entity_type, total, id_list, query, sample, stale
         FROM refs WHERE session_id = ? AND ref = ?`,
      [this.sessionId, ref],
    );
    return row ? rowToHandle(row as unknown as RefRow) : undefined;
  }

  resolve(ref: string, tx: StoreTx): ResolveResult {
    const handle = this.get(ref);
    if (!handle) return { ids: [], missing: 0, total: 0 };

    const checkIds =
      handle.idList.length > 0 ? handle.idList : this.idsFromQuery(handle, tx);
    if (checkIds.length === 0) {
      return { ids: [], missing: 0, total: handle.total };
    }

    const table = tableForEntityType(handle.entityType);
    if (table === undefined) {
      // Cannot identify a table → cannot verify existence; treat all as
      // surviving rather than falsely reporting total drift.
      return { ids: [...checkIds], missing: 0, total: handle.total };
    }

    const present = this.existingIds(table, checkIds, tx);
    const survivors = checkIds.filter((id) => present.has(id));
    return {
      ids: survivors,
      missing: checkIds.length - survivors.length,
      total: handle.total,
    };
  }

  /** Re-run the stored `query` descriptor to recover ids for an elided
   * (>cap) handle. Minimal: supports a flat `{col: value}` equality filter
   * against the handle's table. Returns `[]` when no query / no table. */
  private idsFromQuery(handle: RefHandle, tx: StoreTx): string[] {
    if (!handle.query) return [];
    const table = tableForEntityType(handle.entityType);
    if (table === undefined) return [];
    const entries = Object.entries(handle.query as Record<string, unknown>).filter(
      ([, v]) => v !== undefined && (typeof v !== 'object' || v === null),
    );
    const where = entries.length > 0 ? `WHERE ${entries.map(([k]) => `${k} = ?`).join(' AND ')}` : '';
    const params = entries.map(([, v]) => v);
    const rows = tx.all(`SELECT id FROM ${table} ${where}`, params);
    return rows.map((r) => String(r['id']));
  }

  /** `SELECT id ... WHERE id IN (...)`, chunked to stay under SQLite's
   * variable limit (999) for very large id lists. */
  private existingIds(table: string, ids: readonly string[], tx: StoreTx): Set<string> {
    const present = new Set<string>();
    const CHUNK = 900;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = tx.all(`SELECT id FROM ${table} WHERE id IN (${placeholders})`, [...chunk]);
      for (const row of rows) present.add(String(row['id']));
    }
    return present;
  }

  markAllStale(sessionId?: string): void {
    this.db.run(`UPDATE refs SET stale = 1 WHERE session_id = ?`, [sessionId ?? this.sessionId]);
  }
}

/** Create a session-scoped `RefStore` backed by the session-domain `refs`
 * table. One store per (session, open `SessionsDb` handle). */
export function createRefStore(db: SessionsDb, sessionId: string): RefStore {
  return new RefStoreImpl(db, sessionId);
}
