/**
 * Read-only record lookup for clickable chips (#14, chip→record
 * navigation). Our agent cites records as `[[record:entity:id:name]]` chips;
 * this endpoint lets the UI expand one into a detail popover.
 *
 * Security: `entity` is interpolated into SQL, so it is validated against the
 * live set of user table names (never a system table) AND a strict charset;
 * `id` must match the record-id shape. Anything else returns null before any
 * SQL runs. The data is the user's own CRM — all columns are returned.
 */

import type { FastifyInstance } from 'fastify';
import { getCrm, type Crm } from '../store/db.js';
import type { AppDeps } from './types.js';

const ENTITY_RE = /^[a-z][a-z_]*$/;
const ID_RE = /^[a-z][a-z_]*_\d+$/;

export interface RecordResult {
  entity: string;
  id: string;
  fields: Record<string, unknown>;
}

function userTableNames(crm: Crm): Set<string> {
  return crm.tx((db) => {
    const rows = db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`) as { name: string }[];
    return new Set(rows.map((r) => r.name));
  });
}

/** Fetch one record by entity (table) + id, or null if the entity/id is
 * invalid/unknown or no row matches. */
export function fetchRecord(crm: Crm, entity: string, id: string): RecordResult | null {
  if (!ENTITY_RE.test(entity) || !ID_RE.test(id)) return null;
  if (!userTableNames(crm).has(entity)) return null;
  const row = crm.tx(
    (db) => db.get(`SELECT * FROM ${entity} WHERE id = ?`, [id]) as Record<string, unknown> | undefined,
  );
  return row ? { entity, id, fields: row } : null;
}

export function registerRecordRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/records/:entity/:id', async (req, reply) => {
    const { entity, id } = req.params as { entity: string; id: string };
    const rec = fetchRecord(getCrm(deps.profile), entity, id);
    if (!rec) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    reply.send(rec);
  });
}
