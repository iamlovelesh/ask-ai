import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { openCrm, crmDbPath, closeRegistered, type Crm } from '../src/store/db';
import { gatherRelated, renderRelated } from '../src/loop/record-related';

const PROFILE = 'test-related';

function cleanup(): void {
  for (const s of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + s;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

let crm: Crm;
beforeEach(() => {
  cleanup();
  crm = openCrm(PROFILE);
  crm.tx((db) => {
    db.run(`INSERT INTO companies (id, name) VALUES ('co_1', 'Acme Inc')`);
    db.run(`INSERT INTO contacts (id, name, company_id) VALUES ('con_1', 'Ada Lovelace', 'co_1')`);
    db.run(`INSERT INTO contacts (id, name, company_id) VALUES ('con_2', 'Ben Nye', 'co_1')`);
    db.run(`INSERT INTO notes (id, contact_id, body) VALUES ('note_1', 'con_1', 'called')`);
    db.run(`INSERT INTO notes (id, contact_id, body) VALUES ('note_2', 'con_1', 'emailed')`);
    db.run(`INSERT INTO tasks (id, contact_id, title) VALUES ('task_1', 'con_1', 'Follow up')`);
    return undefined;
  });
});
afterAll(() => {
  closeRegistered(PROFILE);
  cleanup();
});

describe('gatherRelated (Record 360)', () => {
  it('gathers a contact\'s child records and parent company', () => {
    const r = crm.tx((db) => gatherRelated(db, 'contacts', 'con_1'))!;
    expect(r).not.toBeNull();
    expect(r.label).toBe('Ada Lovelace');
    const byType = Object.fromEntries(r.groups.map((g) => [g.type, g]));
    expect(byType['notes']?.count).toBe(2);
    expect(byType['tasks']?.count).toBe(1);
    expect(byType['companies']?.direction).toBe('parent');
    expect(byType['companies']?.sample[0]).toEqual({ id: 'co_1', label: 'Acme Inc' });
    // a relation with no rows is omitted entirely
    expect(byType['invoices']).toBeUndefined();
  });

  it('gathers a company\'s contacts', () => {
    const r = crm.tx((db) => gatherRelated(db, 'companies', 'co_1'))!;
    const contacts = r.groups.find((g) => g.type === 'contacts');
    expect(contacts?.count).toBe(2);
    expect(contacts?.sample.map((s) => s.id).sort()).toEqual(['con_1', 'con_2']);
  });

  it('returns null for a non-hub entity or a missing record', () => {
    expect(crm.tx((db) => gatherRelated(db, 'invoices', 'inv_1'))).toBeNull(); // no relation map
    expect(crm.tx((db) => gatherRelated(db, 'contacts', 'con_999'))).toBeNull(); // missing
  });

  it('renders a compact observation with ids for follow-up', () => {
    const r = crm.tx((db) => gatherRelated(db, 'contacts', 'con_1'))!;
    const out = renderRelated(r);
    expect(out).toContain('Ada Lovelace');
    expect(out).toContain('note_1');
    expect(out).toContain('co_1');
  });
});
