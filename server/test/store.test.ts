import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTITY_MODEL, ddl } from '../src/entities/model';
import { openCrm, crmDbPath } from '../src/store/db';
import { resetCrm } from '../src/store/reset';

// Throwaway profiles so we never touch the committed template or runtime DBs.
const DDL_PROFILE = 'test-ddl';
const RT_PROFILE = 'test-roundtrip';
const RESET_PROFILE = 'test-reset';
const TEMPLATE_PATH = join(tmpdir(), `crm-${RESET_PROFILE}.template.db`);

function cleanup(profile: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(profile) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

afterAll(() => {
  cleanup(DDL_PROFILE);
  cleanup(RT_PROFILE);
  cleanup(RESET_PROFILE);
  if (existsSync(TEMPLATE_PATH)) rmSync(TEMPLATE_PATH, { force: true });
});

describe('entity model', () => {
  it('declares between 22 and 25 tables', () => {
    expect(ENTITY_MODEL.length).toBeGreaterThanOrEqual(22);
    expect(ENTITY_MODEL.length).toBeLessThanOrEqual(25);
  });

  it('gives every table id PK + created_at + updated_at', () => {
    for (const t of ENTITY_MODEL) {
      const names = t.columns.map((c) => c.name);
      expect(names).toContain('id');
      expect(names).toContain('created_at');
      expect(names).toContain('updated_at');
      const id = t.columns.find((c) => c.name === 'id');
      expect(id?.primaryKey).toBe(true);
      expect(id?.type).toBe('TEXT');
    }
  });

  it('gives every table a unique prefix', () => {
    const prefixes = ENTITY_MODEL.map((t) => t.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('includes the four mandated merged tables with discriminators', () => {
    const byName = new Map(ENTITY_MODEL.map((t) => [t.name, t]));
    for (const [table, col] of [
      ['messages', 'channel'],
      ['line_items', 'parent_type'],
      ['content_items', 'kind'],
      ['participations', 'kind'],
    ] as const) {
      const t = byName.get(table);
      expect(t, `table ${table} must exist`).toBeDefined();
      expect(t!.columns.map((c) => c.name)).toContain(col);
    }
  });

  it('carries the load-bearing eval columns verbatim', () => {
    const byName = new Map(ENTITY_MODEL.map((t) => [t.name, t]));
    const need: Record<string, string[]> = {
      leads: ['source', 'status', 'score', 'owner_id', 'contact_id', 'campaign_id'],
      invoices: ['status', 'due_date', 'issued_at', 'total_cents', 'contact_id'],
      conversations: ['contact_id', 'channel', 'status', 'last_inbound_at', 'last_outbound_at', 'unread'],
      appointments: ['contact_id', 'calendar_id', 'host_user_id', 'status', 'start_at', 'end_at'],
      users: ['role', 'active'],
    };
    for (const [table, cols] of Object.entries(need)) {
      const t = byName.get(table);
      expect(t, `table ${table} must exist`).toBeDefined();
      const have = t!.columns.map((c) => c.name);
      for (const c of cols) expect(have, `${table}.${c}`).toContain(c);
    }
  });
});

describe('ddl()', () => {
  it('creates every declared table in sqlite', () => {
    const crm = openCrm(DDL_PROFILE);
    try {
      const rows = crm.tx((db) =>
        db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"),
      );
      const tableNames = new Set(rows.map((r) => r['name'] as string));
      for (const t of ENTITY_MODEL) {
        expect(tableNames.has(t.name), `missing table ${t.name}`).toBe(true);
      }
      expect(tableNames.size).toBe(ENTITY_MODEL.length);
    } finally {
      crm.close();
    }
  });

  it('creates an index for every column marked indexed', () => {
    const crm = openCrm(DDL_PROFILE);
    try {
      const rows = crm.tx((db) =>
        db.all("SELECT name FROM sqlite_master WHERE type='index'"),
      );
      const indexNames = new Set(rows.map((r) => r['name'] as string));
      for (const t of ENTITY_MODEL) {
        for (const c of t.columns) {
          if (c.indexed) {
            const idx = `idx_${t.name}_${c.name}`;
            expect(indexNames.has(idx), `missing index ${idx}`).toBe(true);
          }
        }
      }
    } finally {
      crm.close();
    }
  });

  it('emits CREATE TABLE and CREATE INDEX statements', () => {
    const stmts = ddl();
    expect(stmts.some((s) => s.startsWith('CREATE TABLE'))).toBe(true);
    expect(stmts.some((s) => s.startsWith('CREATE INDEX'))).toBe(true);
  });
});

describe('store round-trip', () => {
  it('inserts and queries a contact', () => {
    const crm = openCrm(RT_PROFILE);
    try {
      const result = crm.tx((db) => {
        const ins = db.run(
          'INSERT INTO contacts (id, created_at, updated_at, archived, name, email) VALUES (?,?,?,?,?,?)',
          ['con_1', 1000, 1000, 0, 'Ada Lovelace', 'ada@example.com'],
        );
        return ins;
      });
      expect(result.changes).toBe(1);

      const row = crm.tx((db) =>
        db.get('SELECT id, name, email FROM contacts WHERE id = ?', ['con_1']),
      );
      expect(row).toBeDefined();
      expect(row!['name']).toBe('Ada Lovelace');
      expect(row!['email']).toBe('ada@example.com');

      const all = crm.tx((db) => db.all('SELECT * FROM contacts'));
      expect(all.length).toBe(1);
    } finally {
      crm.close();
    }
  });

  it('rolls back a failed transaction', () => {
    const crm = openCrm(RT_PROFILE);
    try {
      expect(() =>
        crm.tx((db) => {
          db.run(
            'INSERT INTO contacts (id, created_at, updated_at, archived, name) VALUES (?,?,?,?,?)',
            ['con_rollback', 1, 1, 0, 'Temp'],
          );
          throw new Error('boom');
        }),
      ).toThrow('boom');

      const row = crm.tx((db) =>
        db.get('SELECT id FROM contacts WHERE id = ?', ['con_rollback']),
      );
      expect(row).toBeUndefined();
    } finally {
      crm.close();
    }
  });
});

describe('resetCrm', () => {
  it('restores a mutated DB to template bytes in under 1000ms', async () => {
    // 1. Fresh DB with schema → close → snapshot as template.
    const seed = openCrm(RESET_PROFILE);
    seed.close();
    const dbFile = crmDbPath(RESET_PROFILE);
    const { copyFileSync } = await import('node:fs');
    copyFileSync(dbFile, TEMPLATE_PATH);
    const templateBytes = readFileSync(TEMPLATE_PATH);

    // 2. Mutate the live DB.
    const mutated = openCrm(RESET_PROFILE);
    mutated.tx((db) =>
      db.run(
        'INSERT INTO contacts (id, created_at, updated_at, archived, name) VALUES (?,?,?,?,?)',
        ['con_mut', 1, 1, 0, 'Mutation'],
      ),
    );
    mutated.close();

    // 3. Reset from template.
    const { ms } = await resetCrm(RESET_PROFILE, TEMPLATE_PATH);
    expect(ms).toBeLessThan(1000);

    // 4. Mutation gone + bytes identical to template.
    const after = openCrm(RESET_PROFILE);
    try {
      const rows = after.tx((db) => db.all('SELECT * FROM contacts'));
      expect(rows.length).toBe(0);
      const liveBytes = readFileSync(dbFile);
      expect(liveBytes.equals(templateBytes)).toBe(true);
    } finally {
      after.close();
    }
  });
});
