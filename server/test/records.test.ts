import { describe, it, expect } from 'vitest';
import { getCrm } from '../src/store/db';
import { fetchRecord } from '../src/api/records';

describe('fetchRecord (clickable record chips, #14)', () => {
  const crm = getCrm('standard');

  it('rejects unknown / unsafe table names', () => {
    expect(fetchRecord(crm, 'sqlite_master', 'con_1')).toBeNull();
    expect(fetchRecord(crm, 'contacts; DROP TABLE contacts', 'con_1')).toBeNull();
    expect(fetchRecord(crm, 'nope', 'con_1')).toBeNull();
  });

  it('rejects a malformed id (no SQL reaches the db)', () => {
    expect(fetchRecord(crm, 'contacts', "1 OR 1=1")).toBeNull();
    expect(fetchRecord(crm, 'contacts', 'DROP')).toBeNull();
  });

  it('returns null for a valid table with no such row', () => {
    expect(fetchRecord(crm, 'contacts', 'con_999999999')).toBeNull();
  });

  it('returns the record fields for a real id', () => {
    const real = crm.tx((db) => db.get('SELECT id FROM contacts LIMIT 1') as { id: string } | undefined);
    expect(real).toBeDefined();
    const rec = fetchRecord(crm, 'contacts', real!.id);
    expect(rec?.entity).toBe('contacts');
    expect(rec?.id).toBe(real!.id);
    expect(rec?.fields['id']).toBe(real!.id);
  });
});
