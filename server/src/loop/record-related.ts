/**
 * Record 360 (relational strength): given one record, gather the
 * records connected to it across the CRM — a contact's deals, notes, tasks,
 * invoices, tickets, orders, quotes, and parent company; a company's contacts,
 * deals, and quotes. One call instead of many separate searches — the basis
 * for meeting-prep and account reviews.
 *
 * READ-ONLY. Returns counts + a small labelled sample per related type; the
 * caller surfaces ids so the model can then act on them (provenance-known).
 */
import type { StoreTx } from '../store/db.js';
import { ENTITY_NAME_SQL } from './name-resolve.js';

/** Child relations: tables that point BACK at a hub record via a foreign key. */
const CHILD_RELATIONS: Readonly<Record<string, ReadonlyArray<{ table: string; fk: string }>>> = {
  contacts: [
    { table: 'opportunities', fk: 'contact_id' },
    { table: 'invoices', fk: 'contact_id' },
    { table: 'support_tickets', fk: 'contact_id' },
    { table: 'tasks', fk: 'contact_id' },
    { table: 'notes', fk: 'contact_id' },
    { table: 'orders', fk: 'contact_id' },
    { table: 'quotes', fk: 'contact_id' },
    { table: 'messages', fk: 'contact_id' },
  ],
  companies: [
    { table: 'contacts', fk: 'company_id' },
    { table: 'opportunities', fk: 'company_id' },
    { table: 'quotes', fk: 'company_id' },
  ],
};

/** Parent relations: a column on the hub record that points UP at one record. */
const PARENT_RELATIONS: Readonly<Record<string, ReadonlyArray<{ column: string; table: string }>>> = {
  contacts: [{ column: 'company_id', table: 'companies' }],
};

export interface RelatedRecord {
  id: string;
  label: string;
}
export interface RelatedGroup {
  /** Related entity/table, e.g. "opportunities". */
  type: string;
  /** How the record relates: "child" (points at the hub) or "parent". */
  direction: 'child' | 'parent';
  count: number;
  sample: RelatedRecord[];
}
export interface RelatedResult {
  entity: string;
  id: string;
  label: string;
  groups: RelatedGroup[];
}

const SAMPLE_LIMIT = 6;

function identifierExists(db: StoreTx, table: string): boolean {
  return /^[a-z_]+$/.test(table);
}

/** Display expression for a table (falls back to the id when unknown). */
function nameExpr(table: string): string {
  return ENTITY_NAME_SQL[table]?.expr ?? "''";
}

function labelOf(row: Record<string, unknown>): string {
  const n = String(row['_label'] ?? '').trim();
  return n !== '' ? n : String(row['id'] ?? '');
}

/**
 * Gather the records related to `id`. Returns null if the id's entity has no
 * known relation map (not a contact/company hub) or the record doesn't exist.
 * Fail-soft: a query error on one relation skips that group, never throws.
 */
export function gatherRelated(db: StoreTx, entity: string, id: string): RelatedResult | null {
  if (!identifierExists(db, entity) || !/^[a-z][a-z_]*_\d+$/.test(id)) return null;
  const children = CHILD_RELATIONS[entity];
  const parents = PARENT_RELATIONS[entity] ?? [];
  if (children === undefined) return null;

  let hub: Record<string, unknown> | undefined;
  try {
    hub = db.get(`SELECT *, (${nameExpr(entity)}) AS _label FROM ${entity} WHERE id = ?`, [id]) as
      | Record<string, unknown>
      | undefined;
  } catch {
    return null;
  }
  if (hub === undefined) return null;

  const groups: RelatedGroup[] = [];

  for (const { column, table } of parents) {
    const parentId = hub[column];
    if (typeof parentId !== 'string' || parentId === '') continue;
    try {
      const row = db.get(`SELECT id, (${nameExpr(table)}) AS _label FROM ${table} WHERE id = ?`, [parentId]) as
        | Record<string, unknown>
        | undefined;
      if (row) groups.push({ type: table, direction: 'parent', count: 1, sample: [{ id: String(row['id']), label: labelOf(row) }] });
    } catch {
      /* skip */
    }
  }

  for (const { table, fk } of children) {
    try {
      const countRow = db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${fk} = ?`, [id]) as { n?: number } | undefined;
      const count = Number(countRow?.n ?? 0);
      if (count === 0) continue;
      const rows = db.all(`SELECT id, (${nameExpr(table)}) AS _label FROM ${table} WHERE ${fk} = ? LIMIT ${SAMPLE_LIMIT}`, [id]) as Record<string, unknown>[];
      groups.push({
        type: table,
        direction: 'child',
        count,
        sample: rows.map((r) => ({ id: String(r['id']), label: labelOf(r) })),
      });
    } catch {
      /* skip this relation */
    }
  }

  return { entity, id, label: labelOf(hub), groups };
}

/** Render a RelatedResult as a compact model observation. */
export function renderRelated(result: RelatedResult): string {
  if (result.groups.length === 0) {
    return `${result.label} (${result.id}) has no related records.`;
  }
  const lines = result.groups.map((g) => {
    const shown = g.sample.map((s) => `${s.label} [${s.id}]`).join('; ');
    const more = g.count > g.sample.length ? ` (+${g.count - g.sample.length} more)` : '';
    const rel = g.direction === 'parent' ? 'belongs to' : `${g.count}`;
    return g.direction === 'parent' ? `- ${g.type}: ${shown}` : `- ${g.type} (${rel}): ${shown}${more}`;
  });
  return `Related to ${result.label} (${result.id}):\n${lines.join('\n')}`;
}
