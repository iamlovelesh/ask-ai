import { describe, expect, it } from 'vitest';
import { parseStepSummary } from '../step-summary.js';

describe('parseStepSummary', () => {
  it('peels the leading slug off into detail, keeping the human count as primary', () => {
    const p = parseStepSummary('invoices.search_invoices: 123 invoices');
    expect(p.primary).toBe('123 invoices');
    expect(p.slug).toBe('invoices.search_invoices');
    expect(p.ref).toBeUndefined();
  });

  it('peels a trailing [ref r_xxx] fragment off into detail', () => {
    const p = parseStepSummary('invoices.search_invoices: 450 invoices [ref r_abc123]');
    expect(p.primary).toBe('450 invoices');
    expect(p.slug).toBe('invoices.search_invoices');
    expect(p.ref).toBe('r_abc123');
  });

  it('keeps a human drift note in the primary line', () => {
    const p = parseStepSummary('leads.assign_lead_owner: 3 leads (2 of 3 still match)');
    expect(p.primary).toBe('3 leads (2 of 3 still match)');
    expect(p.slug).toBe('leads.assign_lead_owner');
  });

  it('is a no-op for a summary with neither slug nor ref', () => {
    const p = parseStepSummary('12 records found');
    expect(p.primary).toBe('12 records found');
    expect(p.slug).toBeUndefined();
    expect(p.ref).toBeUndefined();
  });

  it('handles an empty/undefined summary', () => {
    expect(parseStepSummary(undefined).primary).toBe('');
    expect(parseStepSummary('').primary).toBe('');
  });
});
