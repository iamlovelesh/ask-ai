import { describe, expect, it } from 'vitest';
import { prettifySlug } from '../action-name.js';

describe('prettifySlug', () => {
  it('strips the module segment and sentence-cases the action', () => {
    expect(prettifySlug('invoices.search_invoices')).toBe('Search invoices');
    expect(prettifySlug('leads.assign_lead_owner')).toBe('Assign lead owner');
    expect(prettifySlug('invoices.send_invoice_reminder')).toBe('Send invoice reminder');
  });

  it('keeps a single-segment slug whole (no module to strip)', () => {
    expect(prettifySlug('sort')).toBe('Sort');
    expect(prettifySlug('core')).toBe('Core');
  });

  it('is sentence case, never Title Case', () => {
    expect(prettifySlug('pipelines.list_pipelines')).toBe('List pipelines');
  });

  it('returns the input unchanged when empty', () => {
    expect(prettifySlug('')).toBe('');
  });
});
