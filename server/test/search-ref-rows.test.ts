import { describe, it, expect } from 'vitest';
import { searchRefRows } from '../src/loop/tools';

const tickets = [
  { id: 't1', subject: 'Cannot log in to my account', priority: 'high' },
  { id: 't2', subject: 'Password reset not working', priority: 'urgent' },
  { id: 't3', subject: 'Feature request: bulk export', priority: 'low' },
  { id: 't4', subject: 'Billing charge looks incorrect', priority: 'medium' },
  { id: 't5', subject: 'Login page shows an error', priority: 'high' },
];

describe('searchRefRows (tokenized free-text, #11 fix)', () => {
  it('matches ANY significant word of a natural-language query, not the literal phrase', () => {
    const m = searchRefRows(tickets, 'login or password problems');
    const ids = m.map((r) => r.id).sort();
    // t2 (password), t5 (login), AND t1 "log in" via space-insensitive match.
    expect(ids).toEqual(['t1', 't2', 't5']);
  });

  it('drops stopwords so "the ones about billing" searches for "billing"', () => {
    expect(searchRefRows(tickets, 'the ones about billing').map((r) => r.id)).toEqual(['t4']);
  });

  it('still does a whole-phrase match when the query is one short/stopword-only term', () => {
    expect(searchRefRows(tickets, 'export').map((r) => r.id)).toEqual(['t3']);
  });

  it('empty query matches nothing', () => {
    expect(searchRefRows(tickets, '  ')).toEqual([]);
  });
});
