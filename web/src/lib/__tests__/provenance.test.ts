import { describe, it, expect } from 'vitest';
import { buildProvenance, humanizeAction } from '../provenance.js';

describe('humanizeAction', () => {
  it('maps known data/web/session actions to plain language', () => {
    expect(humanizeAction('data.aggregate_ref')).toMatch(/total/i);
    expect(humanizeAction('data.related')).toMatch(/related/i);
    expect(humanizeAction('web.search')).toMatch(/web/i);
  });
  it('humanizes an unknown catalog slug', () => {
    expect(humanizeAction('leads.search_leads')).toBe('Search leads');
    expect(humanizeAction('contacts.create_contact')).toBe('Create contact');
  });
});

describe('buildProvenance', () => {
  const turn = {
    stepOrder: ['s1', 's2', 's3'],
    steps: {
      s1: { action: 'leads.search_leads', status: 'done', summary: 'Search leads: 5000 leads [ref r_t1_s1]' },
      s2: { action: 'data.aggregate_ref', status: 'done', summary: 'sum over 5000 records: $792,335.89' },
      s3: { action: 'contacts.create_contact', status: 'pending' }, // not settled → omitted
    },
  };

  it('lists one row per settled step, in order, with ref tokens stripped', () => {
    const rows = buildProvenance(turn);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ label: 'Search leads', detail: 'Search leads: 5000 leads' });
    expect(rows[1]!.label).toMatch(/total/i);
    expect(rows[1]!.detail).toContain('$792,335.89');
    expect(JSON.stringify(rows)).not.toContain('[ref'); // internal refs hidden
  });

  it('is empty for a turn that did no tool work', () => {
    expect(buildProvenance({ stepOrder: [], steps: {} })).toEqual([]);
  });
});
