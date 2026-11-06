import { describe, it, expect } from 'vitest';
import { unsanctionedFilters } from '../src/loop/scope-check';

const F = (key: string, value: string) => ({ action: 'x.search', key, value });

describe('unsanctionedFilters', () => {
  it('flags a filter the user never mentioned on a totality answer (true positive)', () => {
    const out = unsanctionedFilters(
      'You have 23 open tickets in total.',
      'how many open tickets in total?',
      [F('priority', 'high')],
    );
    expect(out.map((f) => f.key)).toEqual(['priority']);
  });

  it('does NOT flag a filter the user asked for, across punctuation/case/word-order (review HIGH-2)', () => {
    // enum value "Closed Won" vs user "closed-won"; key "stage" never literal
    expect(unsanctionedFilters(
      'In total, there are 42 deals closed won this quarter.',
      'How many deals have we closed-won in total this quarter?',
      [F('stage', 'Closed Won')],
    )).toEqual([]);
    // "past_due" enum vs "overdue" is a synonym — but the user said "overdue",
    // and the value token is absent; this is the conservative-miss side we accept.
    // The case that must NOT misfire: value present with different formatting.
    expect(unsanctionedFilters(
      'Altogether you have 5 VIP contacts.',
      'how many VIP contacts do we have altogether',
      [F('segment', 'vip')],
    )).toEqual([]);
  });

  it('does not flag when the draft makes no totality claim', () => {
    expect(unsanctionedFilters(
      'Here are 3 high-priority tickets.',
      'show me high priority tickets',
      [F('priority', 'high')],
    )).toEqual([]);
  });

  it('dedupes repeated filters', () => {
    const out = unsanctionedFilters(
      'You have 10 in total.',
      'how many in total',
      [F('priority', 'high'), F('priority', 'high')],
    );
    expect(out).toHaveLength(1);
  });
});
