import { describe, it, expect } from 'vitest';
import { resolveRecordNames, collectRecordIds, entityForId } from '../src/loop/name-resolve';

const NAMES: Record<string, string> = {
  con_4403: 'Liam Mehta',
  con_10303: 'Ada Lovelace',
  co_12: 'Globex',
  inv_6: 'INV-2005',
  user_1: 'Isla Reyes',
  team_2: 'Enterprise Sales',
};
const lookup = (id: string): string | undefined => NAMES[id];

describe('entityForId', () => {
  it('maps prefixes to entities, contacts before companies', () => {
    expect(entityForId('con_1')).toBe('contacts');
    expect(entityForId('co_1')).toBe('companies');
    expect(entityForId('inv_9')).toBe('invoices');
    expect(entityForId('ticket_3')).toBe('support_tickets');
    expect(entityForId('xyz_1')).toBeUndefined();
  });

  it('maps the extended entity set (teams, orders, products, …) without prefix collisions', () => {
    expect(entityForId('team_2')).toBe('teams');
    expect(entityForId('prod_1')).toBe('products');
    expect(entityForId('ord_1')).toBe('orders');
    expect(entityForId('quote_1')).toBe('quotes');
    expect(entityForId('evt_1')).toBe('events');
    expect(entityForId('appt_1')).toBe('appointments');
    expect(entityForId('task_1')).toBe('tasks');
    // The `_`-delimited match keeps these off the shorter con/co prefixes.
    expect(entityForId('conv_1')).toBe('conversations');
    expect(entityForId('content_1')).toBe('content_items');
    expect(entityForId('course_1')).toBe('courses');
  });
});

describe('resolveRecordNames', () => {
  it('wraps a bare id in prose with a named chip', () => {
    const out = resolveRecordNames('Customer ID: con_4403 owes the most.', lookup);
    expect(out).toContain('[[record:contacts:con_4403:Liam Mehta]]');
    expect(out).not.toMatch(/con_4403(?!:)/); // the bare id is gone (only inside the token)
  });

  it('wraps a bare team id into a hoverable chip (reported: team_2 rendered as plain text)', () => {
    const out = resolveRecordNames('Assigned to team_2 for follow-up.', lookup);
    expect(out).toContain('[[record:teams:team_2:Enterprise Sales]]');
  });

  it('collectRecordIds finds extended-entity ids too', () => {
    expect(collectRecordIds('team_2 and ord_9 and con_4403')).toEqual(
      expect.arrayContaining(['team_2', 'ord_9', 'con_4403']),
    );
  });

  it('fixes a token whose display name is the id itself', () => {
    const out = resolveRecordNames('See [[record:contacts:con_10303:con_10303]].', lookup);
    expect(out).toBe('See [[record:contacts:con_10303:Ada Lovelace]].');
  });

  it('leaves a good token untouched and does not double-wrap', () => {
    const good = 'Top: [[record:invoices:inv_6:INV-2005]].';
    expect(resolveRecordNames(good, lookup)).toBe(good);
  });

  it('leaves an id with no resolvable name as-is', () => {
    const out = resolveRecordNames('Unknown con_999 and con_4403.', lookup);
    expect(out).toContain('con_999'); // untouched
    expect(out).toContain('[[record:contacts:con_4403:Liam Mehta]]');
  });

  it('does not confuse a company id (co_) for a contact (con_)', () => {
    const out = resolveRecordNames('Account co_12 bought it.', lookup);
    expect(out).toContain('[[record:companies:co_12:Globex]]');
  });

  it('collectRecordIds gathers distinct ids from prose and tokens', () => {
    const ids = collectRecordIds('con_4403 and [[record:invoices:inv_6:INV-2005]] and con_4403');
    expect(ids.sort()).toEqual(['con_4403', 'inv_6']);
  });
});
