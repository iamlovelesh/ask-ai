import { describe, it, expect } from 'vitest';
import { stripMonologue } from '../src/loop/strip-monologue';

describe('stripMonologue', () => {
  it('removes a leading interjection', () => {
    expect(stripMonologue('Perfect! You have 1,362 open leads.')).toBe('You have 1,362 open leads.');
    expect(stripMonologue('Great, the top invoice is INV-2005.')).toBe('the top invoice is INV-2005.');
  });

  it('removes leading "Let me <process>" scaffolding', () => {
    expect(stripMonologue('Let me create a summary table:\n\nYou have 5 leads.')).toBe('You have 5 leads.');
    expect(stripMonologue('Let me verify this calculation using the aggregate function. The total is $97,333.67.')).toBe(
      'The total is $97,333.67.',
    );
  });

  it('removes leading "Now I have all the data" narration', () => {
    expect(stripMonologue('Now I have all the data I need. There are 3 overdue invoices.')).toBe(
      'There are 3 overdue invoices.',
    );
  });

  it('strips a stacked prefix (interjection + scaffold)', () => {
    expect(stripMonologue('Perfect! Now I can compile the results. You owe $500.')).toBe('You owe $500.');
  });

  it('does NOT strip real content that merely starts with "Based on"', () => {
    const real = 'Based on the data, you have 1,362 open leads.';
    expect(stripMonologue(real)).toBe(real);
  });

  it('does NOT strip a trailing "Let me know" offer', () => {
    const t = 'You have 5 leads. Let me know if you want details.';
    expect(stripMonologue(t)).toBe(t);
  });

  it('never strips the answer to empty', () => {
    expect(stripMonologue('Let me check.')).toBe('Let me check.');
  });
});
