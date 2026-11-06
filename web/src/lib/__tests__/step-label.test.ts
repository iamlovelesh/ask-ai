import { describe, it, expect } from 'vitest';
import { loadingLabel } from '../step-label.js';

describe('loadingLabel', () => {
  it('narrates common CRUD verbs in present tense with the object', () => {
    expect(loadingLabel('leads.search_leads')).toBe('Searching leads…');
    expect(loadingLabel('contacts.create_contact')).toBe('Creating contact…');
    expect(loadingLabel('tasks.set_task_due_date')).toBe('Updating task due date…');
    expect(loadingLabel('invoices.send_invoice_reminder')).toBe('Sending invoice reminder…');
  });

  it('gives the data ref-tools friendly phrasings', () => {
    expect(loadingLabel('data__sort_ref')).toBe('Ranking the results…');
    expect(loadingLabel('data__aggregate_ref')).toBe('Calculating totals…');
    expect(loadingLabel('catalog__search_actions')).toBe('Looking for the right action…');
  });

  it('falls back to the catalog name, then a humanized slug', () => {
    expect(loadingLabel('weird.frobnicate_widget', 'Frobnicate widget')).toBe('Frobnicate widget…');
    expect(loadingLabel('weird.zzz')).toBe('zzz…');
  });
});
