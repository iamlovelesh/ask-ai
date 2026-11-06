import { describe, it, expect } from 'vitest';
import { inferIdParam } from '../src/loop/tools';

describe('inferIdParam (#2 bulk ergonomics)', () => {
  it('uses the record own id for update/send actions', () => {
    expect(inferIdParam(['id', 'status'], ['id'], 'invoices')).toBe('id');
  });
  it('matches a foreign-key param to the ref entity for creates (task per contact)', () => {
    expect(inferIdParam(['contact_id', 'title', 'owner_id'], ['contact_id', 'title'], 'contacts')).toBe('contact_id');
  });
  it('matches entity FK (invoice reminder per invoice)', () => {
    expect(inferIdParam(['invoice_id', 'note'], ['invoice_id'], 'invoices')).toBe('invoice_id');
  });
  it('falls back to any required *_id when no entity FK matches', () => {
    expect(inferIdParam(['contact_id', 'title'], ['contact_id', 'title'], 'leads')).toBe('contact_id');
  });
  it('returns undefined when there is no id-shaped param', () => {
    expect(inferIdParam(['title', 'name'], ['title'], 'leads')).toBeUndefined();
  });
});
