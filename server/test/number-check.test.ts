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

  it('verifies numeric (DD/MM/YYYY and MM/DD/YYYY) date claims, not their day number', () => {
    // EU-format preference renders "Friday, 13/11/2026". The day "13" is a date
    // component, not an unverified figure — it must verify against the ISO date
    // in outputs, in either day/month order.
    const outs = ['Scheduled a follow-up for 2026-11-13T00:00:00.000Z: Follow up with Acme'];
    expect(numberCheck('Done! I scheduled it for Friday, 13/11/2026.', outs).ok).toBe(true);
    expect(numberCheck('Done! I scheduled it for 11/13/2026.', outs).ok).toBe(true);
  });

  it('still flags a numeric date that does NOT match any output date', () => {
    const outs = ['Scheduled a follow-up for 2026-11-13T00:00:00.000Z: Follow up with Acme'];
    const r = numberCheck('Done! I scheduled it for 25/12/2026.', outs);
    expect(r.ok).toBe(false);
    expect(r.unsupported.join(' ')).toContain('25/12/2026');
  });

  it('verifies a rounded magnitude figure ($19.1M) against the exact grounded value', () => {
    // The model presents a grounded total in human-friendly rounded form.
    // "$19.1M" must verify against $19,098,279.08 (stored as cents), and the
    // reported token must keep its suffix — never be mangled to "$19.1".
    const outs = ['opportunities aggregate: sum of value_cents over 712 records: 1909827908'];
    expect(numberCheck('Your open pipeline is about $19.1M across the deals.', outs).ok).toBe(true);
  });

  it('flags a fabricated magnitude figure and keeps its full token (suffix intact)', () => {
    const outs = ['opportunities aggregate: sum of value_cents over 712 records: 1909827908'];
    const r = numberCheck('Your open pipeline is $50.0M.', outs);
    expect(r.ok).toBe(false);
    expect(r.unsupported.join(' ')).toContain('$50.0M');
    expect(r.unsupported.join(' ')).not.toContain('$50.0 ');
  });

  it('verifies a rounded count (~1,100) against a nearby grounded count', () => {
    const outs = ['Search leads: 1087 leads [ref r_1]'];
    expect(numberCheck('You have about 1,100 leads.', outs).ok).toBe(true);
  });

  it('keeps an exact (non-rounded) count strict — 711 is not 712', () => {
    const outs = ['Search opportunities: 712 opportunities in total'];
    const r = numberCheck('You have 711 open opportunities.', outs);
    expect(r.ok).toBe(false);
    expect(r.unsupported.join(' ')).toContain('711');
  });

  it('verifies a day-before-month spelled date ("13 November 2026"), not its day number', () => {
    // A scheduling confirmation renders the EU spoken order "13 November 2026".
    // The day "13" is a date part, verified against the ISO date in outputs —
    // it must NOT be scanned as an unverified figure.
    const outs = ['Scheduled a follow-up for 2026-11-13T00:00:00.000Z: Follow up with Acme'];
    expect(numberCheck('All set — reminder for 13 November 2026.', outs).ok).toBe(true);
    expect(numberCheck('All set — reminder for 13 Nov 2026.', outs).ok).toBe(true);
    // a wrong day-month spelled date still flags
    expect(numberCheck('Reminder for 25 December 2026.', outs).ok).toBe(false);
  });

  it('treats a figure the USER stated as supported (echoing it is not fabrication)', () => {
    // Pure acknowledgement / memory-save turn: the only figure is the user's own
    // stated value. Repeating it back must not raise an "unverified" caution.
    expect(numberCheck('Saved: your sales target is $50k.', [], 'remember my sales target is $50k').ok).toBe(true);
    expect(numberCheck('Noted — target $50,000 and quota 120 deals.', [], 'my target is $50,000 and quota is 120 deals').ok).toBe(true);
    // a figure NOT stated by the user and not in outputs still flags
    expect(numberCheck('Your target is $99,999.', [], 'remember my sales target is $50k').ok).toBe(false);
  });

  it('does not treat a non-date fraction/ratio as a numeric date', () => {
    // "3/5" is one slash, not a date — must not be mis-parsed; 3 and 5 are small
    // ints anyway, so a clean ratio mention passes.
    expect(numberCheck('The win rate is 3/5 for the sample.', []).ok).toBe(true);
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
