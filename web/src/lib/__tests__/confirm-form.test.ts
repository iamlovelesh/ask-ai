import { describe, expect, it } from 'vitest';
import {
  collectFormValues,
  fieldString,
  isFormComplete,
  type ConfirmFormField,
} from '../confirm-form.js';

const fields: ConfirmFormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: true },
  { key: 'note', label: 'Note', type: 'text', required: false },
];

describe('fieldString', () => {
  it('coerces numbers, nullish, and strings to a trimmed string', () => {
    expect(fieldString(42)).toBe('42');
    expect(fieldString('  hi  ')).toBe('hi');
    expect(fieldString(undefined)).toBe('');
    expect(fieldString(null)).toBe('');
    expect(fieldString(0)).toBe('0');
  });
});

describe('isFormComplete', () => {
  it('is false while a required field is empty', () => {
    expect(isFormComplete(fields, { name: 'Ada' })).toBe(false);
  });

  it('is true when all required fields are filled — including a NUMERIC value (regression)', () => {
    // v-model on <input type="number"> stores a number, not a string; this
    // must not throw and must count as filled.
    expect(isFormComplete(fields, { name: 'Ada', amount: 100 })).toBe(true);
  });

  it('ignores optional fields for completeness', () => {
    expect(isFormComplete(fields, { name: 'Ada', amount: 5, note: '' })).toBe(true);
  });
});

describe('collectFormValues', () => {
  it('casts number fields and drops empties, with numeric input (regression)', () => {
    const out = collectFormValues(fields, { name: 'Ada', amount: 250, note: '   ' });
    expect(out).toEqual({ name: 'Ada', amount: 250 });
    expect(typeof out.amount).toBe('number');
  });

  it('parses a numeric string field to a number', () => {
    const out = collectFormValues(fields, { name: 'Ada', amount: '42' });
    expect(out.amount).toBe(42);
  });

  it('does not throw on a numeric value (the reported crash)', () => {
    expect(() => collectFormValues(fields, { amount: 7 })).not.toThrow();
  });
});
