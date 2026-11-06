import { describe, it, expect } from 'vitest';
import { numberCheck } from '../src/loop/number-check';

const OUTPUTS = [
  'invoices.search: 14 invoices [ref r_t1_s1]. result={"items":[{"id":"inv_1","total_cents":955865,"issued_at":"2026-05-10T05:24:30.000Z"},{"id":"inv_2","total_cents":341978}],"total":14}',
  'sum of total_cents over 14 records: 4619657',
];

describe('numberCheck', () => {
  it('passes figures present in tool outputs, including cents→dollars conversion', () => {
    const r = numberCheck('You have 14 overdue invoices totaling $46,196.57. The largest is $9,558.65.', OUTPUTS);
    expect(r.ok).toBe(true);
  });

  it('flags a dollar figure absent from (and not derivable from) outputs', () => {
    const r = numberCheck('You are owed $6,842.02 in total.', OUTPUTS);
    expect(r.ok).toBe(false);
    expect(r.unsupported.join(' ')).toContain('6,842.02');
  });

  it('passes pair-sums of output figures', () => {
    // 9558.65 + 3419.78 = 12978.43
    const r = numberCheck('Those two invoices together come to $12,978.43.', OUTPUTS);
    expect(r.ok).toBe(true);
  });

  it('verifies month-day date claims against ISO dates in outputs', () => {
    expect(numberCheck('It was issued on May 10, 2026.', OUTPUTS).ok).toBe(true);
    const bad = numberCheck('It was issued on August 16, 2026.', OUTPUTS);
    expect(bad.ok).toBe(false);
    expect(bad.unsupported.join(' ')).toMatch(/August 16/);
  });

  it('ignores small integers, years, times, and list indices', () => {
    const r = numberCheck('Here are 3 examples from 2026, meeting at 2:30 PM: 1. first 2. second', OUTPUTS);
    expect(r.ok).toBe(true);
  });

  it('a draft with no numeric claims passes trivially', () => {
    expect(numberCheck('Okay — I stopped. Nothing further was changed.', []).ok).toBe(true);
  });
});
