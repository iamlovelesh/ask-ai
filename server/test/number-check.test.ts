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

  it('F5: accepts day-count claims derivable as differences between output dates', () => {
    const outs = ['due_date 2026-08-07T00:00:00.000Z now 2026-11-04T10:00:00.000Z'];
    expect(numberCheck('That invoice is 89 days overdue.', outs).ok).toBe(true);
    expect(numberCheck('That invoice is 43 days overdue.', outs).ok).toBe(false);
  });

  it('a draft with no numeric claims passes trivially', () => {
    expect(numberCheck('Okay — I stopped. Nothing further was changed.', []).ok).toBe(true);
  });

  it('round-7c: a figure late in large outputs is still verified (date digits must not exhaust the pool)', () => {
    // Live failure: 30 wide rows × 5 ISO timestamps each shed ~7 digit
    // tokens apiece, hitting the pool cap before the tool-computed sum at
    // the END of the last observation — the CORRECT total got flagged.
    const noisyRows = Array.from({ length: 150 }, (_, i) =>
      `{"id":"inv_${i}","created_at":"2026-05-15T19:33:01.323Z","updated_at":"2026-06-01T07:12:44.001Z","due_date":"2026-07-20T00:00:00.000Z"}`,
    ).join(',');
    const outs = [`top rows: [${noisyRows}]. Sum of total_cents over these top 10: 9733367.`];
    expect(numberCheck('The combined value is **$97,333.67**.', outs).ok).toBe(true);
  });

  it('round-7b N2: repeated unsupported figures are reported once (deduped)', () => {
    const r = numberCheck('You owe $55.55. To repeat: $55.55 — that is $55.55.', OUTPUTS);
    expect(r.ok).toBe(false);
    expect(r.unsupported.filter((u) => u.includes('55.55'))).toHaveLength(1);
  });

  it('round-7 support: record reference tokens are verified — id AND name must appear in outputs', () => {
    const outs = ['result={"items":[{"id":"con_77","name":"Sofia Osei"}],"total":1}'];
    expect(numberCheck('The thread belongs to [[record:contacts:con_77:Sofia Osei]].', outs).ok).toBe(true);
    const wrongName = numberCheck('The thread belongs to [[record:contacts:con_77:Liam Volkov]].', outs);
    expect(wrongName.ok).toBe(false);
    expect(wrongName.unsupported.join(' ')).toContain('Liam Volkov');
    const wrongId = numberCheck('See [[record:contacts:con_99:Sofia Osei]].', outs);
    expect(wrongId.ok).toBe(false);
  });

  it('round-7 support: bare record ids in prose must come from outputs or the user', () => {
    const outs = ['result={"items":[{"id":"ticket_141"}],"total":1}'];
    expect(numberCheck('Your open ticket is ticket_141.', outs).ok).toBe(true);
    expect(numberCheck('Also check ticket_999.', outs).ok).toBe(false);
    // user-typed ids are legitimate evidence
    expect(numberCheck('ticket_555 was not found.', outs, 'whats up with ticket_555').ok).toBe(true);
  });
});
