import { describe, expect, it } from 'vitest';
import { parseClarifyOptions } from '../clarify.js';

describe('parseClarifyOptions', () => {
  it('parses a colon-led comma/or enumeration of 3 options', () => {
    expect(parseClarifyOptions('Which contact did you mean: Jane Smith, John Doe, or Jane Doe?')).toEqual([
      'Jane Smith',
      'John Doe',
      'Jane Doe',
    ]);
  });

  it('parses an em-dash-led enumeration', () => {
    expect(parseClarifyOptions('Which campaign — Spring Sale, Summer Clearance, or Fall Promo?')).toEqual([
      'Spring Sale',
      'Summer Clearance',
      'Fall Promo',
    ]);
  });

  it('parses a "between A, B, or C" lead-in', () => {
    expect(parseClarifyOptions('Should I search between Leads, Contacts, or Opportunities?')).toEqual([
      'Leads',
      'Contacts',
      'Opportunities',
    ]);
  });

  it('parses a comma-separated list with no lead-in marker', () => {
    expect(parseClarifyOptions('Acme Corp, Acme Inc, or Acme LLC?')).toEqual(['Acme Corp', 'Acme Inc', 'Acme LLC']);
  });

  it('returns null for a bare "X or Y?" with no comma and no lead-in — too ambiguous', () => {
    expect(parseClarifyOptions('Did you want leads or contacts?')).toBeNull();
  });

  it('returns null for an ordinary clarifying question with no enumeration', () => {
    expect(parseClarifyOptions('Which date range did you mean?')).toBeNull();
  });

  it('returns null when there are more than 4 options', () => {
    expect(parseClarifyOptions('Pick one: A, B, C, D, or E?')).toBeNull();
  });

  it('returns null when an option is too long to be a short pick', () => {
    expect(
      parseClarifyOptions(
        'Which one: the lead created last week in the Boston office, or the one from yesterday in Denver?',
      ),
    ).toBeNull();
  });

  it('returns null for an empty question', () => {
    expect(parseClarifyOptions('   ')).toBeNull();
  });
});
