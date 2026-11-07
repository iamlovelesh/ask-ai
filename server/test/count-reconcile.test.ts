import { describe, it, expect } from 'vitest';
import { countReconciliationNote, writeCountReconcileNote } from '../src/loop/count-reconcile';

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

describe('writeCountReconcileNote (batch overclaim guard)', () => {
  const TASKS = new Set(['task']);

  it('flags when the answer claims more records acted on than were actually written', () => {
    const note = writeCountReconcileNote(
      "I've created follow-up tasks for the 5 newest leads, due next Monday.",
      3,
      TASKS,
    );
    expect(note).not.toBeNull();
    expect(note).toMatch(/\b3\b/);
    expect(note).toMatch(/\b5\b/);
    expect(note).toMatch(/remaining 2|only .*3|not 5/i);
  });

  it('flags "created N tasks" overclaims', () => {
    const note = writeCountReconcileNote('Created 5 tasks for your leads.', 3, TASKS);
    expect(note).not.toBeNull();
    expect(note).toMatch(/3/);
  });

  it('does NOT flag when the claim matches what was written', () => {
    expect(writeCountReconcileNote('Created 5 tasks.', 5, TASKS)).toBeNull();
  });

  it('does NOT flag when the claim is smaller than what was written', () => {
    expect(writeCountReconcileNote('Updated 2 records as requested.', 3, new Set(['record']))).toBeNull();
  });

  it('does NOT flag when there is no quantity claim', () => {
    expect(writeCountReconcileNote('Done — the follow-up tasks are created.', 3, TASKS)).toBeNull();
  });

  it('does NOT flag when the answer already states the real accomplished count ("3 of the 5")', () => {
    const honest = 'I created follow-up tasks for 3 of the 5 newest leads; the other 2 have no associated contact.';
    expect(writeCountReconcileNote(honest, 3, TASKS)).toBeNull();
  });

  it('does NOT read bare years or ids as a quantity claim', () => {
    expect(writeCountReconcileNote('Created tasks for leads added in 2026.', 3, TASKS)).toBeNull();
  });

  it('returns null when nothing was written', () => {
    expect(writeCountReconcileNote('I created tasks for the 5 leads.', 0, TASKS)).toBeNull();
  });

  it('does NOT flag a report answer that counts an entity it never wrote (regression: "not 100")', () => {
    // A pipeline-summary report created 2 report *structures*; the answer reports
    // "1,100 opportunities" — a read figure, not a write claim. Must not fire.
    const reportAnswer =
      '**Total: 1,100 opportunities worth $29,083,740.12** across all stages.';
    expect(writeCountReconcileNote(reportAnswer, 2, new Set(['structure']))).toBeNull();
  });

  it('parses thousands separators when the entity WAS written', () => {
    // If opportunities really were written, the correction must name 1,100 — not 100.
    const note = writeCountReconcileNote('Created 1,100 opportunities.', 2, new Set(['opportunity']));
    expect(note).not.toBeNull();
    expect(note).toMatch(/1,100/);
    expect(note).not.toMatch(/not 100\b/);
  });

  it('stays silent when no written entities are supplied (fail-safe)', () => {
    expect(writeCountReconcileNote('Created 5 tasks.', 3)).toBeNull();
  });
});
