import { describe, it, expect } from 'vitest';
import { countReconciliationNote } from '../src/loop/count-reconcile';

describe('countReconciliationNote (#1 undercount guard)', () => {
  it('flags when the answer states a small count but a ref-tool sorted a much larger set', () => {
    const tools = ['Sorted 119 records by value_cents desc (numeric order); top 5 [ref r_x]: …'];
    const note = countReconciliationNote('You have **5 negotiation-stage opportunities** over $20,000.', tools);
    expect(note).toMatch(/119/);
    expect(note).toMatch(/top|sample|not the complete/i);
  });

  it('flags using a filter_ref "matched" total', () => {
    const tools = ['Filter stage eq "negotiation" over 439 records: 119 matched [ref r_y]. Sample: …'];
    const note = countReconciliationNote('I found 5 matching opportunities.', tools);
    expect(note).toMatch(/119/);
  });

  it('does NOT flag when the answer already states the full total', () => {
    const tools = ['Sorted 119 records by value_cents desc; top 5 [ref r_x]'];
    expect(countReconciliationNote('Of your 119 negotiation opportunities, the top 5 are: …', tools)).toBeNull();
  });

  it('does NOT flag small sets (no meaningful undercount)', () => {
    const tools = ['Sorted 6 records by value_cents desc; top 5 [ref r_x]'];
    expect(countReconciliationNote('You have 5 opportunities.', tools)).toBeNull();
  });

  it('does NOT flag when there is no count claim in the answer', () => {
    const tools = ['Sorted 119 records by value_cents desc; top 5 [ref r_x]'];
    expect(countReconciliationNote('The highest-value deal is Acme Corp, closing Friday.', tools)).toBeNull();
  });

  it('returns null with no tool outputs', () => {
    expect(countReconciliationNote('You have 5 things.', [])).toBeNull();
  });
});
