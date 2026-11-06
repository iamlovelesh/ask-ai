import { describe, it, expect } from 'vitest';
import { pluralNoun } from '../src/loop/tools';

describe('pluralNoun (persona finding: "opportunitie")', () => {
  it('singularizes plural entity names correctly for count 1', () => {
    expect(pluralNoun('opportunities', 1)).toBe('opportunity');
    expect(pluralNoun('companies', 1)).toBe('company');
    expect(pluralNoun('contacts', 1)).toBe('contact');
    expect(pluralNoun('invoices', 1)).toBe('invoice');
    expect(pluralNoun('teams', 1)).toBe('team');
    expect(pluralNoun('address', 1)).toBe('address'); // -ss intact
  });
  it('keeps/forms plurals for count > 1', () => {
    expect(pluralNoun('opportunities', 3)).toBe('opportunities');
    expect(pluralNoun('invoices', 2)).toBe('invoices');
    expect(pluralNoun('record', 2)).toBe('records');
  });
});
